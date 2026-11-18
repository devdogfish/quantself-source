import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { applicationAddressPattern } from './application-address';
import { accountTabProgram, accountTargetFor, withAccountBrowser } from './browser-accounts';
import type { BrowserConnection, BrowserDiscovery, BrowserResult, BrowserSubmitWork } from './browser';
import { jobsHome } from './config';

type WorkdayWork = Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>;
type Field = Extract<BrowserDiscovery, { kind: 'discovered' }>['fields'][number];
const contactAlias = z.enum(['firstName', 'lastName', 'email', 'phone', 'addressLine1', 'city', 'region', 'postalCode']);

export function workdayTarget(sourceUrl: string) {
  const target = accountTargetFor(sourceUrl);
  return target?.portal === 'workday' ? target : undefined;
}

type WorkdayTarget = NonNullable<ReturnType<typeof workdayTarget>>;
type Binding = WorkdayTarget['workday']['fields'][number];

function publicField({ widget: _widget, alias: _alias, shownLabel: _shownLabel, ...field }: Binding): Field {
  return field;
}

const matchesIdentity = (work: WorkdayWork, target: NonNullable<ReturnType<typeof workdayTarget>>) =>
  (work.company === undefined || work.company === target.company) && (work.role === undefined || work.role === target.role);

// These two exact schemas were captured before any applicant data was entered.
// They remain available while Workday requires account activation or sign-in.
export async function discoverWorkday(work: WorkdayWork, _connection: BrowserConnection): Promise<BrowserDiscovery> {
  const target = workdayTarget(work.sourceUrl);
  if (!target) return { kind: 'failed', code: 'unsupported_portal' };
  if (!matchesIdentity(work, target)) return { kind: 'failed', code: 'identity_mismatch' };
  return { kind: 'discovered', listingUrl: target.url, fields: target.workday.fields.map(publicField) };
}

