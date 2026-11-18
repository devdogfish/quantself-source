import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMultistep, multistepTarget, publicResumeLinkField, submitMultistep } from './browser-multistep';
import { breezyFixtureFriendlyId, multistepFixtures } from './browser-multistep.fixture';

let breezy: NonNullable<ReturnType<typeof multistepTarget>>, google_form: NonNullable<ReturnType<typeof multistepTarget>>, google_account_form: NonNullable<ReturnType<typeof multistepTarget>>;
const [breezyUrl, google_formUrl, google_account_formUrl] = multistepFixtures.map(target => target.listingUrl);
let fixtureHome: string;
const previousHome = process.env.QUANTSELF_JOBS_HOME;
beforeAll(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'qs-multistep-config-'));
  process.env.QUANTSELF_JOBS_HOME = fixtureHome;
  await writeFile(join(fixtureHome, 'multistep-targets.json'), JSON.stringify(multistepFixtures), { mode: 0o600 });
  breezy = multistepTarget(breezyUrl)!;
  google_form = multistepTarget(google_formUrl)!;
  google_account_form = multistepTarget(google_account_formUrl)!;
});
afterAll(async () => {
  if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
  else process.env.QUANTSELF_JOBS_HOME = previousHome;
  await rm(fixtureHome, { recursive: true, force: true });
});
const privacy = () => breezy.fields.find(f => f.id === 'gdprAgreement')!.label;
const work = (plan: typeof breezy) => ({ kind: 'submit' as const, sourceUrl: plan.listingUrl, company: plan.companies[0], role: plan.role });
const escape = (value: string) => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function breezyPage(tamperAfterStep: boolean, filledHoneypot: boolean) {
  const phases = [...new Set(breezy.fields.map(f => f.phase!))];
  const fields = phases.map(phase => `<section data-phase="${phase}"${phase === 'initial' ? '' : ' hidden'}>${breezy.fields.filter(f => f.phase === phase).map(f => {
    const name = f.selector!.match(/\[name="([^"]+)"\]/)?.[1] ?? f.id;
    const id = f.selector!.match(/#([\w-]+)/)?.[1] ?? f.id;
    const req = f.required ? ' required' : '';
    if (f.type === 'radio') return `<fieldset><legend>${escape(f.label)}</legend>${f.options.map(option => `<label><input type="radio" name="${name}" value="${escape(option)}"${req}>${escape(option)}</label>`).join('')}</fieldset>`;
    if (f.type === 'select') return `<div class="desired-salary"><select class="salary-details"${req}>${f.options.map(option => `<option>${option}</option>`).join('')}</select></div>`;
    if (f.type === 'textarea') return `<label>${escape(f.label)}<textarea name="${name}"${req}></textarea></label>`;
    if (f.type === 'checkbox') return `<label><input type="checkbox" name="${name}"${req}>${escape(f.label)}</label>${f.id==='gdprAgreement'?'<a href="https://example-team.breezy.hr/privacy">Privacy Notice</a>':''}`;
    return `<li><label>${escape(f.label)}<input id="${id}" name="${name}" type="${f.type === 'email' || f.type === 'file' ? f.type : 'text'}"${req}${f.type === 'file' ? ' hidden' : ''}></label></li>`;
  }).join('')}${phase === 'initial' ? `<ul id="jobs-history"></ul><a href="#" ng-click="e.preventDefault(); addPosition()">Add Position</a><a href="#" ng-click="e.preventDefault(); addEducation()">Add Education</a>` : ''}</section>`).join('');
  return `<!doctype html><title>${breezy.title}</title><div data-friendly-id="${breezyFixtureFriendlyId}"><h1>${breezy.title}</h1><div class="application-form"><form name="form" novalidate><input type="hidden" name="${multistepFixtures[0].honeypotName}" value="${filledHoneypot ? 'synthetic trap' : ''}">${fields}
  <input name="hp_fixture"><div class="navigation-buttons"><button type="button" ng-click="nextSection()">Continue</button><button type="button" ng-click="apply()" hidden>Submit Application</button></div></form></div></div>
  <div class="confirmation-container" ng-show="applied" hidden><div class="application-confirmed"><h1>Application Submitted</h1></div></div>
  <script>
  const form=document.querySelector('form'), stages=[...form.querySelectorAll('[data-phase]')];
  let active=0; const next=form.querySelector('[ng-click="nextSection()"]'), send=form.querySelector('[ng-click="apply()"]');
  const selectors = { candidatePosition:['company_name','title','summary','date_start','date_end'], candidateSchool:['school_name','field_of_study','summary','date_start','date_end'] };
  for(const [action,model] of [['addPosition','candidatePosition'],['addEducation','candidateSchool']]) form.querySelector('a[ng-click*="'+action+'"]').addEventListener('click',e=>{
    e.preventDefault(); const row=document.createElement('li'); row.className='experience';
    for(const suffix of selectors[model]) { const item=document.createElement(suffix==='summary'?'textarea':'input'); if(suffix.startsWith('date'))item.type='date'; item.setAttribute('ng-model',model+'.'+suffix); row.append(item); }
    document.querySelector('#jobs-history').append(row);
  });
  next.addEventListener('click',()=>{
    const section=stages[active]; if([...section.querySelectorAll('input,select,textarea')].some(e=>!e.validity.valid)) return;
    section.hidden=true; active++;
    if(${tamperAfterStep} && active===1)form.elements.cName.value="Replaced after Continue";
    if(stages[active]?.dataset.phase==='va_id_number'&&form.elements['section_80000000_question_0'].value==='I do not have a VA ID') active++;
    if(stages[active]?.dataset.phase==='work_commitments_details'&&form.elements['section_80000004_question_0'].value==='No') active++;
    stages[active].hidden=false; next.hidden=active===stages.length-1; send.hidden=!next.hidden;
  });
  send.addEventListener('click',async()=>{
    const f=n=>form.elements[n], checked=[f('cName').value==='Synthetic Applicant', f('cEmail').value==='fixture@example.test',
      f('cResume').files[0]?.name==='fixture-resume.pdf',f('section_80000003_question_0').files[0]?.name==='fixture-cover.pdf',
      f('section_80000001_question_0').value==='SYNTH-42', f('section_80000005_question_0').value==='10',
      form.querySelector('[ng-model="candidatePosition.company_name"]').value==='Fixture Employer', form.querySelector('[ng-model="candidatePosition.date_start"]').value==='2020-01-02',
      form.querySelector('[ng-model="candidateSchool.school_name"]').value==='Fixture School', f('gdprAgreement').checked, !f('smsConsent').checked, !f('hp_fixture').value];
    const receipt=await fetch('/synthetic-breezy-submit',{method:'POST',body:JSON.stringify(checked)});
    if(receipt.ok){form.hidden=true;document.querySelector('.confirmation-container').hidden=false;}
  });</script>`;
}

