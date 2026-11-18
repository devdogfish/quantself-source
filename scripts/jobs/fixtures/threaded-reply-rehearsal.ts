import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const processReport = z.object({
  pid: z.number().int().positive(),
  cases: z.array(z.object({
    case: z.string(), status: z.string(), reachedTransport: z.boolean(), imapCommands: z.number().int().nonnegative(),
    providerCalls: z.number().int().nonnegative(), workerMs: z.number().nullable(), elapsedMs: z.number(),
  })),
  ackDropped: z.literal(true).optional(),
  draftSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  receipt: z.object({ status: z.literal('sent'), message_id: z.string() }).optional(),
  inReplyTo: z.string().optional(),
});

export async function rehearseThreadedReply(input: {
  directory: string;
  address: string;
  applicationId: string;
  ref: { folder: string; uid: number; uidvalidity: number };
  secret: string;
  fetchJobs: (request: Request) => Response | Promise<Response>;
}) {
  const state = join(input.directory, 'threaded-reply');
  await mkdir(state, { mode: 0o700 });
  const cert = join(state, 'cert.pem');
  const key = join(state, 'key.pem');
  const certificate = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert]);
  if (certificate.exitCode !== 0) throw new Error('Threaded reply fixture TLS setup failed.');

  const requests: { method: string; path: string; status: number; elapsedMs: number }[] = [];
  const resolvePath = '/api/v1/jobs/applications/resolve-reply';
  const lifecyclePath = `/api/v1/jobs/applications/${input.applicationId}/lifecycle`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      const started = performance.now();
      const path = new URL(request.url).pathname;
      const allowed = (request.method === 'POST' && path === resolvePath) || (request.method === 'GET' && path === lifecyclePath);
      const response = allowed ? await input.fetchJobs(request) : new Response(null, { status: 403 });
      requests.push({ method: request.method, path, status: response.status, elapsedMs: Math.round(performance.now() - started) });
      return response;
    },
  });

  const commandId = randomUUID();
  async function run(mode: 'dispatch' | 'restart') {
    const started = performance.now();
    const firstRequest = requests.length;
    const child = Bun.spawn(['python3', '-B', 'agents/sam/jobs-mail/rehearse_send.py'], {
      stdin: new Blob([JSON.stringify({ mode, commandId, state, bun: process.execPath, address: input.address,
        applicationId: input.applicationId, ref: input.ref })]), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: Bun.env.PATH, QUANTSELF_API_URL: server.url.origin, QUANTSELF_API_KEY: input.secret, QS_FIXTURE_TLS_CERT: cert },
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try {
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Threaded reply fixture ${mode} failed: ${error}`);
      return { ...processReport.parse(JSON.parse(output)), requests: requests.slice(firstRequest), elapsedMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    const dispatch = await run('dispatch');
    const restart = await run('restart');
    return { commandId, dispatch, restart };
  } finally {
    await server.stop(true);
  }
}
