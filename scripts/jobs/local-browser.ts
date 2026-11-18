import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { jobsHome } from './config';

export async function ensureLocalBrowser(cdpUrl: string) {
  const url = new URL(cdpUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_local_browser');
  const ready = async () => {
    try {
      const response = await fetch(`${url.origin}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(800) });
      if (!response.ok) return false;
      const data = await response.json() as { Browser?: unknown; webSocketDebuggerUrl?: unknown };
      const websocket = typeof data.webSocketDebuggerUrl === 'string' && URL.parse(data.webSocketDebuggerUrl);
      return typeof data.Browser === 'string' && Boolean(websocket && websocket.protocol === 'ws:' &&
        websocket.host === url.host && !websocket.username && !websocket.password && !websocket.search &&
        !websocket.hash && /^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(websocket.pathname));
    } catch { return false; }
  };
  if (await ready()) return;
  // Chrome may open on IPv6 alone when another process owns the requested IPv4 port.
  const occupied = await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const finish = (connected: boolean) => { socket.destroy(); resolve(connected); };
    socket.setTimeout(800, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
  if (occupied) throw new Error('local_browser_port_in_use');
  const executable = process.env.QUANTSELF_JOBS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(executable)) throw new Error('local_browser_unavailable');
  const profile = join(jobsHome(), 'chrome');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${url.port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], {
    detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  let failed = false;
  child.once('error', () => { failed = true; }); child.unref();
  for (let attempt = 0; attempt < 30 && !failed; attempt++) {
    if (await ready()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error('local_browser_unavailable');
}
