import { resolve } from 'node:path';
import { z } from 'zod';
import { accountTabProgram, withAccountBrowser } from './browser-accounts';
import { exactBrowserPosting, readBrowserConfig, reviewedBrowserUrl } from './private-browser-config';
import { browserSubmitGate, runBrowserProgram, withBrowser, type BrowserConnection, type BrowserDiscovery, type BrowserGate,
  type BrowserOptions, type BrowserResult, type BrowserSubmitWork } from './browser';

const question = z.object({
  id: z.string().regex(/^[A-Za-z\d_][A-Za-z\d_:.\[\]-]{0,100}$/), label: z.string().min(1).max(400),
  type: z.enum(['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'textarea', 'select', 'combobox', 'combobox-multi', 'checkbox', 'checkbox-group', 'radio']),
  required: z.boolean(), options: z.array(z.string().min(1).max(200)).max(30),
}).strict();
type Question = z.infer<typeof question>;
type PlannedField = Question & { selector?: string; key?: string; entry?: number; phase?: string };
const variables = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'region', 'country', 'postalCode', 'addressLine1', 'linkedin', 'website'] as const;
const blocks = ['candidate_facts_missing', 'form_shape_unverified', 'public_resume_link_required', 'cover_letter_required', 'privacy_agreement', 'google_sign_in_required', 'browser_challenge'] as const;
type Block = typeof blocks[number];
type MultistepFailure = Extract<BrowserResult, { kind: 'failed' }> & { block?: Block };
const status = z.object({ qsJobsBrowser: z.enum(['write_started', 'confirmation_page', 'confirmation_message', 'manual_required', 'identity_mismatch', 'runner_unavailable', 'submission_uncertain']) }).strict();
const report = z.object({ qsJobsBrowser: z.literal('manual_required'), block: z.enum(blocks), questions: z.array(question).max(40), variables: z.array(z.enum(variables)).max(12) }).strict();
const discovery = z.object({ qsJobsBrowser: z.literal('discovered'), fields: z.array(question).max(40) }).strict();

const plannedField = question.extend({
  selector: z.string().min(1).max(240).optional(),
  key: z.enum([...variables, 'resume', 'coverLetter', 'publicResume']).optional(),
  entry: z.number().int().positive().max(2_147_483_647).optional(),
  phase: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
});
const text = z.string().trim().min(1).max(400);
const commonTarget = z.strictObject({
  listingUrl: reviewedBrowserUrl,
  url: reviewedBrowserUrl,
  respondent: reviewedBrowserUrl,
  companies: z.array(text).min(1).max(10),
  role: text,
  fields: z.array(plannedField).max(40),
});
const targetSchema = z.discriminatedUnion('portal', [
  commonTarget.extend({ portal: z.literal('breezy'), title: text, formSelector: text,
    historyFields: z.tuple([plannedField, plannedField]), consentText: text,
    privacyUrl: reviewedBrowserUrl, honeypotName: text, coverLetterFieldId: text, consentFieldId: text,
    branches: z.record(z.string().regex(/^[a-z0-9_-]{1,40}$/), z.strictObject({ fieldId: text, equals: text })) }),
  commonTarget.extend({ portal: z.literal('google_form'), title: text, resumeLinkFieldId: text }),
  commonTarget.extend({ portal: z.literal('google_account_form'), title: text.optional() }),
]).superRefine((target, context) => {
  const listing = new URL(target.listingUrl);
  const respondent = new URL(target.respondent);
  const apply = new URL(target.url);
  const fail = () => context.addIssue({ code: 'custom', message: 'Unverified form target' });
  if (listing.search || respondent.search || (apply.search && target.portal !== 'google_account_form')) fail();
  if (new Set(target.fields.map(field => field.id)).size !== target.fields.length) fail();
  if (target.portal === 'breezy') {
    if (!listing.hostname.endsWith('.breezy.hr') || respondent.origin !== listing.origin ||
        apply.href !== respondent.href || respondent.pathname !== listing.pathname.replace(/\/$/, '') + '/apply' ||
        !target.fields.length || !target.fields.every(field => field.selector && field.phase) ||
        !Object.entries(target.branches).every(([phase, branch]) => target.fields.some(field => field.phase === phase) &&
          target.fields.some(field => field.id === branch.fieldId && field.options.includes(branch.equals))) ||
        !target.fields.some(field => field.id === target.coverLetterFieldId && field.type === 'file') ||
        !target.fields.some(field => field.id === target.consentFieldId && field.type === 'checkbox')) fail();
    return;
  }
  if (respondent.hostname !== 'docs.google.com' ||
      !/^\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]+\/viewform$/.test(respondent.pathname)) fail();
  if (target.portal === 'google_form') {
    if (apply.href !== respondent.href ||
        !target.fields.every(field => field.selector || field.entry || field.key) ||
        !target.fields.some(field => field.id === target.resumeLinkFieldId && field.type === 'url')) fail();
  } else {
    const shortLink = apply.hostname === 'forms.gle' && /^\/[A-Za-z0-9_-]+$/.test(apply.pathname) && !apply.search;
    if (target.fields.length || (!shortLink && ![respondent.href, respondent.href + '?usp=send_form'].includes(apply.href))) fail();
  }
});
const targetList = z.array(targetSchema).max(50).refine(targets =>
  new Set(targets.map(target => exactBrowserPosting(target.listingUrl))).size === targets.length);
