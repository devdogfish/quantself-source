import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { browserSubmitGate, discoverForm, runBrowserProgram, submitApplication, type BrowserSubmitWork } from './browser';
import { smartRecruitersFixture } from './browser-smartrecruiters.fixture';
import { directBrowserFixtures } from './browser-direct.fixture';

const posting = '/example/12345678-1234-1234-1234-123456789012';
const work: BrowserSubmitWork = { kind: 'submit', company: 'Example', role: 'Engineer',
  sourceUrl: `https://jobs.lever.co${posting}?metadata=not-forwarded` };
const ashbyPath = posting.replace('/example/', '/example.ai/');
const ashbyWork = { ...work, sourceUrl: `https://jobs.ashbyhq.com${ashbyPath}` };
const embeddedWork = { ...work, company: 'Embedded Board', role: 'Fixture Billing Associate',
  sourceUrl: 'https://embedded.example.test/job/?gh_jid=1000105' };
const manatalWork = { ...work, company: 'Example Office', role: 'Fixture Accounts Associate',
  sourceUrl: 'https://www.careers-page.com/fixture-office/job/FA000001' };
const workableWork = { ...work, company: 'Example Studio', role: 'Fixture Support Associate',
  sourceUrl: 'https://apply.workable.com/fixture-studio/j/FIXTURE001/' };
const ripplingWork = { ...work, company: 'Example Data', role: 'Fixture Migration Engineer',
  sourceUrl: 'https://board.example.test/jobs/fixture-migration-opening' };
const ripplingPath = '/fixture-organization/jobs/00000000-0000-4000-8000-000000000107';
const ripplingKey = `https://ats.rippling.com${ripplingPath}`;
const smsNo = 'No - I do not consent to receiving text messages';
const termsLabel = 'Agree to Rippling Terms of Service and User Privacy Notice';
const brandedPath = '/careers/job/fixture-opening';
const brandedKey = `https://application.example.test${brandedPath}`;
const brandedWork = { ...work, company: 'Example Services', role: 'Fixture Service Associate',
  sourceUrl: `https://application.example.test/emplois/poste-fictif` };
const brandedConsent = 'I permit Example Services to review this fixture application.';
const brandedTalent = 'Keep this example application in the fixture talent pool.';
const jazzPath = '/apply/FixtureOpening01';
const jazzWork = { ...work, company: 'Example Catalog', role: 'Fixture Catalog Associate',
  sourceUrl: `https://example-catalog.applytojob.com${jazzPath}` };
const jazzQuestions = [
  'What interests you in this synthetic catalog opening?',
  'Which inventory tools have you used?',
  'Can you work a rotating weekday schedule?',
  'Describe how you would correct a sample catalog entry.',
];
const taleoPath = '/en/job/fixture-opening';
const taleoWork = { ...work, company: 'Example Contact', role: 'Fixture Contact Associate',
  sourceUrl: `https://contact.example.test${taleoPath}` };
const taleoGate = { kind: 'privacy_agreement', url: 'https://example-contact.taleo.net/careersection/99/jobapply.ftl?job=FX001',
  policyUrl: 'https://contact.example.test/privacy' } as const;
const { sourceUrl: smartSource, url: smartUrl, company: smartCompany, role: smartRole } = smartRecruitersFixture;
const smartPath = new URL(smartSource).pathname;
const smartApply = new URL(smartUrl);
const smartWork = { ...work, sourceUrl: smartSource, company: smartCompany, role: smartRole };
const smartNotice = 'Please be informed that your application to this job offer will trigger some processing of your personal data by the recruiting company, the data controller. SmartRecruiters, the data processor, has no control over such personal data processing. For more information on these personal data processing, please refer to the recruiting company’s privacy notice.';
const workableLongPrompt = 'Describe a recurring example from a previous support role where you wrote instructions or built a reusable process that other people could use, and explain what changed for the team after it went into use.';

test('direct profiles reject unavailable config, changed routes and mismatched identities before CDP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qs-direct-targets-'));
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = root;
  const profile = directBrowserFixtures[0];
  const target = { kind: 'submit' as const, sourceUrl: profile.sources[0], company: profile.company, role: profile.role };
  const path = join(root, 'direct-browser-targets.json');
  let requests = 0;
  const cdp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    return new Response(null, { status: 404 });
  } });
  const options = { cdpUrl: `http://127.0.0.1:${cdp.port}`, browserUseCommand: process.execPath,
    pdfPath: join(root, 'unused.pdf'), privateConfigPath: join(root, 'unused.json') };
  const unsupported = { kind: 'failed', code: 'unsupported_portal' } as const;
  try {
    expect(await discoverForm(target, options)).toEqual(unsupported);
    for (const invalid of [[profile, profile], [{ ...profile, url: profile.url.replace('job-boards.greenhouse.io', 'other.example.test') }]]) {
      await writeFile(path, JSON.stringify(invalid), { mode: 0o600 });
      expect(await submitApplication(target, options)).toEqual(unsupported);
    }
    await writeFile(path, JSON.stringify([profile]));
    await chmod(path, 0o644);
    expect(await discoverForm(target, options)).toEqual(unsupported);
    await chmod(path, 0o600);
    expect(await discoverForm({ ...target, sourceUrl: target.sourceUrl + '&preview=1' }, options)).toEqual(unsupported);
    expect(await discoverForm({ ...target, role: 'Different fixture role' }, options))
      .toEqual({ kind: 'failed', code: 'identity_mismatch' });
    expect(await submitApplication({ ...target, company: 'Different fixture company' }, options))
      .toEqual({ kind: 'failed', code: 'manual_required' });
    expect(requests).toBe(0);
  } finally {
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    await cdp.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
const executable = String.raw`#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
time.sleep = lambda _: None
if sys.argv[1:] == ['--reload']:
    sys.exit(0)
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
script = sys.stdin.read()
assert 'ANTHROPIC_API_KEY' not in os.environ and 'BROWSER_USE_API_KEY' not in os.environ
assert 'not-forwarded' not in json.dumps(params) and 'ignored-summary' not in json.dumps(params)
assert os.environ['BH_RECORD'] == '0' and os.environ['ANONYMIZED_TELEMETRY'] == 'false'
assert os.environ['BU_CDP_WS'].startswith('ws://127.0.0.1:')
assert 'private-person@example.test' not in script + json.dumps(params)
assert 'type_secret(' not in script and 'capture_screenshot(' not in script
state = {'clicks': 0, 'filled': {}, 'uploads': 0}
mode = __MODE__
log = Path(__LOG__)
ashby = params['portal'] == 'ashby'
question = {'id': 'select_1', 'label': 'Are you authorized to work here?', 'type': 'select',
            'required': True, 'options': ['Yes', 'No']}

def cdp(method, **kwargs):
    if method == 'Target.createBrowserContext': return {'browserContextId': 'new-context'}
    if method == 'Target.createTarget':
        assert kwargs['browserContextId'] == 'new-context'
        return {'targetId': 'tab'}
    if method == 'Target.disposeBrowserContext':
        log.write_text(json.dumps(state)); return {}
    if method == 'DOM.getDocument': return {'root': {'nodeId': 1}}
    if method == 'DOM.querySelector':
        if ashby: assert kwargs['selector'] == ':is(div#form[role=tabpanel] > div.ashby-application-form-container) #_systemfield_resume'
        else: assert kwargs['selector'] == ':is(form#application-form, form.application-form) #resume-upload-input'
        return {'nodeId': 2}
    if method == 'DOM.setFileInputFiles':
        assert kwargs['nodeId'] == 2 and len(kwargs['files']) == 1
        state['uploads'] += 1
        return {}
    raise RuntimeError('unexpected operation')

def js(code):
    if 'return {url: location.href' in code:
        url = params['url']
        headings = ['Engineer']
        if mode == 'fixturealias-alias':
            return {'url': url, 'title': 'Job Application for Synthetic Associate I at Example Labs – careers',
                    'headings': ['Synthetic Associate I'], 'challenge': False, 'consent': False}
        if mode == 'different-listing': url = url.replace('12345678-', '23456789-')
        if state['clicks']:
            if mode == 'crash-after-click':
                log.write_text(json.dumps(state)); os._exit(1)
            url = url if ashby else url.removesuffix('/apply') + '/thanks'
            headings = ['Your application was successfully submitted' if ashby else 'Application submitted!']
            if mode == 'false-receipt': url = url.replace('12345678-', '23456789-')
        return {'url': url, 'title': 'Engineer @ Example' if ashby else 'Example - Engineer', 'headings': headings,
                'challenge': False, 'consent': False}
    if 'const field = descriptor(e, forms[0])' in code:
        assert params['mode'] == 'discover'
        assert 'privateConfigPath' not in params and 'pdfPath' not in params
        assert 'e.value' not in code and 'getAttribute(\'value\')' not in code
        field = {'id': 'first_name', 'label': 'First name', 'type': 'text', 'required': True, 'options': []}
        if mode == 'bad-discovery': field['value'] = 'private-person@example.test'
        return [field]
    if code == 'location.href': return params['url']
    if code.startswith('Boolean([...document.querySelectorAll('): return False
    if 'const eligible' in code:
        if mode == 'required-custom-field': return None
        if '"values": null' in code:
            mapping = [{'selector': '#_systemfield_name' if ashby else 'input[name="name"]', 'key': 'fullName', 'required': True, 'type': 'text', 'question': None},
                       {'selector': '#_systemfield_email' if ashby else 'input[name="email"]', 'key': 'email', 'required': True, 'type': 'email', 'question': None}]
            blocked = []
            if ashby:
                if '"answerLabels": ["Are you authorized to work here?"]' in code:
                    mapping.append({'selector': '#select_1', 'key': 'question:Are you authorized to work here?', 'required': True, 'type': 'select', 'question': question})
                else: blocked.append(question)
            return {'mapping': mapping, 'blocked': blocked, 'unmapped': False,
                    'resumeTarget': '#_systemfield_resume' if ashby else '#resume-upload-input'}
        if '"submit": true' in code:
            assert state['uploads'] == 1
            assert len(state['filled']) == (3 if ashby else 2)
            state['clicks'] += 1
        if mode == 'post-fill-echo':
            return {'blocked': [{**question, 'label': 'Please confirm Private Person'}]}
        return True
    if 'HTMLSelectElement.prototype' in code:
        if '"select", "Yes"' in code:
            state['filled']['select'] = True
        return True
    if 'matchesAnswer(e, t, v, group)' in code:
        return mode != 'verify-fails' or '"select", "Yes"' not in code
    raise RuntimeError('unexpected JS')

def fill_input(selector, value):
    assert selector.startswith(':is(div#form[role=tabpanel] > div.ashby-application-form-container) #_systemfield_') if ashby else selector.startswith(':is(form#application-form, form.application-form) input[')
    state['filled'][selector] = bool(value)

def wait_for_element(selector, timeout):
    assert ashby and selector == 'div#form[role=tabpanel] > div.ashby-application-form-container' and timeout == 8
    return True

# Raw browser diagnostics, if any, must not become application data.
print('private-person@example.test', flush=True)
exec(compile(script, 'browser-program', 'exec'), {
    'js': js, 'cdp': cdp, 'fill_input': fill_input, 'new_tab': lambda: None, 'switch_tab': lambda tab: None,
    'goto_url': lambda url: None, 'wait_for_load': lambda: None, 'wait_for_element': wait_for_element,
})
log.write_text(json.dumps(state))
`;

async function withFixture(mode: string, run: (fixture: {
  options: { pdfPath: string; privateConfigPath: string; browserUseCommand: string; cdpUrl: string };
  log: string;
}) => Promise<void>, redirect = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-fixture-'));
  const log = join(directory, 'calls.json');
  const pdfPath = join(directory, 'synthetic.pdf');
  const privateConfigPath = join(directory, 'private.json');
  const browserUseCommand = join(directory, 'fake-browser-use');
  await writeFile(pdfPath, '%PDF-1.4\n');
  await writeFile(privateConfigPath, JSON.stringify({ personal: { firstName: 'Private', lastName: 'Person',
    email: 'private-person@example.test' }, ...(mode !== 'missing-answer' && { answers: {
      [ashbyWork.sourceUrl]: { 'Are you authorized to work here?': { type: 'option', value: 'Yes' } },
    } }) }));
  await writeFile(browserUseCommand, executable.replace('__MODE__', JSON.stringify(mode)).replace('__LOG__', JSON.stringify(log)));
  await chmod(browserUseCommand, 0o700);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    if (redirect) return Response.redirect('https://remote.example/devtools', 302);
    const host = new URL(request.url).host;
    return Response.json({ webSocketDebuggerUrl: `ws://${host}/devtools/browser/12345678-1234-1234-1234-123456789012` });
  } });
  try {
    await run({ options: { pdfPath, privateConfigPath, browserUseCommand, cdpUrl: `http://127.0.0.1:${server.port}` }, log });
  } finally {
    await server.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
}

