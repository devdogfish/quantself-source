import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { applicationAddressPattern } from './application-address';
import { runBrowserProgram, withBrowser, type BrowserConnection } from './browser';
import { jobsHome, readLocal, writeLocal } from './config';
import { exactBrowserPosting, readBrowserConfig, reviewedBrowserUrl } from './private-browser-config';

type AccountWork = { company: string; role: string; sourceUrl: string; applicationAddress?: string };
const text = z.string().trim().min(1).max(400);
const accountFields = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: text,
  shownLabel: text,
  widget: z.enum(['text', 'menu', 'search', 'radio']),
  type: z.enum(['text', 'combobox', 'radio']),
  required: z.boolean(),
  options: z.array(text).max(50),
  alias: z.enum(['firstName', 'lastName', 'country', 'phone', 'addressLine1', 'city', 'region', 'postalCode']).optional(),
});
const accountBase = z.strictObject({
  company: text,
  role: text,
  sources: z.array(reviewedBrowserUrl).min(1).max(12),
  url: reviewedBrowserUrl,
  signInUrl: reviewedBrowserUrl.optional(),
});
const accountTarget = z.discriminatedUnion('portal', [
  accountBase.extend({ portal: z.literal('workday'), workday: z.strictObject({
    steps: z.union([z.literal(5), z.literal(6)]),
    fields: z.array(accountFields).min(1).max(20).refine(fields => new Set(fields.map(field => field.id)).size === fields.length),
    privacyUrl: reviewedBrowserUrl,
    signInButton: z.enum(['Submit', 'Sign In']),
    review: z.strictObject({
      label: text,
      notice: z.string().min(1).max(2_000),
      verificationFile: z.string().regex(/^[a-z0-9_-]+\.json$/).max(160),
      verificationPurpose: text,
    }).optional(),
  }) }).refine(target => new URL(target.url).hostname.endsWith('.myworkdayjobs.com')),
  accountBase.extend({ portal: z.literal('djinni') }).refine(target => {
    const url = new URL(target.url);
    return url.hostname === 'djinni.co' && (!target.signInUrl || new URL(target.signInUrl).origin === url.origin);
  }),
  accountBase.extend({ portal: z.literal('onlinejobs') }),
]);
const accountTargets = z.array(accountTarget).max(50).refine(targets => {
  const urls = targets.flatMap(target => target.sources.map(exactBrowserPosting));
  return new Set(urls).size === urls.length;
});
type AccountTarget = z.infer<typeof accountTarget>;

export function accountTargetFor(sourceUrl: string): AccountTarget | undefined {
  const posting = exactBrowserPosting(sourceUrl);
  if (!posting) return;
  return readBrowserConfig('account-targets.json', accountTargets)
    ?.find(target => target.sources.some(source => exactBrowserPosting(source) === posting));
}

const workdayStage = z.object({
  name: z.enum(['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review']),
  actions: z.array(z.enum(['Back', 'Next', 'Save and Continue', 'Submit'])).max(4),
  controls: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/i),
    type: z.enum(['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'checkbox', 'radio', 'textarea', 'select', 'combobox']),
    required: z.boolean(),
  }).strict()).max(40),
}).strict();
const accountState = z.object({ qsJobsBrowser: z.literal('account_state'), state: z.enum([
  'sign_in_required', 'application_ready', 'portal_closed', 'application_unverified',
  'identity_mismatch', 'challenge_required',
]), tabId: z.string().regex(/^[A-F0-9]{32}$/).optional(), workdayStage: workdayStage.optional() }).strict();
export type AccountState = {
  state: z.infer<typeof accountState>['state'] | 'eligibility_required' | 'runner_unavailable' | 'unsupported_portal';
  tabId?: string;
  workdayStage?: z.infer<typeof workdayStage>;
};

// Opt-in account flows use the persistent context of the dedicated Jobs Chrome.
// Cookies and credentials stay in Chrome and never enter the runner payload.
export const accountTabProgram = String.raw`
from urllib.parse import urlsplit, parse_qs

def same_url(actual, expected):
    a, b = urlsplit(actual), urlsplit(expected)
    return (a.scheme, a.netloc, a.path.rstrip('/'), parse_qs(a.query, keep_blank_values=True), a.fragment) == (
        b.scheme, b.netloc, b.path.rstrip('/'), parse_qs(b.query, keep_blank_values=True), b.fragment)

def account_tab(url, aliases=()):
    isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
    found = [t['targetId'] for t in cdp('Target.getTargets')['targetInfos']
             if t['type'] == 'page' and t.get('browserContextId') not in isolated and
             any(same_url(t['url'], expected) for expected in (url, *aliases))]
    if len(found) > 1:
        raise RuntimeError('duplicate_portal_tabs')
    if found:
        switch_tab(found[0])
        return found[0], False
    tab = cdp('Target.createTarget', url='about:blank', background=True)['targetId']
    switch_tab(tab)
    goto_url(url)
    return tab, True
`;

const verifyProfile = String.raw`
import json, os

profile = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])['jobsChromeProfile']
profile_tab = cdp('Target.createTarget', url='about:blank', background=True)['targetId']
try:
    switch_tab(profile_tab)
    goto_url('chrome://version/')
    wait_for_load()
    dedicated = js("""location.href === 'chrome://version/' &&
        document.querySelector('#profile_path')?.textContent.trim() === """ + json.dumps(profile))
    if not dedicated:
        raise RuntimeError('jobs_chrome_required')
finally:
    cdp('Target.closeTarget', targetId=profile_tab)
`;

export async function withAccountBrowser<T>(options: BrowserConnection, params: Record<string, unknown>,
  unavailable: T, program: string, readResult: (result: Awaited<ReturnType<typeof runBrowserProgram>>) => T,
  privateInput?: Uint8Array) {
  const profile = await realpath(join(jobsHome(), 'chrome', 'Default')).catch(() => undefined);
  if (!profile) return unavailable;
  return withBrowser(options, { ...params, jobsChromeProfile: profile },
    unavailable, async (command, env, cwd) =>
      readResult(await runBrowserProgram(command, env, cwd, verifyProfile + program, privateInput)));
}