type Target = z.infer<typeof targetSchema>;

export function readMultistepTargets() {
  return readBrowserConfig('multistep-targets.json', targetList) ?? [];
}

export function multistepTarget(sourceUrl: string, targets = readMultistepTargets()): Target | undefined {
  const source = exactBrowserPosting(sourceUrl);
  if (!source || new URL(source).search) return;
  return targets.find(target => exactBrowserPosting(target.listingUrl) === source);
}

export function publicResumeLinkField(sourceUrl: string, targets?: Target[]) {
  const target = multistepTarget(sourceUrl, targets);
  if (target?.portal === 'google_form') return target.resumeLinkFieldId;
}

const program = String.raw`
import hashlib, ipaddress, json, os, re, time, unicodedata
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
context = None
started = False
clicked = False


def emit(status, **fields):
    print(json.dumps({'qsJobsBrowser': status, **fields}), flush=True)

${browserSubmitGate}

def missing(block, fields=(), variables=()):
    safe = [{k: f[k] for k in ('id', 'label', 'type', 'required', 'options')} for f in fields]
    emit('manual_required', block=block, questions=safe[:40], variables=list(dict.fromkeys(variables))[:12])
    return None


def same_form(raw, response=False):
    found, expected = urlsplit(raw or ''), urlsplit(p['respondent'])
    path = expected.path.replace('/viewform', '/formResponse') if response and p['portal'] != 'breezy' else expected.path
    return (found.scheme == 'https' and found.netloc == expected.netloc and found.path == path and not found.fragment
            and all(key == 'usp' and len(values) == 1 and values[0] in ('send_form', 'sharing', 'header') for key, values in parse_qs(found.query, keep_blank_values=True).items())
            and (p['portal'] != 'breezy' or not found.query))


def authenticated_gate(raw):
    parsed = urlsplit(raw or '')
    continuation = parse_qs(parsed.query).get('continue', [])
    return (parsed.scheme == 'https' and parsed.netloc == 'accounts.google.com' and parsed.path in ('/v3/signin/identifier', '/ServiceLogin')
            and len(continuation) == 1 and same_form(continuation[0]))


def safe_url(raw):
    if not isinstance(raw, str) or not 0 < len(raw) <= 2048 or any(c.isspace() for c in raw):
        return False
    parsed = urlsplit(raw)
    host = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', host):
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        return not re.search(r'(?:^|\.)(?:localhost|local|internal|home\.arpa)$', host)


def text_value(value, multiline=False, length=255):
    return (isinstance(value, str) and 0 < len(value.strip()) <= length and '\0' not in value and
            (multiline or not any(c in value for c in '\r\n')))


def local_pdf(raw, limit=12*1024*1024):
    if not isinstance(raw, str) or not Path(raw).is_absolute():
        return None
    file = Path(raw)
    if file.is_symlink() or not file.is_file() or file.suffix.lower() != '.pdf' or not 5 <= file.stat().st_size <= limit:
        return None
    data = file.read_bytes()
    if not data.startswith(b'%PDF-'):
        return None
    return (file, hashlib.sha256(data).hexdigest())


def approved_resume_link(private, pdf):
    link = private.get('resumeLinks', {}).get(p['listingUrl'])
    if not isinstance(link, dict) or set(link) != {'url', 'publicShareApproved', 'pdfSha256'} or link['publicShareApproved'] is not True or not pdf:
        return None
    return link['url'] if safe_url(link['url']) and link['pdfSha256'] == pdf[1] else None


def approved_cover(private, pdf):
    letter = private.get('coverLetters', {}).get(p['listingUrl'])
    if not isinstance(letter, dict) or set(letter) != {'path', 'approved', 'pdfSha256'} or letter['approved'] is not True:
        return None
    file = local_pdf(letter['path'])
    return file[0] if file and file[1] == letter['pdfSha256'] and (not pdf or file[1] != pdf[1]) else None


def records(value, names):
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        return None
    out = []
    for row in value:
        if not isinstance(row, dict) or not set(row) <= set(names) | {'summary','startDate','endDate'} or any(not text_value(row.get(n)) for n in names):
            return None
        if 'summary' in row and not text_value(row['summary'], True, 2000):
            return None
        for key in ('startDate', 'endDate'):
            if key in row:
                try:
                    if date.fromisoformat(row[key]).isoformat() != row[key]:
                        return None
                except (ValueError, TypeError):
                    return None
        if row.get('startDate') and row.get('endDate') and row['startDate'] > row['endDate']:
            return None
        out.append({k: v.strip() for k,v in row.items()})
    return out


def choice(field, answers, private_values):
    kind = field['type']
    if field.get('key'):
        raw = private_values.get(field['key'])
    else:
        data = answers.get(field['label'])
        tag = 'boolean' if kind == 'checkbox' else 'option' if kind in ('radio','select') else 'text'
        raw = data.get('value') if isinstance(data, dict) and set(data) == {'type','value'} and data['type'] == tag else None
    if kind == 'checkbox':
        return raw if isinstance(raw, bool) and (raw or not field['required']) else None
    if kind in ('radio','select'):
        return raw if raw in field['options'] else None
    if kind == 'file':
        return raw if isinstance(raw, Path) else None
    if not text_value(raw, kind == 'textarea', 2000 if kind in ('textarea','url') else 255):
        return None
    raw = raw.strip()
    if kind == 'number' and not re.fullmatch(r'\d{1,7}(?:\.\d{1,2})?', raw):
        return None
    if kind == 'email' and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', raw):
        return None
    if kind == 'url' and not safe_url(raw):
        return None
    return raw


def dom(operation, **arguments):
    payload = json.dumps({'operation':operation,'arguments':arguments,'target':p['respondent'],'portal':p['portal'],'title':p['title'],
                          'formSelector':p.get('formSelector'), 'fields':p['fields'],'consentText':p.get('consentText'), 'privacyUrl':p.get('privacyUrl'), 'honeypotName':p.get('honeypotName')})
    return js(r'''(p => {
      const { operation, arguments: a, fields, portal, target } = p;
      const squish = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
      const shown = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden=true]'));
      const unique = (root, s) => { const all = root ? [...root.querySelectorAll(s)] : []; return all.length === 1 ? all[0] : null; };
      const challenge = [...document.querySelectorAll('iframe, input[type=password]')].some(e => shown(e) &&
        (e.type === 'password' || (e.offsetHeight > 90 && /captcha|challenge/i.test(e.title + ' ' + e.src))));
      const expected = new URL(target);
      if (location.origin !== expected.origin || location.hash) return null;
      if (operation === 'receipt') {
        if (challenge) return null;
        if (portal === 'breezy') {
          if (location.pathname !== expected.pathname || location.search) return false;
          const receipt = unique(document, '.confirmation-container[ng-show="applied"] .application-confirmed h1');
          const form = unique(document, p.formSelector);
          return shown(receipt) && squish(receipt.textContent) === 'Application Submitted' && !shown(form);
        }
        if (location.pathname !== expected.pathname.replace('/viewform','/formResponse')) return false;
        const receipt = [...document.querySelectorAll('main, [role=main], .vHW8K, .freebirdFormviewerViewResponseConfirmationMessage')].some(e =>
          shown(e) && squish(e.textContent) === 'Your response has been recorded.');
        return receipt && ![...document.querySelectorAll('form')].some(shown);
      }
      if (location.pathname !== expected.pathname || (portal === 'breezy' && location.search)) return null;
      if (challenge) return { challenge: true };
      const root = portal === 'breezy' ? unique(document, p.formSelector) : unique(document, 'form');
      if (!root || !shown(root) || squish(document.title) !== p.title) return null;
      if (portal !== 'breezy' && (root.method.toLowerCase() !== 'post' || root.action !== expected.origin + expected.pathname.replace('/viewform','/formResponse'))) return null;
      if (portal === 'breezy' && (root.querySelector('input[name=' + CSS.escape(p.honeypotName) + ']')?.value ||
          ![...document.querySelectorAll('h1')].some(e => shown(e) && squish(e.textContent) === p.title))) return null;
      const googleGroups = portal === 'breezy' ? [] : [...root.querySelectorAll('[role=listitem]')].filter(e =>
        e.querySelector('input:not([type=hidden]), textarea, [role=radio], [role=checkbox], [role=listbox]'));
      const groupLabel = e => squish(e.querySelector('[role=heading],.M7eMe')?.textContent);
      if (portal === 'google_form') {
        const meta = window.FB_PUBLIC_LOAD_DATA_?.[1]?.[1];
        if (!Array.isArray(meta) || meta.length !== fields.length - 1 || googleGroups.length !== fields.length || fields.slice(1).some((f,i) => {
          const q = meta[i], items = q?.[4];
          const labels = items?.[0]?.[1]?.map(x => x[0]) ?? [];
          return String(q?.[0]) !== f.id || squish(q?.[1]) !== f.label || items?.length !== 1 || items[0][0] !== f.entry ||
            JSON.stringify(labels) !== JSON.stringify(f.options) || items[0][2] !== 0;
        })) return null;
      }
      const optionLabel = e => squish(e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.closest('label')?.textContent || e.value);
      const controls = (f, i) => {
        if (portal === 'breezy') return [...root.querySelectorAll(f.selector)];
        const group = googleGroups[i];
        if (!group || groupLabel(group) !== (f.id === 'email' ? 'Email *' : f.label) && groupLabel(group) !== (f.id === 'email' ? 'Email*' : f.label)) return [];
        return [...group.querySelectorAll(f.type === 'radio' ? '[role=radio]' : f.type === 'textarea' ? 'textarea' : f.type === 'email' ? 'input[type=email]' : 'input[type=text]')];
      };
      const read = (f, nodes) => {
        const e = nodes[0];
        if (f.type === 'radio') return nodes.filter(x => x.checked || x.getAttribute('aria-checked') === 'true').map(optionLabel);
        if (f.type === 'checkbox') return e.checked;
        if (f.type === 'file') return [...e.files].map(x => x.name);
        if (f.type === 'select') return e.selectedOptions.length ? squish(e.selectedOptions[0].textContent) : '';
        return e.value;
      };
      const normalize = (f, value) => (f.type === 'radio' || f.type === 'file') && typeof value === 'string' ? [value] : value;
      const equal = (x,y) => JSON.stringify(x) === JSON.stringify(y);
      const blank = (f,nodes) => { const value=read(f,nodes); return Array.isArray(value) ? !value.length : f.type==='select' ? true : !value; };
      const rows = fields.map((f,i) => ({f,nodes:controls(f,i)}));
      if (rows.some(({f,nodes}) => (f.type !== 'radio' && nodes.length !== 1) || (f.type === 'radio' &&
          (nodes.length !== f.options.length || !equal(nodes.map(optionLabel), f.options))) ||
          (f.type === 'file' && nodes[0]?.type !== 'file') || (f.type === 'checkbox' && nodes[0]?.type !== 'checkbox'))) return null;
      if (portal === 'breezy' && rows.some(({f,nodes}) => {
        if (f.phase === 'initial' || f.id === 'gdprAgreement') return false;
        const expectedLabel = squish(f.label);
        for (let node = nodes[0].parentElement, depth = 0; node && node !== root && depth < 7; node = node.parentElement, depth++) {
          if (squish(node.textContent).includes(expectedLabel)) return false;
        }
        return true;
      })) return null;
      const visibleField = (f,nodes) => nodes.some(e => shown(e) || shown(e.closest('label')) ||
        (f.type === 'file' && (shown(e.closest('li')) || shown(e.parentElement?.querySelector('button,a,label')))));
      const active = rows.filter(({f,nodes}) => visibleField(f,nodes));
      const buttons = portal === 'breezy' ? {
        next: unique(root, '.navigation-buttons button[type="button"][ng-click="nextSection()"]'),
        submit: unique(root, '.navigation-buttons button[type="button"][ng-click="apply()"]'),
      } : { submit: [...root.querySelectorAll('[role=button]')].filter(e => shown(e) && squish(e.textContent) === 'Submit').length === 1
              ? [...root.querySelectorAll('[role=button]')].find(e => shown(e) && squish(e.textContent) === 'Submit') : null };
      const expectedButton = (e,label) => shown(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && squish(e.textContent) === label;
      const buttonReady = (kind) => expectedButton(buttons[kind], kind === 'next' ? 'Continue' : portal === 'breezy' ? 'Submit Application' : 'Submit');
      const historyDefs = {
        position: { trigger: 'a[ng-click*="addPosition()"]', label: 'Add Position', model:'candidatePosition', names: {company:'company_name',title:'title',summary:'summary',startDate:'date_start',endDate:'date_end'} },
        education: { trigger: 'a[ng-click*="addEducation()"]', label: 'Add Education', model:'candidateSchool', names: {school:'school_name',field:'field_of_study',summary:'summary',startDate:'date_start',endDate:'date_end'} },
      };
      const historyRows = (def) => [...root.querySelectorAll('li.experience')].filter(e=>e.querySelector('[ng-model^="'+def.model+'."]'));
      const assign = (e,v) => {
        if (!shown(e) || e.disabled || e.readOnly || !['INPUT','TEXTAREA','SELECT'].includes(e.tagName)) return false;
        const proto = e.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName==='SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(e,v);
        e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
        e.dispatchEvent(new Event('blur',{bubbles:true}));
        return e.value===v;
      };
      const controlsKnown = () => {
        const known = new Set(rows.flatMap(row=>row.nodes));
        for (const def of Object.values(historyDefs)) for (const row of historyRows(def)) {
          for (const key of Object.values(def.names)) { const e=unique(row,'[ng-model="'+def.model+'.'+key+'"]'); if(e) known.add(e); }
        }
        return [...root.querySelectorAll('input,textarea,select,[role=radio],[role=checkbox],[role=listbox],[contenteditable=true]')].every(e=>
          known.has(e) || e.type==='hidden' || e.disabled || !shown(e) || ['submit','button','reset'].includes(e.type) || e.name===p.honeypotName);
      };
      if (!controlsKnown()) return null;
      if (portal === 'breezy' && (!squish(root.textContent).includes(squish(p.consentText)) ||
          ![...root.querySelectorAll('a[href]')].some(e=>e.href===p.privacyUrl))) return null;
      if (operation === 'inspect') return { active: active.map(row=>row.f.id), next: buttonReady('next'), submit: buttonReady('submit'),
        fresh: rows.every(({f,nodes})=>blank(f,nodes)) && (portal!=='breezy'||Object.values(historyDefs).every(def=>!historyRows(def).length)) };
      if (operation === 'history-add') {
        const def=historyDefs[a.kind]; const trigger=unique(root,def?.trigger);
        if (!def || !expectedButton(trigger,def.label) || historyRows(def).length!==a.index || !active.some(row=>row.f.id==='cName')) return false;
        trigger.click(); return true;
      }
      if (operation === 'history-fill' || operation === 'history-verify') {
        const def=historyDefs[a.kind], rows=historyRows(def); if(rows.length!==a.count||!rows[a.index])return false;
        for(const [key,name] of Object.entries(def.names)) {
          const e=unique(rows[a.index],'[ng-model="'+def.model+'.'+name+'"]'), value=a.values[key]??'';
          if(!e||e.disabled|| (operation==='history-fill'&&value && !assign(e,value)) || e.value!==value || !e.validity.valid) return false;
        }
        return true;
      }
      if (operation === 'fill' || operation === 'verify') {
        const row=rows.find(r=>r.f.id===a.id); if(!row)return false;
        const {f,nodes}=row, e=nodes[0];
        if(operation==='fill') {
          if (!visibleField(f,nodes) || nodes.some(n=>n.disabled||n.readOnly)) return false;
          if(f.type==='radio') { const picked=nodes.filter(n=>optionLabel(n)===a.value); if(picked.length!==1)return false; if(!picked[0].checked&&picked[0].getAttribute('aria-checked')!=='true')picked[0].click(); }
          else if(f.type==='checkbox') { if(e.checked!==a.value)e.click(); }
          else if(f.type==='select') { const options=[...e.options].filter(o=>!o.disabled&&squish(o.textContent)===a.value); if(options.length!==1||!assign(e,options[0].value))return false; }
          else if(!assign(e,a.value))return false;
        }
        return equal(read(f,nodes), normalize(f,a.value)) && nodes.every(n=>!n.disabled&&(!shown(n)||!n.validity||n.validity.valid) && n.getAttribute('aria-invalid')!=='true');
      }
      if (operation === 'step') {
        const seen = new Set(a.active);
        if (active.length!==seen.size || active.some(({f,nodes})=>!seen.has(f.id) ||
            (Object.hasOwn(a.values,f.id)?!equal(read(f,nodes),normalize(f,a.values[f.id])) : f.required || !blank(f,nodes)) ||
            nodes.some(n=>shown(n)&&(n.getAttribute('aria-invalid')==='true'||n.validity?.valid===false)))) return false;
        if (rows.some(({f,nodes})=>Object.hasOwn(a.values,f.id)&&!equal(read(f,nodes),normalize(f,a.values[f.id]))))return false;
        if(!buttonReady(a.kind) || a.kind==='submit'&&buttonReady('next'))return false;
        buttons[a.kind].click(); return true;
      }
      return false;
    })(''' + payload + ')')


def attach(field, path):
    if not same_form(js('location.href')):
        return False
    doc = cdp('DOM.getDocument')['root']['nodeId']
    node = cdp('DOM.querySelector', nodeId=doc, selector=p['formSelector']+' '+field['selector'])['nodeId']
    if not node:
        return False
    cdp('DOM.setFileInputFiles', nodeId=node, files=[str(path)])
    return dom('verify', id=field['id'], value=path.name) is True


def wait_state(previous=None):
    for _ in range(16):
        state = dom('inspect')
        if isinstance(state, dict) and (state.get('challenge') or (state.get('active') and state.get('active') != previous)):
            return state
        time.sleep(.25)
    return None


def history(kind, entries, write=False):
    for index, entry in enumerate(entries):
        if write:
            if dom('history-add', kind=kind, index=index) is not True:
                return False
            time.sleep(.12)
        count = index+1 if write else len(entries)
        if dom('history-fill' if write else 'history-verify', kind=kind, index=index, count=count, values=entry) is not True:
            return False
    return True


def is_in_branch(field, values):
    branch = p.get('branches', {}).get(field.get('phase'))
    return branch is None or values.get(branch['fieldId']) == branch['equals']


def execute():
    global context, started, clicked
    context = cdp('Target.createBrowserContext')['browserContextId']
    tab = cdp('Target.createTarget', url='about:blank', browserContextId=context, background=True)['targetId']
    switch_tab(tab)
    goto_url(p['url'])
    wait_for_load()
    raw = js('location.href')
    if p['portal'] == 'google_account_form':
        if authenticated_gate(raw):
            return missing('google_sign_in_required')
        return missing('form_shape_unverified') if same_form(raw) else 'identity_mismatch'
    if not same_form(raw):
        return 'identity_mismatch'
    state = wait_state()
    if state and state.get('challenge'):
        return missing('browser_challenge')
    if not state or not state.get('fresh'):
        return missing('form_shape_unverified')
    all_fields = p['fields'] + p.get('historyFields', [])
    if p['mode'] == 'discover':
        emit('discovered', fields=[{k: f[k] for k in ('id','label','type','required','options')} for f in all_fields])
        return None

    with open(p['privateConfigPath'], encoding='utf-8') as source:
        private = json.load(source)
    personal = private.get('personal', {})
    if not isinstance(personal, dict):
        return missing('candidate_facts_missing')
    answers = private.get('answers', {}).get(p['listingUrl'], {})
    if not isinstance(answers, dict) or len(answers)>60:
        return missing('candidate_facts_missing')
    pdf = local_pdf(p['pdfPath'])
    private_values = {k:personal.get(k) for k in ('email','phone','linkedin')}
    if all(text_value(personal.get(key)) for key in ('firstName','lastName')):
        private_values['fullName'] = personal['firstName'].strip()+' '+personal['lastName'].strip()
    private_values['resume'] = pdf[0] if pdf else None
    if p['portal'] == 'google_form':
        private_values['publicResume'] = approved_resume_link(private, pdf)
    else:
        private_values['coverLetter'] = approved_cover(private, pdf)
    values = {f['id']:choice(f, answers, private_values) for f in p['fields']}
    absent = [f for f in p['fields'] if (f['required'] or (not f.get('key') and f['label'] in answers)) and values[f['id']] is None and is_in_branch(f,values)]
    variable_names = [f['key'] for f in absent if f.get('key') in ('email','phone','fullName','linkedin')]
    history_data = {}
    if p['portal'] == 'breezy':
        work = answers.get('Work History')
        study = answers.get('Education')
        history_data = {
            'position':records(work.get('value'), ('company','title')) if isinstance(work,dict) and work.get('type')=='records' else None,
            'education':records(study.get('value'), ('school','field')) if isinstance(study,dict) and study.get('type')=='records' else None,
        }
        absent += [f for f, data in zip(p['historyFields'], history_data.values()) if not data]
    if absent:
        ids = {f['id'] for f in absent}
        block = ('public_resume_link_required' if p.get('resumeLinkFieldId') in ids else 'privacy_agreement' if p.get('consentFieldId') in ids else
                 'cover_letter_required' if p.get('coverLetterFieldId') in ids else 'candidate_facts_missing')
        return missing(block, absent, variable_names)
    if not same_form(js('location.href')) or dom('inspect') != state:
        return missing('form_shape_unverified')
    started = True
    emit('write_started')
    completed = {}
    if p['portal'] == 'breezy':
        for kind, entries in history_data.items():
            if not history(kind, entries, write=True):
                return missing('form_shape_unverified')
    plan = {f['id']:f for f in p['fields']}
    for _ in range(10):
        if not same_form(js('location.href')) or state.get('challenge'):
            return missing('browser_challenge') if state.get('challenge') else missing('form_shape_unverified')
        if not state.get('active') or any(i in completed for i in state['active']):
            return missing('form_shape_unverified')
        for id in state['active']:
            f, value = plan[id], values[id]
            if value is None:
                if f['required']:
                    return missing('candidate_facts_missing', [f])
                continue
            if f['type'] == 'file':
                if not attach(f,value):
                    return missing('form_shape_unverified', [f])
                value = value.name
            elif dom('fill', id=id, value=value) is not True:
                return missing('form_shape_unverified', [f])
            completed[id] = value
        if any(dom('verify',id=id,value=value) is not True for id,value in completed.items()):
            return missing('form_shape_unverified')
        if any(not history(kind,entries) for kind,entries in history_data.items()):
            return missing('form_shape_unverified')
        if state.get('submit') and not state.get('next'):
            if any(f['required'] and is_in_branch(f,values) and f['id'] not in completed for f in p['fields']):
                return missing('form_shape_unverified')
            if not await_submit_ack():
                return 'runner_unavailable'
            clicked = True
            if dom('step',kind='submit',active=state['active'],values=completed) is not True:
                clicked = False
                return missing('form_shape_unverified')
            for _ in range(24):
                if same_form(js('location.href'), response=True) and dom('receipt') is True:
                    return 'confirmation_message'
                time.sleep(.25)
            return 'submission_uncertain'
        if not state.get('next') or dom('step',kind='next',active=state['active'],values=completed) is not True:
            return missing('form_shape_unverified')
        state = wait_state(state['active'])
        if not state or any(dom('verify',id=id,value=value) is not True for id,value in completed.items()):
            return missing('form_shape_unverified')
    return missing('form_shape_unverified')


result = None
try:
    result = execute()
    if result:
        emit(result)
except Exception:
    result = 'submission_uncertain' if started or clicked else 'runner_unavailable'
    emit(result)
finally:
    if context and result != 'submission_uncertain':
        try:
            cdp('Target.disposeBrowserContext', browserContextId=context)
        except Exception:
            pass
`;