const workdayStageProgram = accountTabProgram + String.raw`
import json, os, re, time

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
fields = p['fields']

def step(action, data=None, account=None):
    return js('''(p => {
      const visible = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
      const all = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
      const one = (root, selector) => {
        const matches = all(root, selector);
        return matches.length === 1 ? matches[0] : null;
      };
      const text = e => e?.textContent.trim().replace(/\s+/g, ' ') ?? '';
      const label = e => [...(e.labels ?? [])].map(text).join(' ').replace(/\s*\*$/, '');
      const shape = id => p.auditOnly ? 'shape:' + id : 'shape';
      if (location.href !== p.url || text(one(document, '[data-automation-id=jobTitleHeading]')) !== p.role) return 'identity';
      if (all(document, '#challenge-stage,iframe[title*="captcha" i]').length) return 'challenge';
      const account = one(document, 'button#accountSettingsButton[data-automation-id=utilityMenuButton]');
      if (!account || text(account).toLowerCase() !== p.account.toLowerCase()) return 'auth';
      const active = text(one(document, '[data-automation-id=progressBarActiveStep]'));
      const myExperience = active === 'current step 2 of ' + p.steps + 'My Experience' &&
        all(document, 'h2,h3').filter(e => text(e) === 'My Experience').length === 1;
      if (p.action === 'transition') return myExperience;
      if (p.action === 'preflight' && myExperience) return 'my_experience';
      if (active !== 'current step 1 of ' + p.steps + 'My Information') return 'stage';
      const next = one(document, '[data-automation-id=pageFooter] button[data-automation-id=pageFooterNextButton]');
      if (!next || next.type !== 'submit' || next.form || text(next) !== 'Save and Continue' ||
          all(document, 'button').some(e => /^submit( application)?$/i.test(text(e)))) return shape('next');
      const container = e => e.closest('[data-automation-id^=formField-]');
      const controls = new Map(), bound = new Set();
      for (const field of p.fields) {
        if (field.widget === 'radio') {
          const group = one(document, '[data-automation-id="' + field.id + '"]');
          const radios = all(group, 'input[type=radio]');
          const heading = one(group, 'legend');
          if (text(heading).replace(/\s*\*$/, '') !== field.shownLabel || radios.length !== 2 ||
              !field.options.every(value => radios.filter(e => label(e) === value).length === 1) ||
              !radios[0].name || radios.some(e => e.name !== radios[0].name || e.disabled)) return shape(field.id);
          controls.set(field.id, radios);
          radios.forEach(e => bound.add(e));
          continue;
        }
        const e = one(document, '#' + CSS.escape(field.id));
        const isMenu = field.widget === 'menu';
        if (!e || !container(e) || e.disabled || e.readOnly ||
            (isMenu ? !e.matches('button[type=button][aria-haspopup=listbox]') : e.tagName !== 'INPUT' || e.type !== 'text')) return shape(field.id);
        const wrapperLabel = container(e).querySelector('label');
        if ((isMenu ? text(wrapperLabel).replace(/\s*\*$/, '') : label(e)) !== field.shownLabel ||
            (!isMenu && !e.required && e.getAttribute('aria-required') !== 'true')) return shape(field.id);
        controls.set(field.id, e);
        bound.add(e);
      }
      const allowedOptional = new Set(['address--addressLine2', 'phoneNumber--extension', 'name--preferredCheck']);
      if (all(document, 'input,textarea,select,[role=combobox],button[aria-haspopup=listbox]').some(e => {
        if (bound.has(e) || e.type === 'hidden') return false;
        if (!container(e)) return e.required || e.getAttribute('aria-required') === 'true';
        return !allowedOptional.has(e.id) || e.required || e.getAttribute('aria-required') === 'true' ||
          (e.type === 'checkbox' ? e.checked : e.value);
      })) return shape('extra');
      if (p.action === 'preflight') return 'ready';
      const equivalent = (value, expected) => value.trim().normalize('NFKC').toLowerCase() === expected.trim().normalize('NFKC').toLowerCase();
      const verify = (field, expected) => {
        const e = controls.get(field.id);
        if (field.widget === 'radio') return e.some(radio => radio.checked && label(radio) === expected);
        if (e.getAttribute('aria-invalid') === 'true' || (e.validity && !e.validity.valid)) return false;
        if (field.widget === 'menu') return equivalent(text(e), expected);
        if (field.widget === 'search') {
          const selected = all(container(e), '[data-automation-id=selectedItem]');
          return selected.length === 1 && equivalent(text(selected[0]), expected);
        }
        if (field.alias === 'phone') return e.value.replace(/\D/g, '') === expected.replace(/\D/g, '');
        return e.value === expected;
      };
      if (p.action === 'advance') {
        if (!p.fields.every(field => verify(field, p.data[field.id])) || next.disabled ||
            next.getAttribute('aria-disabled') === 'true') return 'mismatch';
        next.scrollIntoView({block:'center', inline:'center'});
        const box = next.getBoundingClientRect();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        return next.contains(document.elementFromPoint(x, y)) ? {x, y} : 'shape';
      }
      const field = p.fields.find(field => field.id === p.data.id);
      const e = controls.get(field?.id);
      const value = p.data.value;
      if (!e || typeof value !== 'string') return 'shape';
      if (verify(field, value)) return 'filled';
      const isSourcePrompt = field.id === 'source--source' && field.widget === 'search';
      if (isSourcePrompt) {
        const root = container(e);
        const trigger = one(root, 'span[data-automation-id=promptSearchButton]');
        if (!trigger || !field.options.some(option => equivalent(option, value))) return 'shape';
        const popup = one(document, '[data-automation-id=responsiveMonikerPrompt]');
        const focusOwned = document.activeElement === e || Boolean(popup?.contains(document.activeElement));
        if (p.action === 'choose') {
          if (!popup || !focusOwned) return 'waiting';
          const options = all(popup, '[role=option][data-automation-id=menuItem]')
            .filter(option => option.getAttribute('aria-disabled') !== 'true')
            .map(option => one(option, '[data-automation-id=promptLeafNode] [data-automation-id=promptOption]'))
            .filter(option => option && equivalent(text(option), value));
          if (options.length !== 1) return 'waiting';
          options[0].click();
          return 'chosen';
        }
        if (popup && !focusOwned) return 'shape';
        e.focus();
        if (!popup) trigger.click();
        return 'open';
      }
      if (p.action === 'choose') {
        const selectors = [e.getAttribute('aria-controls'), e.getAttribute('aria-owns')]
          .flatMap(id => id?.split(/\s+/) ?? []).filter(Boolean).map(id => '#' + CSS.escape(id));
        const activePopup = e.getAttribute('aria-expanded') === 'true' &&
          all(document, '[aria-expanded=true][aria-haspopup=listbox]').every(trigger => trigger === e);
        const region = selectors.length ? one(document, selectors.join(',')) :
          one(container(e), '[role=listbox]') ?? (activePopup ? one(document, '[role=listbox]') : null);
        const options = all(region, '[role=option]').filter(option => equivalent(text(option), value) &&
          option.getAttribute('aria-disabled') !== 'true');
        if (options.length !== 1) return 'waiting';
        options[0].click();
        return 'chosen';
      }
      if (field.widget === 'radio') {
        const radio = e.find(radio => label(radio) === value);
        if (!radio) return 'shape';
        radio.click();
        return 'chosen';
      }
      if (field.widget === 'menu') {
        if (e.getAttribute('aria-expanded') !== 'true') e.click();
        return 'open';
      }
      e.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value);
      e.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
      e.dispatchEvent(new Event('change', {bubbles:true}));
      if (field.widget === 'search') return 'open';
      e.blur();
      return verify(field, value) ? 'filled' : 'mismatch';
    })(''' + json.dumps({'url':p['url'], 'role':p['role'], 'steps':p['steps'], 'fields':fields,
         'action':action, 'data':data, 'account':account, 'auditOnly':p.get('auditOnly') is True}) + ')')

def submit_first():
    isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
    tabs = [target for target in cdp('Target.getTargets')['targetInfos'] if target['type'] == 'page' and
            target.get('browserContextId') not in isolated and target['url'] == p['url']]
    if not tabs:
        return {'state':'auth'}
    if len(tabs) != 1:
        return {'state':'stage'}
    account = p.get('applicationAddress')
    if account is None:
        with open(p['identityPath'], encoding='utf-8') as file:
            identity = json.load(file)['admin']
        account = identity['email']
        if identity.get('verifiedDelivery') is not True or not isinstance(account, str) or not account.endswith('@luigigirke.com'):
            return {'state':'auth'}
    switch_tab(tabs[0]['targetId'], activate=not p.get('auditOnly'))
    guard = step('preflight', account=account)
    if guard != 'ready':
        if p.get('auditOnly') and isinstance(guard, str) and guard.startswith('shape:'):
            return {'state':'shape', 'mismatch':guard[6:]}
        return {'state':guard}
    if p.get('auditOnly'):
        return {'state':'ready'}
    with open(p['privateConfigPath'], encoding='utf-8') as file:
        private = json.load(file)
    answers = private.get('answers', {}).get(p['url'], {})
    personal = private.get('personal', {})
    if p.get('applicationAddress') and personal.get('email') != account:
        return {'state':'auth'}
    values, questions, aliases = {}, [], []
    missing_only = True
    for field in fields:
        alias = field.get('alias')
        answer = answers.get(field['label'], {})
        if alias:
            value = personal.get(alias)
        else:
            allowed = ('option',) if field['widget'] in ('radio','search','menu') else ('text',)
            value = answer.get('value') if answer.get('type') in allowed else None
        if not isinstance(value, str) or not value.strip() or len(value) > 240 or any(ord(c) < 32 for c in value) or (
            field['options'] and value not in field['options']):
            (aliases if alias else questions).append(alias or field['id'])
            if alias or field['label'] in answers:
                missing_only = False
        else:
            values[field['id']] = value
    if questions or aliases:
        return {'state':'factual_pause' if missing_only else 'missing', 'questions':questions, 'aliases':aliases}
    phone_key = 'phoneNumber--phoneNumber'
    phone = values[phone_key].strip()
    digits = re.sub(r'[^0-9]', '', phone)
    if phone.startswith('+'):
        code = re.findall(r'(?:^|[\s(])\+([1-9][0-9]{0,2})(?=[\s)]|$)', values['phoneNumber--countryPhoneCode'])
        if len(code) != 1 or not digits.startswith(code[0]):
            return {'state':'missing', 'questions':['phoneNumber--countryPhoneCode'], 'aliases':['phone']}
        digits = digits[len(code[0]):]
    if not re.fullmatch(r'\+?[0-9 .()-]+', phone) or not 5 <= len(digits) <= 15:
        return {'state':'missing', 'questions':[], 'aliases':['phone']}
    values[phone_key] = digits
    for field in fields:
        data = {'id':field['id'], 'value':values[field['id']]}
        result = step('fill', data, account)
        if result == 'open':
            for _ in range(8):
                result = step('choose', data, account)
                if result != 'waiting':
                    break
                time.sleep(.2)
        if result not in ('filled','chosen'):
            return {'state':'stage'}
    point = step('advance', values, account)
    if not isinstance(point, dict) or set(point) != {'x','y'}:
        return {'state':'stage'}
    click_at_xy(point['x'], point['y'])
    for _ in range(12):
        if step('transition', account=account) is True:
            return {'state':'my_experience'}
        time.sleep(.25)
    return {'state':'stage'}

try:
    result = submit_first()
except Exception:
    result = {'state':'stage'}
print(json.dumps({'qsJobsBrowser':'workday_stage', **result}), flush=True)
`;