const accountProgram = String.raw`
import json, os, time
` + accountTabProgram + String.raw`
params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
portal, url, sign_in = params['portal'], params['url'], params.get('signInUrl')
tab = None
created = keep = False

def inspect():
    return js('''(() => {
      const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const one = selector => [...document.querySelectorAll(selector)].filter(shown).length === 1;
      const heading = selector => [...document.querySelectorAll(selector)].filter(shown).map(e => e.textContent.trim());
      const challenge = /^(just a moment|access denied|verify you are human)/i.test(document.title) ||
        [...document.querySelectorAll('#challenge-stage, iframe[title*="captcha" i]')].some(e => shown(e) && e.offsetHeight > 90);
      const status = {
        url: location.href,
        challenge,
        workdayRole: heading('[data-automation-id=jobTitleHeading]').slice(0, 2),
        workdaySignIn: one('button[data-automation-id=signInSubmitButton]') || one('button[data-automation-id=SignInWithEmailButton]'),
        workdayCreate: one('button[data-automation-id=createAccountSubmitButton]') && one('button[data-automation-id=signInLink]'),
        djinniSignIn: one('input#email[type=email]') && one('input#password[type=password]') &&
          heading('h1,h2,h3').includes('Log In to Djinni'),
      };
      return status;
    })()''')

def inspect_workday_stage(expected_url, role):
    # Return only fixed stage/action names and structural attributes. The review
    # page can contain the full submitted profile; never read its text or values.
    return js('''(([expected, role, applicationAddress]) => {
      const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const headings = [...document.querySelectorAll('[data-automation-id=jobTitleHeading]')].filter(shown);
      if (location.href !== expected || headings.length !== 1 || headings[0].textContent.trim() !== role) return null;
      if (applicationAddress) {
        const accounts = [...document.querySelectorAll('button#accountSettingsButton[data-automation-id=utilityMenuButton]')].filter(shown);
        if (accounts.length !== 1 || accounts[0].textContent.trim().toLowerCase() !== applicationAddress) return null;
      }
      const stageNames = ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review'];
      const actionNames = ['Back', 'Next', 'Save and Continue', 'Submit'];
      const actions = [...new Set([...document.querySelectorAll('button')].filter(shown)
        .map(b => b.textContent.trim()).filter(label => actionNames.includes(label)))];
      const candidates = rank => [...document.querySelectorAll(rank)].filter(shown)
        .map(e => e.textContent.trim()).filter(text => stageNames.includes(text));
      const h2 = candidates('h2');
      const found = h2.length ? h2 : candidates('h3');
      const name = found.includes('Review') && actions.includes('Submit') ? 'Review' : found.length === 1 ? found[0] : null;
      if (!name || !actions.some(action => action !== 'Back') ||
          (name === 'Review') !== actions.includes('Submit')) return null;
      const types = ['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'checkbox', 'radio', 'textarea', 'select', 'combobox'];
      const controls = [];
      for (const e of document.querySelectorAll('input,textarea,select,[role=combobox]')) {
        if (!shown(e)) continue;
        const id = e.getAttribute('data-automation-id') || '';
        const type = e.getAttribute('role') === 'combobox' ? 'combobox' :
          e.tagName === 'SELECT' ? 'select' : e.tagName === 'TEXTAREA' ? 'textarea' : e.type;
        if (!/^[a-z][a-z0-9_-]{0,79}$/i.test(id) || !types.includes(type) ||
            controls.some(control => control.id === id)) continue;
        controls.push({id, type, required: Boolean(e.required || e.getAttribute('aria-required') === 'true')});
      }
      return {name, actions, controls: controls.slice(0,40)};
    })(''' + json.dumps([expected_url, role, params.get('applicationAddress')]) + ')')

def check():
    global tab, created, keep
    tab, created = account_tab(url, (sign_in,) if sign_in else ())
    for _ in range(24):
        state = inspect()
        exact = same_url(state['url'], url)
        login = bool(sign_in and same_url(state['url'], sign_in))
        if state['challenge'] and (exact or login):
            return 'challenge_required', None
        if portal == 'workday' and exact and state['workdayRole'] == [params['role']]:
            if state['workdaySignIn'] or state['workdayCreate']:
                if params['openSignIn'] and state['workdayCreate']:
                    js('''(([expected, role]) => {
                      const headings = [...document.querySelectorAll('[data-automation-id=jobTitleHeading]')]
                        .filter(e => e.getClientRects().length);
                      if (location.href !== expected || headings.length !== 1 || headings[0].textContent.trim() !== role) return false;
                      const found = [...document.querySelectorAll('button[data-automation-id=signInLink]')]
                        .filter(b => b.getClientRects().length && !b.disabled && b.textContent.trim() === 'Sign In' &&
                          (!b.form || b.type === 'button'));
                      if (found.length !== 1) return false;
                      found[0].click();
                      return true;
                    })(''' + json.dumps([state['url'], params['role']]) + ')')
                return 'sign_in_required', None
            stage = inspect_workday_stage(state['url'], params['role'])
            if stage:
                return 'application_ready', stage
        if portal == 'djinni' and login and state['djinniSignIn']:
            return 'sign_in_required', None
        time.sleep(.25)
    if not exact and not login:
        return 'identity_mismatch', None
    if portal == 'workday' and state['workdayRole'] and state['workdayRole'] != [params['role']]:
        return 'identity_mismatch', None
    return 'application_unverified', None

try:
    state, stage = check()
    keep = bool(params['openSignIn'] and state == 'sign_in_required')
    if keep:
        cdp('Target.activateTarget', targetId=tab)
    result = {'qsJobsBrowser': 'account_state', 'state': state}
    if stage:
        result['workdayStage'] = stage
    if keep:
        result['tabId'] = tab
    print(json.dumps(result), flush=True)
finally:
    if tab and created and not keep:
        cdp('Target.closeTarget', targetId=tab)
`;