const counts = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as { clicks: number; uploads: number; filled: object };

describe('private Browser Use execution', () => {
  test('fills, uploads and submits once, returning only a receipt', async () => {
    await withFixture('success', async ({ options, log }) => {
      const request = { ...work, summary: 'ignored-summary' };
      expect(await submitApplication(request, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_page' });
      expect(await counts(log)).toMatchObject({ clicks: 1, uploads: 1 });
    });
  });

  test('holds the final click until the parent acknowledges submission', async () => {
    for (const accept of [true, false]) {
      await withFixture('success', async ({ options, log }) => {
        const gate = Promise.withResolvers<void>();
        const reached = Promise.withResolvers<void>();
        const submission = submitApplication(work, { ...options, beforeSubmit: () => {
          reached.resolve();
          return gate.promise;
        } });
        await reached.promise;
        expect(await Bun.file(log).exists()).toBe(false);
        if (accept) gate.resolve();
        else gate.reject(new Error('synthetic acknowledgement failure'));
        expect((await submission).kind).toBe(accept ? 'applied' : 'failed');
        expect(await counts(log)).toMatchObject({ clicks: accept ? 1 : 0, uploads: 1 });
      });
    }
  });

  test('uses a private approval socket and cleans it up after denial', async () => {
    const python = Bun.which('python3')!;
    const program = `
import json, os, stat

def emit(status, **data):
    print(json.dumps({'qsJobsBrowser': status, **data}), flush=True)

path = os.environ['QS_JOBS_SUBMIT_ACK_SOCKET']
assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
assert stat.S_ISSOCK(os.stat(path).st_mode)
${browserSubmitGate}
emit('accepted' if await_submit_ack() else 'denied', path=path)
`;
    const result = await runBrowserProgram(python, {}, tmpdir(), program, undefined, async () => {
      throw new Error('synthetic approval denied');
    });

    expect(result.exitCode).toBe(0);
    const [message] = result.messages as Array<{ qsJobsBrowser: string; path: string }>;
    expect(result.messages).toEqual([{ qsJobsBrowser: 'denied', path: expect.any(String) }]);
    await expect(stat(dirname(message!.path))).rejects.toHaveProperty('code', 'ENOENT');
  });

  test('releases the approval socket on child exit while awaiting the decision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-ack-exit-'));
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const python = Bun.which('python3')!;
    const program = `
import json, os
from pathlib import Path

def emit(status):
    print(json.dumps({'qsJobsBrowser': status}), flush=True)
    raise SystemExit(17)

Path('approval-path').write_text(os.environ['QS_JOBS_SUBMIT_ACK_SOCKET'])
${browserSubmitGate}
await_submit_ack()
`;
    let finished = false;
    const result = runBrowserProgram(python, {}, directory, program, undefined, () => {
      reached.resolve();
      return gate.promise;
    }).then(outcome => {
      finished = true;
      return outcome;
    });
    try {
      await reached.promise;
      const socketDirectory = dirname(await readFile(join(directory, 'approval-path'), 'utf8'));
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await stat(socketDirectory).catch(() => null))) break;
        await Bun.sleep(10);
      }
      await expect(stat(socketDirectory)).rejects.toHaveProperty('code', 'ENOENT');
      expect(finished).toBe(false);
    } finally {
      gate.resolve();
      await result;
      await rm(directory, { recursive: true, force: true });
    }
    expect(await result).toEqual({ exitCode: 17, messages: [] });
  });

  test('unknown required fields and listing changes stop before local reads or writes', async () => {
    for (const mode of ['different-listing', 'required-custom-field']) {
      await withFixture(mode, async ({ options, log }) => {
        expect(await submitApplication(work, { ...options, privateConfigPath: '/does/not/exist' }))
          .toEqual({ kind: 'failed', code: 'manual_required' });
        expect(await counts(log)).toEqual({ clicks: 0, uploads: 0, filled: {} });
      });
    }
  });

  test('crash after click produces uncertainty and no resubmission', async () => {
    await withFixture('crash-after-click', async ({ options, log }) => {
      expect(await submitApplication(work, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(await counts(log)).toMatchObject({ clicks: 1, uploads: 1 });
    });
  });

  test('rejects lookalike and arbitrary portals, remote CDP and arbitrary field maps', async () => {
    await withFixture('success', async ({ options, log }) => {
      expect(await submitApplication({ ...work, sourceUrl: `https://jobs.lever.co.example.test${posting}` }, options))
        .toEqual({ kind: 'failed', code: 'unsupported_portal' });
      expect(await submitApplication(work, { ...options, cdpUrl: 'http://example.test:9222' }))
        .toEqual({ kind: 'failed', code: 'runner_unavailable' });
      expect(await submitApplication(work, { ...options, fieldMap: [{ id: 'input:has(*)', label: 'Name', key: 'firstName' }] }))
        .toEqual({ kind: 'failed', code: 'manual_required' });
      expect(await Bun.file(log).exists()).toBe(false);
    });
    await withFixture('success', async ({ options }) => {
      expect(await submitApplication(work, options)).toEqual({ kind: 'failed', code: 'runner_unavailable' });
    }, true);
  });

  test('blank discovery for another supported origin returns descriptors without values', async () => {
    const ashby = { sourceUrl: `https://jobs.ashbyhq.com${posting}` };
    await withFixture('discovery', async ({ options, log }) => {
      expect(await discoverForm(ashby, options)).toEqual({ kind: 'discovered', listingUrl: ashby.sourceUrl, fields: [{
        id: 'first_name', label: 'First name', type: 'text', required: true, options: [],
      }] });
      expect(await counts(log)).toEqual({ clicks: 0, uploads: 0, filled: {} });
    });
    await withFixture('bad-discovery', async ({ options }) => {
      expect(await discoverForm(ashby, options)).toEqual({ kind: 'failed', code: 'manual_required' });
    });
  });

  test('Ashby screening uses the explicit local option and verifies it before attaching the PDF', async () => {
    await withFixture('ashby', async ({ options, log }) => {
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(await counts(log)).toMatchObject({ clicks: 1, uploads: 1, filled: { select: true } });
    });
    await withFixture('verify-fails', async ({ options, log }) => {
      expect(await submitApplication(ashbyWork, options)).toMatchObject({ kind: 'failed', code: 'manual_required' });
      expect(await counts(log)).toMatchObject({ clicks: 0, uploads: 0 });
    });
  });

  test('reports the missing screening question without sending or guessing an answer', async () => {
    await withFixture('missing-answer', async ({ options, log }) => {
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'failed', code: 'manual_required', attention: {
        questions: [{ id: 'select_1', label: 'Are you authorized to work here?', type: 'select',
          required: true, options: ['Yes', 'No'] }], variables: [],
      } });
      expect(await counts(log)).toEqual({ clicks: 0, uploads: 0, filled: {} });
    });
  });

  test('rejects an explicit success message on a different listing after the one submit click', async () => {
    await withFixture('false-receipt', async ({ options, log }) => {
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(await counts(log)).toMatchObject({ clicks: 1, uploads: 1 });
    });
  });

  test('post-fill labels cannot appear in application attention', async () => {
    await withFixture('post-fill-echo', async ({ options, log }) => {
      expect(await submitApplication(work, options)).toEqual({ kind: 'failed', code: 'manual_required',
        attention: { questions: [], variables: [] } });
      expect(await counts(log)).toMatchObject({ clicks: 0, uploads: 0 });
    });
  });

  test('discovery and submission reject the same mismatched listing identity before writes', async () => {
    await withFixture('success', async ({ options, log }) => {
      const wrongCompany = { ...work, company: 'Different Company' };
      expect(await discoverForm(wrongCompany, options)).toEqual({ kind: 'failed', code: 'identity_mismatch' });
      expect(await submitApplication(wrongCompany, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(await counts(log)).toMatchObject({ clicks: 0, uploads: 0 });
    });
  });

  test('a private board title alias is bound to the exact staged role and listing ID', async () => {
    await withFixture("fixturealias-alias", async ({ options }) => {
      const example = { company: "Example Labs", role: "Synthetic Associate",
        sourceUrl: "https://job-boards.greenhouse.io/example-labs/jobs/1000101" };
      const candidateRules = [{ ...example, rules: [],
        pageIdentity: { company: "Example Labs – careers", role: "Synthetic Associate I" } }];
      expect(await discoverForm(example, { ...options, candidateRules: [] }))
        .toEqual({ kind: 'failed', code: 'identity_mismatch' });
      const reviewed = { ...options, candidateRules };
      expect(await discoverForm(example, reviewed)).toMatchObject({ kind: 'discovered', listingUrl: example.sourceUrl });
      expect(await discoverForm({ ...example, company: 'Different employer' }, reviewed))
        .toEqual({ kind: 'failed', code: 'identity_mismatch' });
      expect(await discoverForm({ ...example, sourceUrl: example.sourceUrl.replace('1000101', '1000102') }, reviewed))
        .toEqual({ kind: 'failed', code: 'identity_mismatch' });
    });
  });
});