const stageResult = z.strictObject({
  qsJobsBrowser: z.literal('workday_stage'),
  state: z.enum(['identity', 'challenge', 'auth', 'shape', 'stage', 'missing', 'factual_pause', 'my_experience', 'ready']),
  questions: z.array(z.string()).max(12).optional(),
  aliases: z.array(contactAlias).max(contactAlias.options.length).optional(),
  mismatch: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/).optional(),
});

export async function auditWorkdayFirstStage(work: WorkdayWork, options: BrowserConnection) {
  const target = workdayTarget(work.sourceUrl);
  if (!target || !matchesIdentity(work, target)) return 'identity' as const;
  return withAccountBrowser(options, { url: target.url, role: target.role,
    steps: target.workday.steps, fields: target.workday.fields,
    identityPath: join(jobsHome(), 'category-identities.json'), auditOnly: true },
  { state: 'unavailable' } as { state: z.infer<typeof stageResult>['state'] | 'unavailable'; mismatch?: string },
  workdayStageProgram, ({ exitCode, messages }) => {
    const result = messages.length === 1 && stageResult.safeParse(messages[0]);
    if (exitCode !== 0 || !result || !result.success) return { state: 'unavailable' };
    const { state, mismatch } = result.data;
    return { state, ...(mismatch && ['next', 'extra', ...target.workday.fields.map(field => field.id)].includes(mismatch)
      ? { mismatch } : {}) };
  });
}