function correctJob(target: Target, work: Partial<Pick<BrowserSubmitWork, 'role' | 'company'>>) {
  return (!work.role || work.role.trim().toLowerCase() === target.role.toLowerCase()) &&
    (!work.company || target.companies.some(company => company.toLowerCase() === work.company!.trim().toLowerCase()));
}
function gateFor(target: Target, block: Block): BrowserGate | undefined {
  if (block === 'google_sign_in_required') return { kind: 'authentication', url: `${target.respondent}?usp=send_form` };
  if (block === 'privacy_agreement') return { kind: 'privacy_agreement', url: target.url, ...(target.portal === 'breezy' ? { policyUrl: target.privacyUrl } : {}) };
  if (block === 'browser_challenge') return { kind: 'human_verification', url: target.url };
}

export async function submitMultistep(work: BrowserSubmitWork, options: BrowserOptions,
  target = multistepTarget(work.sourceUrl)): Promise<BrowserResult> {
  if (!target) return { kind: 'failed', code: 'unsupported_portal' };
  if (!correctJob(target, work)) return { kind: 'failed', code: 'manual_required' };
  const unavailable: MultistepFailure = { kind: 'failed', code: 'runner_unavailable' };
  return withBrowser<BrowserResult>(options, { ...target, mode: 'submit', pdfPath: resolve(options.pdfPath), privateConfigPath: resolve(options.privateConfigPath) }, unavailable,
    async (command, env, cwd) => {
      const { exitCode, messages } = await runBrowserProgram(command, env, cwd, program, undefined, options.beforeSubmit);
      const started = messages.some(message => status.safeParse(message).data?.qsJobsBrowser === 'write_started');
      if (exitCode !== 0 || messages.length !== (started ? 2 : 1) || (started && status.safeParse(messages[0]).data?.qsJobsBrowser !== 'write_started')) {
        return started ? { kind: 'failed', code: 'submission_uncertain' } : unavailable;
      }
      const result = status.safeParse(messages.at(-1)).data?.qsJobsBrowser;
      if (started && result === 'confirmation_message') return { kind: 'applied', receiptCode: result };
      if (result === 'submission_uncertain') return { kind: 'failed', code: result };
      const attention = report.safeParse(messages.at(-1)).data;
      if (!attention) return result === 'identity_mismatch' ? { kind: 'failed', code: 'manual_required' } : started ? { kind: 'failed', code: 'submission_uncertain' } : unavailable;
      const gate = gateFor(target, attention.block);
      const failure: MultistepFailure = { kind: 'failed', code: 'manual_required', block: attention.block,
        attention: { questions: attention.questions, variables: attention.variables }, ...(gate ? { gate } : {}),
        ...(options.beforeSubmit && !started && attention.block === 'candidate_facts_missing' ? { safeToResume: true } : {}) };
      return failure;
    });
}

