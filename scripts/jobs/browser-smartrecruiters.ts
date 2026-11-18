import { join, resolve } from 'node:path';
import { z } from 'zod';
import { browserSubmitGate, runBrowser, runBrowserProgram, withBrowser,
  type BrowserConnection, type BrowserDiscovery, type BrowserOptions, type BrowserResult, type BrowserSubmitWork } from './browser';
import { jobsHome } from './config';
import { readPrivatePostingFile } from './private-posting-file';

const host = 'jobs.smartrecruiters.com';
const postingUrl = z.string().max(2_048).refine(value => {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && url.hostname === host && url.href === value &&
    !url.username && !url.password && !url.port && !url.hash;
});
const targetSchema = z.strictObject({
  sourceUrl: postingUrl.refine(value => {
    const url = URL.parse(value);
    return !!url && /^\/[\w-]+\/[\w-]+$/.test(url.pathname) && !url.search;
  }),
  url: postingUrl.refine(value => /^\/oneclick-ui\/company\/[\w-]+\/publication\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(URL.parse(value)?.pathname ?? '')),
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  listingTitle: z.string().min(1).max(400),
  applicationTitle: z.string().min(1).max(400),
});
type SmartRecruitersTarget = z.infer<typeof targetSchema>;

export function smartRecruitersTarget(sourceUrl: string) {
  if (URL.parse(sourceUrl)?.hostname !== host) return;
  try {
    const configured = readPrivatePostingFile(join(jobsHome(), 'smartrecruiters-target.json'), {
      maxBytes: 8 * 1024, missing: 'allow', errorCode: 'invalid_smartrecruiters_target',
    });
    const target = targetSchema.safeParse(configured);
    if (target.success && target.data.sourceUrl === sourceUrl) return target.data;
  } catch { /* Unavailable private configuration disables this adapter. */ }
}

const notice = 'Please be informed that your application to this job offer will trigger some processing of your personal data by the recruiting company, the data controller. SmartRecruiters, the data processor, has no control over such personal data processing. For more information on these personal data processing, please refer to the recruiting company’s privacy notice.';
const field = <T extends 'text' | 'email' | 'tel' | 'combobox' | 'file' | 'checkbox'>(
  id: string, label: string, type: T, options: string[] = [],
) => ({ id, label, type, options, required: true });
const fields = [
  field('first-name-input', 'First name', 'text'),
  field('last-name-input', 'Last name', 'text'),
  field('email-input', 'Email', 'email'),
  field('confirm-email-input', 'Confirm your email', 'email'),
  field('location-autocomplete', 'City', 'combobox'),
  field('phone-country', 'Phone country calling code', 'combobox', ['Canada +1', 'United States +1']),
  field('phone-number', 'Phone number', 'tel'),
  field('resume-upload', 'Resume', 'file'),
  field('noPolicy', notice, 'checkbox'),
];
function parameters({ sourceUrl, url, role, listingTitle, applicationTitle }: SmartRecruitersTarget) {
  const gate = { kind: 'privacy_agreement', url } as const;
  return { sourceUrl, url, role, listingTitle, applicationTitle, notice, gate, fields };
}
const unavailable = { kind: 'failed', code: 'runner_unavailable' } as const;