export async function checkAccountPortal(work: AccountWork, options: BrowserConnection, openSignIn = false): Promise<AccountState> {
  const target = accountTargetFor(work.sourceUrl);
  if (!target) return { state: 'unsupported_portal' };
  if (target.company !== work.company || target.role !== work.role) return { state: 'identity_mismatch' };
  if (work.applicationAddress !== undefined && !applicationAddressPattern.test(work.applicationAddress)) return { state: 'identity_mismatch' };
  if (target.portal === 'onlinejobs') return { state: 'eligibility_required' };
  return withAccountBrowser<AccountState>(options, {
    portal: target.portal, role: target.role, url: target.url, signInUrl: target.signInUrl, openSignIn,
    applicationAddress: work.applicationAddress,
  }, { state: 'runner_unavailable' }, accountProgram, ({ exitCode, messages }) => {
    const parsed = messages.length === 1 && accountState.safeParse(messages[0]);
    if (exitCode !== 0 || !parsed || !parsed.success) return { state: 'runner_unavailable' };
    const { state, tabId, workdayStage } = parsed.data;
    return { state, ...(tabId ? { tabId } : {}), ...(workdayStage ? { workdayStage } : {}) };
  });
}

const vaultReference = z.object({
  email: z.email().max(254).refine(email => email.endsWith('@luigigirke.com')),
  vaultShareId: z.string().regex(/^[A-Za-z0-9_=-]{4,192}$/),
  vaultItemId: z.string().regex(/^[A-Za-z0-9_=-]{4,192}$/),
  verifiedDelivery: z.boolean(),
});
async function accountReference({ applicationAddress }: AccountWork) {
  if (applicationAddress === undefined) {
    return vaultReference.safeParse((await readLocal<{ admin?: unknown }>('category-identities.json').catch(() => null))?.admin).data;
  }
  if (!applicationAddressPattern.test(applicationAddress)) return;
  const records = await readLocal<Record<string, unknown>>('application-identities.json').catch(() => null);
  const ref = vaultReference.safeParse(records?.[applicationAddress]);
  if (ref.success && ref.data.email === applicationAddress) return ref.data;
}
const passItem = z.object({ item: z.object({ content: z.object({ content: z.object({
  Login: z.object({ email: z.string().nullable(), username: z.string().nullable(),
    password: z.string().min(8).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u) }),
}) }) }) });
const signupMessage = z.strictObject({
  qsJobsBrowser: z.literal('workday_signup'),
  state: z.enum(['prepared', 'challenge_required', 'form_unverified', 'terms_confirmation_required',
    'account_created', 'verification_pending', 'existing_account', 'account_creation_uncertain']),
  tabId: z.string().regex(/^[A-F0-9]{32}$/).optional(),
  reason: z.enum(['blank_shape', 'existing_values', 'shape_changed', 'field_value_mismatch',
    'field_validation', 'submit_unavailable']).optional(),
  registrationHttp: z.enum(['ok', 'failed']).optional(),
});
const workdaySignInStatus = z.strictObject({
  qsJobsBrowser: z.literal('workday_sign_in'),
  state: z.enum(['signed_in', 'identity_mismatch', 'challenge_required', 'form_unverified', 'sign_in_uncertain']),
});
type SignupFailure = { state: 'unsupported_portal' | 'identity_mismatch' | 'delivery_unverified' |
  'vault_unavailable' | 'runner_unavailable' | 'challenge_required' | 'form_unverified' |
  'terms_confirmation_required' | 'account_creation_uncertain' | 'existing_account' | 'application_ready';
  reason?: z.infer<typeof signupMessage>['reason']; registrationHttp?: z.infer<typeof signupMessage>['registrationHttp'] };
export type WorkdaySignup = SignupFailure | {
  state: 'prepared'; tabId: string; url: string; privacyUrl: string; privacyReviewCheckbox: boolean;
} | {
  state: 'account_created' | 'verification_pending'; tabId: string;
};

async function passCredentials(ref: z.infer<typeof vaultReference>, command: string) {
  try {
    const child = Bun.spawn([command, 'item', 'view', '--output', 'json', '--share-id', ref.vaultShareId,
      '--item-id', ref.vaultItemId], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
      env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
      signal: AbortSignal.timeout(15_000) });
    const [raw, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0 || raw.length > 32_768) return;
    const parsed = passItem.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const login = parsed.data.item.content.content.Login;
    if (!(login.email || login.username) || [login.email, login.username].some(email => email && email !== ref.email) ||
        !/[A-Z]/.test(login.password) || !/[a-z]/.test(login.password) || !/\d/.test(login.password) ||
        !/[^a-z0-9]/i.test(login.password)) return;
    return Buffer.from(JSON.stringify({ email: ref.email, password: login.password }) + '\n');
  } catch { /* CLI errors may include private data. */ }
}

