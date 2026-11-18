import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const host = 'job-boards.greenhouse.io';
const listing = '/quantself-fixture/jobs/987654321';
const pilotListing = '/synthetic-studio/jobs/197';
export const syntheticPosting = {
  sourceUrl: `https://${host}${listing}`, company: 'Example Studio', role: 'Catalog Editor',
};
export const syntheticSourceIdentity = 'greenhouse:global:quantself-fixture:987654321';
export const syntheticCandidate = { firstName: 'Synthetic', lastName: 'Applicant' };
export const syntheticQuestion = { id: 'application_source', label: 'Application source', type: 'text', required: true, options: [] };
export const syntheticAnswer = 'Synthetic job board';
export const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

export function syntheticPdf(revision: number) {
  const stream = `BT /F1 12 Tf 72 720 Td (Synthetic resume revision ${revision}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, '0');
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${offset} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function checkedCommand(command: string[], stdin?: Uint8Array) {
  const result = Bun.spawnSync(command, { stdin, stderr: 'ignore' });
  if (result.exitCode !== 0) throw new Error(`Synthetic portal setup failed: ${command.slice(0, 2).join(' ')}`);
  return result.stdout;
}

export async function openSyntheticPortal(directory: string, expectedDigest: string, applicationAddress: string,
  respondToSubmission: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
  listingUrl = syntheticPosting.sourceUrl) {
  const fixture = new URL(listingUrl);
  if (fixture.origin !== `https://${host}` || fixture.search || fixture.hash ||
      ![listing, pilotListing].includes(fixture.pathname)) {
    throw new Error('Use the synthetic Jobs portal listing.');
  }
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  checkedCommand(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`,
    '-keyout', key, '-out', cert, '-days', '1']);
  const publicKey = checkedCommand(['openssl', 'x509', '-in', cert, '-pubkey', '-noout']);
  const der = checkedCommand(['openssl', 'pkey', '-pubin', '-outform', 'der'], publicKey);
  const spki = createHash('sha256').update(der).digest('base64');
  const { role, company } = fixture.pathname === pilotListing ? { role: 'Editor', company: 'Synthetic Studio' } : syntheticPosting;
  const page = (await Bun.file(new URL('./synthetic-job-application.html', import.meta.url)).text())
    .replaceAll('{{role}}', role).replaceAll('{{company}}', company);
  let requests = 0;
  let pageReads = 0;
  let clicks = 0;
  let validSubmissions = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      requests++;
      const url = new URL(request.url);
      if (url.hostname !== host) return new Response(null, { status: 404 });
      if (request.method === 'GET' && url.pathname === fixture.pathname) {
        pageReads++;
        return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; form-action 'self'" } });
      }
      if (request.method === 'POST' && url.pathname === '/synthetic-submit') {
        clicks++;
        const data = await request.formData();
        const resume = data.get('resume');
        if (data.get('first_name') !== syntheticCandidate.firstName || data.get('last_name') !== syntheticCandidate.lastName ||
            data.get('email') !== applicationAddress || data.get(syntheticQuestion.id) !== syntheticAnswer ||
            !(resume instanceof File) ||
            resume.name !== 'resume.pdf' || sha256(new Uint8Array(await resume.arrayBuffer())) !== expectedDigest) {
          return new Response(null, { status: 400 });
        }
        validSubmissions++;
        return respondToSubmission();
      }
      return new Response(null, { status: 404 });
    },
  });
  const chromePath = process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = join(directory, 'chrome');
  let chrome: ReturnType<typeof Bun.spawn> | undefined;
  let chromeError: Promise<string> | undefined;
  async function close() {
    chrome?.kill();
    await chrome?.exited;
    await server.stop(true);
  }
  try {
    chrome = Bun.spawn([chromePath, '--headless=new', '--disable-background-networking', '--no-first-run',
      '--no-proxy-server', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP ${host} 127.0.0.1:${server.port}, MAP * ~NOTFOUND, EXCLUDE localhost`, 'about:blank'],
    { stdout: 'ignore', stderr: 'pipe' });
    chromeError = new Response(chrome.stderr as ReadableStream<Uint8Array>).text();
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline && chrome.exitCode === null && chrome.signalCode === null) {
      const activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, browserPath] = activePort.split('\n');
      if (/^\d+$/.test(port) && browserPath) {
        const cdpUrl = `http://127.0.0.1:${port}`;
        const version = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(750) })
          .then(response => response.ok ? response.json() : null).catch(() => null) as { webSocketDebuggerUrl?: string } | null;
        if (version?.webSocketDebuggerUrl === `ws://127.0.0.1:${port}${browserPath}`) {
          return { cdpUrl, close, requests: () => requests, pageReads: () => pageReads,
            clicks: () => clicks, validSubmissions: () => validSubmissions };
        }
      }
      await Bun.sleep(100);
    }
    throw new Error('Synthetic Chrome did not expose its loopback debugger.');
  } catch (error) {
    await close();
    const details = (await chromeError)?.trim().slice(-2_000);
    throw new Error(details ? `${error instanceof Error ? error.message : String(error)}\n${details}` : String(error), { cause: error });
  }
}