const liveRunner = process.env.QS_JOBS_TEST_BROWSER_USE;
test.skipIf(!liveRunner)('pinned Browser Use verifies synthetic portal submissions and gates over loopback', async () => {
  const root = await mkdtemp('/tmp/qs-browser-ashby-');
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = root;
  try {
    await writeFile(join(root, 'direct-browser-targets.json'), JSON.stringify(directBrowserFixtures), { mode: 0o600 });
    await writeFile(join(root, 'smartrecruiters-target.json'), JSON.stringify(smartRecruitersFixture), { mode: 0o600 });
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
    const ssl = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj',
      '/CN=jobs.ashbyhq.com', '-keyout', key, '-out', cert, '-days', '1'], { stderr: 'ignore' });
    expect(ssl.exitCode).toBe(0);
    const publicKey = Bun.spawnSync(['openssl', 'x509', '-in', cert, '-pubkey', '-noout']);
    const der = Bun.spawnSync(['openssl', 'pkey', '-pubin', '-outform', 'der'], { stdin: publicKey.stdout });
    const spki = new Bun.CryptoHasher('sha256').update(der.stdout).digest('base64');
    let observed = 0, parseAttempts = 0;
    let exactRipplingReceipt = false;
    let verifiedBranded = false, brandedWrites = 0;
    let ashbySurvey: 'optional' | 'required' | 'duplicate' = 'optional', ashbyWrites = 0;
    let ashbyNameLabel = 'Name';
    let jazzVerified = false, jazzWrites = 0;
    let smartWrites = 0, smartClicks = 0;
    const html = (text: string) => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        const { hostname, pathname: path } = new URL(request.url);
        if (hostname === 'ats.rippling.com' && path === '/synthetic-parse' && request.method === 'POST') {
          parseAttempts++;
          return new Response('ok');
        }
        if (hostname === 'application.example.test' && path === '/synthetic-write' && request.method === 'POST') {
          brandedWrites++;
          return new Response('ok');
        }
        if (hostname === 'jobs.ashbyhq.com' && path === '/synthetic-write' && request.method === 'POST') {
          ashbyWrites++;
          return new Response('ok');
        }
        if (hostname === 'example-catalog.applytojob.com' && path === '/synthetic-write' && request.method === 'POST') {
          jazzWrites++;
          return new Response('ok');
        }
        if (hostname === 'jobs.smartrecruiters.com' && path === '/synthetic-write' && request.method === 'POST') {
          smartWrites++;
          return new Response('ok');
        }
        if (path === '/synthetic-confirm' && request.method === 'POST') {
          if (hostname === 'jobs.smartrecruiters.com') smartClicks++;
          const checks = await request.json();
          if (!Array.isArray(checks) || checks.length !== (hostname === 'jobs.ashbyhq.com' ? 7 : 4) ||
              checks.some(value => value !== true)) {
            return new Response('invalid', { status: 400 });
          }
          observed++;
          return new Response('ok');
        }
        if (hostname === 'embedded.example.test' && path === '/job') {
          return html(`<!doctype html><title>Fixture Billing Associate | Embedded Board Careers</title><h1>Fixture Billing Associate</h1>
            <iframe title="Job Application Form" src="${directBrowserFixtures[0].url.replace('job-boards.greenhouse.io', 'boards.greenhouse.io')}"></iframe>`);
        }
        if (hostname === 'boards.greenhouse.io' && path === '/embed/job_app') {
          return Response.redirect(request.url.replace('boards.greenhouse.io', 'job-boards.greenhouse.io'));
        }
        if (hostname === 'job-boards.greenhouse.io' && path === '/embed/job_app') {
          return html(`<!doctype html><title>Job Application for Fixture Billing Associate at Embedded Board</title><h1>Fixture Billing Associate</h1>
            <form id="application-form">
              <label for="first_name">First Name</label><input id="first_name" required>
              <label for="last_name">Last Name</label><input id="last_name" required>
              <label for="email">Email</label><input id="email" type="email" required>
              <label for="survey">Synthetic self-ID *</label>
              <div class="select__container"><div class="select__value-container--is-multi">
                <input id="survey" role="combobox" aria-controls="survey-menu" aria-expanded="false" aria-required="true">
              </div></div>
              <div id="survey-menu" role="listbox" hidden><div role="option">Prefer not to answer</div><div role="option">Another option</div></div>
              <label for="resume">Resume/CV</label><input id="resume" type="file" required>
              <button type="submit">Submit application</button>
            </form><script>
              const combo = document.querySelector('#survey'), menu = document.querySelector('#survey-menu');
              const open = () => { menu.hidden=false; combo.setAttribute('aria-expanded','true'); };
              combo.addEventListener('input', open);
              combo.addEventListener('keydown', event => { if (event.key === 'ArrowDown') open(); });
              for (const option of menu.children) option.addEventListener('click', () => {
                const chip = document.createElement('span');
                chip.className = 'select__multi-value__label'; chip.textContent = option.textContent;
                combo.parentElement.append(chip); combo.value=''; menu.hidden=true; combo.setAttribute('aria-expanded','false');
              });
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const selected = [...document.querySelectorAll('.select__multi-value__label')].map(e=>e.textContent);
                const checks = [document.querySelector('#first_name').value === 'Private' && document.querySelector('#last_name').value === 'Person',
                  document.querySelector('#email').value === 'private-person@example.test',
                  selected.length === 1 && selected[0] === 'Prefer not to answer',
                  document.querySelector('#resume').files[0]?.name === 'synthetic.pdf'];
                const receipt = await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
                if (receipt.ok) document.body.innerHTML = '<h1>Application submitted!</h1>';
              });
            </script>`);
        }
        if (hostname === 'www.careers-page.com' && path === '/fixture-office/job/FA000001/apply') {
          return html(`<!doctype html><title>Fixture Accounts Associate - Example Office | Career Page</title>
            <h1>Fixture Accounts Associate</h1><form>
              <div class="form-group"><label>Full Name: *</label><div><input id="field900002" name="900002"></div></div>
              <div class="form-group"><label>Email: *</label><div><input id="field900004" name="900004"></div></div>
              <div class="form-group"><label>Phone: *</label><div><input id="field900006" name="900006"></div></div>
              <div class="form-group"><label>Cover Letter:</label><textarea id="field910001" name="1468273"></textarea></div>
              <div class="form-group"><label>Resume: *</label><div><input id="field910002" class="custom-file-input" type="file" name="1468274"></div></div>
              <div><input type="checkbox" name="terms_and_condition"><span>I agree to the <a href="/fixture-office/terms-and-conditions">terms and conditions</a> &amp;
                <a href="/fixture-office/privacy-policy">privacy policy</a></span></div>
              <button id="submit-id-submit" type="submit" name="submit">Apply</button>
            </form><script>
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const checks = [document.querySelector('#field900002').value === 'Private Person',
                  document.querySelector('#field900004').value === 'private-person@example.test' && document.querySelector('#field900006').value === '5550100',
                  document.querySelector('[name=terms_and_condition]').checked && document.querySelector('#field910001').value === '',
                  document.querySelector('#field910002').files[0]?.name === 'synthetic.pdf'];
                const receipt = await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
                if (receipt.ok) document.body.innerHTML = '<div class="text-center"><p class="font-weight-bold">Thank you for your application!</p><p class="font-weight-bold">Your application was successfully submitted.</p></div>';
              });
            </script>`);
        }
        if (hostname === 'apply.workable.com' && path === '/fixture-studio/j/FIXTURE001/apply/') {
          return html(`<!doctype html><title>Fixture Support Associate - Example Studio - Application</title>
            <div data-ui="job-title">Fixture Support Associate</div>
            <div role="dialog" data-ui="cookie-consent" aria-label="Cookie Consent">
              <button data-ui="cookie-consent-settings">Cookies settings</button>
              <button data-ui="cookie-consent-accept">Accept all</button>
              <button data-ui="cookie-consent-decline">Decline all</button>
            </div>
            <form data-ui="application-form">
              <label for="firstname">*First name</label><input id="firstname" name="firstname" type="text" data-ui="firstname" required>
              <label for="lastname">*Last name</label><input id="lastname" name="lastname" type="text" data-ui="lastname" required>
              <label for="email">*Email</label><input id="email" name="email" data-ui="email" type="email" required>
              <span id="radio-label">*Have you used a sample ticket queue?</span>
              <fieldset role="radiogroup" aria-labelledby="radio-label" aria-required="true" data-ui="QA_700001">
                <div role="radio" data-ui="option"><input type="radio" id="option-a" name="QA_700001" aria-hidden="true" required>YES</div>
                <div role="radio" data-ui="option"><input type="radio" id="option-b" name="QA_700001" aria-hidden="true" required>NO</div>
              </fieldset>
              <label for="QA_700013">*${workableLongPrompt}</label><textarea id="QA_700013" name="QA_700013" required></textarea>
              <label for="resume-test">*Resume</label><input id="resume-test" type="file" data-ui="resume" required>
              <button data-ui="apply-button" type="submit">Submit application</button>
            </form><script>
              let declined = false;
              document.querySelector('[data-ui=cookie-consent-decline]').addEventListener('click', event => {
                declined = true; document.cookie = 'workable_preference=declined; SameSite=Lax';
                event.target.closest('[role=dialog]').remove();
              });
              for (const option of document.querySelectorAll('[role=radio]')) {
                option.addEventListener('click', () => { option.querySelector('input').checked = true; });
              }
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const checks = [document.querySelector('#firstname').value === 'Private' &&
                  document.querySelector('#lastname').value === 'Person' && document.querySelector('#email').value === 'private-person@example.test',
                  declined && document.cookie.includes('workable_preference=declined') &&
                  document.querySelector('#option-a').checked && !document.querySelector('#option-b').checked,
                  document.querySelector('#QA_700013').value === 'Synthetic answer.',
                  document.querySelector('#resume-test').files[0]?.name === 'synthetic.pdf'];
                const receipt = await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
                if (receipt.ok) {
                  history.replaceState(null, '', '/fixture-studio/j/FIXTURE001/unknown-finish');
                  document.body.innerHTML = '<h1>Application submitted</h1>';
                }
              });
            </script>`);
        }
        if (hostname === 'board.example.test' && path === new URL(ripplingWork.sourceUrl).pathname) {
          return html('<title>Fixture Migration Engineer – Remote · Canada | Example Data</title><h1>Fixture Migration Engineer</h1><a href="/fixture-organization">Example Data</a>');
        }
        if (hostname === 'ats.rippling.com' && path === ripplingPath) {
          return html('<title>Fixture Migration Engineer</title><h1>Fixture Migration Engineer</h1><button data-testid="Apply now">Apply now</button>');
        }
        if (hostname === 'ats.rippling.com' && path === ripplingPath + '/apply') {
          const query = new URL(request.url).searchParams;
          if (query.size !== 3 || query.get('jobBoardSlug') !== 'fixture-organization' ||
              query.get('jobId') !== ripplingPath.split('/').at(-1) || query.get('step') !== 'application') {
            return new Response('wrong application', { status: 404 });
          }
          return html(`<!doctype html><title>Apply - Fixture Migration Engineer</title>
            <main id="main-content"><h1>Application: Fixture Migration Engineer</h1><form>
              <div data-testid="field"><span id="resume-label">Résumé</span>
                <label data-testid="resume"><input type="file" data-testid="input-resume" hidden></label></div>
              <label id="first-label">First name</label>
              <input name="random-1" data-testid="input-first_name" data-input="first_name" aria-labelledby="first-label" aria-required="true">
              <label id="last-label">Last name</label>
              <input name="random-2" data-testid="input-last_name" data-input="last_name" aria-labelledby="last-label" aria-required="true">
              <label id="email-label">Email</label>
              <input name="random-3" data-testid="input-email" data-input="email" aria-labelledby="email-label" aria-required="true">
              <label id="phone-label">Phone number</label>
              <div data-testid="phone_number-code"><input role="combobox" data-testid="input-select-search-input"
                aria-expanded="false" aria-required="true" value="+1 US"></div>
              <ul id="dial-list" role="listbox" data-testid="menuList" hidden>
                <li role="option">+1 US - United States</li><li role="option">+1&nbsp;CA&nbsp;-&nbsp;Canada</li></ul>
              <input name="random-4" data-testid="input-phone_number" data-input="phone_number" aria-labelledby="phone-label" aria-required="true" inputmode="tel">
              <label id="loc-label">Location</label>
              <div data-testid="location"><input name="random-5" data-testid="input-undefined"
                aria-autocomplete="list" aria-labelledby="loc-label" aria-required="true">
                <input type="hidden" data-testid="input-externalPlaceId" data-input="externalPlaceId"></div>
              <ul id="loc-list" role="listbox" data-testid="menuList" hidden><li role="option">Synthetic City, CA</li></ul>
              <label id="company-label">Current company</label>
              <input data-testid="input-current_company" data-input="current_company" aria-labelledby="company-label">
              <div data-testid="sms_opt_in" role="radiogroup">
                <div data-testid="radio-label-sms_opt_in" role="radio" data-value="true" aria-checked="false">
                  <input name="random-6" type="radio" data-testid="radio-sms_opt_in">Yes - I consent to receiving text messages</div>
                <div data-testid="radio-label-sms_opt_in" role="radio" data-value="false" aria-checked="false">
                  <input name="random-6" type="radio" data-testid="radio-sms_opt_in">${smsNo}</div></div>
              <p>By clicking "Apply" you agree to Rippling's <a href="https://app.rippling.com/legal/user">Terms of Service</a>
                and <a href="https://app.rippling.com/legal/privacy">User Privacy Notice</a>.</p>
              <button type="submit" data-testid="Apply" data-disabled="true" aria-disabled="true">Apply</button>
            </form></main><script>
              const testid = id => document.querySelector('[data-testid="' + id + '"]');
              const first = testid('input-first_name'), last = testid('input-last_name'), email = testid('input-email');
              const phone = testid('input-phone_number'), company = testid('input-current_company');
              const file = testid('input-resume'), submit = testid('Apply');
              const place = testid('input-externalPlaceId'), locationField = testid('input-undefined');
              const dial = testid('input-select-search-input');
              let parsed = false, cleanBeforeParse = false;
              file.addEventListener('change', async () => {
                cleanBeforeParse = !first.value && !last.value && !email.value && !phone.value;
                const warning = document.createElement('div');
                warning.textContent = 'Parsing the résumé. This might take a few seconds.';
                document.body.append(warning);
                await fetch('/synthetic-parse', {method:'POST'});
                first.value = 'Parsed'; last.value = 'Wrong'; email.value = 'wrong@example.test'; company.value = 'Parsed Employer';
                parsed = true;
                warning.textContent = 'Résumé parsing was successful.';
              });
              const options = (input, list, openWithArrow, choose) => {
                const open = () => {
                  list.hidden = false; input.setAttribute('aria-controls', list.id);
                  if (openWithArrow) input.setAttribute('aria-expanded', 'true');
                };
                const close = () => {
                  list.hidden = true; input.removeAttribute('aria-controls');
                  if (openWithArrow) input.setAttribute('aria-expanded', 'false');
                };
                input.addEventListener('input', open);
                input.addEventListener('keydown', event => {
                  if (event.key === 'ArrowDown' && openWithArrow) open();
                  if (event.key === 'Escape') close();
                });
                for (const option of list.children) option.addEventListener('click', () => {
                  choose(option.textContent.trim()); close();
                });
              };
              options(dial, document.querySelector('#dial-list'), true, label => dial.value = label.split('-')[0].trim());
              options(locationField, document.querySelector('#loc-list'), false, label => {
                locationField.value = label; place.value = 'synthetic-place-id';
              });
              const radios = [...document.querySelectorAll('[data-testid=radio-label-sms_opt_in]')];
              for (const radio of radios) radio.addEventListener('click', () => {
                for (const option of radios) {
                  option.querySelector('input').checked = option === radio;
                  option.setAttribute('aria-checked', String(option === radio));
                }
                submit.removeAttribute('data-disabled'); submit.removeAttribute('aria-disabled');
              });
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const checks = [parsed && cleanBeforeParse && file.files[0]?.name === 'synthetic.pdf',
                  first.value === 'Private' && last.value === 'Person' && email.value === 'private-person@example.test' && !company.value,
                  phone.value === '9025550100' && dial.value.replace(/\\s+/g, ' ') === '+1 CA' &&
                    locationField.value === 'Synthetic City, CA' && place.value === 'synthetic-place-id',
                  radios[1].querySelector('input').checked && radios[1].getAttribute('aria-checked') === 'true' &&
                    !radios[0].querySelector('input').checked];
                const receipt = await fetch('/synthetic-confirm', {method:'POST',body:JSON.stringify(checks)});
                if (receipt.ok) {
                  const query = new URLSearchParams(location.search);
                  query.set('step', 'confirmation');
                  history.replaceState(null, '', '${ripplingPath}/${exactRipplingReceipt ? 'apply' : 'unknown-receipt'}?' + query);
                  document.querySelector('main').innerHTML = '<h1>You have successfully applied to Fixture Migration Engineer</h1>';
                }
              });
            </script>`);
        }
        if (hostname === 'example-catalog.applytojob.com' && path === jazzPath) {
          return html(`<!doctype html><title>${jazzWork.role} - Example Catalog - Career Page</title>
            <h1>${jazzWork.role}</h1><form id="form_submit_new_resume" method="post" enctype="multipart/form-data">
              <label for="resumator-firstname-value">First Name*</label><input id="resumator-firstname-value" name="resumator-firstname-value" type="text">
              <label for="resumator-lastname-value">Last Name*</label><input id="resumator-lastname-value" name="resumator-lastname-value" type="text">
              <label for="resumator-email-value">Email Address*</label><input id="resumator-email-value" name="resumator-email-value" type="email">
              <label for="resumator-phone-value">Phone*</label><input id="resumator-phone-value" name="resumator-phone-value" type="tel">
              <label for="resumator-resume-value">Resume*</label><input hidden id="resumator-resume-value" name="resumator-resume-value" type="file">
              ${jazzQuestions.map((label, i) => `<label for="resumator-questionnaire-q${799998+i}">${label}*</label>
              <textarea id="resumator-questionnaire-q${799998+i}" name="resumator-questionnaire[${799998+i}]"></textarea>`).join('')}
              <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" style="height:78px;border:0"></iframe>
              <textarea hidden id="g-recaptcha-response" name="g-recaptcha-response">${jazzVerified ? 'synthetic-verified' : ''}</textarea>
              <div id="resumator-submit"><a href="#" id="resumator-submit-resume">Submit Application</a></div>
            </form><script>
              const form = document.querySelector('form');
              form.addEventListener('input', () => fetch('/synthetic-write',{method:'POST'}), {once:true});
              document.querySelector('#resumator-submit-resume').addEventListener('click', async event => {
                event.preventDefault();
                const data = new FormData(form);
                const checks = [data.get('resumator-firstname-value') === 'Private' && data.get('resumator-lastname-value') === 'Person',
                  data.get('resumator-email-value') === 'private-person@example.test' && data.get('resumator-phone-value') === '5550100',
                  [...form.querySelectorAll('textarea[id^=resumator-questionnaire]')].every(e => e.value === 'Synthetic answer'),
                  data.get('resumator-resume-value')?.name === 'synthetic.pdf' && Boolean(data.get('g-recaptcha-response'))];
                await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
                document.body.innerHTML = '<h1>Application submitted</h1>';
              });
            </script>`);
        }
        if (hostname === 'contact.example.test' && path === taleoPath) {
          return html(`<!doctype html><title>${taleoWork.role} Job in Montreal at Example Contact</title><h1>${taleoWork.role}</h1>
            <a href="https://example-contact.taleo.net/careersection/17/jobapply.ftl?job=FX001">Apply now</a>`);
        }
        if (hostname === 'example-contact.taleo.net' && path === '/careersection/99/jobapply.ftl' && new URL(request.url).search === '?job=FX001') {
          return html(`<!doctype html><title>Privacy Agreement</title><h1>Privacy Agreement</h1>
            <form id="dialogTemplate-dialogForm" method="post" action="/careersection/fixture/statement.jsf">
              <p>I acknowledge Example Contact's Website Privacy Policy.</p>
              <input id="dialogTemplate-dialogForm-StatementBeforeAuthentificationContent-ContinueButton" type="button" value="I Accept">
              <input id="dialogTemplate-dialogForm-StatementBeforeAuthentificationContent-CancelButton" type="button" value="I Decline">
            </form>`);
        }
        if (hostname === 'jobs.smartrecruiters.com' && path === smartPath) {
          return html(`<!doctype html><title>${smartRecruitersFixture.listingTitle}</title><h1>${smartWork.role}</h1>
            <a href="${smartUrl}">I'm interested</a>`);
        }
        if (hostname === 'jobs.smartrecruiters.com' && path === smartApply.pathname && new URL(request.url).search === smartApply.search) {
          return html(`<!doctype html><title>${smartRecruitersFixture.applicationTitle}</title>
            <oc-app-root><h1>${smartWork.role}</h1><oc-oneclick-form>
              <spl-input id="first-name-input"></spl-input><spl-input id="last-name-input"></spl-input>
              <spl-input id="email-input"></spl-input><spl-input id="confirm-email-input"></spl-input>
              <oc-location-autocomplete><spl-autocomplete data-test="location-autocomplete" required></spl-autocomplete></oc-location-autocomplete>
              <oc-phone-number><spl-phone-field required></spl-phone-field></oc-phone-number>
              <oc-resume-upload><spl-dropzone data-test="resume-upload"></spl-dropzone></oc-resume-upload>
              <oc-no-policy-decision><spl-checkbox id="noPolicy" required>${smartNotice}</spl-checkbox></oc-no-policy-decision>
              <oc-nav-first-page><footer data-test="footer"><oc-button data-test="footer-submit"><spl-button></spl-button></oc-button></footer></oc-nav-first-page>
            </oc-oneclick-form></oc-app-root><script>
              const form = document.querySelector('oc-oneclick-form');
              const shadow = (host, markup) => { const r = host.attachShadow({mode:'open'}); r.innerHTML=markup; return r; };
              const input = (host,id,type,label,attrs='') => shadow(host, '<label for="' + id + '">' + label +
                '*</label><input required id="' + id + '" type="' + type + '" ' + attrs + '>').querySelector('input');
              const standard = [['first-name-input','text','First name'],['last-name-input','text','Last name'],
                ['email-input','email','Email'],['confirm-email-input','email','Confirm your email']]
                .map(([id,type,label]) => input(document.getElementById(id),id,type,label));
              const city = form.querySelector('spl-autocomplete');
              const cityRoot = shadow(city, '<spl-input required></spl-input><div role="listbox" data-sr-id="location-autocomplete-search-menu" hidden>' +
                '<div role="option">Synthetic City, CA</div></div>');
              const cityInput = input(cityRoot.querySelector('spl-input'),'synthetic-city','text','City','role="combobox" aria-expanded="false"');
              const cityMenu = cityRoot.querySelector('[role=listbox]');
              cityInput.addEventListener('input', () => { cityMenu.hidden = false; cityInput.setAttribute('aria-expanded','true'); });
              cityMenu.firstElementChild.addEventListener('click', () => {
                city.value = { label:'Synthetic City, CA' };
                cityInput.value = city.value.label;
                cityMenu.hidden = true;
                cityInput.setAttribute('aria-expanded','false');
              });
              const phone = shadow(form.querySelector('spl-phone-field'), '<spl-select splarialabel="Country code">' +
                '<spl-select-option value="CA" hidden>Canada +1</spl-select-option><spl-select-option value="US" hidden>United States +1</spl-select-option>' +
                '</spl-select><spl-input class="c-spl-phone-field-input" type="tel"></spl-input>');
              const phoneInput = input(phone.querySelector('spl-input'),'synthetic-phone','tel','Phone number');
              const dial = phone.querySelector('spl-select'), options = [...dial.querySelectorAll('spl-select-option')];
              const dialButton = shadow(dial,'<button role="combobox">Country code</button><slot></slot>').querySelector('button');
              options[1].selected = true;
              dialButton.addEventListener('click', () => { for (const option of options) option.hidden = false; });
              for (const option of options) option.addEventListener('click', () => {
                for (const other of options) { other.selected = other === option; other.hidden = true; }
              });
              const file = shadow(form.querySelector('spl-dropzone'),'<input type="file" accept=".pdf">').querySelector('input');
              const consent = shadow(form.querySelector('spl-checkbox'),'<slot></slot><input id="noPolicy" type="checkbox" aria-required="true">').querySelector('input');
              const submit = shadow(form.querySelector('spl-button'),'<button type="button">Submit</button>').querySelector('button');
              form.addEventListener('input', () => fetch('/synthetic-write',{method:'POST'}), {once:true});
              submit.addEventListener('click', async () => {
                const checks = [standard[0].value === 'Private' && standard[1].value === 'Person',
                  standard[2].value === 'private-person@example.test' && standard[3].value === standard[2].value,
                  city.value?.label === 'Synthetic City, CA' && phoneInput.value === '9025550100' && options[0].selected,
                  consent.checked && file.files[0]?.name === 'synthetic.pdf'];
                await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
              });
            </script>`);
        }
        if (hostname === 'application.example.test' && path === brandedPath) {
          const select = (name: string, label: string, choices: string[]) => `<label><span>${label} *</span>
            <select name="${name}" required><option value="" disabled selected>Select</option>
              ${choices.map(choice => `<option>${choice}</option>`).join('')}</select></label>`;
          return html(`<!doctype html><html lang="en-CA"><head><title>Fixture Service Associate | Example Services</title>
            <link rel="alternate" hreflang="en-CA" href="${brandedKey}">
            <link rel="alternate" hreflang="fr-CA" href="${brandedWork.sourceUrl}"></head>
            <body><main id="fixture-main"><h1>Fixture Service Associate</h1><section id="fixture-apply"><form novalidate>
              <label><span>First name *</span><input name="firstName" type="text" required></label>
              <label><span>Last name *</span><input name="lastName" type="text" required></label>
              <label><span>Email *</span><input name="email" type="email" required></label>
              <label><span>Phone *</span><input name="phone" type="tel" required></label>
              <label><span>City *</span><input name="city" type="text" required></label>
              ${select('province', 'Province', ['Ontario', 'Quebec', 'Alberta', 'British Columbia', 'Other'])}
              ${select('workAuthorization', 'Work authorization in Canada', ['Canadian citizen', 'Permanent resident', 'Work permit', 'Open work permit', 'Need sponsorship'])}
              ${select('yearsExperience', 'Years of experience', ['Entry level', '1 to 3 years', '3 to 6 years', '6 years or more', 'Leadership'])}
              ${select('englishLevel', 'English level', ['Native', 'C2', 'C1', 'B2', 'B1', 'A2', 'A1', 'None'])}
              ${select('frenchLevel', 'French level', ['Native', 'C2', 'C1', 'B2', 'B1', 'A2', 'A1', 'None'])}
              ${select('workModePreference', 'Preferred work mode', ['Onsite', 'Hybrid', 'Remote', 'Any'])}
              <div><span>Resume or CV *</span><label><span>Resume or CV</span><input id="fixture-resume" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"></label>
                <p>PDF, DOC, DOCX, JPG or PNG, up to 4 MB.</p></div>
              <label>Cover note (optional)<textarea name="coverNote"></textarea></label>
              <label><input name="consent" type="checkbox" value="true" required><span>${brandedConsent}</span></label>
              <label><input name="talentOptIn" type="checkbox" value="true"><span>${brandedTalent}</span></label>
              <div aria-label="Fixture verification"><input type="hidden" name="fixture-verification-response" value="${verifiedBranded ? 'synthetic-verified' : ''}"></div>
              <button type="submit">Submit application</button>
            </form></section></main><script>
              const form = document.querySelector('form');
              form.addEventListener('input', () => fetch('/synthetic-write',{method:'POST'}), {once:true});
              form.addEventListener('submit', async event => {
                event.preventDefault();
                const data = new FormData(form), cv = document.querySelector('#fixture-resume').files[0];
                const checks = [data.get('firstName') === 'Private' && data.get('lastName') === 'Person' &&
                    data.get('email') === 'private-person@example.test' && data.get('phone') === '5550100',
                  data.get('city') === 'Synthetic City' && data.get('province') === 'Ontario' && data.get('workAuthorization') === 'Work permit' &&
                    data.get('yearsExperience') === '1 to 3 years' && data.get('englishLevel') === 'C1' && data.get('frenchLevel') === 'None' &&
                    data.get('workModePreference') === 'Remote',
                  data.get('consent') === 'true' && !data.has('talentOptIn') && !data.get('coverNote'),
                  cv?.name === 'synthetic.pdf' && cv.size < 4194304 && Boolean(data.get('fixture-verification-response'))];
                const receipt = await fetch('/synthetic-confirm',{method:'POST',body:JSON.stringify(checks)});
                if (receipt.ok) form.outerHTML = '<div><h3>Fixture receipt</h3><p>Receipt number: QS-TEST-001. Your fixture is complete.</p></div>';
              });
            </script></body></html>`);
        }
        if (path === posting + '/apply' && hostname === 'jobs.lever.co') {
          return new Response(`<!doctype html><title>Example - Engineer</title><h2>Engineer</h2>
            <form id="application-form" method="post">
              <label>Name <input name="name" required></label>
              <label>Email <input name="email" required type="email"></label>
              <li class="application-question custom-question"><div>
                <div class="application-label">Application source ✱</div>
                <div class="application-field"><input name="cards[example][field0]" required></div>
              </div></li>
              <label>Resume/CV <input id="resume-upload-input" type="file" required></label>
              <button hidden id="hcaptchaSubmitBtn" type="submit"></button>
              <button type="submit">Submit application</button>
            </form><script>
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const checks = [document.querySelector('[name=name]').value === 'Private Person',
                  document.querySelector('[name=email]').value === 'private-person@example.test',
                  document.querySelector('.application-field input').value === 'Synthetic source',
                  document.querySelector('#resume-upload-input').files[0]?.name === 'synthetic.pdf'];
                const receipt = await fetch('/synthetic-confirm', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(checks)});
                if (receipt.ok) { history.replaceState(null, '', location.pathname.replace(/apply$/, 'thanks'));
                  document.body.innerHTML = '<h1>Application submitted!</h1>'; }
              });
            </script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (path !== ashbyPath + '/application') return new Response('missing', { status: 404 });
        return new Response(`<!doctype html><title>Engineer @ Example</title><h1>Engineer</h1>
          <div id="form" role="tabpanel"><input type="file"><button type="submit">Upload file</button>
          <div class="ashby-application-form-container">
          <label for="_systemfield_name">${ashbyNameLabel}</label><input id="_systemfield_name" required>
          <label for="_systemfield_email">Email</label><input id="_systemfield_email" required type="email">
          <label for="website">Website</label><input id="website" type="url">
          <label for="screen">Local screening?</label><select id="screen" required>
            <option value="">Choose</option><option value="y">Yes</option><option value="n">No</option></select>
          <label for="region">Region</label><input id="region" role="combobox" aria-autocomplete="list"
            aria-controls="choices" aria-expanded="false" aria-required="true">
          <div id="choices" role="listbox" hidden><div role="option" id="choice">Atlantic</div></div>
          <fieldset id="skills[]" class="checkbox" aria-required="true"><legend>Languages *</legend>
            <input type="checkbox" id="skill-a" name="skills[]" required><label for="skill-a">French</label>
            <input type="checkbox" id="skill-b" name="skills[]" required><label for="skill-b">English</label></fieldset>
          <label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" type="file" required>
          </div>
          ${ashbySurvey === 'duplicate' ? '<div class="ashby-application-form-container"></div>' : ''}
          <div class="ashby-survey-form-container"><div class="ashby-application-form-container">
            <fieldset><legend>Optional demographic survey</legend>
              <label>Option A<input type="radio" name="survey" ${ashbySurvey === 'required' ? 'required' : ''}></label>
              <label>Option B<input type="radio" name="survey"></label>
            </fieldset>
          </div></div>
          <button class="ashby-application-form-submit-button">Submit Application</button></div>
          <script>
            document.querySelector('#form').addEventListener('input', () => fetch('/synthetic-write',{method:'POST'}), {once:true});
            const field = document.querySelector('#region'), choices = document.querySelector('#choices');
            const openChoices = () => { choices.hidden = false; field.setAttribute('aria-expanded','true'); };
            field.addEventListener('input', openChoices);
            field.addEventListener('keydown', event => {
              if (event.key === 'ArrowDown') openChoices();
              if (event.key === 'Escape') { choices.hidden = true; field.setAttribute('aria-expanded','false'); }
            });
            document.querySelector('#choice').addEventListener('click', () => {
              field.value='Atlantic'; choices.hidden=true; field.setAttribute('aria-expanded','false'); field.setAttribute('aria-valuetext','Atlantic');
            });
            let nativeChanged = false;
            document.querySelector('#screen').addEventListener('change', () => { nativeChanged = true; });
            document.getElementById('skills[]').addEventListener('change', event => {
              const options = [...event.currentTarget.querySelectorAll('input')];
              const required = !options.some(option => option.checked);
              for (const option of options) option.required = required;
            });
            document.querySelector('.ashby-application-form-submit-button').addEventListener('click', async event => {
              event.preventDefault();
              const checks = [document.querySelector('#_systemfield_name').value === 'Private Person',
                document.querySelector('#_systemfield_email').value === 'private-person@example.test',
                nativeChanged && document.querySelector('#screen').value === 'y', field.getAttribute('aria-valuetext') === 'Atlantic',
                document.querySelector('#_systemfield_resume').files[0]?.name === 'synthetic.pdf',
                document.querySelector('#website').value === '' && !document.querySelector('.ashby-survey-form-container input:checked'),
                document.querySelector('#skill-a').checked && !document.querySelector('#skill-b').checked];
              const receipt = await fetch('/synthetic-confirm', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(checks)});
              if (receipt.ok) document.body.innerHTML = '<h1>Your application was successfully submitted</h1>';
            });
          </script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
    const chromePath = process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    // Every other hostname is unresolvable. The ATS hostname resolves only to this test's server.
    const chrome = Bun.spawn([chromePath, '--headless=new', '--disable-background-networking', '--no-first-run',
      '--no-proxy-server', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${join(root, 'chrome')}`, `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=${['jobs.ashbyhq.com','jobs.lever.co','embedded.example.test','boards.greenhouse.io','job-boards.greenhouse.io','www.careers-page.com','apply.workable.com','board.example.test','ats.rippling.com','application.example.test','example-catalog.applytojob.com','contact.example.test','example-contact.taleo.net','jobs.smartrecruiters.com']
        .map(host => `MAP ${host} 127.0.0.1:${server.port}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE localhost`,
      'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      let port = '';
      for (let i = 0; i < 50 && !port; i++) {
        const activePort = await readFile(join(root, 'chrome/DevToolsActivePort'), 'utf8').catch(() => '');
        [port] = activePort.split('\n');
        if (!port) await Bun.sleep(100);
      }
      expect(port).toMatch(/^\d+$/);
      const privateConfigPath = join(root, 'private.json'), pdfPath = join(root, 'synthetic.pdf');
      await writeFile(pdfPath, '%PDF-1.4\n');
      const profile = {
        personal: { firstName: 'Private', lastName: 'Person', email: 'private-person@example.test', phone: '5550100', region: 'Atlantic', website: '' },
        fieldMaps: { [ashbyWork.sourceUrl]: [{ id: 'region', label: 'Region', key: 'region' }] },
        answers: {
          [ashbyWork.sourceUrl]: { 'Local screening?': { type: 'option', value: 'Yes' },
            Languages: { type: 'options', value: ['French'] } },
          [`https://jobs.lever.co${posting}`]: { 'Application source': { type: 'text', value: 'Synthetic source' } },
          'https://embedded.example.test/job?gh_jid=1000105': { 'Synthetic self-ID': { type: 'options', value: ['Prefer not to answer'] } },
        },
      };
      await writeFile(privateConfigPath, JSON.stringify(profile));
      const options = { browserUseCommand: liveRunner, cdpUrl: `http://127.0.0.1:${port}`, privateConfigPath, pdfPath };
      expect(await discoverForm(ashbyWork, options)).toMatchObject({ kind: 'discovered', fields: expect.arrayContaining([
        { id: 'region', label: 'Region', type: 'combobox', required: true, options: ['Atlantic'] },
        { id: 'screen', label: 'Local screening?', type: 'select', required: true, options: ['Yes', 'No'] },
        { id: 'skills[]', label: 'Languages', type: 'checkbox-group', required: true, options: ['French', 'English'] },
      ]) });
      ashbySurvey = 'required';
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      ashbySurvey = 'duplicate';
      expect(await discoverForm(ashbyWork, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(ashbyWrites).toBe(0);
      ashbySurvey = 'optional';
      ashbyNameLabel = 'Legal Name';
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(ashbyWrites).toBe(0);
      ashbyNameLabel = 'Preferred Name';
      expect(await submitApplication(ashbyWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(ashbyWrites).toBe(1);
      expect(await discoverForm(work, options)).toMatchObject({ kind: 'discovered', fields: expect.arrayContaining([
        { id: 'cards[example][field0]', label: 'Application source', type: 'text', required: true, options: [] },
      ]) });
      expect(await submitApplication(work, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_page' });
      expect(observed).toBe(2);
      expect(await discoverForm({ sourceUrl: embeddedWork.sourceUrl.replace('1000105', '8232313') }, options))
        .toEqual({ kind: 'failed', code: 'unsupported_portal' });
      expect(await discoverForm(embeddedWork, options)).toMatchObject({ kind: 'discovered', fields: expect.arrayContaining([
        { id: 'survey', label: 'Synthetic self-ID', type: 'combobox-multi', required: true, options: ['Prefer not to answer', 'Another option'] },
      ]) });
      expect(await submitApplication(embeddedWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(observed).toBe(3);
      const terms = 'I agree to the terms and conditions & privacy policy';
      expect(await discoverForm(manatalWork, options)).toMatchObject({ kind: 'discovered', fields: expect.arrayContaining([
        { id: 'field910002', label: 'Resume', type: 'file', required: true, options: [] },
        { id: 'field910001', label: 'Cover Letter', type: 'textarea', required: false, options: [] },
        { id: 'terms_and_condition', label: terms, type: 'checkbox', required: true, options: [] },
      ]) });
      expect(await submitApplication(manatalWork, options)).toMatchObject({ kind: 'failed', code: 'manual_required',
        attention: { questions: [{ id: 'terms_and_condition', label: terms, type: 'checkbox', required: true, options: [] }], variables: [] } });
      expect(observed).toBe(3);
      await writeFile(privateConfigPath, JSON.stringify({ ...profile, answers: { ...profile.answers,
        [manatalWork.sourceUrl]: { [terms]: { type: 'boolean', value: true } },
      } }));
      expect(await submitApplication(manatalWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(observed).toBe(4);
      const workableKey = workableWork.sourceUrl.slice(0, -1);
      const workableAnswers = {
        'Have you used a sample ticket queue?': { type: 'option', value: 'YES' },
        [workableLongPrompt]: { type: 'text', value: 'Synthetic answer.' },
      };
      expect(await discoverForm(workableWork, options)).toMatchObject({ kind: 'discovered', listingUrl: workableKey, fields: expect.arrayContaining([
        { id: 'QA_700001', label: 'Have you used a sample ticket queue?', type: 'radio', required: true, options: ['YES', 'NO'] },
        { id: 'QA_700013', label: workableLongPrompt, type: 'textarea', required: true, options: [] },
      ]) });
      await writeFile(privateConfigPath, JSON.stringify({ ...profile, answers: { ...profile.answers, [workableKey]: workableAnswers } }));
      expect(await submitApplication(workableWork, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(observed).toBe(5);
      expect(await discoverForm({ sourceUrl: ripplingWork.sourceUrl + '?different=true' }, options))
        .toEqual({ kind: 'failed', code: 'unsupported_portal' });
      expect(await discoverForm(ripplingWork, options)).toMatchObject({ kind: 'discovered', listingUrl: ripplingKey,
        fields: expect.arrayContaining([
          { id: 'phone_number-code', label: 'Phone country calling code', type: 'combobox', required: true, options: ['+1 US - United States', '+1 CA - Canada'] },
          { id: 'location', label: 'Location', type: 'combobox', required: true, options: [] },
          { id: 'resume', label: 'Résumé', type: 'file', required: true, options: [] },
          { id: 'rippling_terms', label: termsLabel, type: 'checkbox', required: true, options: [] },
        ]) });
      const ripplingAnswers = {
        'Phone country calling code': { type: 'option', value: '+1 CA - Canada' },
        Location: { type: 'option', value: 'Synthetic City, CA' },
      };
      const ripplingProfile = { ...profile, personal: { ...profile.personal, phone: '+1 (902) 555-0100' } };
      await writeFile(privateConfigPath, JSON.stringify({ ...ripplingProfile, answers: { [ripplingKey]: ripplingAnswers } }));
      expect(await submitApplication(ripplingWork, options)).toMatchObject({ kind: 'failed', code: 'manual_required',
        attention: { questions: expect.arrayContaining([{ id: 'rippling_terms', label: termsLabel, type: 'checkbox', required: true, options: [] },
          expect.objectContaining({ id: 'sms_opt_in', required: true })]), variables: [] } });
      expect(parseAttempts).toBe(0);
      expect(observed).toBe(5);
      await writeFile(privateConfigPath, JSON.stringify({ ...ripplingProfile, answers: { [ripplingKey]: {
        ...ripplingAnswers, [termsLabel]: { type: 'boolean', value: true },
        'Consent to receive SMS about this application': { type: 'option', value: smsNo },
      } } }));
      expect(await submitApplication(ripplingWork, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(parseAttempts).toBe(1);
      expect(observed).toBe(6);
      // A separate synthetic run exercises the known receipt path.
      exactRipplingReceipt = true;
      expect(await submitApplication(ripplingWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_page' });
      expect(parseAttempts).toBe(2);
      expect(observed).toBe(7);
      expect(await discoverForm(brandedWork, options)).toMatchObject({ kind: 'discovered', listingUrl: brandedKey,
        fields: expect.arrayContaining([
          { id: 'fixture-resume', label: 'Resume or CV', type: 'file', required: true, options: [] },
          { id: 'province', label: 'Province', type: 'select', required: true, options: ['Ontario', 'Quebec', 'Alberta', 'British Columbia', 'Other'] },
          { id: 'consent', label: brandedConsent, type: 'checkbox', required: true, options: [] },
          { id: 'talentOptIn', label: brandedTalent, type: 'checkbox', required: false, options: [] },
        ]) });
      const brandedProfile = { ...profile, personal: { ...profile.personal, city: 'Synthetic City', region: 'Ontario' } };
      const brandedAnswers = {
        'Work authorization in Canada': { type: 'option', value: 'Work permit' },
        'Years of experience': { type: 'option', value: '1 to 3 years' },
        'English level': { type: 'option', value: 'C1' },
        'French level': { type: 'option', value: 'None' },
        'Preferred work mode': { type: 'option', value: 'Remote' },
      };
      await writeFile(privateConfigPath, JSON.stringify({ ...brandedProfile, answers: { [brandedKey]: brandedAnswers } }));
      expect(await submitApplication(brandedWork, options)).toMatchObject({ kind: 'failed', code: 'manual_required',
        attention: { questions: [{ id: 'consent', label: brandedConsent, type: 'checkbox', required: true, options: [] }], variables: [] } });
      await writeFile(privateConfigPath, JSON.stringify({ ...brandedProfile, answers: {
        [brandedKey]: { ...brandedAnswers, [brandedConsent]: { type: 'boolean', value: true } },
      } }));
      expect(await submitApplication(brandedWork, options)).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(brandedWrites).toBe(0);
      expect(observed).toBe(7);
      verifiedBranded = true;
      const oversized = join(root, 'oversized.pdf');
      await writeFile(oversized, new Uint8Array(4 * 1024 * 1024 + 1));
      expect(await submitApplication(brandedWork, { ...options, pdfPath: oversized })).toEqual({ kind: 'failed', code: 'runner_unavailable' });
      expect(brandedWrites).toBe(0);
      expect(await submitApplication(brandedWork, options)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(brandedWrites).toBe(1);
      expect(observed).toBe(8);
      const jazzGate = { kind: 'human_verification', url: jazzWork.sourceUrl };
      expect(await discoverForm(jazzWork, options)).toMatchObject({ kind: 'discovered', gate: jazzGate, fields: expect.arrayContaining([
        { id: 'resumator-resume-value', label: 'Resume', type: 'file', required: true, options: [] },
        { id: 'resumator-questionnaire-q800001', label: jazzQuestions[3], type: 'textarea', required: true, options: [] },
      ]) });
      const jazzAnswers = Object.fromEntries(jazzQuestions.map(label => [label, { type: 'text', value: 'Synthetic answer' }]));
      await writeFile(privateConfigPath, JSON.stringify({ ...profile, answers: { [jazzWork.sourceUrl]: jazzAnswers } }));
      expect(await submitApplication(jazzWork, options)).toMatchObject({ kind: 'failed', code: 'manual_required', gate: jazzGate });
      expect(jazzWrites).toBe(0);
      jazzVerified = true;
      expect(await submitApplication(jazzWork, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(jazzWrites).toBe(1);
      expect(observed).toBe(9);
      expect(await discoverForm(taleoWork, options)).toEqual({ kind: 'failed', code: 'manual_required', gate: taleoGate });
      expect(await submitApplication(taleoWork, { ...options, privateConfigPath: join(root, 'missing.json') }))
        .toMatchObject({ kind: 'failed', code: 'manual_required', gate: taleoGate });
      const smartGate = { kind: 'privacy_agreement', url: smartUrl };
      expect(await discoverForm(smartWork, options)).toMatchObject({ kind: 'discovered', listingUrl: smartWork.sourceUrl, gate: smartGate });
      const smartProfile = { ...profile, personal: { ...profile.personal, country: 'Canada', phone: '+1 (902) 555-0100' } };
      const smartAnswers = { City: { type: 'option', value: 'Synthetic City, CA' } };
      let smartSubmitChecks = 0;
      const checkSmartSubmit = async () => {
        smartSubmitChecks++;
        expect(smartClicks).toBe(0);
      };
      await writeFile(privateConfigPath, JSON.stringify({ ...smartProfile, answers: { [smartWork.sourceUrl]: smartAnswers } }));
      expect(await submitApplication(smartWork, { ...options, beforeSubmit: checkSmartSubmit }))
        .toMatchObject({ kind: 'failed', code: 'manual_required', gate: smartGate });
      expect(smartSubmitChecks).toBe(0);
      expect(smartWrites).toBe(0);
      await writeFile(privateConfigPath, JSON.stringify({ ...smartProfile, answers: {
        [smartWork.sourceUrl]: { ...smartAnswers, [smartNotice]: { type: 'boolean', value: true } },
      } }));
      expect(await submitApplication(smartWork, { ...options, beforeSubmit: async () => {
        await checkSmartSubmit();
        throw new Error('synthetic gate rejection');
      } })).toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(smartSubmitChecks).toBe(1);
      expect(smartWrites).toBe(1);
      expect(smartClicks).toBe(0);
      expect(await submitApplication(smartWork, { ...options, beforeSubmit: checkSmartSubmit }))
        .toEqual({ kind: 'failed', code: 'submission_uncertain' });
      expect(smartSubmitChecks).toBe(2);
      expect(smartWrites).toBe(2);
      expect(smartClicks).toBe(1);
      expect(observed).toBe(10);
    } finally {
      chrome.kill();
      await chrome.exited;
      await server.stop(true);
    }
  } finally {
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