const workdaySignInProgram = accountTabProgram + String.raw`
import json, os, time
p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    login = json.loads(private.readline(4096))

def auth(action):
    return js('''(p => {
      const visible = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
      const all = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
      const one = (root, selector) => {
        const found = all(root, selector);
        return found.length === 1 ? found[0] : null;
      };
      const text = e => e?.textContent.trim().replace(/\s+/g, ' ') ?? '';
      if (location.href !== p.url || text(one(document, '[data-automation-id=jobTitleHeading]')) !== p.role) return 'waiting';
      if (all(document, '#challenge-stage,iframe[title*="captcha" i]').length) return 'challenge_required';
      const account = one(document, 'button#accountSettingsButton[data-automation-id=utilityMenuButton]');
      if (account) return text(account).toLowerCase() === p.login.email.toLowerCase() ? 'signed_in' : 'identity_mismatch';
      if (p.action === 'status') return 'waiting';
      const submit = one(document, 'button[data-automation-id=signInSubmitButton]');
      if (!submit) {
        const id = p.action === 'open-email' ? 'SignInWithEmailButton' : 'signInLink';
        const label = id === 'signInLink' ? 'Sign In' : 'Sign in with email';
        const button = one(document, 'button[data-automation-id=' + id + ']');
        if (button && (!button.form || button.type === 'button') && !button.disabled && text(button) === label) {
          button.click();
          return 'opened';
        }
        return 'waiting';
      }
      const form = submit.form;
      if (p.action.startsWith('open-')) return form ? 'ready' : 'form_unverified';
      const rules = [
        ['email','text','Email Address*','email'], ['password','password','Password*','current-password'],
      ];
      const inputs = rules.map(([id,type,label,autocomplete]) => {
        const e = one(form, 'input[data-automation-id=' + id + ']');
        return e && e.type === type && !e.name && e.autocomplete === autocomplete && !e.disabled && !e.readOnly &&
          (e.required || e.getAttribute('aria-required') === 'true') &&
          [...e.labels].map(text).join(' ') === label ? e : null;
      });
      if (!form?.matches('form[data-automation-id=signInFormo]') || form.hasAttribute('action') ||
          form.method !== 'get' || submit.type !== 'submit' || text(submit) !== 'Sign In' ||
          !inputs.every(Boolean) || all(form, 'input,textarea,select').some(e => e.type !== 'hidden' && !inputs.includes(e))) {
        return 'form_unverified';
      }
      const values = [p.login.email, p.login.password];
      if (p.action === 'fill') {
        if (inputs.some((e,i) => e.value && e.value !== values[i])) return 'form_unverified';
        inputs.forEach((e,i) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, values[i]);
          e.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
          e.dispatchEvent(new Event('change', {bubbles:true}));
        });
        return 'filled';
      }
      if (p.action !== 'click-point' || !inputs.every((e,i) => e.value === values[i] &&
          e.validity.valid && e.getAttribute('aria-invalid') !== 'true') ||
          submit.disabled || submit.getAttribute('aria-disabled') === 'true') return 'form_unverified';
      submit.scrollIntoView({block:'center',inline:'center'});
      const box = submit.getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      const proxy = one(form, 'div[data-automation-id=click_filter][role=button][aria-label="' + p.proxyLabel + '"]');
      const publicControl = proxy && proxy.parentElement === submit.parentElement &&
        proxy.closest('[data-automation-id=noCaptchaWrapper]') && submit.getAttribute('aria-hidden') === 'true';
      return submit.contains(hit) || publicControl && proxy === hit ? {x,y} : 'form_unverified';
    })(''' + json.dumps({**p, 'action':action, 'login':login if action in ('fill','click-point') else {'email':login['email']}}) + ')')

def sign_in():
    tab, created = account_tab(p['url'])
    switch_tab(tab, activate=True)
    if not created:
        goto_url(p['url'])
    opened = set()
    for _ in range(30):
        state = auth('status')
        if state != 'waiting':
            return state
        for action in ('open-email','open-signin'):
            if action in opened:
                continue
            status = auth(action)
            if status == 'opened':
                opened.add(action)
                break
            if status == 'ready':
                if auth('fill') != 'filled':
                    return 'form_unverified'
                time.sleep(.25)
                point = auth('click-point')
                if not isinstance(point, dict) or set(point) != {'x','y'}:
                    return 'form_unverified'
                click_at_xy(point['x'], point['y'])
                for _ in range(28):
                    state = auth('status')
                    if state != 'waiting':
                        return state
                    time.sleep(.35)
                return 'sign_in_uncertain'
        time.sleep(.25)
    return 'form_unverified'

try:
    state = sign_in()
except Exception:
    state = 'sign_in_uncertain'
print(json.dumps({'qsJobsBrowser':'workday_sign_in','state':state}),flush=True)
`;