const program = String.raw`
import json
import os
import re
import time
from pathlib import Path

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
started = False
uncertain = False
context = None

def emit(status, **data):
    print(json.dumps({'qsJobsBrowser':status, **data}), flush=True)

${browserSubmitGate}

def expression(body, data=None):
    config = {key:p[key] for key in ('url','role','notice','applicationTitle')}
    config['data'] = data
    return '''(p => {
      if (location.href !== p.url || document.title !== p.applicationTitle) return null;
      const one = (root, selector) => {
        const matches = root?.querySelectorAll(selector);
        return matches?.length === 1 ? matches[0] : null;
      };
      const shown = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
      const squash = t => t.trim().replace(/\s+/g, ' ');
      const required = e => e?.required || e?.getAttribute('aria-required') === 'true';
      const label = e => squash([...(e?.labels ?? [])].map(l => l.textContent).join(' ') ||
        e?.getAttribute('aria-label') || '').replace(/\s*\*$/, '');
      const app = one(document, 'oc-app-root');
      const root = one(app, 'oc-oneclick-form');
      const native = (host, selector) => one(host?.shadowRoot, selector);
      const text = (id, type, caption) => {
        const e = native(one(root, 'spl-input#' + id), 'input#' + id + '[type=' + type + ']');
        return shown(e) && required(e) && label(e) === caption ? e : null;
      };
      const personal = {
        firstName:text('first-name-input','text','First name'),
        lastName:text('last-name-input','text','Last name'),
        email:text('email-input','email','Email'),
        confirmEmail:text('confirm-email-input','email','Confirm your email'),
      };
      const city = one(root, 'oc-location-autocomplete spl-autocomplete[data-test=location-autocomplete][required]');
      const cityInput = native(native(city, 'spl-input[required]'), 'input[type=text][role=combobox]');
      const cityMenu = native(city, 'div[role=listbox][data-sr-id=location-autocomplete-search-menu]');
      const phone = one(root, 'oc-phone-number spl-phone-field[required]');
      const phoneInput = native(native(phone, 'spl-input.c-spl-phone-field-input[type=tel]'), 'input[type=tel]');
      const dial = native(phone, 'spl-select[splarialabel="Country code"]');
      const dialButton = native(dial, 'button[role=combobox]');
      const upload = one(root, 'oc-resume-upload spl-dropzone[data-test=resume-upload]');
      const file = native(upload, 'input[type=file]');
      const consent = one(root, 'oc-no-policy-decision spl-checkbox#noPolicy[required]');
      const checkbox = native(consent, 'input#noPolicy[type=checkbox][aria-required=true]');
      const submit = native(one(app, 'oc-nav-first-page footer[data-test=footer] oc-button[data-test=footer-submit] spl-button'), 'button[type=button]');
      const walk = parent => [...parent.querySelectorAll('*')].flatMap(e => e.shadowRoot ? [e, ...walk(e.shadowRoot)] : [e]);
      const expected = [...Object.values(personal), cityInput, phoneInput, checkbox];
      if (!root || ![...document.querySelectorAll('oc-app-root h1')].some(e => shown(e) && squash(e.textContent) === p.role) ||
          !expected.every(e => shown(e) && required(e)) || label(cityInput) !== 'City' || label(phoneInput) !== 'Phone number' ||
          !cityMenu || !shown(dialButton) || !file || file.multiple || !file.accept.split(',').some(t => t.trim() === '.pdf') ||
          squash(consent.textContent) !== p.notice || !shown(submit) || submit.form ||
          walk(root).some(e => e.matches('input,select,textarea') && required(e) && !expected.includes(e))) return null;
      const country = code => {
        if (!['CA','US'].includes(code)) return null;
        const e = one(dial, 'spl-select-option[value=' + code + ']');
        return e && squash(e.textContent) === (code === 'CA' ? 'Canada +1' : 'United States +1') ? e : null;
      };
      const enter = (e, value) => {
        if (!shown(e) || e.disabled || e.readOnly) return false;
        e.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value);
        e.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
        e.dispatchEvent(new Event('change', {bubbles:true, composed:true}));
        return e.value === value;
      };
      const cityMatches = value => Boolean(city.value && cityInput.value === value && cityInput.getAttribute('aria-expanded') !== 'true');
      const valid = e => !e.disabled && !e.readOnly && e.getAttribute('aria-invalid') !== 'true' && e.validity.valid;
      const verified = v => Object.entries(personal).every(([key,e]) => valid(e) && e.value === v[key]) &&
        valid(cityInput) && cityMatches(v.city) && valid(phoneInput) && phoneInput.value.replace(/\D/g,'') === v.phone &&
        country(v.country)?.selected === true && checkbox.checked && checkbox.getAttribute('aria-invalid') !== 'true';
      const attached = filename => file.files.length === 1 && file.files[0].name === filename ||
        [...upload.shadowRoot.querySelectorAll('ul.c-spl-file-list *')].some(e =>
          !e.children.length && shown(e) && e.textContent.trim() === filename);
    ''' + body + '})(' + json.dumps(config) + ')'

def site(body, data=None):
    return js(expression(body, data))

def attention(questions=(), variables=(), gate=None):
    emit('manual_required', questions=list(questions), variables=list(variables), **({'gate':gate} if gate else {}))

def open_form():
    goto_url(p['sourceUrl'])
    wait_for_load()
    if not js('''(p => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible';
      const links = [...document.querySelectorAll('a[href*="oneclick-ui"]')].filter(e => visible(e) && e.textContent.trim() === "I'm interested");
      return location.href === p.sourceUrl && document.title === p.listingTitle &&
        [...document.querySelectorAll('h1')].some(e => visible(e) && e.textContent.trim() === p.role) &&
        links.length > 0 && links.every(e => e.href === p.url);
    })(''' + json.dumps({key:p[key] for key in ('sourceUrl','url','role','listingTitle')}) + ')'):
        return False
    goto_url(p['url'])
    wait_for_load()
    for _ in range(40):
        if site('return Boolean(country("CA") && country("US"));') is True:
            return True
        time.sleep(.25)
    return False

def select_option(open_action, pick_action, verify_action, value):
    if site(verify_action, value) is True:
        return True
    if not site(open_action, value):
        return False
    for _ in range(16):
        if site(pick_action, value):
            return site(verify_action, value) is True
        time.sleep(.25)
    return False

def submit():
    global started, uncertain
    private = json.loads(Path(p['privateConfigPath']).read_text())
    personal = private['personal']
    answers = private.get('answers', {}).get(p['sourceUrl'], {})
    by_id = {f['id']:f for f in p['fields']}
    def answer(key, kind):
        item = answers.get(key)
        return item.get('value') if isinstance(item,dict) and item.get('type') == kind else None
    values = {key:personal.get(key) for key in ('firstName','lastName','email','phone')}
    missing = [key for key,value in values.items() if not isinstance(value,str) or
               not 0 < len(value.strip()) <= 200 or any(c in value for c in '\r\n\0')]
    questions = []
    city = answer('City','option')
    if not isinstance(city,str) or not 3 <= len(city.strip()) <= 200 or any(c in city for c in '\r\n\0'):
        questions.append(by_id['location-autocomplete'])
    dial = answer('Phone country calling code','option')
    if dial is None:
        dial = {'Canada':'Canada +1','CA':'Canada +1','United States':'United States +1','US':'United States +1'}.get(personal.get('country'))
    if dial not in ('Canada +1','United States +1'):
        questions.append(by_id['phone-country'])
    consent = answer(p['notice'],'boolean') is True
    if not consent:
        questions.append(by_id['noPolicy'])
    if questions or missing:
        return attention(questions,missing,None if consent else p['gate'])
    values = {key:value.strip() for key,value in values.items()}
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', values['email']):
        return attention(variables=['email'])
    raw = values['phone']
    digits = re.sub(r'\D','',raw)
    if raw.startswith('+') and len(digits)==11 and digits.startswith('1'):
        digits=digits[1:]
    if len(digits) != 10 or not re.fullmatch(r'\+?[\d ().-]+',raw):
        return attention(variables=['phone'])
    values.update(confirmEmail=values['email'], city=city.strip(), country='CA' if dial=='Canada +1' else 'US', phone=digits)
    file = Path(p['pdfPath'])
    if not file.is_file() or file.suffix.lower() != '.pdf':
        return emit('runner_unavailable')
    if not site('return !checkbox.checked && Object.values(personal).every(e => !e.value) && !cityInput.value && !phoneInput.value && !file.files.length;'):
        return attention()
    started = True
    emit('write_started')
    if not site('return Object.entries(personal).every(([key,e]) => enter(e,p.data[key]));', values):
        return attention()
    if not select_option('dialButton.click(); return true;',
        'const option=country(p.data); if (!shown(option)) return false; option.click(); return true;',
        'return country(p.data)?.selected === true;',values['country']):
        return attention()
    if not site('return enter(phoneInput,p.data);',digits):
        return attention()
    if not select_option('return enter(cityInput,p.data);',
        '''const options=[...cityMenu.querySelectorAll('[role=option]')].filter(e =>
          shown(e) && e.getAttribute('aria-disabled') !== 'true' && squash(e.textContent) === p.data);
          if (options.length !== 1) return false; options[0].click(); return true;''',
        'return cityMatches(p.data);',values['city']):
        return attention([by_id['location-autocomplete']])
    if not site('if (!checkbox.checked) checkbox.click(); return verified(p.data);', values):
        return attention()
    handle = cdp('Runtime.evaluate', expression=expression('return file;'), returnByValue=False).get('result', {}).get('objectId')
    if not handle:
        return attention()
    cdp('DOM.setFileInputFiles', objectId=handle, files=[str(file)])
    data = {'values':values,'filename':file.name}
    for _ in range(20):
        if site('return verified(p.data.values) && attached(p.data.filename);', data):
            break
        time.sleep(.25)
    else:
        return attention()
    if not await_submit_ack():
        return emit('runner_unavailable')
    uncertain = True
    site('''if (!verified(p.data.values) || !attached(p.data.filename) || submit.disabled ||
             submit.getAttribute('aria-disabled')==='true') return false;
            submit.click(); return true;''', data)
    emit('submission_uncertain')

try:
    context = cdp('Target.createBrowserContext')['browserContextId']
    target = cdp('Target.createTarget', url='about:blank', browserContextId=context, background=True)['targetId']
    switch_tab(target)
    if not open_form():
        emit('manual_required')
    elif p.get('mode') == 'discover':
        emit('discovered')
    else:
        submit()
except Exception:
    uncertain = started
    emit('submission_uncertain' if started else 'runner_unavailable')
finally:
    if context and not uncertain:
        try:
            cdp('Target.disposeBrowserContext', browserContextId=context)
        except Exception:
            pass
`;

