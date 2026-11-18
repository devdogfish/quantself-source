import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountTabProgram, accountTargetFor, checkAccountPortal, createPreparedDjinniAccount, createPreparedWorkdayAccount,
  createPreparedReviewedWorkdayAccount, prepareDjinniSignup, prepareWorkdaySignup, signInWorkdayAccount,
  verifyReviewedWorkdayAccountLink, withAccountBrowser } from './browser-accounts';
import { accountFixtures } from './browser-accounts.fixture';
import { indeedFixture } from './browser-indeed.fixture';
import { discoverForm, submitApplication } from './browser';
import { writeLocal } from './config';
import { continuationRequirements, listingRequirements } from './private-fields';

const standardWorkday = { company: 'Example Technology', role: 'Fixture Engineer',
  sourceUrl: 'https://standard.wd1.myworkdayjobs.com/1/job/standard-example-3/Fixture-Opening_R000001' };
const indeed = { company: indeedFixture.company, role: indeedFixture.role, sourceUrl: indeedFixture.listing };
const reviewedWorkday = { company: 'Example Services', role: 'Fixture Analyst',
  sourceUrl: 'https://reviewed.wd1.myworkdayjobs.com/reviewed-example-1/job/reviewed-example-3/Fixture-Opening_R000001' };
const djinni = { company: 'Example Board', role: 'Fixture Operator', sourceUrl: 'https://djinni.co/jobs/000001-fixture-opening/' };