const signupProgram = String.raw`
import json, os, time
` + accountTabProgram + String.raw`
p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    login = json.loads(private.readline(4096))
tab = None
context = None
keep = False
reason = None
registration_http = None

def signup(action, data=None):
    config = {key:p[key] for key in ('url','role','privacyUrl','reviewLabel','applicationNotice','authorizePrivacyReview')}
    config['action'] = action
    config['data'] = data
    return js('''(p => {
      const shown = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
      const squash = t => t.trim().replace(/\s+/g, ' ');
      const one = (root, selector) => {
        const elements = [...(root?.querySelectorAll(selector) ?? [])].filter(shown);
        return elements.length === 1 ? elements[0] : null;
      };
      if (location.href !== p.url) return 'form_unverified';
      if (/^(just a moment|access denied|verify you are human)/i.test(document.title) ||
          [...document.querySelectorAll('#challenge-stage,iframe[title*="captcha" i]')].some(shown)) return 'challenge_required';
      const job = one(document, '[data-automation-id=jobTitleHeading]');
      if (!job || squash(job.textContent) !== p.role) return 'waiting';
      const submit = one(document, 'button[data-automation-id=createAccountSubmitButton][type=submit]');
      const form = submit?.form;
      if (!form) {
        if (p.action !== 'navigate' || document.title !== 'Sign In') return 'waiting';
        const links = [['SignInWithEmailButton','Sign in with email'], ['createAccountLink','Create Account']]
          .filter(([id]) => id === p.data)
          .map(([id, label]) => [one(document, 'button[data-automation-id=' + id + ']'), label])
          .filter(([button, label]) => button && !button.disabled && (!button.form || button.type === 'button') &&
            squash(button.textContent) === label);
        if (links.length !== 1) return 'waiting';
        links[0][0].click();
        return 'navigated';
      }
      const inputs = [
        ['email','text','Email Address*','email'],
        ['password','password','Password*','new-password'],
        ['verifyPassword','password','Verify New Password*','new-password'],
      ].map(([id, type, label, autocomplete]) => {
        const e = one(form, 'input[data-automation-id=' + id + '][type=' + type + ']');
        return e && e.form === form && !e.disabled && !e.readOnly && e.autocomplete === autocomplete &&
          (e.required || e.getAttribute('aria-required') === 'true') &&
          squash([...(e.labels ?? [])].map(l => l.textContent).join(' ')) === label ? e : null;
      });
      const checkbox = one(form, 'input[data-automation-id=createAccountCheckbox][type=checkbox]');
      const review = p.reviewLabel ? checkbox && checkbox.form === form &&
        (!checkbox.checked || p.authorizePrivacyReview && p.action === 'create') &&
        squash([...(checkbox.labels ?? [])].map(l => l.textContent).join(' ')) === p.reviewLabel : !checkbox;
      const links = [...document.querySelectorAll('a[data-automation-id=privacyLink]')].filter(shown);
      const rules = [...document.querySelectorAll('li')].filter(shown).map(e => squash(e.textContent));
      const expectedRules = ['An alphabetic character', 'A special character', 'An uppercase character',
        'A numeric character', 'A lowercase character', 'A minimum of 8 characters'];
      const stageHeadings = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(shown);
      const createStage = document.title === 'Create Account' || document.title === p.role &&
        stageHeadings.filter(heading => squash(heading.textContent) === 'Create Account').length === 1;
      if (!createStage || !form.matches('form[data-automation-id=signInFormo]') ||
          form.hasAttribute('action') || form.method !== 'get' || !review || links.length !== 1 || links[0].href !== p.privacyUrl ||
          squash(submit.textContent) !== 'Create Account' || !inputs.every(Boolean) ||
          (p.action === 'shape' && !expectedRules.every(rule => rules.includes(rule))) ||
          [...form.querySelectorAll('input,select,textarea')].some(e =>
            shown(e) && e.type !== 'hidden' && !inputs.includes(e) && e !== checkbox)) return 'waiting';
      const honey = document.querySelector('input[data-automation-id=beecatcher][name=website]');
      if (honey?.value) return 'form_unverified';
      if (p.action === 'shape' || p.action === 'shape_after') return 'ready';
      if (p.action === 'fill') {
        const index = ['email','password','verifyPassword'].indexOf(p.data.key);
        if (index < 0) return false;
        const input = inputs[index];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, p.data.value);
        input.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
        return input.value === p.data.value;
      }
      const values = [p.data.email, p.data.password, p.data.password];
      if (p.action === 'blank') return inputs.every((e, i) => !e.value || e.value === values[i]);
      const matches = inputs.every((e, i) => e.value === values[i]);
      const valid = inputs.every(e => e.validity.valid && e.getAttribute('aria-invalid') !== 'true');
      const enabled = !submit.disabled && submit.getAttribute('aria-disabled') !== 'true';
      if (p.action === 'verify') return !matches ? 'field_value_mismatch' : !valid ? 'field_validation'
        : p.reviewLabel || enabled ? true : 'submit_unavailable';
      if (p.action === 'create') {
        const decline = one(document, 'button[data-automation-id=legalNoticeDeclineButton]');
        if (decline && !decline.disabled && squash(decline.textContent) === 'Decline') {
          decline.click();
          return 'cookies_declined';
        }
        const applicationNotice = p.applicationNotice;
        const terms = document.body.innerText.split('\\n').map(squash).filter(line =>
          !(p.authorizePrivacyReview && p.reviewLabel && line === applicationNotice));
        if ((p.reviewLabel || checkbox) && !p.authorizePrivacyReview || terms.some(line =>
          /by (?:clicking|selecting|creating|submitting|continuing)|you (?:agree|consent)|i (?:accept|agree)|terms (?:and conditions|of use|of service)/i.test(line))) {
          return 'terms_confirmation_required';
        }
        if (!matches || !valid) return 'form_unverified';
        if (checkbox && !checkbox.checked) {
          if (checkbox.disabled) return 'form_unverified';
          checkbox.click();
          return 'review_acknowledged';
        }
        if (!enabled) return 'form_unverified';
        window.addEventListener('submit', event => {
          if (event.target === form) event.preventDefault();
        }, {once:true});
        submit.scrollIntoView({block:'center', inline:'center'});
        const box = submit.getBoundingClientRect();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        // Workday's user-facing button can be an accessible sibling of its hidden
        // native submit control. Click that public control and leave its handler in charge.
        const publicButton = one(form, 'div[data-automation-id=click_filter][role=button][aria-label="Create Account"]');
        const wrapsSubmit = publicButton && publicButton.parentElement === submit.parentElement &&
          publicButton.closest('[data-automation-id=noCaptchaWrapper]') && submit.getAttribute('aria-hidden') === 'true';
        return submit.contains(hit) || wrapsSubmit && publicButton === hit ? {x, y} : 'form_unverified';
      }
      return false;
    })(''' + json.dumps(config) + ')')

def prepare():
    global tab, context, reason
    if p.get('persistent'):
        tab, _ = account_tab(p['url'])
    else:
        context = cdp('Target.createBrowserContext')['browserContextId']
        tab = cdp('Target.createTarget', url='about:blank', browserContextId=context, background=True)['targetId']
        switch_tab(tab)
        goto_url(p['url'])
    wait_for_load()
    navigated = set()
    for _ in range(36):
        shape = signup('shape')
        if shape in ('challenge_required', 'form_unverified'):
            return shape
        if shape == 'ready':
            if signup('blank', login) is not True:
                reason = 'existing_values'
                return 'form_unverified'
            for key, value in [('email',login['email']), ('password',login['password']), ('verifyPassword',login['password'])]:
                if signup('shape_after') != 'ready':
                    reason = 'shape_changed'
                    return 'form_unverified'
                if signup('fill', {'key':key, 'value':value}) is not True:
                    reason = 'field_value_mismatch'
                    return 'form_unverified'
            for _ in range(8):
                check = signup('verify', login)
                if check is True:
                    return 'prepared'
                time.sleep(.25)
            reason = check if check in ('field_value_mismatch','field_validation','submit_unavailable') else 'shape_changed'
            return 'form_unverified'
        for aid in ('SignInWithEmailButton','createAccountLink'):
            if aid not in navigated and signup('navigate', aid) == 'navigated':
                navigated.add(aid)
                break
        time.sleep(.3)
    reason = 'blank_shape'
    return 'form_unverified'

def create():
    global tab, registration_http
    isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
    tabs = [t for t in cdp('Target.getTargets')['targetInfos'] if t['type'] == 'page' and
            (t.get('browserContextId') in isolated) != p.get('persistent', False) and
            t['url'] == p['url'] and t['targetId'] == p['preparedTabId']]
    if len(tabs) != 1 or (p['reviewLabel'] and not p['authorizePrivacyReview']):
        return 'form_unverified'
    tab = tabs[0]['targetId']
    switch_tab(tab, activate=True)
    outcome = signup('create', login)
    if outcome == 'cookies_declined':
        time.sleep(.3)
        outcome = signup('create', login)
    if outcome == 'review_acknowledged':
        time.sleep(.3)
        outcome = signup('create', login)
    if outcome in ('terms_confirmation_required', 'challenge_required', 'form_unverified'):
        return outcome
    if not isinstance(outcome, dict) or set(outcome) != {'x','y'}:
        return 'form_unverified'
    started = js('performance.now()')
    click_at_xy(outcome['x'], outcome['y'])
    for _ in range(32):
        if not registration_http:
            registration_http = js('''(started => {
              const requests = performance.getEntriesByType('resource').filter(entry => {
                const url = new URL(entry.name);
                return entry.startTime >= started && url.origin === location.origin &&
                  /(?:^|\\/)register\\/?$/.test(url.pathname) && entry.responseStatus > 0;
              });
              if (requests.length !== 1) return null;
              return requests[0].responseStatus >= 200 && requests[0].responseStatus < 300 ? 'ok' : 'failed';
            })(''' + json.dumps(started) + ')')
        result = js('''(([expected, role, email]) => {
          if (location.href !== expected) return null;
          const shown = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
          const headings = [...document.querySelectorAll('h1,h2,h3,[data-automation-id=jobTitleHeading]')].filter(shown);
          if (!headings.some(e => e.textContent.trim() === role)) return null;
          const text = document.body.innerText;
          if (/account (?:already exists|with this email address already exists)/i.test(text)) return 'existing_account';
          if (/(?:verify|confirm) your email(?: address)?|verification email (?:was |has been )?sent|check your email (?:to verify|for a verification)/i.test(text)) return 'verification_pending';
          const accounts = [...document.querySelectorAll('button#accountSettingsButton[data-automation-id=utilityMenuButton]')].filter(shown);
          if (accounts.length === 1 && accounts[0].textContent.trim().toLowerCase() === email.toLowerCase() &&
              [...document.querySelectorAll('[data-automation-id=progressBarActiveStep]')].filter(shown)
                .some(e => e.textContent.trim().endsWith('My Information'))) {
            return 'account_created';
          }
          return null;
        })(''' + json.dumps([p['url'], p['role'], login['email']]) + ')')
        if result:
            return result
        time.sleep(.35)
    return 'account_creation_uncertain'

try:
    state = create() if p.get('preparedTabId') else prepare()
    keep = state in ('prepared','verification_pending','account_created','existing_account','account_creation_uncertain')
    result = {'qsJobsBrowser':'workday_signup','state':state}
    if reason and state == 'form_unverified':
        result['reason'] = reason
    if keep and tab:
        result['tabId'] = tab
    if state == 'account_creation_uncertain' and registration_http:
        result['registrationHttp'] = registration_http
    print(json.dumps(result), flush=True)
finally:
    if context and not keep:
        cdp('Target.disposeBrowserContext', browserContextId=context)
`;