export async function discoverMultistep(work: Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'role' | 'company'>>,
  options: BrowserConnection, target = multistepTarget(work.sourceUrl)): Promise<BrowserDiscovery> {
  if (!target) return { kind: 'failed', code: 'unsupported_portal' };
  if (!correctJob(target, work)) return { kind: 'failed', code: 'identity_mismatch' };
  return withBrowser<BrowserDiscovery>(options, { ...target, mode: 'discover' }, { kind: 'failed', code: 'runner_unavailable' },
    async (command, env, cwd) => {
      const { exitCode, messages } = await runBrowserProgram(command, env, cwd, program);
      if (exitCode !== 0 || messages.length !== 1) return { kind: 'failed', code: 'runner_unavailable' };
      const fields = discovery.safeParse(messages[0]).data?.fields;
      if (fields) return { kind: 'discovered', listingUrl: target.listingUrl, fields };
      if (status.safeParse(messages[0]).data?.qsJobsBrowser === 'identity_mismatch') return { kind: 'failed', code: 'identity_mismatch' };
      const block = report.safeParse(messages[0]).data?.block;
      const gate = block && gateFor(target, block);
      const failure = { kind: 'failed' as const, code: 'manual_required' as const, ...(gate ? { gate } : {}) };
      return failure;
    });
}

