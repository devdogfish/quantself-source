import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalBrowser } from './local-browser';

test('an occupied non-CDP port stops before launching another Chrome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jobs-browser-port-'));
  const executable = join(directory, 'fake-chrome');
  const previousExecutable = process.env.QUANTSELF_JOBS_CHROME;
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) });
  try {
    await writeFile(executable, '#!/bin/sh\ntouch "$(dirname "$0")/launched"\n', { mode: 0o700 });
    process.env.QUANTSELF_JOBS_CHROME = executable;
    process.env.QUANTSELF_JOBS_HOME = directory;
    await expect(ensureLocalBrowser(`http://127.0.0.1:${server.port}`)).rejects.toThrow('local_browser_port_in_use');
    expect(existsSync(join(directory, 'launched'))).toBe(false);
  } finally {
    if (previousExecutable === undefined) delete process.env.QUANTSELF_JOBS_CHROME;
    else process.env.QUANTSELF_JOBS_CHROME = previousExecutable;
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