type SignupOptions = BrowserConnection & { passCommand?: string; persistent?: boolean };
export async function signInWorkdayAccount(work: AccountWork, options: SignupOptions) {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday' || target.company !== work.company || target.role !== work.role) return 'identity_mismatch';
  const ref = await accountReference(work);
  const command = options.passCommand ?? Bun.which('pass-cli');
  if (!ref?.verifiedDelivery || !command) return 'vault_unavailable';
  const privateInput = await passCredentials(ref, command);
  if (!privateInput) return 'vault_unavailable';
  try {
    return await withAccountBrowser(options, { url: target.url, role: target.role,
      proxyLabel: target.workday.signInButton }, 'runner_unavailable' as
      z.infer<typeof workdaySignInStatus>['state'] | 'runner_unavailable', workdaySignInProgram, ({ exitCode, messages }) => {
      const parsed = messages.length === 1 && workdaySignInStatus.safeParse(messages[0]);
      return exitCode === 0 && parsed && parsed.success ? parsed.data.state : 'runner_unavailable';
    }, privateInput);
  } finally {
    privateInput.fill(0);
  }
}

const verificationLinkFile = z.strictObject({
  urls: z.tuple([z.string().max(4096).url()]),
  sourceUid: z.string().regex(/^[0-9]+$/),
  purpose: text,
});
const verifyReviewedWorkdayProgram = String.raw`
import json, os, time

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    verification = json.loads(private.readline(8192))
tab = cdp('Target.createTarget', url='about:blank', background=True)['targetId']
state = 'verification_uncertain'
try:
    switch_tab(tab)
    goto_url(verification['url'])
    for _ in range(28):
        result = js('''(host => {
          if (location.protocol !== 'https:' || location.hostname !== host) return 'waiting';
          const visible = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
          if ([...document.querySelectorAll('#challenge-stage,iframe[title*="captcha" i]')].some(visible)) return 'challenge_required';
          const status = document.body?.innerText ?? '';
          if (/(?:invalid|expired) verification link|verification (?:has )?(?:failed|expired)|unable to verify/i.test(status)) return 'verification_rejected';
          if (/email (?:address )?(?:has been |was )?(?:successfully )?(?:verified|confirmed)|successfully verif(?:ied|y) your email/i.test(status)) return 'verified';
          if ([...document.querySelectorAll('button[data-automation-id=signInSubmitButton],button[data-automation-id=SignInWithEmailButton]')].some(visible)) {
            return 'sign_in_ready';
          }
          return 'waiting';
        })(''' + json.dumps(p['host']) + ')')
        if result != 'waiting':
            state = result
            break
        time.sleep(.3)
finally:
    cdp('Target.closeTarget', targetId=tab)
print(json.dumps({'qsJobsBrowser':'workday_email_verification','state':state}),flush=True)
`;

/** Visit only the first-party verification link staged from the owner's mailbox. */
export async function verifyReviewedWorkdayAccountLink(work: AccountWork, options: BrowserConnection) {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday' || !target.workday.review ||
      target.company !== work.company || target.role !== work.role) return 'identity_mismatch';
  const filename = target.workday.review.verificationFile;
  const metadata = await lstat(join(jobsHome(), filename)).catch(() => null);
  if (!metadata?.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.() || metadata.size > 8192) {
    return 'verification_link_unavailable';
  }
  const record = verificationLinkFile.safeParse(await readLocal<unknown>(filename).catch(() => null));
  if (!record.success || record.data.purpose !== target.workday.review.verificationPurpose) return 'verification_link_unavailable';
  const link = new URL(record.data.urls[0]);
  const expected = new URL(target.url);
  const redirect = link.searchParams.get('redirect');
  if (link.origin !== expected.origin || link.username || link.password || link.hash ||
      !/(?:verif|confirm|activat)/i.test(link.pathname) || [...link.searchParams.keys()].join() !== 'redirect' ||
      !redirect?.startsWith('/') || redirect.startsWith('//') || URL.parse(redirect, expected.origin)?.origin !== expected.origin) {
    return 'identity_mismatch';
  }
  const privateInput = Buffer.from(JSON.stringify({ url: link.href }) + '\n');
  const status = z.strictObject({ qsJobsBrowser: z.literal('workday_email_verification'),
    state: z.enum(['verified', 'sign_in_ready', 'verification_rejected', 'verification_uncertain', 'challenge_required']) });
  try {
    return await withAccountBrowser(options, { host: expected.hostname }, 'verification_uncertain' as z.infer<typeof status>['state'],
      verifyReviewedWorkdayProgram, ({ exitCode, messages }) => {
        const parsed = messages.length === 1 && status.safeParse(messages[0]);
        return exitCode === 0 && parsed && parsed.success ? parsed.data.state : 'verification_uncertain';
      }, privateInput);
  } finally {
    privateInput.fill(0);
  }
}