function google_formPage() {
  const metadata = [null, [null, google_form.fields.slice(1).map(f => [Number(f.id), f.label, null, 0, [[f.entry, f.options.map(x => [x]), 0]]])]];
  return `<!doctype html><title>${google_form.title}</title><h1>${google_form.title}</h1><form method="post" action="${google_form.url.replace('/viewform','/formResponse')}">${google_form.fields.map(f => `<div role="listitem"><div role="heading">${escape(f.id==='email' ? 'Email *' : f.label)}</div>${f.type==='radio' ? f.options.map(o=>`<div role="radio" aria-checked="false" aria-label="${o}">${o}</div>`).join('') : f.type==='textarea' ? `<textarea name="field-${f.id}"></textarea>` : `<input type="${f.type==='email'?'email':'text'}" name="field-${f.id}"${f.id==='email'?' required':''}>`}</div>`).join('')}
    <div role="button" tabindex="0">Submit</div></form><script>window.FB_PUBLIC_LOAD_DATA_=${JSON.stringify(metadata)}; document.querySelector('[role=button]').onclick=()=>document.querySelector('form').requestSubmit();</script>`;
}

test('invalid or unavailable private targets stop before a browser connection', async () => {
  const configPath = join(fixtureHome, 'multistep-targets.json');
  const options = { cdpUrl: 'http://127.0.0.1:1' };
  try {
    await rm(configPath);
    expect(await discoverMultistep(work(breezy), options)).toEqual({ kind: 'failed', code: 'unsupported_portal' });
    for (const value of [
      JSON.stringify([multistepFixtures[0], multistepFixtures[0]]),
      JSON.stringify([{ ...multistepFixtures[0], respondent: 'https://unsafe.example.test/apply' }]),
      JSON.stringify([{ ...multistepFixtures[2], url: 'https://unsafe.example.test/fixtureShort02' }]),
      ...multistepFixtures.slice(0, 2).map(fixture => JSON.stringify([{ ...fixture, title: undefined }])),
      '{',
    ]) {
      await writeFile(configPath, value, { mode: 0o600 });
      expect(multistepTarget(breezyUrl)).toBeUndefined();
      expect(multistepTarget(google_account_formUrl)).toBeUndefined();
    }
    await writeFile(configPath, JSON.stringify(multistepFixtures));
    await chmod(configPath, 0o644);
    expect(multistepTarget(breezyUrl)).toBeUndefined();
  } finally {
    await writeFile(configPath, JSON.stringify(multistepFixtures));
    await chmod(configPath, 0o600);
  }
});

