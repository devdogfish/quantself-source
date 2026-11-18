import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAccountBrowser } from './browser-accounts';
import { reviewedIndeedAdapter } from './browser-indeed';
import { indeedFixture, fixtureFinalDisclosureDigest as indeedFinalDisclosureDigest, fixtureAttestationStatementDigest as indeedAttestationStatementDigest } from './browser-indeed.fixture';
import { discoverForm, submitApplication } from './browser';
import { writeLocal } from './config';
import { localPython } from './local-files';

const original = 'https://careers.example.test/jobs/fixture-opening';
const selected = 'https://ca.indeed.com/viewjob?jk=00000000f0000001';
const stage = '/beta/indeedapply/form/resume-selection-module/resume-selection';
const questionStage = '/beta/indeedapply/form/questions-module/questions/';
const reviewStage = '/beta/indeedapply/form/review-module';
const confirmationStage = '/beta/indeedapply/form/confirmation-module';
const finalDisclosure = "Selecting Submit sends this synthetic application and accepts the Terms, Cookie & Privacy Policies.";
const attestationStatement = 'I confirm the synthetic application is complete.';
const aiReviewStatement = 'Synthetic attestation 3';
const work = { kind: 'submit' as const, company: 'Example Employer', role: 'Fixture Associate',
  sourceUrl: original, applicationId: '00000000-0000-4000-8000-000000009001', revision: 8, resumeTrack: 'admin',
  id: '00000000-0000-4000-8000-000000000001', token: '00000000-0000-4000-8000-000000000002',
  summary: 'Synthetic approved summary with 2+ years of experience.' };