async function runWorkdaySignup(work: AccountWork, options: SignupOptions, preparedTabId?: string,
  authorizePrivacyReview = false): Promise<WorkdaySignup> {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday') return { state: 'unsupported_portal' };
  if (target.company !== work.company || target.role !== work.role) return { state: 'identity_mismatch' };
  const ref = await accountReference(work);
  if (!ref) return { state: 'vault_unavailable' };
  if (!ref.verifiedDelivery) return { state: 'delivery_unverified' };
  const command = options.passCommand ?? Bun.which('pass-cli');
  if (!command) return { state: 'vault_unavailable' };
  const privateInput = await passCredentials(ref, command);
  if (!privateInput) return { state: 'vault_unavailable' };
  const reviewLabel = target.workday.review?.label ?? null;
  const applicationNotice = target.workday.review?.notice ?? null;
  const { privacyUrl } = target.workday;
  const unavailable = { state: preparedTabId ? 'account_creation_uncertain' : 'runner_unavailable' } as const;
  try {
    return await withAccountBrowser<WorkdaySignup>(options, { url: target.url, role: target.role, privacyUrl, reviewLabel, applicationNotice,
      preparedTabId, persistent: options.persistent === true, authorizePrivacyReview },
      unavailable, signupProgram, ({ exitCode, messages }) => {
        const parsed = messages.length === 1 && signupMessage.safeParse(messages[0]);
        if (exitCode !== 0 || !parsed || !parsed.success) return unavailable;
        const { state, tabId, reason, registrationHttp } = parsed.data;
        if (state === 'prepared' && tabId) return { state, tabId, url: target.url, privacyUrl, privacyReviewCheckbox: Boolean(reviewLabel) };
        if (state === 'account_created' || state === 'verification_pending') return tabId ? { state, tabId } : { state: 'account_creation_uncertain' };
        return state === 'prepared' ? { state: 'form_unverified' } : { state, ...(reason ? { reason } : {}),
          ...(registrationHttp ? { registrationHttp } : {}) };
      }, privateInput);
  } finally { privateInput.fill(0); }
}

/** Populate the native fields without accepting privacy terms or creating an account. */
export async function prepareWorkdaySignup(work: AccountWork, options: SignupOptions): Promise<WorkdaySignup> {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday') return { state: 'unsupported_portal' };
  if (target.company !== work.company || target.role !== work.role) return { state: 'identity_mismatch' };
  if ((await checkAccountPortal(work, options)).state === 'application_ready') return { state: 'application_ready' };
  return runWorkdaySignup(work, options);
}

/** Create only the authorized Workday account in the exact previously prepared tab. */
export async function createPreparedWorkdayAccount(work: AccountWork, options: SignupOptions,
  preparedTabId: string, authorized: boolean): Promise<WorkdaySignup> {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday' || target.workday.review || authorized !== true || !/^[A-F0-9]{32}$/.test(preparedTabId)) {
    return { state: 'terms_confirmation_required' };
  }
  if ((await checkAccountPortal(work, options)).state === 'application_ready') return { state: 'application_ready' };
  return runWorkdaySignup(work, options, preparedTabId);
}

/** Acknowledge the reviewed nonbinding notice and create the exact Workday account. */
export async function createPreparedReviewedWorkdayAccount(work: AccountWork, options: SignupOptions,
  preparedTabId: string, reviewed: boolean): Promise<WorkdaySignup> {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday' || !target.workday.review || reviewed !== true || !/^[A-F0-9]{32}$/.test(preparedTabId)) {
    return { state: 'terms_confirmation_required' };
  }
  if ((await checkAccountPortal(work, options)).state === 'application_ready') return { state: 'application_ready' };
  return runWorkdaySignup(work, options, preparedTabId, true);
}