test('the résumé link exception belongs to the reviewed posting', () => {
  expect(publicResumeLinkField(google_form.listingUrl)).toBe(multistepFixtures[1].resumeLinkFieldId);
  expect(publicResumeLinkField(breezyUrl)).toBeUndefined();
  expect(publicResumeLinkField(google_form.listingUrl + '?changed=1')).toBeUndefined();
});

test('the manual-only account profile loads without a page title', () => {
  const target = multistepTarget(google_account_formUrl);
  expect(target?.portal).toBe('google_account_form');
  expect(target).not.toHaveProperty('title');
});

test('only exact audited posting identities enter multistep adapters', () => {
  expect(multistepTarget(breezyUrl)?.portal).toBe('breezy');
  expect(multistepTarget(google_formUrl)?.portal).toBe('google_form');
  expect(multistepTarget(google_account_formUrl)?.portal).toBe('google_account_form');
  expect(multistepTarget(breezyUrl + '?destination=other')).toBeUndefined();
  expect(multistepTarget('https://example-team.breezy.hr/p/other-job')).toBeUndefined();
  expect(multistepTarget('https://docs.google.com/forms/d/e/arbitrary/viewform')).toBeUndefined();
});

const runner = process.env.QS_JOBS_TEST_BROWSER_USE;
test.skipIf(!runner)('real Chrome verifies staged Breezy input and receipts, Google links, and account gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-multistep-fixture-'));
  const cert = join(root,'cert.pem'), key = join(root,'key.pem');
  const tls = Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',cert,'-days','1']);
  expect(tls.exitCode).toBe(0);
  const pub = Bun.spawnSync(['openssl','x509','-in',cert,'-pubkey','-noout']);
  const der = Bun.spawnSync(['openssl','pkey','-pubin','-outform','der'],{stdin:pub.stdout});
  const spki = createHash('sha256').update(der.stdout).digest('base64');
  const html = (body: string) => new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  const observed = { breezy: 0, google_form: 0 };
  let tamperBreezy = false;
  let filledHoneypot = false;
  let wrongAccountOrigin = false;
  const server = Bun.serve({ hostname:'127.0.0.1', port:0, tls:{key:Bun.file(key),cert:Bun.file(cert)}, async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname==='example-team.breezy.hr' && url.pathname===new URL(breezy.url).pathname) return html(breezyPage(tamperBreezy, filledHoneypot));
    if (url.hostname==='example-team.breezy.hr' && url.pathname==='/synthetic-breezy-submit' && req.method==='POST') {
      observed.breezy++;
      const checks = await req.json() as boolean[];
      return new Response(null,{status: checks.length===12 && checks.every(Boolean) ? 204 : 400});
    }
    if (url.href===google_form.url) return html(google_formPage());
    if (url.href===google_form.url.replace('/viewform','/formResponse') && req.method==='POST') {
      observed.google_form++;
      const data = await req.formData();
      if (data.get('field-email')==='fixture@example.test' && data.get('field-80000008')==='https://example.test/synthetic-resume.pdf') {
        return html('<main><p class="vHW8K">Your response has been recorded.</p></main>');
      }
      return new Response('Synthetic receipt did not match',{status:400});
    }
    if (url.href === google_account_form.url) {
      const host = wrongAccountOrigin ? 'wrong-account.example.test' : 'accounts.google.com';
      return Response.redirect(`https://${host}/v3/signin/identifier?continue=${encodeURIComponent(google_account_form.respondent+'?usp=send_form')}`, 303);
    }
    if (['accounts.google.com', 'wrong-account.example.test'].includes(url.hostname) && url.pathname==='/v3/signin/identifier') return html('<h1>Sign in</h1>');
    return new Response('Fixture not found',{status:404});
  }});
  const chrome = Bun.spawn([process.env.QS_JOBS_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--disable-background-networking','--no-first-run','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${join(root,'chrome')}`,`--ignore-certificate-errors-spki-list=${spki}`,
    `--host-resolver-rules=${['example-team.breezy.hr','docs.google.com','forms.gle','accounts.google.com','wrong-account.example.test'].map(h=>`MAP ${h} 127.0.0.1:${server.port}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE localhost`,'about:blank'], {stdout:'ignore',stderr:'ignore'});
  try {
    let port = '';
    for (let i=0;i<50&&!port;i++) {
      [port] = (await readFile(join(root,'chrome','DevToolsActivePort'),'utf8').catch(()=> '')).split('\n');
      if (!port) await Bun.sleep(100);
    }
    expect(port).toMatch(/^\d+$/);
    const pdfPath=join(root,'fixture-resume.pdf'), coverPath=join(root,'fixture-cover.pdf'), privateConfigPath=join(root,'private.json');
    const resume='%PDF-synthetic-resume', cover='%PDF-synthetic-cover';
    await Promise.all([writeFile(pdfPath,resume),writeFile(coverPath,cover)]);
    const options = { cdpUrl:`http://127.0.0.1:${port}`, browserUseCommand:runner, pdfPath, privateConfigPath };
    const personal = { firstName:'Synthetic', lastName:'Applicant', phone:'555-0100', email:'fixture@example.test' };
    const fields = Object.fromEntries(breezy.fields.filter(f=>!f.key&&f.required).map(f=>[f.label,{
      type: f.type==='checkbox'?'boolean':f.type==='radio'||f.type==='select'?'option':'text',
      value: f.type==='checkbox'?true:f.options[0]??(f.type==='number'?'25':f.id==='section_80000001_question_0'?'SYNTH-42':f.id==='section_80000005_question_0'?'10':'Fixture fact'),
    }]));
    const profile = {
      personal,
      answers: { [breezyUrl]: { ...fields, 'Work History':{ type:'records',value:[{company:'Fixture Employer',title:'Fixture Role',startDate:'2020-01-02'}]},
        Education:{type:'records',value:[{school:'Fixture School',field:'Fixture Studies'}]} } },
      coverLetters:{[breezyUrl]:{path:coverPath,approved:true,pdfSha256:hash(cover)}},
    };
    await writeFile(privateConfigPath,JSON.stringify({personal}));
    expect(await discoverMultistep(work(breezy),options)).toMatchObject({kind:'discovered',fields:expect.arrayContaining([expect.objectContaining({label:privacy()}),expect.objectContaining({label:'Work History'})])});
    expect(await submitMultistep(work(breezy),options)).toMatchObject({kind:'failed',block:'privacy_agreement',gate:{kind:'privacy_agreement'},attention:{questions:expect.arrayContaining([expect.objectContaining({label:privacy()})])}});
    expect(await submitMultistep(work(google_form),options)).toMatchObject({kind:'failed',block:'public_resume_link_required'});
    expect(await discoverMultistep(work(google_account_form),options)).toMatchObject({kind:'failed',gate:{kind:'authentication',url:`${google_account_form.respondent}?usp=send_form`}});
    let accountSubmitChecks = 0;
    expect(await submitMultistep(work(google_account_form), { ...options, beforeSubmit: async () => { accountSubmitChecks++; } }))
      .toMatchObject({ kind: 'failed', code: 'manual_required', block: 'google_sign_in_required' });
    expect(accountSubmitChecks).toBe(0);
    wrongAccountOrigin = true;
    expect(await discoverMultistep(work(google_account_form), options)).toEqual({ kind: 'failed', code: 'identity_mismatch' });
    wrongAccountOrigin = false;
    filledHoneypot = true;
    expect(await discoverMultistep(work(breezy), options)).toEqual({ kind: 'failed', code: 'manual_required' });
    filledHoneypot = false;
    expect(observed).toEqual({breezy:0,google_form:0});
    await writeFile(privateConfigPath,JSON.stringify(profile));
    tamperBreezy = true;
    expect(await submitMultistep(work(breezy),options)).toMatchObject({kind:'failed',block:'form_shape_unverified'});
    expect(observed.breezy).toBe(0);
    tamperBreezy = false;
    expect(await submitMultistep(work(breezy),options)).toEqual({kind:'applied',receiptCode:'confirmation_message'});
    const link = {url:'https://example.test/synthetic-resume.pdf',publicShareApproved:true,pdfSha256:hash(resume)};
    await writeFile(privateConfigPath,JSON.stringify({...profile,resumeLinks:{[google_formUrl]:{...link,pdfSha256:hash(cover)}}}));
    expect(await submitMultistep(work(google_form),options)).toMatchObject({kind:'failed',block:'public_resume_link_required'});
    expect(observed.google_form).toBe(0);
    await writeFile(privateConfigPath,JSON.stringify({...profile,resumeLinks:{[google_formUrl]:link}}));
    expect(await submitMultistep(work(google_form),options)).toEqual({kind:'applied',receiptCode:'confirmation_message'});
    expect(observed).toEqual({breezy:1,google_form:1});
  } finally { chrome.kill(); await chrome.exited; server.stop(true); await rm(root,{recursive:true,force:true}); }
}, 60_000);
