import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForm, submitApplication, type BrowserSubmitWork } from './browser';
import { smartRecruitersFixture as target } from './browser-smartrecruiters.fixture';

test('the private SmartRecruiters selector preserves exact match behavior and rejects unsafe config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qs-smartrecruiters-'));
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = home;
  const path = join(home, 'smartrecruiters-target.json');
  const fakeRunner = join(home, 'fake-runner');
  const work: BrowserSubmitWork = { kind: 'submit', sourceUrl: target.sourceUrl, company: target.company, role: target.role };
  let debuggerReads = 0;
  const fakeDebugger = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    debuggerReads++;
    return Response.json({ webSocketDebuggerUrl: `ws://${new URL(request.url).host}/devtools/browser/00000000-0000-4000-8000-000000000001` });
  } });
  const options = {
    browserUseCommand: fakeRunner, cdpUrl: `http://127.0.0.1:${fakeDebugger.port}`,
    pdfPath: join(home, 'unused.pdf'), privateConfigPath: join(home, 'unused.json'),
  };
  const unavailable = { kind: 'failed', code: 'unsupported_portal' } as const;
  try {
    await writeFile(fakeRunner, `#!/usr/bin/env python3
import json, os, sys
if sys.argv[1:] == ['--reload']:
    sys.exit(0)
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
expected = json.loads(${JSON.stringify(JSON.stringify(target))})
for name in ('sourceUrl','url','role','listingTitle','applicationTitle'):
    assert params[name] == expected[name]
program = sys.stdin.read()
assert 'document.title === p.listingTitle' in program and 'document.title !== p.applicationTitle' in program
if params.get('mode') == 'discover':
    assert 'privateConfigPath' not in params and 'pdfPath' not in params
    print('{"qsJobsBrowser":"discovered"}')
else:
    print('{"qsJobsBrowser":"manual_required","questions":[],"variables":[],"gate":' + json.dumps(params['gate']) + '}')
`, { mode: 0o700 });

    expect(await discoverForm(work, options)).toEqual(unavailable);
    expect(await submitApplication(work, options)).toEqual(unavailable);
    expect(debuggerReads).toBe(0);
    await writeFile(path, JSON.stringify(target), { mode: 0o600 });

    const gate = { kind: 'privacy_agreement', url: target.url };
    expect(await discoverForm(work, options)).toMatchObject({ kind: 'discovered', listingUrl: target.sourceUrl, gate });
    expect(await discoverForm({ sourceUrl: target.sourceUrl }, options)).toMatchObject({ kind: 'discovered', gate });
    expect(await submitApplication(work, options)).toMatchObject({ kind: 'failed', code: 'manual_required', gate });
    expect(debuggerReads).toBe(3);

    for (const mismatch of [{ ...work, company: 'Other employer' }, { ...work, role: 'Other role' }]) {
      expect(await discoverForm(mismatch, options)).toEqual({ kind: 'failed', code: 'identity_mismatch' });
      expect(await submitApplication(mismatch, options)).toEqual({ kind: 'failed', code: 'manual_required' });
    }
    expect(await discoverForm({ sourceUrl: target.sourceUrl, company: target.company }, options))
      .toEqual({ kind: 'failed', code: 'identity_mismatch' });
    for (const sourceUrl of [target.sourceUrl + '/', target.sourceUrl + '?different=true', target.sourceUrl + '#other', target.sourceUrl + '2']) {
      expect(await discoverForm({ ...work, sourceUrl }, options)).toEqual(unavailable);
      expect(await submitApplication({ ...work, sourceUrl }, options)).toEqual(unavailable);
    }

    await chmod(path, 0o644);
    expect(await discoverForm(work, options)).toEqual(unavailable);
    await chmod(path, 0o600);
    await writeFile(path, '{');
    expect(await submitApplication(work, options)).toEqual(unavailable);
    await writeFile(path, JSON.stringify({ ...target, url: target.url.replace('jobs.smartrecruiters.com', 'jobs.example.test') }));
    expect(await submitApplication(work, options)).toEqual(unavailable);
    await rm(path);
    const symlinkSource = join(home, 'other.json');
    await writeFile(symlinkSource, JSON.stringify(target), { mode: 0o600 });
    await symlink(symlinkSource, path);
    expect(await discoverForm(work, options)).toEqual(unavailable);
    expect(debuggerReads).toBe(3);
  } finally {
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    await fakeDebugger.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