let fixtureHome: string;
const initialHome = process.env.QUANTSELF_JOBS_HOME;
beforeAll(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'qs-indeed-config-'));
  process.env.QUANTSELF_JOBS_HOME = fixtureHome;
  await writeFile(join(fixtureHome, 'indeed-target.json'), JSON.stringify(indeedFixture), { mode: 0o600 });
});
afterAll(async () => {
  if (initialHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
  else process.env.QUANTSELF_JOBS_HOME = initialHome;
  await rm(fixtureHome, { recursive: true, force: true });
});

test('only the original review record is eligible for the selected Indeed opening', async () => {
  const options = { pdfPath: '/unused.pdf', privateConfigPath: '/unused.json' };
  expect(await discoverForm({ ...work, company: 'Different company' }, {}))
    .toEqual({ kind: 'failed', code: 'identity_mismatch' });
  expect(await discoverForm({ ...work, sourceUrl: selected }, {}))
    .toEqual({ kind: 'failed', code: 'unsupported_portal' });
  expect(await submitApplication({ ...work, token: '' }, options))
    .toEqual({ kind: 'failed', code: 'manual_required' });
  expect(await submitApplication({ ...work, applicationId: work.id }, options))
    .toEqual({ kind: 'failed', code: 'manual_required' });
});

test('an absent or substituted private Indeed profile cannot select the adapter', async () => {
  const path = join(fixtureHome, 'indeed-target.json');
  try {
    await rm(path);
    expect(reviewedIndeedAdapter(original)).toBeUndefined();
    await writeFile(path, JSON.stringify({ ...indeedFixture, jobKey: '00000000f0000002' }), { mode: 0o600 });
    expect(reviewedIndeedAdapter(original)).toBeUndefined();
  } finally {
    await writeFile(path, JSON.stringify(indeedFixture), { mode: 0o600 });
  }
});

test('an Application Address claim pauses before using an Indeed profile account', async () => {
  const root = await mkdtemp('/tmp/qs-indeed-identity-');
  const previous = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = root;
    await writeFile(join(root, 'indeed-target.json'), JSON.stringify(indeedFixture), { mode: 0o600 });
  try {
    const applicationAddress = 'luigi.k7mq@luigigirke.com';
    const submit = () => submitApplication({ ...work, applicationAddress },
      { pdfPath: '/unused.pdf', privateConfigPath: '/unused.json' });
    expect(await submit()).toEqual({ kind: 'failed', code: 'manual_required' });
    const applicationDirectory = `applications/${work.applicationId}`;
    await mkdir(join(root, applicationDirectory), { recursive: true });
    await writeLocal(`${applicationDirectory}/indeed-final-submit-attempt.json`, {});
    expect(await submit()).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

const liveRunner = process.env.QS_JOBS_TEST_BROWSER_USE;
test.skipIf(!liveRunner)('verified Indeed résumé stage attaches one approved file and stops before any later action', async () => {
  const root = await mkdtemp('/tmp/qs-indeed-');
  const originalHome = process.env.QUANTSELF_JOBS_HOME;
  const originalPython = process.env.QUANTSELF_JOBS_PYTHON;
  const python = localPython();
  process.env.QUANTSELF_JOBS_HOME = root;
    await writeFile(join(root, 'indeed-target.json'), JSON.stringify(indeedFixture), { mode: 0o600 });
  process.env.QUANTSELF_JOBS_PYTHON = python;
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
    expect(Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj',
      '/CN=ca.indeed.com', '-keyout', key, '-out', cert, '-days', '1'], { stderr: 'ignore' }).exitCode).toBe(0);
    const publicKey = Bun.spawnSync(['openssl', 'x509', '-in', cert, '-pubkey', '-noout']);
    const der = Bun.spawnSync(['openssl', 'pkey', '-pubin', '-outform', 'der'], { stdin: publicKey.stdout });
    const spki = createHash('sha256').update(der.stdout).digest('base64');
    const bytes = '%PDF-1.4\nsynthetic attachment\n';
    const hash = createHash('sha256').update(bytes).digest('hex');
    const email = 'indeed-fixture@luigigirke.com';
    const phone = '19025550103';
    const html = (body: string) => new Response('<!doctype html>' + body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const fileInput = '<input hidden type="file" data-testid="resume-selection-file-resume-upload-radio-card-file-input" accept="application/pdf">';
    const uploadedCard = '<div data-testid="resume-selection-file-resume-radio-card">' +
      '<input checked type="radio" data-testid="resume-selection-file-resume-radio-card-input" style="position:absolute;width:100px;height:0;margin:0">' +
      '<label data-testid="resume-selection-file-resume-radio-card-label">resume.pdf</label>' +
      '<button type=button data-testid="ResumeOptionsMenu">Resume options</button>' +
      '<button hidden type=button data-testid="ResumeOptionsMenu-upload">Upload a different file</button>' +
      '<section data-testid="resume-selection-file-resume-pdf-preview"><canvas data-testid="resume-selection-file-resume-pdf-preview-page-canvas"></canvas></section>' +
      '<input hidden type="file" data-testid="resume-selection-file-resume-radio-card-file-input" accept="application/pdf"></div>';
    let scenario = 'normal', attachments = 0, continues = 0, contactContinues = 0, screeningContinues = 0, attestationContinues = 0, finalClicks = 0;
    let expectedUpload = hash, reviewPdf: Uint8Array | undefined;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        const url = new URL(request.url);
        if (url.href === selected) return html('<h1>Synthetic listing</h1>');
        if (url.origin === 'https://apply-preview.indeed.com' && url.pathname === '/indeedapply/applicationpreview/attachment') {
          const headers = { 'Access-Control-Allow-Origin': 'https://smartapply.indeed.com', 'Access-Control-Allow-Credentials': 'true' };
          return new Response(scenario === 'review-wrong-pdf' ? bytes : reviewPdf, { headers });
        }
        if (url.origin !== 'https://smartapply.indeed.com') return new Response(null, { status: 404 });
        if (['/api/v1/synthetic-resume', '/api/v1/file-resumes/process'].includes(url.pathname) && request.method === 'POST') {
          attachments++;
          return new Response('ok', { status: scenario === 'failed-upload' ? 503 : 201 });
        }
        if (url.pathname === '/synthetic-continue' && request.method === 'POST' && await request.text() === expectedUpload) {
          continues++;
          return new Response('ok');
        }
        if (url.pathname === '/synthetic-final') {
          finalClicks++;
          return new Response(null, { status: scenario === 'verified-final' ? 200 : 400 });
        }
        if (url.pathname === '/synthetic-contact') {
          contactContinues++;
          return new Response('ok');
        }
        if (url.pathname === '/synthetic-screening') {
          screeningContinues++;
          return new Response('ok');
        }
        if (url.pathname === '/synthetic-attestation') {
          attestationContinues++;
          return new Response('ok');
        }
        if ([reviewStage, confirmationStage].includes(url.pathname)) {
          const data = '<nav hidden id="gnav-burger-menu-nav"><a href="https://secure.indeed.com/account/logout"><span>' + email + '</span></a></nav>' +
            '<script type="application/json" id="_indeed_gnav_config">' + JSON.stringify({ userEmail: email }) + '</script>' +
            '<script>window._initialData=' + JSON.stringify({
              jobInfo: { jk: '00000000f0000001', jobTitle: work.role, jobCompany: work.company },
              authMetadata: { email }, smartApplyCommonMetadata: { draft: { id: 'synthetic-review-draft' } },
              screenerQuestions: Array.from({ length: 25 }, (_, i) => ({ labelHtml: [2,5].includes(i) ? 'Phone Number' : '' })),
            }) + ';</script>';
          if (url.pathname === confirmationStage) return html(data + '<h1>Application submitted</h1>' +
            (scenario === 'wrong-receipt' ? '<script>sessionStorage.setItem("applySubmissionSuccessDraftId","another-draft");</script>' : ''));
          const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
          const section = (id: string, heading: string, rows: string[][]) => '<section data-testid="' + id + '"><h2>' + heading +
            '</h2><dl>' + rows.map(([key, value]) => '<dt>' + escape(key) + '</dt><dd>' + escape(value) + '</dd>').join('') + '</dl></section>';
          const doc = section('contactInfoSection', 'Contact information', [
            ['First name','Synthetic'],['Last name','Applicant'],['Full name','Synthetic Applicant'],['E-mail',email],['Phone number',phone],
          ]) + '<section data-testid="resumeSection"><h2>Resume</h2>' +
            ['', 'resume.pdf'].map(label => '<a download="resume.pdf" href="https://apply-preview.indeed.com/indeedapply/applicationpreview/attachment?t=fixture">' + label + '</a>').join('') +
            '</section>' + section('screenerQuestionsSection', 'Questions from the employer', [
              ['Phone Number',phone],['Phone Number',phone],['Synthetic screening question 1', 'Yes'],
              ['Synthetic screening question 2', 'Yes'],
              ['Synthetic screening question 3', '0'],
              [attestationStatement, 'Yes, I agree to sign electronically.'], ['Synthetic attestation 2', 'Synthetic Applicant'],
              [aiReviewStatement, 'Yes'],
            ]);
          return html(data + '<main><h1>Review your application</h1><iframe data-testid="application-preview" srcdoc="' + escape(doc) + '"></iframe>' +
            '<label><input type="checkbox">Get email updates for the latest billing coordinator jobs in London, ON</label>' +
            '<div data-testid="legalDisclaimer"><p data-testid="indeedLegalDisclaimer">' + escape(finalDisclosure).replace('Terms, Cookie &amp; Privacy Policies',
              '<a href="https://ca.indeed.com/legal?hl=en_CA">Terms, Cookie &amp; Privacy Policies</a>') + '</p></div>' +
            '<button type=submit data-testid="submit-application-button">Submit your application</button></main><script>' +
            'document.querySelector("button").onclick=()=>fetch("/synthetic-final",{method:"POST"}).then(r=>{' +
            'if(r.ok){sessionStorage.setItem("applySubmissionSuccessDraftId","synthetic-review-draft");location.assign(' +
            JSON.stringify(confirmationStage) + ');}});</script>');
        }
        if ([questionStage + '1', questionStage + '2', questionStage + '3'].includes(url.pathname)) {
          const attestationNames = ['q_00000000000000000000000000000064', 'q_00000000000000000000000000000065', 'q_00000000000000000000000000000066'];
          const requiredNames = ['q_00000000000000000000000000000067', 'q_00000000000000000000000000000068', 'q_00000000000000000000000000000069'];
          const question = (index: number, type: string, labelHtml = '', required = false) => ({
            id: 'fixture-question-' + index, type, labelHtml, required,
            name: requiredNames[index - 8] ?? attestationNames[index - 22] ?? 'q_' + index.toString(16).padStart(32, '0'),
            format: index === 10 ? 'DECIMAL' : 'NONE',
            condition: index === 23 ? { id: 'fixture-question-22', values: ['attestationSign'], exclude: false } : null,
            options: index === 22 ? [{ label: 'Yes, I agree to sign electronically.', value: 'attestationSign' }] :
              index === 24 ? [{ label: 'No', value: 'N' }, { label: 'Yes', value: 'Y' }] : [],
          });
          const questions = [
            question(0, 'INFORMATION'), question(1, 'SELECT'), question(2, 'TEXT'), question(3, 'MULTISELECT'),
            question(4, 'SELECT'), question(5, 'TEXT'), question(6, 'PAGEBREAK'), question(7, 'INFORMATION'),
            question(8, 'SELECT', 'Synthetic screening question 1', true),
            question(9, 'SELECT', 'Synthetic screening question 2', true),
            question(10, 'TEXT', 'Synthetic screening question 3', true),
            ...Array.from({ length: 11 }, (_, i) => question(i + 11, 'TEXT')),
            question(22, 'MULTISELECT', scenario === 'changed-attestation' ? 'Changed declaration.' : attestationStatement, true),
            question(23, 'TEXT', 'Synthetic attestation 2', true), question(24, 'SELECT', aiReviewStatement, true),
          ];
          const screening = url.pathname === questionStage + '2';
          const attesting = url.pathname === questionStage + '3';
          const common = '<h1>Answer these questions from the employer</h1><strong>' + (attesting ? 'Attestations' : screening ? 'Questions' : 'Contact Information') + '</strong>' +
            '<nav hidden id="gnav-burger-menu-nav"><a href="https://secure.indeed.com/account/logout"><span>' + email + '</span></a></nav>' +
            '<script type="application/json" id="_indeed_gnav_config">' + JSON.stringify({ userEmail: email }) + '</script>' +
            '<script>window._initialData=' + JSON.stringify({
              jobInfo: { jk: '00000000f0000001', jobTitle: work.role, jobCompany: work.company },
              authMetadata: { email }, screenerQuestions: questions,
            }) + ';</script>';
          if (attesting) return html(common +
            '<label><input type=checkbox name="' + attestationNames[0] + '" value=attestationSign>Yes, I agree to sign electronically.</label>' +
            '<label><input type=radio name="' + attestationNames[2] + '" value=N>No</label>' +
            '<label><input type=radio name="' + attestationNames[2] + '" value=Y>Yes</label>' +
            '<button type=button>Continue</button><script>' +
            'document.querySelector("input[type=checkbox]").onchange=()=>{setTimeout(()=>{' +
            'const field=document.createElement("input");field.type="text";field.name=' + JSON.stringify(attestationNames[1]) +
            ';document.querySelector("button").before(field);},350);};' +
            'document.querySelector("button").onclick=()=>{' +
            'if(document.querySelector("input[type=checkbox]").checked&&document.querySelector("input[type=text]").value==="Synthetic Applicant"&&' +
            'document.querySelector("input[value=Y]").checked)fetch("/synthetic-attestation");};</script>');
          if (screening) {
            const radios = (name: string) => '<fieldset name="' + name + '" role="radiogroup" aria-required="true" data-testid="input-' + name + '">' +
              ['Yes', 'No'].map((choice, j) => '<label><input type="radio" name="' + name + '" value="' + choice +
                '" data-testid="input-' + name + '-single-select-question-' + j + '">' + choice + '</label>').join('') + '</fieldset>';
            return html(common + radios(requiredNames[0]) + radios(requiredNames[1]) +
              '<input type=text name="' + requiredNames[2] + '" data-testid="input-' + requiredNames[2] + '-input">' +
              '<div role="combobox" aria-expanded="false" data-testid="input-' + questions[14].name + '-select-list-select-list">Select</div>' +
              (scenario === 'screening-unverified' ? '<button type=button>Submit application</button>' : '') +
              '<button type=button id=screening-continue>Continue</button><script>' +
              'let numericInputEvent=false;document.querySelector("input[type=text]").oninput=()=>{' +
              'numericInputEvent=true;const next=document.getElementById("screening-continue");next.disabled=true;' +
              'setTimeout(()=>{next.disabled=false;},350);};' +
              'document.getElementById("screening-continue").onclick=()=>{' +
              'const checked=[...document.querySelectorAll("input[type=radio]:checked")];' +
              'if(checked.length!==2||checked.some(e=>e.value!=="Yes")||!numericInputEvent||document.querySelector("input[type=text]").value!=="0")return;' +
              'fetch("/synthetic-screening").then(()=>location.assign(' + JSON.stringify(questionStage + '3') + '));};</script>');
          }
          return html(common +
            '<input type=text name="' + questions[2].name + '" value="' + phone + '">' +
            '<input type=checkbox name="' + questions[3].name + '">' +
            '<input type=text name="' + questions[5].name + '" value="' + phone + '">' +
            '<button type=button id=contact-continue>Continue</button>' +
            '<script>document.getElementById("contact-continue").onclick=()=>{' +
            'fetch("/synthetic-contact").then(()=>location.assign(' + JSON.stringify(questionStage + '2') + '));};</script>');
        }
        if (url.pathname !== stage) return new Response(null, { status: 404 });
        const jobKey = scenario === 'intervening' ? '0000000000000000' : '00000000f0000001';
        const account = scenario === 'spoof' ? 'different-account@example.com' : email;
        const replacing = scenario.startsWith('replacement');
        return html('<h1>Fixture Associate</h1><p>Example Employer - London, ON</p>' +
          '<button aria-label="' + email + '">Account</button>' +
          '<nav hidden id="gnav-burger-menu-nav"><a href="https://secure.indeed.com/account/logout"><span>' + account + '</span></a></nav>' +
          '<script type="application/json" id="_indeed_gnav_config">' + JSON.stringify({ userEmail: email }) + '</script>' +
          '<script>window._initialData=' + JSON.stringify({
            jobInfo: { jk: jobKey, jobTitle: work.role, jobCompany: work.company }, authMetadata: { email },
          }) + ';</script>' +
          (scenario === 'hidden-form' ? '<form hidden data-testid="resume-selection-form">' + fileInput + '</form>' : '') +
          '<form data-testid="resume-selection-form"><h1>Add a resume</h1>' +
          '<input type="radio" name="resume-selection" style="position:absolute;width:100px;height:0;margin:0">' +
          '<input type="radio" name="resume-selection" style="position:absolute;width:100px;height:0;margin:0">' +
          (replacing ? uploadedCard : fileInput) + (scenario === 'hidden-input' ? fileInput : '') +
          '<button type="button" data-testid="continue-button">Continue</button></form><script>' +
          'const replacing=' + JSON.stringify(replacing) + ',uploadedCard=' + JSON.stringify(uploadedCard) + ';' +
          'function bindPreview(file){const preview=document.querySelector("[data-testid=resume-selection-file-resume-pdf-preview]");' +
          'preview.__reactFiber$fixture={return:{return:{return:{memoizedProps:{file}}}}};}' +
          (replacing ? 'bindPreview(new File([' + JSON.stringify(scenario === 'replacement-wrong-old' ? bytes.replace('synthetic', 'different') : bytes) +
            '],"resume.pdf",{type:"application/pdf"}));' : '') +
          'let selectedFile;for(const input of document.querySelectorAll("input[type=file]"))input.onchange=()=>{' +
          'selectedFile=input.files[0];const req=new XMLHttpRequest();req.open("POST",replacing?"/api/v1/file-resumes/process":"/api/v1/synthetic-resume");' +
          'req.onload=()=>{if(replacing){const old=document.querySelector("form"),updated=old.cloneNode(true);' +
          'updated.querySelector("[data-testid=continue-button]").onclick=old.querySelector("[data-testid=continue-button]").onclick;' +
          'old.replaceWith(updated);bindPreview(selectedFile);updated.querySelector("input[type=file]").value="";' +
          '}else input.outerHTML=uploadedCard;};req.send(selectedFile);};' +
          (scenario === 'layout-change' ? 'const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(...args)=>{' +
            'const old=document.querySelector("[data-testid=continue-button]"), replacement=old.cloneNode(true);' +
            'old.replaceWith(replacement);replacement.onclick=()=>fetch("/synthetic-final");return digest(...args);};' : '') +
          'document.querySelector("[data-testid=continue-button]").onclick=async()=>{' +
          'const file=selectedFile;' +
          'const digest=await crypto.subtle.digest("SHA-256",await file.arrayBuffer());' +
          'const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");' +
          'const result=await fetch("/synthetic-continue",{method:"POST",body:hash});if(!result.ok)return;' +
          'if(replacing){location.assign(' + JSON.stringify(questionStage + '1') + ');return;}' +
          'history.pushState({},"","/synthetic-next-stage");' +
          'document.querySelector("form").innerHTML="<label>Private echoed field <input></label><button type=button>Submit application</button>";' +
          'document.querySelector("form button").onclick=()=>fetch("/synthetic-final");};</script>');
      },
    });
    const chromePath = process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chrome = Bun.spawn([chromePath, '--headless=new', '--disable-background-networking', '--no-first-run', '--no-proxy-server',
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki,
      '--user-data-dir=' + join(root, 'chrome'),
      '--host-resolver-rules=MAP ca.indeed.com 127.0.0.1:' + server.port + ', MAP smartapply.indeed.com 127.0.0.1:' + server.port +
        ', MAP apply-preview.indeed.com 127.0.0.1:' + server.port + ', MAP * ~NOTFOUND, EXCLUDE localhost', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      let port = '';
      for (let i = 0; i < 50 && !port; i++) {
        const path = join(root, 'chrome', 'DevToolsActivePort');
        port = (await readFile(path, 'utf8').catch(() => '')).split('\n')[0];
        if (!port) await Bun.sleep(100);
      }
      expect(port).toMatch(/^\d+$/);
      const options = { browserUseCommand: liveRunner, cdpUrl: 'http://127.0.0.1:' + port };
      const openStage = String.raw`
p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
tab = cdp('Target.createTarget', url='about:blank')['targetId']
switch_tab(tab)
goto_url(p['listing'])
wait_for_load()
goto_url(p['stage'])
wait_for_load()
print(json.dumps({'qsJobsBrowser':'synthetic_indeed_stage','tabId':tab}),flush=True)
`;
      const tabId = await withAccountBrowser(options, { listing: selected, stage: 'https://smartapply.indeed.com' + stage },
        '', openStage, ({ exitCode, messages }) => exitCode === 0 && messages.length === 1
          ? String((messages[0] as { tabId: string }).tabId) : '');
      expect(tabId).toMatch(/^[A-F0-9]{32}$/);
      await writeLocal('category-identities.json', { admin: { email, verifiedDelivery: true } });
      await writeLocal('fixture-indeed-selection.json', {
        applicationId: work.applicationId, sourceUrl: original, selectedUrl: selected, company: work.company, role: work.role,
        location: 'London, ON', ownerSelected: true, recordSourceUnchanged: true, ownerAcceptedSignupTerms: true,
        accountStage: 'signed_in_alias_verified', accountTabId: tabId,
      });
      const privateConfigPath = join(root, 'private-fixture.json');
      const directory = join(root, 'applications', work.applicationId, String(work.revision), 'pdf-' + 'a'.repeat(64));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const pdfPath = join(directory, 'resume.pdf');
      const submitOptions = { ...options, pdfPath, privateConfigPath };
      await Promise.all([
        writeFile(pdfPath, bytes, { mode: 0o600 }),
        writeFile(join(directory, 'resume.work.json'), JSON.stringify(work), { mode: 0o600 }),
        writeFile(join(directory, 'resume.manifest.json'), JSON.stringify({ applicationId: work.applicationId, revision: work.revision, sha256: hash }), { mode: 0o600 }),
        writeFile(privateConfigPath, JSON.stringify({ personal: { email } }), { mode: 0o600 }),
      ]);
      expect(await discoverForm(work, options)).toMatchObject({ kind: 'discovered', listingUrl: selected });
      expect(await submitApplication({ ...work, summary: 'Different version.' }, submitOptions))
        .toEqual({ kind: 'failed', code: 'runner_unavailable' });
      const resetStage = (mode: string, path = stage) => {
        scenario = mode;
        return withAccountBrowser(options, { tabId, url: 'https://smartapply.indeed.com' + path }, false, String.raw`
p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
switch_tab(p['tabId'], activate=False)
goto_url(p['url'])
wait_for_load()
print(json.dumps({'qsJobsBrowser':'reset'}),flush=True)
`, ({ exitCode, messages }) => exitCode === 0 && messages.length === 1);
      };
      const blocked = { kind: 'failed', code: 'manual_required' };
      for (const mode of ['hidden-form', 'hidden-input', 'spoof', 'intervening']) {
        expect(await resetStage(mode)).toBe(true);
        const expected = mode === 'spoof' ? { ...blocked, gate: { kind: 'authentication', url: selected } } : blocked;
        expect(await submitApplication(work, submitOptions)).toEqual(expected);
      }
      expect(attachments).toBe(0);
      expect(await resetStage('layout-change')).toBe(true);
      expect(await submitApplication(work, submitOptions)).toEqual({ ...blocked, indeedStage: 'attachment_unconfirmed' });
      expect(attachments).toBe(1);
      expect(finalClicks).toBe(0);
      expect(continues).toBe(0);

      // Clear the synthetic attempt between fixtures only. The worker never repeats a real attempted attachment.
      await rm(join(root, 'applications', work.applicationId, 'indeed-attachment-attempt.json'));
      expect(await resetStage('failed-upload')).toBe(true);
      expect(await submitApplication(work, submitOptions)).toEqual({ ...blocked, indeedStage: 'attachment_unconfirmed' });
      expect(attachments).toBe(2);
      expect(continues).toBe(0);
      await rm(join(root, 'applications', work.applicationId, 'indeed-attachment-attempt.json'));
      expect(await resetStage('normal')).toBe(true);
      const results = await Promise.all([submitApplication(work, submitOptions), submitApplication(work, submitOptions)]);
      expect(results.filter(result => 'indeedStage' in result && result.indeedStage === 'resume_continue_activated')).toHaveLength(1);
      expect(await resetStage('normal')).toBe(true);
      expect(await submitApplication(work, submitOptions)).toEqual({ ...blocked, indeedStage: 'attachment_unconfirmed' });
      expect(attachments).toBe(3);
      expect(continues).toBe(1);
      expect(finalClicks).toBe(0);

      await writeLocal(`applications/${work.applicationId}/${work.revision}/approved.json`, work);
      expect(await resetStage('normal', questionStage + '1')).toBe(true);
      const nextWork = { ...work, revision: work.revision + 2 };
      expect(await submitApplication({ ...nextWork, summary: 'Different version.' }, submitOptions))
        .toEqual({ kind: 'failed', code: 'runner_unavailable' });
      expect(await submitApplication(nextWork, submitOptions)).toEqual({ ...blocked, indeedStage: 'contact_phone_unverified' });
      expect(contactContinues).toBe(0);
      await writeFile(privateConfigPath, JSON.stringify({ personal: { email, phone: '+1 (902) 555-0103' } }), { mode: 0o600 });
      const continuation = await submitApplication(nextWork, submitOptions);
      expect(contactContinues).toBe(1);
      expect(continuation).toMatchObject({ ...blocked, indeedStage: 'screening_required', safeToResume: true,
        attention: { questions: [{ required: true }, { required: true }, { required: true }], variables: [] } });
      expect(JSON.stringify(continuation)).not.toContain(phone);
      expect(attachments).toBe(3);
      expect(finalClicks).toBe(0);
      await writeFile(privateConfigPath, JSON.stringify({
        personal: { email, phone: '+1 (902) 555-0103' },
        answers: { [selected]: { 'Synthetic screening question 1': { type: 'option', value: 'Yes' } } },
      }), { mode: 0o600 });
      const continuedAgain = await submitApplication(nextWork, submitOptions);
      expect(continuedAgain).toMatchObject({ indeedStage: 'screening_required', attention: { questions: [
        { id: 'indeed-current-residence' }, { id: 'indeed-relevant-experience' },
      ] } });
      expect(contactContinues).toBe(1);
      expect(attachments).toBe(3);
      expect(await resetStage('screening-unverified', questionStage + '2')).toBe(true);
      expect(await submitApplication(nextWork, submitOptions)).toEqual({ ...blocked, indeedStage: 'question_stage_unverified' });

      const destinations = ['https://www.linkedin.com/in/luigigirke', 'https://luigigirke.com',
        'https://rbc-analytics.demo.girke.dev', 'https://sitings.ca/property/'];
      const links = (track: string, extras: string[]) => Object.fromEntries([...destinations, ...extras].map((destination, i) =>
        [destination, 'https://tracking.example.test/' + track + '/' + i]));
      const resumeTrackingLinks = {
        engineering: links('engineering', ['https://github.com/devdogfish', 'https://github.com/devdogfish/etpzp-sms']),
        web: links('web', ['https://github.com/devdogfish']), admin: links('admin', []),
      };
      await writeFile(privateConfigPath, JSON.stringify({
        personal: { email, phone: '+1 (902) 555-0103' }, resumeTrackingLinks,
      }), { mode: 0o600 });
      const replacementRevision = work.revision + 4;
      const replacementFolder = join(root, 'applications', work.applicationId, String(replacementRevision), 'pdf-' + 'b'.repeat(64));
      const trackedPath = join(replacementFolder, 'resume.pdf');
      await mkdir(replacementFolder, { recursive: true, mode: 0o700 });
      const makeTrackedPdf = Bun.spawnSync([python, '-B', '-c', `
import json, sys
from pypdf import PdfWriter
from pypdf.annotations import Link
data = json.load(sys.stdin)
writer = PdfWriter()
writer.add_blank_page(width=600, height=800)
for i, url in enumerate(data["links"]):
    writer.add_annotation(0, Link(rect=(0, 20 * i, 100, 20 * i + 10), url=url))
writer.write(data["path"])
`], { stdin: new Blob([JSON.stringify({ path: trackedPath, links: Object.values(resumeTrackingLinks.admin) })]), stdout: 'ignore', stderr: 'ignore' });
      expect(makeTrackedPdf.exitCode).toBe(0);
      reviewPdf = await readFile(trackedPath);
      const trackedHash = createHash('sha256').update(reviewPdf).digest('hex');
      const replacement = { ...work, revision: replacementRevision, previewDigest: trackedHash,
        summary: 'Synthetic approved summary with 2+ years of professional experience.' };
      const replacementOptions = { ...submitOptions, pdfPath: trackedPath };
      await writeLocal(`applications/${work.applicationId}/${replacementRevision}/approved.json`, replacement);
      await writeFile(join(replacementFolder, 'resume.work.json'), JSON.stringify(replacement), { mode: 0o600 });
      await writeFile(join(replacementFolder, 'resume.manifest.json'), JSON.stringify({
        applicationId: work.applicationId, revision: replacementRevision, sha256: trackedHash,
      }), { mode: 0o600 });
      expect(await resetStage('replacement-wrong-old')).toBe(true);
      expect(await submitApplication({ ...replacement, previewDigest: null }, replacementOptions)).toEqual({
        ...blocked, indeedStage: 'tracked_resume_preview_required',
      });
      expect(await submitApplication(replacement, replacementOptions)).toEqual({
        ...blocked, indeedStage: 'prior_attachment_unverified',
      });
      expect(attachments).toBe(3);
      // Start an independent synthetic contact pass following the replacement.
      const applicationDirectory = join(root, 'applications', work.applicationId);
      await rm(join(applicationDirectory, 'indeed-contact-continue-attempt.json'));
      const oldMarker = await readFile(join(applicationDirectory, 'indeed-attachment-attempt.json'), 'utf8');
      expect(await resetStage('replacement')).toBe(true);
      expectedUpload = trackedHash;
      expect(await submitApplication(replacement, replacementOptions)).toMatchObject({
        ...blocked, indeedStage: 'screening_required', trackedResumeReplaced: true,
      });
      expect(await readFile(join(applicationDirectory, 'indeed-attachment-attempt.json'), 'utf8')).toBe(oldMarker);
      expect(attachments).toBe(4);
      expect(continues).toBe(2);
      expect(contactContinues).toBe(2);
      expect(finalClicks).toBe(0);
      expect(await submitApplication({ ...replacement, revision: replacementRevision + 1, previewDigest: null }, replacementOptions))
        .toMatchObject({ ...blocked, indeedStage: 'screening_required', trackedResumeReplaced: true });
      expect(attachments).toBe(4);
      await writeFile(privateConfigPath, JSON.stringify({
        personal: { email, phone: '+1 (902) 555-0103', firstName: 'Synthetic', lastName: 'Applicant' }, resumeTrackingLinks, answers: {
          [selected]: {
            'Synthetic screening question 1': { type: 'option', value: 'Yes' },
            'Synthetic screening question 2': { type: 'option', value: 'Yes' },
            'Synthetic screening question 3': { type: 'text', value: '0' },
          },
        },
      }), { mode: 0o600 });
      expect(await resetStage('normal', questionStage + '2')).toBe(true);
      expect(await submitApplication({ ...replacement, revision: replacementRevision + 1, previewDigest: null }, replacementOptions))
        .toMatchObject({ ...blocked, indeedStage: 'attestation_required', trackedResumeReplaced: true });
      expect(screeningContinues).toBe(1);
      expect(attachments).toBe(4);
      expect(finalClicks).toBe(0);
      expect(attestationContinues).toBe(0);
      const attestationWork = { ...replacement, revision: replacementRevision + 2, previewDigest: null };
      const approval = {
        applicationId: work.applicationId, revision: attestationWork.revision, attachmentRevision: replacementRevision,
        summaryDigest: createHash('sha256').update(attestationWork.summary).digest('hex'),
        statementDigest: indeedAttestationStatementDigest, electronicSignatureApproved: true,
      };
      const approvalPath = `applications/${work.applicationId}/indeed-attestation-approval.json`;
      await writeLocal(approvalPath, { ...approval, revision: attestationWork.revision - 1 });
      expect(await submitApplication(attestationWork, replacementOptions)).toMatchObject({ indeedStage: 'attestation_required' });
      expect(attestationContinues).toBe(0);
      await writeLocal(approvalPath, approval);
      expect(await resetStage('changed-attestation', questionStage + '3')).toBe(true);
      expect(await submitApplication(attestationWork, replacementOptions)).toMatchObject({ indeedStage: 'question_stage_unverified' });
      expect(attestationContinues).toBe(0);
      expect(await resetStage('normal', questionStage + '3')).toBe(true);
      expect(await submitApplication(attestationWork, replacementOptions)).toMatchObject({ indeedStage: 'attestation_continue_unconfirmed' });
      expect(attestationContinues).toBe(1);
      expect(await submitApplication(attestationWork, replacementOptions)).toMatchObject({ indeedStage: 'attestation_continue_unconfirmed' });
      expect(attestationContinues).toBe(1);
      expect(attachments).toBe(4);
      expect(finalClicks).toBe(0);

      const finalWork = { ...attestationWork, revision: attestationWork.revision + 1 };
      await Promise.all([attestationWork.revision, finalWork.revision].map(revision =>
        mkdir(join(applicationDirectory, String(revision)), { mode: 0o700 })));
      await writeLocal(`applications/${work.applicationId}/${attestationWork.revision}/approved.json`, attestationWork);
      await writeLocal(`applications/${work.applicationId}/${finalWork.revision}/approved.json`, finalWork);
      const finalApproval = {
        applicationId: work.applicationId, revision: finalWork.revision, attachmentRevision: replacementRevision,
        attachmentHash: trackedHash, attestationRevision: attestationWork.revision, summaryDigest: approval.summaryDigest,
        disclosureDigest: indeedFinalDisclosureDigest, finalSubmissionApproved: true,
      };
      const hashBytes = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
      const template = join(root, 'resume.md'), renderer = join(root, 'render.py');
      await writeFile(template, '# Fixture');
      await writeFile(renderer, '# Fixture');
      const scoped = JSON.parse(await readFile(privateConfigPath, 'utf8'));
      Object.assign(scoped, { resumePaths: { admin: template }, rendererPath: renderer, rendererPython: python });
      await writeFile(privateConfigPath, JSON.stringify(scoped), { mode: 0o600 });
      const exact = {
        applicationId: work.applicationId, revision: replacementRevision, resumeTrack: replacement.resumeTrack,
        summary: replacement.summary, company: work.company, role: work.role, sourceUrl: work.sourceUrl,
      };
      await writeFile(join(replacementFolder, 'resume.work.json'), JSON.stringify(exact), { mode: 0o600 });
      const profileKeys = ['firstName','lastName','email','phone','city','region','country','postalCode','addressLine1','linkedin','website'];
      const inputs = {
        source: template, renderer, interpreter: python, templateSha256: hashBytes('# Fixture'), rendererSha256: hashBytes('# Fixture'),
        wrapperSha256: hashBytes(await readFile(new URL('./files.py', import.meta.url))), resumeTrackingLinks,
        identitySha256: hashBytes(JSON.stringify(profileKeys.map(key => [key, scoped.personal[key] ?? '']))),
      };
      const cacheKey = hashBytes(JSON.stringify([2, exact, inputs]));
      await writeLocal(`applications/${work.applicationId}/${replacementRevision}/preview-${cacheKey}-${trackedHash}.json`, {
        cacheKey, artifact: 'pdf-' + 'b'.repeat(64),
      });
      await writeFile(join(replacementFolder, 'resume.manifest.json'), JSON.stringify({
        applicationId: work.applicationId, revision: replacementRevision, sha256: trackedHash,
        templateSha256: inputs.templateSha256, rendererSha256: inputs.rendererSha256,
      }), { mode: 0o600 });
      expect(await resetStage('verified-final', reviewStage)).toBe(true);
      expect(await submitApplication(finalWork, replacementOptions)).toMatchObject({ indeedStage: 'review_required' });
      expect(finalClicks).toBe(0);
      await writeLocal(`applications/${work.applicationId}/indeed-final-approval.json`, finalApproval);
      expect(await submitApplication({ ...finalWork, previewDigest: 'a'.repeat(64) }, replacementOptions))
        .toMatchObject({ indeedStage: 'review_required' });
      expect(finalClicks).toBe(0);
      expect(await resetStage('review-wrong-pdf', reviewStage)).toBe(true);
      expect(await submitApplication(finalWork, replacementOptions)).toMatchObject({ indeedStage: 'review_pdf_unverified' });
      expect(finalClicks).toBe(0);
      expect(await resetStage('verified-final', reviewStage)).toBe(true);
      expect(await submitApplication(finalWork, replacementOptions)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(finalClicks).toBe(1);
      expect(await submitApplication(finalWork, replacementOptions)).toEqual({ kind: 'applied', receiptCode: 'confirmation_message' });
      expect(finalClicks).toBe(1);
      expect(await resetStage('wrong-receipt', confirmationStage)).toBe(true);
      expect(await submitApplication(finalWork, replacementOptions)).toMatchObject({ kind: 'failed', code: 'submission_uncertain' });
      expect(finalClicks).toBe(1);
    } finally {
      chrome.kill();
      await chrome.exited;
      await server.stop(true);
    }
  } finally {
    if (originalHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = originalHome;
    if (originalPython === undefined) delete process.env.QUANTSELF_JOBS_PYTHON;
    else process.env.QUANTSELF_JOBS_PYTHON = originalPython;
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