export async function submitWorkday(work: BrowserSubmitWork,
  options: BrowserConnection & { privateConfigPath: string }): Promise<BrowserResult> {
  const target = workdayTarget(work.sourceUrl);
  if (!target) return { kind: 'failed', code: 'unsupported_portal' };
  const blocked = { kind: 'failed', code: 'manual_required' } as const;
  if (!matchesIdentity(work, target)) return blocked;
  const authentication = { ...blocked, gate: { kind: 'authentication', url: target.url } } as const;
  const { applicationAddress } = work;
  if (applicationAddress !== undefined) {
    if (!applicationAddressPattern.test(applicationAddress)) return authentication;
    const snapshot = await readFile(options.privateConfigPath, 'utf8')
      .then(raw => JSON.parse(raw) as { personal?: { email?: string } } | null).catch(() => null);
    if (snapshot?.personal?.email !== applicationAddress) return authentication;
  } else if ('resumeTrack' in work && work.resumeTrack !== 'admin') {
    return authentication;
  }
  const fields = target.workday.fields;
  return withAccountBrowser<BrowserResult>(options, { url: target.url, role: target.role,
    steps: target.workday.steps, fields,
    privateConfigPath: resolve(options.privateConfigPath),
    ...(applicationAddress ? { applicationAddress } : { identityPath: join(jobsHome(), 'category-identities.json') }) },
  { kind: 'failed', code: 'runner_unavailable' }, workdayStageProgram, ({ exitCode, messages }) => {
    const parsed = messages.length === 1 && stageResult.safeParse(messages[0]);
    if (exitCode !== 0 || !parsed || !parsed.success) return blocked;
    const { state, questions, aliases } = parsed.data;
    if (state === 'auth' || state === 'challenge') return { ...blocked,
      gate: { kind: state === 'auth' ? 'authentication' : 'human_verification', url: target.url } };
    if (state === 'my_experience') return { ...blocked, workdayStage: 'my_experience' };
    if (state !== 'missing' && state !== 'factual_pause') return blocked;
    return { ...blocked, ...(state === 'factual_pause' && { safeToResume: true }), attention: {
      questions: fields.filter(field => !field.alias && questions?.includes(field.id)).map(publicField),
      variables: aliases ?? [],
    } };
  });
}