const djinniSignupUrl = 'https://djinni.co/signup?from=jobs_promo_detail&type=candidate';
const djinniSignupProgram = accountTabProgram + String.raw`
import json, os, time

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    login = json.loads(private.readline(4096))

def form(action):
    return js('''(p => {
      const visible = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
      const all = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
      const one = (root, selector) => {
        const matches = all(root, selector);
        return matches.length === 1 ? matches[0] : null;
      };
      const text = e => e?.textContent.trim().replace(/\s+/g, ' ') ?? '';
      if (location.href !== p.url) return 'form_unverified';
      if (/^(just a moment|access denied|verify you are human)/i.test(document.title) ||
          all(document, '#challenge-stage,iframe[title*="captcha" i]').length) return 'challenge_required';
      if (text(one(document, 'h1')) !== 'Sign Up to Djinni') return 'waiting';
      const form = one(document, 'form#signup[method=post i]');
      if (!form || form.method !== 'post' || new URL(form.action).origin !== 'https://djinni.co' ||
          new URL(form.action).pathname !== '/signup') return 'form_unverified';
      const email = one(form, 'input#email[type=email][name=email]');
      const password = one(form, 'input#password[type=password][name=password]');
      const inputs = [email, password];
      const continueButtons = all(form, 'button[type=submit]').filter(e => text(e) === 'Continue');
      const terms = all(document, 'a').filter(e => text(e) === 'Terms of Service');
      const pricing = all(document, 'a').filter(e => text(e) === 'Pricing');
      if (!inputs.every(e => e && e.form === form && !e.disabled && !e.readOnly) ||
          all(form, 'input,select,textarea').some(e => e.type !== 'hidden' && !inputs.includes(e)) ||
          continueButtons.length !== 1 || terms.length !== 1 || terms[0].href !== 'https://djinni.co/terms-of-use' ||
          pricing.length !== 1 || pricing[0].href !== 'https://djinni.co/pricing' ||
          !document.body.innerText.replace(/\s+/g, ' ').includes('By signing up, you agree with Terms of Service & Pricing')) {
        return 'form_unverified';
      }
      const values = [p.login.email, p.login.password];
      if (p.action === 'prepare') {
        if (inputs.some((e,i) => e.value && e.value !== values[i])) return 'existing_values';
        inputs.forEach((e,i) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, values[i]);
          e.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
          e.dispatchEvent(new Event('change', {bubbles:true}));
        });
      }
      const matches = inputs.every((e,i) => e.value === values[i] && e.validity.valid &&
        e.getAttribute('aria-invalid') !== 'true');
      if (!matches) return 'form_unverified';
      const button = continueButtons[0];
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return 'form_unverified';
      if (p.action !== 'create') return 'prepared';
      button.scrollIntoView({block:'center',inline:'center'});
      const rect = button.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return button.contains(document.elementFromPoint(x, y)) ? {x,y} : 'form_unverified';
    })(''' + json.dumps({'url':p['url'],'action':action,'login':login}) + ')')

def run():
    if p.get('preparedTabId'):
        isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
        tabs = [t for t in cdp('Target.getTargets')['targetInfos'] if t['type'] == 'page' and
                t.get('browserContextId') not in isolated and t['url'] == p['url'] and t['targetId'] == p['preparedTabId']]
        if len(tabs) != 1:
            return 'form_unverified', None
        tab = tabs[0]['targetId']
        switch_tab(tab, activate=True)
        point = form('create')
        if not isinstance(point, dict) or set(point) != {'x','y'}:
            return point, None
        click_at_xy(point['x'], point['y'])
        for _ in range(30):
            state = js('''(() => {
              if (location.origin !== 'https://djinni.co') return 'waiting';
              const visible = e => Boolean(e?.getClientRects().length && getComputedStyle(e).visibility === 'visible');
              if (/^(just a moment|access denied|verify you are human)/i.test(document.title) ||
                  [...document.querySelectorAll('#challenge-stage,iframe[title*="captcha" i]')].some(visible)) return 'challenge_required';
              const body = document.body?.innerText ?? '';
              if (/already (?:registered|in use)|account with (?:this|that) email already exists/i.test(body)) return 'existing_account';
              if (/(?:confirm|verify) your (?:email|registration)|(?:check|sent to) your (?:email|inbox)/i.test(body)) return 'verification_pending';
              return 'waiting';
            })()''')
            if state != 'waiting':
                return state, tab
            time.sleep(.3)
        return 'account_creation_uncertain', tab
    tab, _ = account_tab(p['url'])
    for _ in range(24):
        state = form('prepare')
        if state != 'waiting':
            return (form('verify'), tab) if state == 'prepared' else (state, None)
        time.sleep(.25)
    return 'form_unverified', None

try:
    state, tab = run()
except Exception:
    state, tab = ('account_creation_uncertain' if p.get('preparedTabId') else 'form_unverified'), None
result = {'qsJobsBrowser':'djinni_signup','state':'form_unverified' if state == 'waiting' else state}
if tab:
    result['tabId'] = tab
print(json.dumps(result),flush=True)
`;

const djinniSignupStatus = z.strictObject({
  qsJobsBrowser: z.literal('djinni_signup'),
  state: z.enum(['prepared', 'challenge_required', 'form_unverified', 'existing_values', 'verification_pending',
    'existing_account', 'account_creation_uncertain']),
  tabId: z.string().regex(/^[A-F0-9]{32}$/).optional(),
});

async function runDjinniSignup(work: AccountWork, options: SignupOptions, preparedTabId?: string) {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'djinni' || target.company !== work.company || target.role !== work.role) {
    return { state: 'identity_mismatch' } as const;
  }
  const ref = await accountReference(work);
  const command = options.passCommand ?? Bun.which('pass-cli');
  if (!ref?.verifiedDelivery || !command) return { state: 'vault_unavailable' } as const;
  const privateInput = await passCredentials(ref, command);
  if (!privateInput) return { state: 'vault_unavailable' } as const;
  const unavailable = { state: preparedTabId ? 'account_creation_uncertain' : 'runner_unavailable' } as const;
  try {
    return await withAccountBrowser<{
      state: z.infer<typeof djinniSignupStatus>['state'] | 'runner_unavailable'; tabId?: string;
    }>(options, { url: djinniSignupUrl, preparedTabId }, unavailable, djinniSignupProgram, ({ exitCode, messages }) => {
      const parsed = messages.length === 1 && djinniSignupStatus.safeParse(messages[0]);
      if (exitCode !== 0 || !parsed || !parsed.success) return unavailable;
      const { state, tabId } = parsed.data;
      return { state, ...(tabId ? { tabId } : {}) };
    }, privateInput);
  } finally {
    privateInput.fill(0);
  }
}

export function prepareDjinniSignup(work: AccountWork, options: SignupOptions) {
  return runDjinniSignup(work, options);
}

export function createPreparedDjinniAccount(work: AccountWork, options: SignupOptions, preparedTabId: string,
  acceptedTermsAndPricing: boolean) {
  if (acceptedTermsAndPricing !== true || !/^[A-F0-9]{32}$/.test(preparedTabId)) {
    return Promise.resolve({ state: 'terms_confirmation_required' } as const);
  }
  return runDjinniSignup(work, options, preparedTabId);
}

export async function saveWorkdayPortalReference(work: AccountWork, status: 'prepared' | 'account_created' |
  'verification_pending' | 'account_creation_uncertain' | 'existing_account' | 'application_ready') {
  const target = accountTargetFor(work.sourceUrl);
  if (target?.portal !== 'workday' || target.company !== work.company || target.role !== work.role) throw new Error('invalid_workday_identity');
  const reference = await accountReference(work);
  if (!reference?.verifiedDelivery) throw new Error('invalid_workday_identity');
  const existing = await readLocal<Record<string, unknown>>('portal-identities.json').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return {};
  });
  const host = new URL(target.url).hostname;
  const key = work.applicationAddress ? `${host}:${work.applicationAddress}` : host;
  const { vaultShareId, vaultItemId } = reference;
  await writeLocal('portal-identities.json', { ...existing, [key]: { portal: 'workday',
    ...(work.applicationAddress ? { applicationAddress: work.applicationAddress } : { category: 'admin' }),
    url: target.url, vaultShareId, vaultItemId, status } });
}