const previousAccountHome = process.env.QUANTSELF_JOBS_HOME;
let fixtureAccountHome: string;
beforeAll(async () => {
  fixtureAccountHome = await mkdtemp(join(tmpdir(), 'qs-account-config-'));
  process.env.QUANTSELF_JOBS_HOME = fixtureAccountHome;
  await writeFile(join(fixtureAccountHome, 'account-targets.json'), JSON.stringify(accountFixtures), { mode: 0o600 });
});
afterAll(async () => {
  if (previousAccountHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
  else process.env.QUANTSELF_JOBS_HOME = previousAccountHome;
  await rm(fixtureAccountHome, { recursive: true, force: true });
});

test('a Workday claim refuses before opening the browser if its snapshot email differs from its Application Address', async () => {
  const root = await mkdtemp('/tmp/qs-workday-identity-');
  try {
    const privateConfigPath = join(root, 'private.json');
    await writeFile(privateConfigPath, JSON.stringify({ personal: { email: 'admin@luigigirke.com' } }));
    const work = { ...standardWorkday, kind: 'submit' as const, applicationAddress: 'luigi.k7mq@luigigirke.com' };
    expect(await submitApplication(work, { cdpUrl: 'http://127.0.0.1:1', pdfPath: '/unused.pdf', privateConfigPath }))
      .toMatchObject({ kind: 'failed', code: 'manual_required', gate: { kind: 'authentication' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('account routes bind the exact posting, employer and role', async () => {
  expect(accountTargetFor(standardWorkday.sourceUrl + '/')?.portal).toBe('workday');
  for (const source of [standardWorkday.sourceUrl + '?other=1', standardWorkday.sourceUrl + '#injected',
    standardWorkday.sourceUrl + '-mismatch', standardWorkday.sourceUrl.replace('standard.wd1', 'lookalike.wd1'),
    indeed.sourceUrl + '&jk=00000000000000a1']) expect(accountTargetFor(source)).toBeUndefined();
  expect(await checkAccountPortal({ ...standardWorkday, role: 'Another job' }, {})).toEqual({ state: 'identity_mismatch' });
  expect(await checkAccountPortal(standardWorkday, {})).toEqual({ state: 'runner_unavailable' });
  expect(await checkAccountPortal(indeed, {})).toEqual({ state: 'unsupported_portal' });
  expect(accountTargetFor('https://careers.example.test/jobs/unverified-opening')).toBeUndefined();
  expect(await checkAccountPortal({ company: 'Example Employer', role: 'Fixture Associate',
    sourceUrl: 'https://careers.example.test/jobs/fixture-opening' },
  {}, true)).toEqual({ state: 'eligibility_required' });
});

test('account registration is disabled when the private target list is missing or ambiguous', async () => {
  const path = join(fixtureAccountHome, 'account-targets.json');
  try {
    await rm(path);
    expect(accountTargetFor(standardWorkday.sourceUrl)).toBeUndefined();
    await writeFile(path, JSON.stringify([accountFixtures[0], accountFixtures[0]]), { mode: 0o600 });
    expect(accountTargetFor(standardWorkday.sourceUrl)).toBeUndefined();
  } finally {
    await writeFile(path, JSON.stringify(accountFixtures), { mode: 0o600 });
  }
});

test('portal sign-in uses the Application Address vault login instead of the category account', async () => {
  const root = await mkdtemp('/tmp/qs-portal-identity-');
  const previous = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = root;
    await writeFile(join(root, 'account-targets.json'), JSON.stringify(accountFixtures), { mode: 0o600 });
  try {
    const applicationAddress = 'luigi.k7mq@luigigirke.com';
    const work = { ...standardWorkday, applicationAddress };
    const passCommand = join(root, 'fake-pass');
    const login = JSON.stringify({ item: { content: { content: {
      Login: { email: applicationAddress, username: applicationAddress, password: 'Synthetic9!Login' },
    } } } });
    await writeFile(passCommand, `#!/bin/sh\nprintf '%s\\n' '${login}'\n`, { mode: 0o700 });
    const reference = { email: applicationAddress, vaultShareId: 'synthetic-vault',
      vaultItemId: 'synthetic-item', verifiedDelivery: true };
    await writeLocal('category-identities.json', { admin: reference });
    const options = { passCommand, browserUseCommand: '/unused-browser', cdpUrl: 'http://127.0.0.1:1' };
    expect(await signInWorkdayAccount(work, options)).toBe('vault_unavailable');
    await writeLocal('application-identities.json', { [applicationAddress]: reference });
    expect(await signInWorkdayAccount(work, options)).toBe('runner_unavailable');
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Djinni requires the exact role and explicit terms acceptance before creating an account', async () => {
  const tabId = 'A'.repeat(32);
  expect(await prepareDjinniSignup({ ...djinni, company: 'Another company' }, {})).toEqual({ state: 'identity_mismatch' });
  expect(await createPreparedDjinniAccount(djinni, {}, tabId, false)).toEqual({ state: 'terms_confirmation_required' });
  expect(await createPreparedDjinniAccount({ ...djinni, sourceUrl: djinni.sourceUrl + '?other=1' }, {}, tabId, true))
    .toEqual({ state: 'identity_mismatch' });
});

test('exact Workday sources expose safe first-step questions during account setup', async () => {
  expect(await discoverForm({ ...standardWorkday, role: 'Wrong role' }, {})).toEqual({ kind: 'failed', code: 'identity_mismatch' });
  const schema = await discoverForm(standardWorkday, {});
  expect(schema).toMatchObject({ kind: 'discovered', listingUrl: accountTargetFor(standardWorkday.sourceUrl)?.url });
  if (schema.kind !== 'discovered') throw new Error('workday_schema_unavailable');
  expect(schema.fields).toHaveLength(12);
  expect(schema.fields.find(field => field.id === 'formField-candidateIsPreviousWorker')).toEqual({
    id: 'formField-candidateIsPreviousWorker', label: 'Have you previously worked for Example Technology?',
    required: true, type: 'radio', options: ['Yes', 'No'],
  });
  expect(schema.fields.find(field => field.id === 'name--legalName--firstName')?.label).toBe('Legal First Name');
  expect(listingRequirements('synthetic-id', schema.fields).map(field => field.label)).toEqual([
    'How Did You Hear About Us?', 'Have you previously worked for Example Technology?',
  ]);
  const differentCategory = { ...standardWorkday, kind: 'submit' as const, resumeTrack: 'web' };
  expect(await submitApplication(differentCategory, { pdfPath: '/unused.pdf', privateConfigPath: '/unused.json' }))
    .toMatchObject({ kind: 'failed', code: 'manual_required', gate: { kind: 'authentication' } });
});

const liveRunner = process.env.QS_JOBS_TEST_BROWSER_USE;
test.skipIf(!liveRunner)('dedicated Chrome preserves owner sign-in across Browser Use runs and isolates tenant stages', async () => {
  const root = await mkdtemp('/tmp/qs-browser-accounts-');
  const originalHome = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = root;
    await writeFile(join(root, 'account-targets.json'), JSON.stringify(accountFixtures), { mode: 0o600 });
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
    const ssl = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj',
      '/CN=standard.wd1.myworkdayjobs.com', '-keyout', key, '-out', cert, '-days', '1'], { stderr: 'ignore' });
    expect(ssl.exitCode).toBe(0);
    const publicKey = Bun.spawnSync(['openssl', 'x509', '-in', cert, '-pubkey', '-noout']);
    const der = Bun.spawnSync(['openssl', 'pkey', '-pubin', '-outform', 'der'], { stdin: publicKey.stdout });
    const spki = new Bun.CryptoHasher('sha256').update(der.stdout).digest('base64');
    const target = accountTargetFor(standardWorkday.sourceUrl)!;
    const reviewedWorkdayTarget = accountTargetFor(reviewedWorkday.sourceUrl)!;
    let signIns = 0, protectedStages = 0, fixtureNext = 0, fixtureSubmits = 0;
    let signupFixture = false, accountCreates = 0, stageFixture = false, stageAdvances = 0, showUnknownRequired = false;
    let reviewedWorkdaySignInFixture = false, reviewedWorkdaySignIns = 0, reviewedWorkdayVerificationVisits = 0;
    const syntheticEmail = 'luigi.k7mq@luigigirke.com', syntheticPassword = 'Synthetic-Password-123';
    const signupForm = (isTitan: boolean) => `<form data-automation-id="signInFormo">
      <label for="signup-email">Email Address*</label><input required id="signup-email" data-automation-id="email" type="text" autocomplete="email">
      <label for="signup-password">Password*</label><input required id="signup-password" data-automation-id="password" type="password" autocomplete="new-password">
      <label for="signup-verify">Verify New Password*</label><input required id="signup-verify" data-automation-id="verifyPassword" type="password" autocomplete="new-password">
      <ul><li>An alphabetic character</li><li>A special character</li><li>An uppercase character</li><li>A numeric character</li>
        <li>A lowercase character</li><li>A minimum of 8 characters</li></ul>
      ${isTitan ? `<label><input data-automation-id="createAccountCheckbox" type="checkbox">
        I reviewed the synthetic privacy notice</label>
        <p>By continuing, you acknowledge the synthetic privacy notice.</p>
        <div data-automation-id="noCaptchaWrapper"><div style="position:relative;width:max-content">
          <button type="submit" data-automation-id="createAccountSubmitButton" aria-hidden="true" tabindex="-2">Create Account</button>
          <div data-automation-id="click_filter" role="button" aria-label="Create Account" tabindex="0" style="position:absolute;inset:0"></div>
        </div></div>` : '<button type="submit" data-automation-id="createAccountSubmitButton">Create Account</button>'}
    </form>`;
    const html = (body: string) => new Response('<!doctype html>' + body, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    } });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        const url = new URL(request.url);
        if (url.href === indeed.sourceUrl) return html('<h3>This job has expired on Indeed</h3>');
        if (url.origin === new URL(reviewedWorkdayTarget.url).origin && url.pathname === '/fixture-review/test-verification' &&
            url.searchParams.get('redirect') === '/candidateHome') {
          reviewedWorkdayVerificationVisits++;
          return html('<h2>Email address successfully verified</h2>');
        }
        if (reviewedWorkdaySignInFixture && url.pathname === '/synthetic-sign-in' && request.method === 'POST' &&
            url.origin === new URL(reviewedWorkdayTarget.url).origin && await request.text() === '[true,true]') {
          reviewedWorkdaySignIns++;
          return new Response('ok');
        }
        if (reviewedWorkdaySignInFixture && url.href === reviewedWorkdayTarget.url) {
          return html(`<title>Sign In</title><h2 data-automation-id="jobTitleHeading">${reviewedWorkday.role}</h2>
            <form data-automation-id="signInFormo">
              <label for="signin-email">Email Address*</label><input required id="signin-email" data-automation-id="email" autocomplete="email">
              <label for="signin-password">Password*</label><input required id="signin-password" data-automation-id="password" type="password" autocomplete="current-password">
              <button type="submit" data-automation-id="signInSubmitButton">Sign In</button>
            </form><script>
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const expected = [${JSON.stringify(syntheticEmail)},${JSON.stringify(syntheticPassword)}];
                const checks = [...event.currentTarget.querySelectorAll('input')].map((e,i) => e.value === expected[i]);
                const reply = await fetch('/synthetic-sign-in',{method:'POST',body:JSON.stringify(checks)});
                if (reply.ok) {
                  document.querySelector('form').remove();
                  const account = document.createElement('button');
                  account.id = 'accountSettingsButton';
                  account.setAttribute('data-automation-id','utilityMenuButton');
                  account.textContent = expected[0];
                  document.body.append(account);
                }
              });
            </script>`);
        }
        if (url.pathname === '/synthetic-workday-next' && request.method === 'POST') {
          if (![new URL(target.url).origin, new URL(reviewedWorkdayTarget.url).origin].includes(url.origin) ||
              await request.text() !== 'verified') return new Response(null, { status: 400 });
          stageAdvances++;
          return new Response('ok');
        }
        if (stageFixture && [target.url, reviewedWorkdayTarget.url].includes(url.href)) {
          const isTitan = url.href === reviewedWorkdayTarget.url, steps = isTitan ? 6 : 5;
          const role = isTitan ? reviewedWorkday.role : standardWorkday.role;
          const previous = isTitan ? 'Have you previously been employed by Example Services?' : 'Have you previously worked for Example Technology?';
          const fields = [
            ['source--source', 'How Did You Hear About Us?', isTitan ? 'prompt' : 'menu', isTitan ? 'Third-party boards' : 'Indeed'],
            ['country--country', 'Country', 'menu', 'Canada'],
            ['name--legalName--firstName', 'First Name', 'text', 'Synthetic Legal First'],
            ['name--legalName--lastName', 'Last Name', 'text', 'Synthetic Legal Last'],
            ['address--addressLine1', 'Address Line 1', 'text', '1 Fixture Street'],
            ['address--city', 'City', 'text', 'Fixture City'],
            ['address--countryRegion', 'Province or Territory', 'menu', 'Nova Scotia'],
            ['address--postalCode', 'Postal Code', 'text', 'A1A 1A1'],
            ['phoneNumber--phoneType', 'Phone Device Type', 'menu', 'Mobile'],
            ['phoneNumber--countryPhoneCode', 'Country Phone Code', 'search', 'Canada (+1)'],
            ['phoneNumber--phoneNumber', 'Phone Number', 'text', '9025550100'],
          ];
          return html(`<h2 data-automation-id="jobTitleHeading">${role}</h2>
            <button id="accountSettingsButton" data-automation-id="utilityMenuButton">${syntheticEmail}</button>
            <div data-automation-id="progressBarActiveStep">current step 1 of ${steps}My Information</div>
            <main>${fields.map(([id,label,kind,expected]) => `<div data-automation-id="formField-${id}">
              <label for="${id}">${label}*</label>
              ${kind === 'menu' ? `<button id="${id}" type="button" aria-haspopup="listbox" aria-expanded="false">Select One</button>`
                : `<input id="${id}" type="text" ${kind === 'prompt' ? 'aria-required="true"' : 'required'}>`}
              ${kind === 'text' ? '' : kind === 'prompt' ? '<span data-automation-id="promptSearchButton">Open</span>'
                : `<div hidden role="listbox"><div role="option">${expected}</div></div>`}
              </div>`).join('')}
              <fieldset data-automation-id="formField-candidateIsPreviousWorker"><legend>${previous}*</legend>
                <label for="workdayYes">Yes</label><input id="workdayYes" name="previous" type="radio">
                <label for="workdayNo">No</label><input id="workdayNo" name="previous" type="radio">
              </fieldset>
              ${showUnknownRequired ? '<input id="unmapped" required>' : ''}
              <div data-automation-id="pageFooter"><button data-automation-id="pageFooterNextButton">Save and Continue</button></div>
            </main><script>
              const fields = ${JSON.stringify(fields)};
              for (const [id,label,kind,expected] of fields) {
                if (kind === 'text') continue;
                const field = document.getElementById(id), list = field.parentElement.querySelector('[role=listbox]');
                if (kind === 'prompt') {
                  field.parentElement.querySelector('[data-automation-id=promptSearchButton]').onclick = () => {
                    const popup = document.createElement('div');
                    popup.setAttribute('data-automation-id','responsiveMonikerPrompt');
                    popup.innerHTML = '<div role="option" data-automation-id="menuItem"><div data-automation-id="promptLeafNode"><div data-automation-id="promptOption">' + expected + '</div></div></div>';
                    popup.firstElementChild.onclick = () => {
                      const selected = document.createElement('span');
                      selected.setAttribute('data-automation-id','selectedItem');
                      selected.textContent = expected;
                      field.parentElement.append(selected);
                      popup.remove();
                    };
                    document.body.append(popup);
                  };
                  continue;
                }
                field.addEventListener(kind === 'menu' ? 'click' : 'input', () => {
                  list.hidden = false;
                  field.setAttribute('aria-expanded','true');
                });
                list.querySelector('[role=option]').onclick = () => {
                  if (kind === 'menu') field.textContent = expected;
                  else {
                    const selection = document.createElement('span');
                    selection.setAttribute('data-automation-id','selectedItem');
                    selection.textContent = expected;
                    field.parentElement.append(selection);
                  }
                  field.setAttribute('aria-expanded','false');
                  list.hidden = true;
                };
              }
              document.querySelector('[data-automation-id=pageFooterNextButton]').onclick = async () => {
                const verified = fields.every(([id,label,kind,expected]) => {
                  const field = document.getElementById(id);
                  return (kind === 'menu' ? field.textContent : kind === 'prompt'
                    ? field.parentElement.querySelector('[data-automation-id=selectedItem]')?.textContent : field.value) === expected;
                }) && document.getElementById('workdayNo').checked;
                const reply = await fetch('/synthetic-workday-next',{method:'POST',body:verified?'verified':'incorrect'});
                if (!reply.ok) return;
                document.querySelector('[data-automation-id=progressBarActiveStep]').textContent = 'current step 2 of ${steps}My Experience';
                document.querySelector('main').innerHTML = '<h2>My Experience</h2><button>Submit</button>';
                document.querySelector('main button').onclick = () => fetch('/synthetic-submit',{method:'POST'});
              };
            </script>`);
        }
        if (url.pathname === '/synthetic-create' && request.method === 'POST') {
          const allowed = url.origin === new URL(target.url).origin ? '[true,true,true]'
            : url.origin === new URL(reviewedWorkdayTarget.url).origin ? '[true,true,true,true]' : null;
          if (await request.text() !== allowed) return new Response(null, { status: 400 });
          accountCreates++;
          return new Response('ok');
        }
        if (signupFixture && [target.url, reviewedWorkdayTarget.url].includes(url.href)) {
          const isTitan = url.href === reviewedWorkdayTarget.url;
          const role = isTitan ? reviewedWorkday.role : standardWorkday.role;
          const policy = isTitan ? 'https://careers.example.test/privacy-reviewed' : 'https://careers.example.test/privacy-standard';
          return html(`<title>${isTitan ? 'Sign In' : 'Create Account'}</title>
            <h2 data-automation-id="jobTitleHeading">${role}</h2><div id="stage">
            ${isTitan ? '<button type="button" data-automation-id="SignInWithEmailButton">Sign in with email</button>' : signupForm(false) +
              '<button type="button" data-automation-id="signInLink">Sign In</button>'}
            </div><a data-automation-id="privacyLink" href="${policy}">Privacy Policy</a>
            <script>
              const stage = document.querySelector('#stage');
              document.querySelector('[data-automation-id=SignInWithEmailButton]')?.addEventListener('click', () => {
                stage.innerHTML = '<button type="button" data-automation-id="createAccountLink">Create Account</button>';
                stage.firstElementChild.addEventListener('click', () => {
                  document.title = ${JSON.stringify(role)};
                  stage.innerHTML = '<h2>Create Account</h2>' + ${JSON.stringify(signupForm(true))};
                  stage.querySelector('[data-automation-id=click_filter]').addEventListener('click', event => {
                    if (event.isTrusted) stage.querySelector('form').requestSubmit();
                  });
                  stage.querySelector('form').addEventListener('submit', async event => {
                    event.preventDefault();
                    const expected = [${JSON.stringify(syntheticEmail)},${JSON.stringify(syntheticPassword)},${JSON.stringify(syntheticPassword)}];
                    const checks = [...event.currentTarget.querySelectorAll('input')].map((e,i) => i < 3 ? e.value === expected[i] : e.checked);
                    const reply = await fetch('/synthetic-create',{method:'POST',body:JSON.stringify(checks)});
                    if (reply.ok) stage.innerHTML = '<h2>Verify your email address</h2>';
                  });
                });
              });
              if (!${isTitan}) stage.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const expected = [${JSON.stringify(syntheticEmail)},${JSON.stringify(syntheticPassword)},${JSON.stringify(syntheticPassword)}];
                const checks = [...event.currentTarget.querySelectorAll('input')].map((e,i) => e.value === expected[i]);
                const reply = await fetch('/synthetic-create',{method:'POST',body:JSON.stringify(checks)});
                if (reply.ok) stage.innerHTML = '<h2>Verify your email address</h2>';
              });
            </script>`);
        }
        if (url.href === reviewedWorkdayTarget.url && !request.headers.has('cookie')) return html(`
          <h2 data-automation-id="jobTitleHeading">Fixture Analyst</h2>
          <button data-automation-id="SignInWithEmailButton">Sign in with email</button>`);
        if (url.origin !== new URL(target.url).origin) return new Response(null, { status: 404 });
        if (url.pathname === '/synthetic-login' && request.method === 'POST' &&
            (await request.text()) === 'synthetic=owner') {
          signIns++;
          return new Response(null, { status: 303, headers: { Location: target.url, 'Set-Cookie':
            '__Host-fixture=session; Secure; HttpOnly; Path=/; SameSite=Strict' } });
        }
        if (url.pathname === '/synthetic-next' && request.method === 'POST' &&
            request.headers.get('cookie') === '__Host-fixture=session') {
          fixtureNext++;
          return new Response(null, { status: 303, headers: { Location: target.url } });
        }
        if (url.pathname === '/synthetic-submit' && request.method === 'POST') {
          fixtureSubmits++;
          return new Response(null, { status: 400 });
        }
        if (url.href !== target.url) return new Response(null, { status: 404 });
        const heading = '<h2 data-automation-id="jobTitleHeading">Fixture Engineer</h2>';
        if (request.headers.get('cookie') === '__Host-fixture=session') {
          protectedStages++;
          return html(heading + (fixtureNext ? `<h2>Review</h2><h3>My Information</h3><p>Synthetic private value</p>
            <form action="/synthetic-submit" method="post"><button>Submit</button></form>` :
            `<h2>My Information</h2><input data-automation-id="legalNameSection_firstName" required value="Synthetic private value">
            <form action="/synthetic-next" method="post"><button>Save and Continue</button></form>`));
        }
        return html(heading + `<h2>Create Account</h2><button data-automation-id="createAccountSubmitButton">Create Account</button>
          <button data-automation-id="signInLink">Sign In</button>
          <form action="/synthetic-login" method="post" hidden>
            <input type="hidden" name="synthetic" value="owner"><button data-automation-id="signInSubmitButton">Sign In</button>
          </form>
          <script>document.querySelector('[data-automation-id=signInLink]').onclick = () => {
            document.querySelector('form').hidden = false;
            for (const b of document.querySelectorAll('body > button')) b.remove();
          };</script>`);
      },
    });
    const chromePath = process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chrome = Bun.spawn([chromePath, '--headless=new', '--disable-background-networking', '--no-first-run',
      '--no-proxy-server', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${join(root, 'chrome')}`, `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=${[new URL(target.url).hostname, new URL(reviewedWorkdayTarget.url).hostname, new URL(indeed.sourceUrl).hostname]
        .map(host => `MAP ${host} 127.0.0.1:${server.port}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE localhost`,
      'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      let port = '';
      for (let attempt = 0; attempt < 50 && !port; attempt++) {
        const active = await readFile(join(root, 'chrome', 'DevToolsActivePort'), 'utf8').catch(() => '');
        [port] = active.split('\n');
        if (!port) await Bun.sleep(100);
      }
      expect(port).toMatch(/^\d+$/);
      const options = { browserUseCommand: liveRunner, cdpUrl: `http://127.0.0.1:${port}` };
      process.env.QUANTSELF_JOBS_HOME = join(root, 'different-jobs-home');
      await mkdir(join(process.env.QUANTSELF_JOBS_HOME, 'chrome', 'Default'), { recursive: true });
      await writeFile(join(process.env.QUANTSELF_JOBS_HOME, 'account-targets.json'), JSON.stringify(accountFixtures), { mode: 0o600 });
      expect(await checkAccountPortal(standardWorkday, options, true)).toEqual({ state: 'runner_unavailable' });
      process.env.QUANTSELF_JOBS_HOME = root;
      await writeFile(join(root, 'account-targets.json'), JSON.stringify(accountFixtures), { mode: 0o600 });
      const gate = await checkAccountPortal(standardWorkday, options, true);
      expect(gate).toEqual({ state: 'sign_in_required', tabId: expect.stringMatching(/^[A-F0-9]{32}$/) });
      expect(signIns).toBe(0);
      expect(protectedStages).toBe(0);
      const ownerSignIn = String.raw`
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
switch_tab(params['tabId'])
js("document.querySelector('form:not([hidden]) button[data-automation-id=signInSubmitButton]').click()")
wait_for_load()
print(json.dumps({'qsJobsBrowser':'synthetic_sign_in'}),flush=True)
`;
      expect(await withAccountBrowser(options, { tabId: gate.tabId }, false, ownerSignIn,
        ({ exitCode, messages }) => exitCode === 0 && messages.length === 1)).toBe(true);
      const firstStage = { state: 'application_ready', workdayStage: { name: 'My Information',
        actions: ['Save and Continue'], controls: [{ id: 'legalNameSection_firstName', type: 'text', required: true }] } };
      expect(await checkAccountPortal(standardWorkday, options)).toEqual(firstStage);
      expect(signIns).toBe(1);
      expect(protectedStages).toBe(1);
      expect(fixtureNext).toBe(0);
      const advanceFixtureStage = String.raw`
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
switch_tab(params['tabId'])
js("""document.querySelector('form[action="/synthetic-next"] button').click()""")
wait_for_load()
print(json.dumps({'qsJobsBrowser':'synthetic_stage_advanced'}),flush=True)
`;
      expect(await withAccountBrowser(options, { tabId: gate.tabId }, false, advanceFixtureStage,
        ({ exitCode, messages }) => exitCode === 0 && messages.length === 1)).toBe(true);
      const reviewStage = { state: 'application_ready', workdayStage: { name: 'Review', actions: ['Submit'], controls: [] } };
      expect(await checkAccountPortal(standardWorkday, options)).toEqual(reviewStage);
      expect(fixtureNext).toBe(1);
      expect(fixtureSubmits).toBe(0);
      const closeOwnerTab = String.raw`
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
cdp('Target.closeTarget', targetId=params['tabId'])
print(json.dumps({'qsJobsBrowser':'synthetic_tab_closed'}),flush=True)
`;
      expect(await withAccountBrowser(options, { tabId: gate.tabId }, false, closeOwnerTab,
        ({ exitCode, messages }) => exitCode === 0 && messages.length === 1)).toBe(true);
      expect(await checkAccountPortal(standardWorkday, options)).toEqual(reviewStage);
      expect(protectedStages).toBe(3);
      expect(await checkAccountPortal(reviewedWorkday, options)).toEqual({ state: 'sign_in_required' });
      expect(await checkAccountPortal(indeed, options, true)).toEqual({ state: 'unsupported_portal' });
      signupFixture = true;
      const passCommand = join(root, 'fake-pass');
      await writeFile(passCommand, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ item: { content: { content: {
        Login: { email: syntheticEmail, username: syntheticEmail, password: syntheticPassword },
      } } } })}'\n`, { mode: 0o700 });
      const reference = { email: syntheticEmail, vaultShareId: 'synthetic-vault', vaultItemId: 'synthetic-item', verifiedDelivery: false };
      await writeLocal('category-identities.json', { admin: reference });
      expect(await prepareWorkdaySignup(standardWorkday, { ...options, passCommand })).toEqual({ state: 'delivery_unverified' });
      await writeLocal('category-identities.json', { admin: { ...reference, verifiedDelivery: true } });
      const signupOptions = { ...options, passCommand };
      const standardWorkdaySignup = await prepareWorkdaySignup(standardWorkday, signupOptions);
      expect(standardWorkdaySignup).toMatchObject({ state: 'prepared', privacyReviewCheckbox: false });
      const reviewedWorkdaySignup = await prepareWorkdaySignup(reviewedWorkday, signupOptions);
      expect(reviewedWorkdaySignup).toMatchObject({ state: 'prepared', privacyReviewCheckbox: true });
      if (standardWorkdaySignup.state !== 'prepared' || reviewedWorkdaySignup.state !== 'prepared') throw new Error('synthetic_signup_failed');
      expect(accountCreates).toBe(0);
      expect(await createPreparedWorkdayAccount(reviewedWorkday, signupOptions, reviewedWorkdaySignup.tabId, true)).toEqual({ state: 'terms_confirmation_required' });
      expect(await createPreparedWorkdayAccount(standardWorkday, signupOptions, standardWorkdaySignup.tabId, false)).toEqual({ state: 'terms_confirmation_required' });
      expect(await createPreparedWorkdayAccount(standardWorkday, signupOptions, standardWorkdaySignup.tabId, true))
        .toEqual({ state: 'verification_pending', tabId: standardWorkdaySignup.tabId });
      expect(accountCreates).toBe(1);
      expect(await createPreparedReviewedWorkdayAccount(reviewedWorkday, signupOptions, reviewedWorkdaySignup.tabId, false))
        .toEqual({ state: 'terms_confirmation_required' });
      expect(await createPreparedReviewedWorkdayAccount(reviewedWorkday, signupOptions, reviewedWorkdaySignup.tabId, true))
        .toEqual({ state: 'verification_pending', tabId: reviewedWorkdaySignup.tabId });
      expect(accountCreates).toBe(2);
      const verification = { sourceUid: '123', purpose: 'fixture-account-activation' };
      const file = 'fixture-account-verification.json';
      await writeLocal(file, { ...verification, urls: ['https://example.test/verify?redirect=%2FcandidateHome'] });
      expect(await verifyReviewedWorkdayAccountLink(reviewedWorkday, options)).toBe('identity_mismatch');
      expect(reviewedWorkdayVerificationVisits).toBe(0);
      await writeLocal(file, { ...verification, urls: [new URL('/fixture-review/test-verification?redirect=%2FcandidateHome', reviewedWorkdayTarget.url).href] });
      expect(await verifyReviewedWorkdayAccountLink(reviewedWorkday, options)).toBe('verified');
      expect(reviewedWorkdayVerificationVisits).toBe(1);
      reviewedWorkdaySignInFixture = true;
      expect(await signInWorkdayAccount(reviewedWorkday, signupOptions)).toBe('signed_in');
      expect(reviewedWorkdaySignIns).toBe(1);
      reviewedWorkdaySignInFixture = false;
      stageFixture = true;
      const refreshStage = String.raw`
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
` + accountTabProgram + String.raw`
tab, created = account_tab(params['url'])
if not created:
    goto_url(params['url'])
wait_for_load()
print(json.dumps({'qsJobsBrowser':'synthetic_stage_ready'}),flush=True)
`;
      const refresh = (url = target.url) => withAccountBrowser(options, { url }, false, refreshStage,
        ({ exitCode, messages }) => exitCode === 0 && messages.length === 1);
      const path = join(root, 'claim-private.json');
      const work = { ...standardWorkday, kind: 'submit' as const };
      const submit = () => submitApplication(work, { ...options, pdfPath: join(root, 'unused.pdf'), privateConfigPath: path });
      const personal = { firstName: 'Synthetic Legal First', lastName: 'Synthetic Legal Last',
        country: 'Canada', addressLine1: '1 Fixture Street', city: 'Fixture City', region: 'Nova Scotia',
        postalCode: 'A1A 1A1', phone: '+1 (902) 555-0100' };
      const answers = {
        'How Did You Hear About Us?': { type: 'option', value: 'Indeed' },
        'Have you previously worked for Example Technology?': { type: 'option', value: 'No' },
        'Phone Device Type': { type: 'option', value: 'Mobile' },
        'Country Phone Code': { type: 'option', value: 'Canada (+1)' } };
      await writeFile(path, JSON.stringify({ personal, answers: {} }), { mode: 0o600 });
      expect(await refresh()).toBe(true);
      const pause = await submit();
      expect(pause).toMatchObject({ kind: 'failed', code: 'manual_required', safeToResume: true, attention: { variables: [] } });
      expect(continuationRequirements({ applicationId: 'ba92602f-eb6c-4cb0-9da2-a6fe6051a14f', resumeTrack: 'admin' }, pause)).toBeUndefined();
      expect(stageAdvances).toBe(0);
      await writeFile(path, JSON.stringify({ personal: { ...personal, firstName: '' }, answers: { [target.url]: {
        ...answers, 'Legal First Name': { type: 'text', value: personal.firstName },
      } } }));
      const missingContact = await submit();
      expect(missingContact).toMatchObject({ attention: { questions: [], variables: ['firstName'] } });
      expect(missingContact).not.toHaveProperty('safeToResume');
      expect(stageAdvances).toBe(0);
      await writeFile(path, JSON.stringify({ personal, answers: { [target.url]: {
        ...answers, 'Phone Device Type': { type: 'option', value: 'Unexpected' },
      } } }));
      const invalidChoice = await submit();
      expect(invalidChoice).toMatchObject({ attention: { questions: [{ id: 'phoneNumber--phoneType' }], variables: [] } });
      expect(invalidChoice).not.toHaveProperty('safeToResume');
      expect(stageAdvances).toBe(0);
      await writeFile(path, JSON.stringify({ personal, answers: { [target.url]: {
        ...answers, Country: { type: 'option', value: 'Wrong Country' },
      } } }));
      await writeLocal('category-identities.json', { admin: { ...reference, email: 'wrong-account@luigigirke.com', verifiedDelivery: true } });
      expect(await submit()).toMatchObject({ gate: { kind: 'authentication', url: target.url } });
      expect(stageAdvances).toBe(0);
      await writeLocal('category-identities.json', { admin: { ...reference, verifiedDelivery: true } });
      showUnknownRequired = true;
      expect(await refresh()).toBe(true);
      expect(await submit()).toEqual({ kind: 'failed', code: 'manual_required' });
      expect(stageAdvances).toBe(0);
      showUnknownRequired = false;
      expect(await refresh()).toBe(true);
      await writeFile(path, JSON.stringify({ personal: { ...personal, email: syntheticEmail }, answers: { [target.url]: answers } }));
      await rm(join(root, 'category-identities.json'));
      expect(await submitApplication({ ...work, applicationAddress: syntheticEmail }, {
        ...options, pdfPath: join(root, 'unused.pdf'), privateConfigPath: path,
      })).toEqual({ kind: 'failed', code: 'manual_required', workdayStage: 'my_experience' });
      expect(stageAdvances).toBe(1);
      await writeLocal('category-identities.json', { admin: { ...reference, verifiedDelivery: true } });
      await rm(path);
      expect(await submit()).toEqual({ kind: 'failed', code: 'manual_required', workdayStage: 'my_experience' });
      expect(stageAdvances).toBe(1);
      await writeFile(path, JSON.stringify({ personal, answers: { [reviewedWorkdayTarget.url]: { ...answers,
        'How Did You Hear About Us?': { type: 'option', value: 'Third-party boards' },
        'Have you previously been employed by Example Services?': { type: 'option', value: 'No' },
      } } }));
      expect(await refresh(reviewedWorkdayTarget.url)).toBe(true);
      expect(await submitApplication({ ...reviewedWorkday, kind: 'submit' }, {
        ...options, pdfPath: join(root, 'unused.pdf'), privateConfigPath: path,
      })).toEqual({ kind: 'failed', code: 'manual_required', workdayStage: 'my_experience' });
      expect(stageAdvances).toBe(2);
      expect(fixtureSubmits).toBe(0);
    } finally {
      chrome.kill();
      await chrome.exited;
      await server.stop(true);
    }
  } finally {
    if (originalHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