type Identity = Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>;
const matches = (work: Identity, target: SmartRecruitersTarget) => work.sourceUrl === target.sourceUrl &&
  (work.company === undefined && work.role === undefined || work.company === target.company && work.role === target.role);

export async function discoverSmartRecruiters(work: Identity, options: BrowserConnection, target: SmartRecruitersTarget): Promise<BrowserDiscovery> {
  if (!matches(work, target)) return { kind: 'failed', code: 'identity_mismatch' };
  const params = parameters(target);
  return withBrowser<BrowserDiscovery>(options, { ...params, mode: 'discover' }, unavailable, async (command, env, cwd) => {
    const { exitCode, messages } = await runBrowserProgram(command, env, cwd, program);
    if (exitCode !== 0) return unavailable;
    if (messages.length === 1 && JSON.stringify(messages[0]) === '{"qsJobsBrowser":"discovered"}') {
      return { kind: 'discovered', listingUrl: target.sourceUrl, fields, gate: params.gate };
    }
    return { kind: 'failed', code: 'manual_required' };
  });
}

export async function submitSmartRecruiters(work: BrowserSubmitWork,
  options: BrowserOptions, target: SmartRecruitersTarget): Promise<BrowserResult> {
  if (!matches(work, target)) return { kind: 'failed', code: 'manual_required' };
  return withBrowser<BrowserResult>(options, { ...parameters(target), pdfPath: resolve(options.pdfPath),
    privateConfigPath: resolve(options.privateConfigPath) }, unavailable,
  (command, env, cwd) => runBrowser(command, env, cwd, program, options.beforeSubmit));
}