const googleFormsAccountState = z.object({ qsJobsBrowser: z.literal('googleForms_account'),
  state: z.enum(['sign_in_required', 'authenticated_form_unverified', 'identity_mismatch']),
}).strict();

/** Explicit sign-in handoff only. Never reads account details or fills a form. */
export function openGoogleFormsSignIn(sourceUrl: string, options: BrowserConnection, activate = false) {
  const target = multistepTarget(sourceUrl);
  if (target?.portal !== 'google_account_form') return Promise.resolve('runner_unavailable' as const);
  return withAccountBrowser<'sign_in_required' | 'authenticated_form_unverified' | 'identity_mismatch' | 'runner_unavailable'>(
    options, { url: target.url, form: target.respondent, activate }, 'runner_unavailable', accountTabProgram + String.raw`
import json, os, time
p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])


def exact_form(raw):
    return any(same_url(raw, p['form']+query) for query in ('','?usp=send_form'))


def sign_in(raw):
    url = urlsplit(raw)
    proceed = parse_qs(url.query).get('continue', [])
    return (url.scheme == 'https' and url.netloc == 'accounts.google.com' and url.path in ('/v3/signin/identifier','/ServiceLogin')
        and len(proceed)==1 and exact_form(proceed[0]))


isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
login_tabs = [target['targetId'] for target in cdp('Target.getTargets')['targetInfos']
    if target['type']=='page' and target.get('browserContextId') not in isolated and sign_in(target['url'])]
if len(login_tabs)>1:
    raise RuntimeError('duplicate_login_tabs')
if login_tabs:
    tab, created = login_tabs[0], False
    switch_tab(tab)
else:
    tab, created = account_tab(p['url'], (p['form'], p['form']+'?usp=send_form'))

state = 'identity_mismatch'
keep = False
try:
    for _ in range(24):
        url = js('location.href')
        if sign_in(url):
            state = 'sign_in_required'
            break
        if exact_form(url):
            state = 'authenticated_form_unverified'
            break
        time.sleep(.2)
    if state=='sign_in_required' and p['activate']:
        cdp('Target.activateTarget', targetId=tab)
        keep = True
    print(json.dumps({'qsJobsBrowser':'googleForms_account','state':state}),flush=True)
finally:
    if created and not keep:
        cdp('Target.closeTarget', targetId=tab)
`, ({ exitCode, messages }) => exitCode === 0 && messages.length === 1
      ? googleFormsAccountState.safeParse(messages[0]).data?.state ?? 'runner_unavailable'
      : 'runner_unavailable');
}
