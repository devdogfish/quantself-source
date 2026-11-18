import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForm } from './browser';

const browserUseCommand = process.env.QS_JOBS_TEST_BROWSER_USE;

test.skipIf(!browserUseCommand)('discovers the scoped Ashby form after page load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qs-ashby-discovery-'));
  const sourceUrl = 'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789012';
  const requests: string[] = [];
  try {
    const key = join(root, 'key.pem');
    const cert = join(root, 'cert.pem');
    const certificate = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj',
      '/CN=jobs.ashbyhq.com', '-keyout', key, '-out', cert, '-days', '1'], { stderr: 'ignore' });
    expect(certificate.exitCode).toBe(0);
    const publicKey = Bun.spawnSync(['openssl', 'x509', '-in', cert, '-pubkey', '-noout']);
    const der = Bun.spawnSync(['openssl', 'pkey', '-pubin', '-outform', 'der'], { stdin: publicKey.stdout });
    expect(der.exitCode).toBe(0);
    const spki = new Bun.CryptoHasher('sha256').update(der.stdout).digest('base64');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        requests.push(`${request.method} ${pathname}`);
        if (request.method !== 'GET' || pathname !== `${new URL(sourceUrl).pathname}/application`) {
          return new Response(null, { status: 404 });
        }
        return new Response(`<!doctype html><title>Accountant @ Example</title>
          <h1>Accountant</h1><div id="form" role="tabpanel"></div>
          <script>
            addEventListener('load', () => setTimeout(() => {
              document.querySelector('#form').innerHTML = \`<div class="ashby-application-form-container">
                <label for="_systemfield_name">Name</label><input id="_systemfield_name" required>
                <label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" type="file" required>
              </div>\`;
            }, 2500));
          </script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
    const profile = join(root, 'chrome');
    const executable = process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chrome = Bun.spawn([executable, '--headless=new', '--disable-background-networking', '--no-first-run',
      '--no-proxy-server', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP jobs.ashbyhq.com 127.0.0.1:${server.port}, MAP * ~NOTFOUND, EXCLUDE localhost`,
      'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      let port = '';
      for (let i = 0; i < 50 && !port; i++) {
        [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n');
        if (!port) await Bun.sleep(100);
      }
      expect(port).toMatch(/^\d+$/);
      const result = await discoverForm({ company: 'Example', role: 'Accountant', sourceUrl }, {
        browserUseCommand,
        cdpUrl: `http://127.0.0.1:${port}`,
      });
      expect(result).toMatchObject({ kind: 'discovered', fields: expect.arrayContaining([
        { id: '_systemfield_name', label: 'Name', type: 'text', required: true, options: [] },
        { id: '_systemfield_resume', label: 'Resume', type: 'file', required: true, options: [] },
      ]) });
      expect(requests).toContain(`GET ${new URL(sourceUrl).pathname}/application`);
      expect(requests.every(request => request.startsWith('GET '))).toBe(true);
    } finally {
      chrome.kill();
      await chrome.exited;
      await server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
