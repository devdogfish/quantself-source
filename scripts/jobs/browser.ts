import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { matchCandidateRules, type CandidateRules } from './candidate-rules';
import { readCandidateRules } from './local-candidate-rules';
import { directBrowserTarget } from './browser-direct-targets';

export type BrowserSubmitWork = {
  kind: 'submit';
  company: string;
  role: string;
  sourceUrl: string;
  applicationAddress?: string;
};

export type BrowserConnection = {
  browserUseCommand?: string;
  cdpUrl?: string;
  candidateRules?: CandidateRules;
};
export type BrowserOptions = BrowserConnection & {
  pdfPath: string;
  privateConfigPath: string;
  fieldMap?: FormFieldBinding[];
  beforeSubmit?: () => Promise<void>;
};

const privateKeyNames = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'region', 'country',
  'postalCode', 'addressLine1', 'linkedin', 'website'] as const;
const privateKeys = z.enum(privateKeyNames);
const fieldId = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_:.\[\]-]{0,100}$/);
const fieldLabelMax = 400;
const fieldLabel = z.string().min(1).max(fieldLabelMax);
const fieldText = z.string().min(1).max(200);
const fieldBinding = z.object({ id: fieldId, label: fieldLabel, key: privateKeys }).strict();
type FormFieldBinding = z.infer<typeof fieldBinding>;
const fieldDescriptor = z.object({
  id: fieldId, label: fieldLabel, type: z.enum(['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'textarea',
    'select', 'combobox', 'combobox-multi', 'checkbox', 'checkbox-group', 'radio']), required: z.boolean(), options: z.array(fieldText).max(30),
}).strict();
type FormFieldDescriptor = z.infer<typeof fieldDescriptor>;
const browserGate = z.object({
  kind: z.enum(['human_verification', 'privacy_agreement', 'authentication']),
  url: z.url(),
  policyUrl: z.url().optional(),
}).strict();
export type BrowserGate = z.infer<typeof browserGate>;
const discovered = z.object({ qsJobsBrowser: z.literal('discovered'), fields: z.array(fieldDescriptor).max(40),
  gate: browserGate.optional() }).strict();
const attention = z.object({ qsJobsBrowser: z.literal('manual_required'),
  questions: z.array(fieldDescriptor).max(40), variables: z.array(privateKeys).max(12), gate: browserGate.optional() }).strict();

type FailureCode = 'unsupported_portal' | 'manual_required' | 'runner_unavailable' | 'submission_uncertain';
export type BrowserResult =
  | { kind: 'applied'; receiptCode: 'confirmation_page' | 'confirmation_message' }
  | { kind: 'failed'; code: FailureCode; attention?: Pick<z.infer<typeof attention>, 'questions' | 'variables'>; gate?: BrowserGate;
      workdayStage?: 'my_experience'; safeToResume?: true };

export const browserSubmitGate = `
def await_submit_ack():
    path = os.environ.get('QS_JOBS_SUBMIT_ACK_SOCKET')
    if path is None:
        return True
    import socket
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.connect(path)
        emit('submit_gate')
        return channel.recv(1) == b'1'
`;

const brandedResumeMaxBytes = 4 * 1024 * 1024;

function portalFor(sourceUrl: string) {
  const source = URL.parse(sourceUrl);
  if (!source || source.protocol !== 'https:' || source.username || source.password || source.port) return;
  const path = source.pathname.replace(/\/$/, '');
  const lever = ['jobs.lever.co', 'jobs.eu.lever.co'].includes(source.hostname);
  const greenhouse = ['job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.greenhouse.io', 'boards.eu.greenhouse.io'].includes(source.hostname);
  if (lever && /^\/[a-z\d_-]+\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/apply)?$/i.test(path)) {
    const listingPath = path.replace(/\/apply$/, '');
    const listingUrl = `${source.origin}${listingPath}`;
    return { portal: 'lever', url: `${listingUrl}/apply`, listingUrl, listingPath };
  }
  if (greenhouse && /^\/[a-z\d_-]+\/jobs\/\d+$/i.test(path)) {
    // Legacy boards redirects to the corresponding first-party job board.
    const host = source.hostname.startsWith('boards.') ? `job-${source.hostname}` : source.hostname;
    const listingUrl = `https://${host}${path}`;
    return { portal: 'greenhouse', url: listingUrl, listingUrl, listingPath: path };
  }
  if (source.hostname === 'jobs.ashbyhq.com' &&
      /^\/[a-z\d_-]+(?:\.[a-z\d_-]+)*\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/application)?$/i.test(path)) {
    const listingPath = path.replace(/\/application$/, '');
    const locations = source.searchParams.getAll('locationId');
    if (locations.length > 1 || (locations.length && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(locations[0]))) return;
    const query = locations.length ? `?locationId=${locations[0]}` : '';
    return { portal: 'ashby', url: `${source.origin}${listingPath}/application${query}`,
      listingUrl: `${source.origin}${listingPath}${query}`, listingPath };
  }
  const site = directBrowserTarget(sourceUrl);
  if (site) return { portal: site.portal, url: site.url, listingUrl: site.listingUrl, listingPath: site.listingPath, site };
}

const BROWSER_PROGRAM = String.raw`
import json
import os
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

params = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
expected = urlsplit(params['url'])
expected_path = expected.path.rstrip('/')
expected_query = parse_qs(expected.query, keep_blank_values=True)
portal = params['portal']
site = params.get('site') or {}
embedded = portal == 'greenhouse' and bool(site)
bound_query = embedded or portal in ('rippling', 'branded', 'jazzhr', 'taleo')
branded_max_bytes = ${brandedResumeMaxBytes}
form_selector, resume_selector, fields = {
    'greenhouse': ('form#application-form', 'input#resume[type=file]',
        {'input#first_name': 'firstName', 'input#last_name': 'lastName', 'input#email': 'email', 'input#phone': 'phone'}),
    'lever': ('form#application-form, form.application-form', 'input#resume-upload-input[type=file]',
        {'input[name="name"]': 'fullName', 'input[name="email"]': 'email', 'input[name="phone"]': 'phone',
         'input[name="urls[LinkedIn]"]': 'linkedin', 'input[name="urls[Website]"]': 'website'}),
    'ashby': ('div#form[role=tabpanel] > div.ashby-application-form-container',
        'input#_systemfield_resume[type=file], input[name="_systemfield_resume"][type=file]',
        {'input#_systemfield_name, input[name="_systemfield_name"]': 'fullName',
         'input#_systemfield_email, input[name="_systemfield_email"]': 'email',
         'input#_systemfield_phone, input[name="_systemfield_phone"]': 'phone'}),
    'manatal': (None, None, {}),
    'workable': ('form[data-ui="application-form"]', 'input[data-ui="resume"][type=file]',
        {'input[data-ui="firstname"][name="firstname"][type=text]': 'firstName',
         'input[data-ui="lastname"][name="lastname"][type=text]': 'lastName',
         'input[data-ui="email"][name="email"][type=email]': 'email'}),
    'rippling': ('main#main-content form', 'input[data-testid="input-resume"][type=file i]',
        {'input[data-testid="input-first_name"][data-input="first_name"]': 'firstName',
         'input[data-testid="input-last_name"][data-input="last_name"]': 'lastName',
         'input[data-testid="input-email"][data-input="email"]': 'email',
         'input[data-testid="input-phone_number"][data-input="phone_number"]': 'phone'}),
    'branded': (None, None, {}),
    'jazzhr': ('form#form_submit_new_resume', 'input#resumator-resume-value[name=resumator-resume-value][type=file]',
        {'input#resumator-firstname-value[name=resumator-firstname-value][type=text]': 'firstName',
         'input#resumator-lastname-value[name=resumator-lastname-value][type=text]': 'lastName',
         'input#resumator-email-value[name=resumator-email-value][type=email]': 'email',
         'input#resumator-phone-value[name=resumator-phone-value][type=tel]': 'phone'}),
    'taleo': ('form#dialogTemplate-dialogForm', '', {}),
}[portal]
if 'form' in site:
    form_selector, resume_selector, fields = (site['form'][key] for key in ('selector', 'resumeSelector', 'fields'))
started = False
clicked = False
submission_context = None
blank_questions = []

def emit(status, **data):
    print(json.dumps({'qsJobsBrowser': status, **data}), flush=True)

${browserSubmitGate}

def normalized(text):
    return ' '.join(unicodedata.normalize('NFKC', text).split()).casefold()

def same_url(raw, path):
    url = urlsplit(raw)
    return url.scheme == expected.scheme and url.netloc == expected.netloc and url.path.rstrip('/') == path

def same_listing(raw):
    url = urlsplit(raw)
    actual_query = parse_qs(url.query, keep_blank_values=True)
    return same_url(raw, expected_path) and (
        not url.fragment and actual_query == expected_query if bound_query else
        actual_query.get('locationId') == expected_query.get('locationId'))

def page():
    return js('''(() => {
      const shown = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const challenge = [...document.querySelectorAll('iframe, input[type=password]')].some(e =>
        shown(e) && (e.type === 'password' || (e.offsetHeight > 90 && /captcha|challenge/i.test(e.title + ' ' + e.src))));
      const headings = [...document.querySelectorAll('h1, h2, .posting-headline h3, [role=status], .text-center > p.font-weight-bold, [data-ui=job-title]')]
        .filter(shown).map(e => e.textContent.trim());
      const consent = /\bby (?:submitting|applying)[^.]{0,300}\b(?:consent|agree|authorize)\b|\b(?:use of ai|ai[- ]powered|automated decision.making)\b[^.]{0,120}\b(?:evaluat|screen|candidacy)/i.test(document.body?.innerText ?? '');
      return {url: location.href, title: document.title, headings, challenge, consent};
    })()''')

def open_target():
    if portal == 'taleo':
        goto_url(params['listingUrl'])
        wait_for_load()
        source = page()
        role = site['role']
        if source['url'] != params['listingUrl'] or source['challenge'] or (
            source['title'] != site['sourceTitle']) or role not in source['headings'] or not js('''(expected => {
              const links = [...document.querySelectorAll('a[href*="jobapply.ftl"]')].filter(e =>
                e.getClientRects().length && e.textContent.trim() === 'Apply now');
              return links.length > 0 && links.every(e => e.href === expected);
            })(''' + json.dumps(site['sourceApply']) + ')'):
            return None
    if portal == 'rippling':
        goto_url(site['sourceListing'])
        wait_for_load()
        source = page()
        if (source['url'] != site['sourceListing'] or source['challenge'] or
            normalized(site['sourceHeading']) not in map(normalized, source['headings']) or not js('''(([url, label]) =>
              [...document.querySelectorAll('a[href]')].some(a => a.getAttribute('href') === url &&
                a.textContent.trim().toLowerCase() === label.toLowerCase()))(''' +
              json.dumps([site['sourceLinkHref'], site['sourceLinkLabel']]) + ')')):
            return None
        goto_url(params['listingUrl'])
        wait_for_load()
        listing = page()
        if (listing['url'] != params['listingUrl'] or listing['challenge'] or
            normalized(listing['title']) != normalized(site['listingTitle']) or
            normalized(site['listingHeading']) not in map(normalized, listing['headings']) or not js(
                """[...document.querySelectorAll('button[data-testid="Apply now"]')].some(b => b.textContent.trim() === 'Apply now' && !b.disabled && b.getClientRects().length)""")):
            return None
    if embedded:
        goto_url(params['listingUrl'])
        wait_for_load()
        source = page()
        headings = js("[...document.querySelectorAll('h1')].map(e => e.textContent.trim())")
        if source['url'] != params['listingUrl'] or source['challenge'] or source['consent'] or len(headings) != 1:
            return None
        if not headings[0]:
            return None
        role = headings[0]
        if normalized(source['title']) != normalized(site['sourceTitle']):
            return None
        frames = js("[...document.querySelectorAll('iframe[title=\"Job Application Form\"]')].map(f => f.src)")
        if len(frames) != 1:
            return None
        frame = urlsplit(frames[0])
        if (frame.scheme != 'https' or frame.netloc not in ('boards.greenhouse.io', expected.netloc) or frame.path != expected.path or
            frame.fragment or parse_qs(frame.query, keep_blank_values=True) != expected_query):
            return None
    goto_url(params['url'])
    wait_for_load()
    state = page()
    if not same_listing(state['url']) or state['challenge']:
        return None
    if portal in ('ashby', 'workable', 'rippling', 'branded'):
        if not wait_for_element(form_selector, timeout=8):
            return None
        state = page()
        if not same_listing(state['url']) or state['challenge']:
            return None
    if embedded and (normalized(state['title']) != normalized(site['applicationTitle']) or
                     normalized(role) not in map(normalized, state['headings'])):
        return None
    if portal == 'rippling' and (normalized(state['title']) != normalized(site['applicationTitle']) or
        normalized(site['applicationHeading']) not in map(normalized, state['headings'])):
        return None
    if portal == 'branded' and (state['title'] != site['pageTitle'] or not js('''(([english, french, role, headingSelector]) => {
      const titles = document.querySelectorAll(headingSelector);
      const alternate = (lang, url) => {
        const links = document.querySelectorAll('link[rel=alternate][hreflang="' + lang + '"]');
        return links.length === 1 && links[0].href === url;
      };
      return location.href === english && document.documentElement.lang === 'en-CA' && titles.length === 1 &&
        titles[0].textContent.trim() === role && alternate('en-CA', english) && alternate('fr-CA', french);
    })(''' + json.dumps([params['listingUrl'], site['sourceListing'], site['role'], site['headingSelector']]) + ')')):
        return None
    return state

def listing_identity(state):
    role, company = normalized(params.get('role') or ''), normalized(params.get('company') or '')
    if not role or not company or (site and (company, role) != (normalized(site['company']), normalized(site['role']))):
        return False
    alias = params.get('identityAlias')
    if alias and (company, role) == (normalized(alias['company']), normalized(alias['role'])):
        company, role = normalized(alias['pageCompany']), normalized(alias['pageRole'])
    if portal == 'taleo':
        return (company == normalized(site['company']) and role == normalized(site['role']) and same_listing(state['url']) and
                state['title'] == site['applicationTitle'] and site['applicationHeading'] in state['headings'])
    title = {'lever': f'{company} - {role}', 'greenhouse': f'job application for {role} at {company}',
             'ashby': f'{role} @ {company}', 'manatal': f'{role} - {company} | career page',
             'workable': f'{role} - {company} - application', 'rippling': f'apply - {role}',
             'branded': f'{role} | {company}', 'jazzhr': f'{role} - {company} - career page'}[portal]
    heading = f'application: {role}' if portal == 'rippling' else role
    return (same_listing(state['url']) and normalized(state['title']) == title and
            heading in map(normalized, state['headings']))

def controls_script():
    return 'const reviewedForm = ' + json.dumps(site) + ';' + '''
      const squash = text => text.replace(/[\u200b\u2060\ufeff]/g, '').trim().replace(/\s+/g, ' ');
      const withoutRequiredMarker = text => squash(text).replace(/^[✱*]\s*|[✱*]\s*$/g, '').trim();
      const onWorkable = location.hostname === 'apply.workable.com';
      const onRippling = location.hostname === 'ats.rippling.com';
      const ripplingField = e => {
        if (!onRippling) return null;
        if (e.matches('[data-testid=phone_number-code] input[data-testid=input-select-search-input][role=combobox]')) {
          return {id:'phone_number-code', label:'Phone country calling code',
            selector:'[data-testid=phone_number-code] input[data-testid=input-select-search-input][role=combobox]'};
        }
        if (e.matches('[data-testid=location] input[data-testid=input-undefined][aria-autocomplete=list]')) {
          return {id:'location', label:'Location', selector:'[data-testid=location] input[data-testid=input-undefined][aria-autocomplete=list]'};
        }
        if (e.matches('label[data-testid=resume] input[data-testid=input-resume][type=file]')) {
          return {id:'resume', label:'Résumé', selector:'input[data-testid=input-resume][type=file]'};
        }
        if (e.matches('label[data-testid=cover_letter] input[data-testid=input-cover_letter][type=file]')) {
          return {id:'cover_letter', label:'Cover letter', selector:'input[data-testid=input-cover_letter][type=file]'};
        }
        const key = e.getAttribute('data-input');
        if (['first_name','last_name','email','phone_number','current_company'].includes(key) &&
            e.getAttribute('data-testid') === 'input-' + key) {
          return {id:key, selector:'input[data-testid=input-' + key + '][data-input=' + key + ']'};
        }
        if (e.matches('input[data-testid=input-select-search-input][role=combobox]') &&
            document.getElementById(e.getAttribute('aria-labelledby'))?.textContent.trim() === 'Pronouns') {
          return {id:'pronouns', label:'Pronouns'};
        }
        return null;
      };
      const ripplingPlace = root => root.querySelector('input[type=hidden][data-testid=input-externalPlaceId][data-input=externalPlaceId]');
      const workableRadio = e => {
        if (!onWorkable || e.type !== 'radio' || !reviewedForm.radioNames?.includes(e.name)) return null;
        const wrapper = e.closest('[role=radio][data-ui=option]');
        const fieldset = wrapper?.closest('fieldset[role=radiogroup]');
        return fieldset?.getAttribute('data-ui') === e.name ? wrapper : null;
      };
      const workableFile = e => onWorkable && e.type === 'file' ?
        {resume: 'Resume', avatar: 'Photo'}[e.getAttribute('data-ui')] : null;
      const reviewedTerms = e => {
        if (!reviewedForm.termsControl || !e?.matches(reviewedForm.termsControl)) return '';
        const span = e.nextElementSibling;
        const paths = [...(span?.querySelectorAll('a[href]') ?? [])].map(link => link.getAttribute('href'));
        if (!span?.matches('span') || !paths.includes(reviewedForm.termsPath) || !paths.includes(reviewedForm.privacyPath)) return '';
        return squash(span.textContent) === reviewedForm.termsLabel ? squash(span.textContent) : '';
      };
      const manatalLabel = e => location.hostname === 'www.careers-page.com' ?
        e.closest('.form-group')?.querySelector(':scope > label')?.textContent ?? '' : '';
      const clean = (text, max = 200) => {
        const s = squash(text);
        return s && s.length <= max && !/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d .()-]{6,}\d|https?:\/\//i.test(s) ? s : '';
      };
      const labelFor = e => {
        const platformLabel = workableRadio(e)?.textContent || workableFile(e) || ripplingField(e)?.label;
        if (platformLabel) return squash(platformLabel);
        if (reviewedForm.portal === 'branded') {
          if (e.matches(reviewedForm.form.resumeSelector)) return 'Resume or CV';
          if (e.tagName === 'SELECT' && e.labels.length === 1 && e.labels[0].contains(e)) {
            const heading = e.labels[0].querySelector(':scope > span');
            if (heading) return withoutRequiredMarker(heading.textContent);
          }
        }
        const labels = [...(e.labels ?? [])].map(l => l.textContent).join(' ');
        const labelledBy = e.getAttribute('aria-labelledby') ||
          (e.type === 'file' ? e.closest('[role=group]')?.getAttribute('aria-labelledby') : '');
        const ariaLabels = (labelledBy ?? '').split(/\s+/)
          .map(id => document.getElementById(id)?.textContent ?? '').join(' ');
        const leverLabel = !['checkbox', 'radio'].includes(e.type) ?
          e.closest('li.application-question')?.querySelector('.application-label')?.textContent : '';
        const label = withoutRequiredMarker(e.getAttribute('aria-label') || ariaLabels.trim() || leverLabel || labels ||
          reviewedTerms(e) || manatalLabel(e));
        return location.hostname === 'www.careers-page.com' ? label.replace(/:$/, '') : label;
      };
      const required = e => e.required || e.getAttribute('aria-required') === 'true' || Boolean(reviewedTerms(e)) ||
        ripplingField(e)?.id === 'resume' ||
        reviewedForm.portal === 'branded' && e.matches(reviewedForm.form.resumeSelector) ||
        /\*\s*$/.test(manatalLabel(e)) ||
        e.labels && [...e.labels].some(l => /[✱*]\s*$/.test(l.textContent)) ||
        e.type === 'file' && e.closest('[role=group]')?.getAttribute('aria-required') === 'true' ||
        /[✱*]\s*$/.test(e.closest('li.application-question')?.querySelector('.application-label')?.textContent ?? '') ||
        /[✱*]\s*$/.test(document.getElementById(e.getAttribute('aria-labelledby'))?.textContent ?? '');
      const fieldId = e => ripplingField(e)?.id ?? (workableFile(e) ? e.getAttribute('data-ui') : e.id || e.name);
      const elements = root => [...root.querySelectorAll('input,select,textarea')];
      const grouped = (e, root) => ['radio', 'checkbox'].includes(e.type) && e.name ?
        elements(root).filter(input => input.type === e.type && input.name === e.name) : [e];
      const typeFor = (e, root) => {
        if (e.getAttribute('role') === 'combobox' || e.hasAttribute('aria-autocomplete')) {
          return e.closest('.select__value-container--is-multi') ? 'combobox-multi' : 'combobox';
        }
        if (e.tagName === 'SELECT') return 'select';
        if (e.tagName === 'TEXTAREA') return 'textarea';
        if (e.type === 'checkbox' && root && grouped(e, root).length > 1) return 'checkbox-group';
        return e.type;
      };
      const inputTypes = ['text', 'email', 'tel', 'url', 'number', 'date', 'textarea', 'select', 'combobox', 'combobox-multi', 'checkbox',
        'checkbox-group', 'radio'];
      const descriptor = (e, form) => {
        const type = typeFor(e, form), multiple = ['radio', 'checkbox-group'].includes(type);
        const group = multiple ? grouped(e, form) : [e];
        const fieldset = e.closest('fieldset');
        const question = multiple ? fieldset?.querySelector('legend')?.textContent ||
          (workableRadio(e) ? document.getElementById(fieldset?.getAttribute('aria-labelledby'))?.textContent : null) ||
          e.closest('li.application-question.custom-question')?.querySelector('.application-label')?.textContent : labelFor(e);
        const id = multiple ? e.name : fieldId(e);
        const label = clean(withoutRequiredMarker(question ?? ''), ${fieldLabelMax});
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_:.\[\]-]{0,100}$/.test(id) || !label || ![...inputTypes, 'file'].includes(type)) return null;
        const options = type === 'select' ? [...e.options].filter(o => o.value && !o.disabled).map(o => clean(o.textContent)) :
          multiple ? group.map(o => clean(labelFor(o))) : [];
        return {id, label, type, required: group.some(required), options: options.filter(Boolean).slice(0, 30)};
      };
      const selectorFor = (e, root) => ripplingField(e)?.selector ?? (['radio','checkbox-group'].includes(typeFor(e, root)) && e.name ?
        'input[type=' + e.type + '][name="' + CSS.escape(e.name) + '"]' :
        e.id ? '#' + CSS.escape(e.id) : e.name ? e.tagName.toLowerCase() + '[name="' + CSS.escape(e.name) + '"]' : '');
      const cleanInputs = form => elements(form).filter(e => !e.disabled &&
        (e.getAttribute('aria-hidden') !== 'true' || workableRadio(e)) &&
        !(onRippling && e.closest('[data-testid=sms_opt_in][role=radiogroup]')) &&
        !['hidden', 'button', 'submit', 'reset', 'password'].includes(e.type) && !e.classList.contains('iti__search-input'));
    '''

cookie_label = 'Workable cookie choice'
sms_label = 'Consent to receive SMS about this application'
rippling_terms_label = 'Agree to Rippling Terms of Service and User Privacy Notice'
rippling_sms_options = {'true': 'Yes - I consent to receiving text messages', 'false': 'No - I do not consent to receiving text messages'}

def rippling_policy_script():
    return '''
      const ripplingSmsOptions = ''' + json.dumps(rippling_sms_options) + ''';
      const ripplingSms = form => {
        const groups = [...form.querySelectorAll('[data-testid=sms_opt_in][role=radiogroup]')];
        if (groups.length !== 1) return null;
        const group = groups[0];
        const radios = [...group.querySelectorAll('[data-testid=radio-label-sms_opt_in][role=radio][data-value]')];
        if (radios.length !== 2 || new Set(radios.map(r => r.getAttribute('data-value'))).size !== 2 ||
            radios.some(r => squash(r.textContent) !== ripplingSmsOptions[r.getAttribute('data-value')] ||
              r.querySelectorAll('input[type=radio][data-testid=radio-sms_opt_in]').length !== 1)) return null;
        return {group, radios};
      };
      const ripplingPolicy = form => {
        if (/uses ai to analy[sz]e applications|do not wish for your application to be analy[sz]ed/i.test(document.body.innerText)) return false;
        const terms = form.querySelector('a[href="https://app.rippling.com/legal/user"]');
        const policy = form.querySelector('a[href="https://app.rippling.com/legal/privacy"]');
        const notice = terms?.parentElement;
        return Boolean(notice && policy?.parentElement === notice && terms.textContent.trim() === 'Terms of Service' &&
          policy.textContent.trim() === 'User Privacy Notice' &&
          /by clicking ["“]apply["”] you agree to rippling['’]s terms of service and user privacy notice/i.test(squash(notice.textContent)));
      };
      const smsMatches = (radios, choice) => radios.every(r => {
        const checked = ripplingSmsOptions[r.getAttribute('data-value')] === choice;
        return r.querySelector('input[type=radio]').checked === checked && r.getAttribute('aria-checked') === String(checked);
      });
    '''

def rippling_policy_questions():
    return [
        {'id': 'sms_opt_in', 'label': sms_label, 'type': 'radio', 'required': True, 'options': list(rippling_sms_options.values())},
        {'id': 'rippling_terms', 'label': rippling_terms_label, 'type': 'checkbox', 'required': True, 'options': []},
    ]

def jazz_verification_script():
    return '''
      const jazzVerification = form => {
        const anchors = [...form.querySelectorAll('iframe[title="reCAPTCHA"]')].filter(e => {
          const src = new URL(e.src, location.href);
          return e.getClientRects().length && getComputedStyle(e).visibility === 'visible' &&
            src.origin === 'https://www.google.com' && src.pathname === '/recaptcha/api2/anchor';
        });
        const responses = form.querySelectorAll('textarea#g-recaptcha-response[name="g-recaptcha-response"]');
        const response = responses.length === 1 && responses[0].form === form ? responses[0] : null;
        return anchors.length === 1 && response ? {response, verified: Boolean(response.value.trim())} : null;
      };
    '''

def current_gate():
    if portal == 'jazzhr':
        ready = js('''(selector => {
          ''' + jazz_verification_script() + '''
          const form = document.querySelector(selector);
          return Boolean(form && jazzVerification(form)?.verified);
        })(''' + json.dumps(form_selector) + ')')
        if ready is not True:
            return {'kind': 'human_verification', 'url': params['url']}
    if portal == 'taleo':
        agreement = js('''(([selector, origin, notice, agreementPath]) => {
          const shown = e => e?.getClientRects().length && getComputedStyle(e).visibility === 'visible';
          const form = document.querySelector(selector);
          const accept = form?.querySelector('input#dialogTemplate-dialogForm-StatementBeforeAuthentificationContent-ContinueButton[type=button][value="I Accept"]');
          const decline = form?.querySelector('input#dialogTemplate-dialogForm-StatementBeforeAuthentificationContent-CancelButton[type=button][value="I Decline"]');
          const action = form && new URL(form.action);
          return Boolean(shown(accept) && shown(decline) && form.method === 'post' &&
            action.origin === origin &&
            action.pathname === agreementPath &&
            form.innerText.normalize('NFKC').replace(/[’]/g, "'").toLowerCase().includes(notice));
        })(''' + json.dumps([form_selector, expected.scheme + '://' + expected.netloc,
                             site['policyNotice'].replace('’', "'").casefold(), site['agreementPath']]) + ')')
        if agreement:
            return {'kind': 'privacy_agreement', 'url': params['url'], 'policyUrl': site['policyUrl']}
    return None

def branded_form_script():
    return '''
      const [optionalSelector, optionalLabel] = reviewedForm.optionalControl ?? [];
      const brandedShape = form => {
        const headings = document.querySelectorAll(reviewedForm.headingSelector);
        if (document.title !== reviewedForm.pageTitle || headings.length !== 1 ||
            headings[0].textContent.trim() !== reviewedForm.role ||
            form.hasAttribute('action') || form.hasAttribute('method')) return false;
        const requiredMatch = ([selector, label]) => {
          const elements = form.querySelectorAll(selector);
          return elements.length === 1 && elements[0].form === form &&
            elements[0].required && !elements[0].disabled && labelFor(elements[0]) === label;
        };
        const talent = form.querySelectorAll(optionalSelector);
        return reviewedForm.requiredControls.every(requiredMatch) && talent.length === 1 && talent[0].form === form &&
          !talent[0].required && !talent[0].disabled && labelFor(talent[0]) === optionalLabel;
      };
      const brandedVerified = form => {
        const widget = form.querySelectorAll(reviewedForm.verificationSelector);
        const response = widget.length === 1 && widget[0].querySelectorAll(reviewedForm.verificationResponse);
        return Boolean(response && response.length === 1 && response[0].value.trim());
      };
    '''

def await_branded_verification():
    for _ in range(24):
        if not same_listing(js('location.href')):
            return False
        if js('''(selector => {
          ''' + controls_script() + branded_form_script() + '''
          const form = document.querySelector(selector);
          return Boolean(form && brandedVerified(form));
        })(''' + json.dumps(form_selector) + ')') is True:
            return True
        time.sleep(.25)
    return False

def rippling_sms(choice):
    return js('''(([selector, choice]) => {
      ''' + controls_script() + rippling_policy_script() + '''
      const form = document.querySelector(selector), options = form && ripplingSms(form);
      if (!options || !ripplingPolicy(form)) return false;
      const target = options.radios.find(e => ripplingSmsOptions[e.getAttribute('data-value')] === choice);
      if (!target || !target.getClientRects().length || target.getAttribute('aria-disabled') === 'true') return false;
      if (!smsMatches(options.radios, choice)) target.click();
      return true;
    })(''' + json.dumps([form_selector, choice]) + ')')

def workable_cookies(answer=None):
    return js('''(answer => {
      const shown = e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible';
      const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(shown);
      if (dialogs.length !== 1) return dialogs.length ? false : null;
      if (!dialogs[0].matches('[data-ui=cookie-consent][aria-label="Cookie Consent"]')) return false;
      const options = new Map([['Decline all', 'cookie-consent-decline'], ['Accept all', 'cookie-consent-accept']]);
      const available = new Map();
      for (const [label, id] of options) {
        const matches = [...dialogs[0].querySelectorAll('button[data-ui="' + id + '"]')].filter(b =>
          shown(b) && !b.disabled && !b.form && b.textContent.trim() === label);
        if (matches.length === 1) available.set(label, matches[0]);
      }
      if (!answer) return available.size ? [...available.keys()] : false;
      const button = available.get(answer);
      if (!button) return false;
      button.click();
      return true;
    })(''' + json.dumps(answer) + ')')

def discover():
    # Fresh incognito context: no applicant cookies, form values, profile or local file access.
    context = cdp('Target.createBrowserContext')['browserContextId']
    try:
        tab = cdp('Target.createTarget', url='about:blank', browserContextId=context, background=True)['targetId']
        switch_tab(tab)
        state = open_target()
        if state is None:
            return 'manual_required'
        if ('company' in params or 'role' in params) and not listing_identity(state):
            return 'identity_mismatch'
        gate = current_gate()
        if portal == 'taleo':
            return needs_answers(gate=gate)
        fields = js('''(selector => {
          const forms = document.querySelectorAll(selector);
          if (forms.length !== 1) return null;
          ''' + controls_script() + '''
          const result = [];
          for (const e of cleanInputs(forms[0])) {
            const field = descriptor(e, forms[0]);
            if (field && !result.some(other => other.id === field.id)) result.push(field);
          }
          return result.slice(0, 40);
        })(''' + json.dumps(form_selector) + ')')
        if fields is None:
            return 'manual_required'
        if portal == 'rippling':
            if not js('''(selector => {
              ''' + controls_script() + rippling_policy_script() + '''
              const form = document.querySelector(selector);
              return Boolean(form && ripplingSms(form) && ripplingPolicy(form) && ripplingPlace(form));
            })(''' + json.dumps(form_selector) + ')'):
                return 'manual_required'
            fields.extend(rippling_policy_questions())
        for field in [item for item in fields if item['type'] in ('combobox', 'combobox-multi')][:18]:
            focus = js('''(([root, id, label]) => {
              ''' + controls_script() + '''
              const form = document.querySelector(root);
              if (!form) return false;
              const controls = cleanInputs(form).filter(e => fieldId(e) === id && labelFor(e) === label &&
                ['combobox', 'combobox-multi'].includes(typeFor(e)));
              if (controls.length !== 1) return false;
              controls[0].focus();
              return document.activeElement === controls[0];
            })(''' + json.dumps([form_selector, field['id'], field['label']]) + ')')
            if not focus or not same_listing(js('location.href')):
                continue
            press_key('ArrowDown')
            for _ in range(3):
                choices = js('''(() => {
                  ''' + controls_script() + '''
                  const list = document.getElementById(document.activeElement?.getAttribute('aria-controls'));
                  if (!list || list.getAttribute('role') !== 'listbox') return [];
                  return [...list.querySelectorAll('[role=option]')].filter(o => o.getAttribute('aria-disabled') !== 'true')
                    .map(o => clean(o.textContent)).filter(Boolean).slice(0, 30);
                })()''')
                if choices:
                    field['options'] = choices
                    break
                time.sleep(.1)
            press_key('Escape')
        emit('discovered', fields=fields, **({'gate': gate} if gate else {}))
        return None
    finally:
        cdp('Target.disposeBrowserContext', browserContextId=context)

def value_script():
    return '''
      const optionText = text => squash(text);
      const equalAnswer = (actual, expected) => Array.isArray(actual) && Array.isArray(expected) ?
        JSON.stringify(actual) === JSON.stringify([...expected].sort()) : actual === expected;
      const hasAnswer = value => Array.isArray(value) ? value.length > 0 : Boolean(value);
      const readValue = (e, type, group = []) => {
        const rippling = ripplingField(e)?.id;
        if (rippling === 'phone_number') return e.value.replace(/\D/g, '');
        if (['phone_number-code', 'location', 'pronouns'].includes(rippling)) return squash(e.value);
        if (type === 'checkbox') return e.checked;
        if (type === 'checkbox-group') return group.filter(r => r.checked).map(labelFor).sort();
        if (type === 'radio') return group.find(r => r.checked) ? labelFor(group.find(r => r.checked)) : '';
        if (type === 'select') return e.value && e.selectedOptions.length === 1 ? optionText(e.selectedOptions[0].textContent) : '';
        if (type === 'combobox') return optionText(e.closest('[class*=select__container]')?.querySelector('[class*=select__single-value]')?.textContent ||
          e.getAttribute('aria-valuetext') || '');
        if (type === 'combobox-multi') return [...(e.closest('.select__container')?.querySelectorAll('.select__multi-value__label') ?? [])]
          .map(label => optionText(label.textContent)).sort();
        return e.value;
      };
      const matchesAnswer = (e, type, value, group = []) => {
        const kind = ripplingField(e)?.id;
        const expected = kind === 'phone_number-code' ? value.split(' - ')[0] : value;
        if (kind === 'location' && !ripplingPlace(e.form)?.value.trim()) return false;
        return equalAnswer(readValue(e, type, group), expected);
      };
    '''

def rippling_resume_script():
    return '''
      const ripplingResumePresent = (form, filename) => {
        const candidates = [...form.querySelectorAll('[data-testid=field]')].filter(field =>
          field.querySelector('label[data-testid=resume]') ||
          [...field.querySelectorAll('[id$=-label]')].some(label => withoutRequiredMarker(label.textContent) === 'Résumé'));
        if (candidates.length !== 1) return false;
        const file = candidates[0].querySelector('input[data-testid=input-resume][type=file]');
        return (file?.files.length === 1 && file.files[0].name === filename) ||
          [...candidates[0].querySelectorAll('span,div,p')].some(e =>
            !e.children.length && e.getClientRects().length && e.textContent.trim() === filename);
      };
    '''

def await_rippling_parse(filename):
    for _ in range(80):
        if not same_listing(js('location.href')):
            return False
        if js('''(([selector, name]) => {
          ''' + controls_script() + rippling_resume_script() + '''
          const form = document.querySelector(selector), body = document.body.innerText;
          return Boolean(form && ripplingResumePresent(form, name) &&
            body.includes('Résumé parsing was successful.') && !body.includes('Parsing the résumé.'));
        })(''' + json.dumps([form_selector, filename]) + ')'):
            return True
        time.sleep(.25)
    return False

def inspect_form(answer_labels=(), values=None, filename=None, submit=False, resume_target=None):
    config = json.dumps({'formSelector': form_selector, 'resumeSelector': resume_selector,
                         'fields': fields, 'values': values, 'filename': filename,
                         'expectedOrigin': f'{expected.scheme}://{expected.netloc}',
                         'expectedPath': expected_path, 'submit': submit, 'portal': portal,
                         'expectedLocations': expected_query.get('locationId', []),
                         'boundQuery': expected_query if bound_query else None,
                         'smsChoice': params.get('smsChoice'),
                         'expectedResumeTarget': resume_target,
                         'fieldMap': params.get('fieldMap', []), 'answerLabels': list(answer_labels)})
    return js('''(p => {
      const one = (root, selector) => {
        const matches = root.querySelectorAll(selector);
        return matches.length === 1 ? matches[0] : null;
      };
      if (location.origin !== p.expectedOrigin || location.pathname.replace(/\/$/, '') !== p.expectedPath) return null;
      if (JSON.stringify(new URL(location.href).searchParams.getAll('locationId')) !== JSON.stringify(p.expectedLocations)) return null;
      const boundRoute = search => !p.boundQuery ||
        [...search.keys()].length === Object.keys(p.boundQuery).length &&
        Object.entries(p.boundQuery).every(([name, values]) => JSON.stringify(search.getAll(name)) === JSON.stringify(values));
      if (!boundRoute(new URL(location.href).searchParams) || p.boundQuery && location.hash) return null;
      const form = one(document, p.formSelector);
      if (!form) return null;
      const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible';
      const nativeForm = form instanceof HTMLFormElement;
      const nativeOwner = nativeForm ? form : null;
      let submit;
      if (nativeForm) {
        const action = new URL(form.action);
        if (action.origin !== p.expectedOrigin || action.pathname.replace(/\/$/, '') !== p.expectedPath ||
            !boundRoute(action.searchParams) || p.boundQuery && action.hash || !['', '_self'].includes(form.target) ||
            (['lever','jazzhr'].includes(p.portal) && form.method.toLowerCase() !== 'post') ||
            (p.portal === 'jazzhr' && form.enctype !== 'multipart/form-data')) return null;
        const submitSelector = ({manatal: 'button#submit-id-submit[type=submit][name=submit]',
          workable: 'button[data-ui=apply-button][type=submit]', rippling: 'button[data-testid=Apply][type=submit]',
          jazzhr: 'div#resumator-submit > a#resumator-submit-resume[href="#"]'})[p.portal] ??
          'button[type=submit], input[type=submit]';
        const visible = [...form.querySelectorAll(submitSelector)].filter(shown);
        if (visible.length === 1) submit = visible[0];
      } else if (p.portal === 'ashby' && form.parentElement?.matches('div#form[role=tabpanel]')) {
        const panel = form.parentElement;
        const controls = panel.querySelectorAll('button.ashby-application-form-submit-button');
        if (controls.length !== 1 || controls[0].parentElement !== panel ||
            ![null, 'submit'].includes(controls[0].getAttribute('type'))) return null;
        submit = controls[0];
        const surveys = panel.querySelectorAll(':scope > div.ashby-survey-form-container');
        const extras = [...document.querySelectorAll('div.ashby-application-form-container')].filter(e => e !== form);
        if (surveys.length > 1 || extras.length !== surveys.length) return null;
        if (surveys.length && (extras[0].parentElement !== surveys[0] ||
            [...surveys[0].querySelectorAll('input,select,textarea,[aria-required=true],[contenteditable=true]')].some(e =>
              e.required || e.getAttribute('aria-required') === 'true' || e.isContentEditable ||
              (e.type !== 'hidden' && (['checkbox','radio'].includes(e.type) ? e.checked : Boolean(e.value)))))) return null;
      }
      if (!submit || !shown(submit) || (p.portal === 'jazzhr' ? submit.closest('form') : submit.form) !== nativeOwner ||
          submit.hasAttribute('formaction') ||
          submit.hasAttribute('formmethod') || submit.hasAttribute('formtarget') ||
          !(['manatal', 'rippling'].includes(p.portal) ? /^apply$/i : /^submit application$/i).test(submit.textContent.trim() || submit.value)) return null;
      ''' + controls_script() + '''
      ''' + value_script() + '''
      ''' + rippling_policy_script() + rippling_resume_script() + '''
      ''' + branded_form_script() + '''
      ''' + jazz_verification_script() + '''
      if (p.portal === 'manatal' && !reviewedTerms(one(form, reviewedForm.termsControl))) return null;
      if (p.portal === 'branded' && !brandedShape(form)) return null;
      const sms = p.portal === 'rippling' ? ripplingSms(form) : null;
      const jazzCaptcha = p.portal === 'jazzhr' ? jazzVerification(form) : null;
      if (p.portal === 'jazzhr' && !jazzCaptcha) return null;
      if (p.portal === 'rippling' && (!sms || !ripplingPolicy(form) || !ripplingPlace(form))) return null;
      const resumeChoices = [...form.querySelectorAll(p.resumeSelector)];
      const labelledResume = [...form.querySelectorAll('input[type=file]')].filter(e =>
        ['Resume', 'Resume/CV', 'CV'].includes(labelFor(e)));
      const resume = resumeChoices.length ? one(form, p.resumeSelector) : labelledResume.length === 1 ? labelledResume[0] : null;
      if (p.portal === 'manatal' && (!resume || labelFor(resume) !== 'Resume')) return null;
      if (p.portal === 'rippling' && resume && ripplingField(resume)?.id !== 'resume') return null;
      if (p.portal === 'branded' && (!resume || resume.multiple || !resume.accept.toLowerCase().split(',').map(s => s.trim()).includes('.pdf'))) return null;
      const resumeTarget = resume ? ['workable','rippling'].includes(p.portal) ? p.resumeSelector : selectorFor(resume) : '';
      if (p.expectedResumeTarget && resumeTarget !== p.expectedResumeTarget) return null;
      const greenhouseResumeWidget = p.portal === 'greenhouse' ?
        one(form, '[role=group][aria-labelledby="upload-label-resume"]') : null;
      const seen = new Set([resume, greenhouseResumeWidget].filter(Boolean));
      if (jazzCaptcha) seen.add(jazzCaptcha.response);
      if (sms) {
        seen.add(sms.group);
        for (const child of sms.group.querySelectorAll('*')) seen.add(child);
      }
      const mapping = [];
      const eligible = e => e && shown(workableRadio(e) ?? e) && !e.disabled && !e.readOnly &&
        e.form === nativeOwner && inputTypes.includes(typeFor(e, form));
      const inputs = cleanInputs(form);
      const add = (e, key) => {
        if (!eligible(e) || seen.has(e) || mapping.some(f => f.key === key)) return false;
        const selector = selectorFor(e, form);
        const matches = selector ? [...form.querySelectorAll(selector)] : [];
        const field = descriptor(e, form);
        const type = typeFor(e, form);
        if (!matches.includes(e) || (!['radio', 'checkbox-group'].includes(type) && matches.length !== 1) ||
            matches.some(match => seen.has(match) || !eligible(match))) return false;
        for (const match of matches) seen.add(match);
        const group = type === 'checkbox-group' ? e.closest('fieldset.checkbox') : null;
        if (group) seen.add(group);
        const radioGroup = workableRadio(e)?.closest('fieldset[role=radiogroup]');
        if (radioGroup) seen.add(radioGroup);
        mapping.push({selector, key, type, required: matches.some(required) || Boolean(group && required(group)), question: field});
        return true;
      };
      for (const binding of p.fieldMap) {
        if (p.portal === 'branded' && binding.id === 'province' && p.answerLabels.includes('Province')) continue;
        const matches = inputs.filter(e => fieldId(e) === binding.id && labelFor(e) === binding.label);
        if (matches.length !== 1 || !add(matches[0], binding.key)) return null;
      }
      for (const [selector, key] of Object.entries(p.fields)) {
        const e = one(form, selector);
        if (!eligible(e)) continue;
        if (p.portal === 'manatal' && labelFor(e) !== { fullName: 'Full Name', email: 'Email', phone: 'Phone' }[key]) return null;
        if (p.portal === 'rippling' && labelFor(e) !== { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone number' }[key]) return null;
        if (p.portal === 'ashby' && key === 'fullName' &&
            !['name', 'full name', 'preferred name', 'first & last name', 'please enter your full name'].includes(labelFor(e).toLowerCase())) return null;
        if (p.portal === 'jazzhr' &&
            (!required(e) || labelFor(e) !== {firstName:'First Name',lastName:'Last Name',email:'Email Address',phone:'Phone'}[key])) return null;
        if (p.portal === 'branded') {
          if (labelFor(e) !== { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', city: 'City', region: 'Province' }[key] ||
              !e.required) return null;
          if (key === 'region' && p.answerLabels.includes('Province')) continue;
        }
        if (mapping.some(f => f.key === key)) {
          if (!seen.has(e)) return null;
          continue;
        }
        if (!add(e, key)) return null;
      }
      const common = { 'LinkedIn Profile': 'linkedin', 'LinkedIn Profile:': 'linkedin', 'LinkedIn URL': 'linkedin',
        'Website': 'website', 'Website URL': 'website' };
      if (p.portal === 'ashby') {
        const phones = inputs.filter(e => e.type === 'tel' && ['Phone', 'Phone Number'].includes(labelFor(e)));
        if (phones.length === 1 && !seen.has(phones[0]) && !mapping.some(f => f.key === 'phone')) add(phones[0], 'phone');
      }
      for (const [label, key] of Object.entries(common)) {
        const matches = inputs.filter(e => !seen.has(e) && labelFor(e) === label);
        if (matches.length === 1 && !mapping.some(f => f.key === key)) add(matches[0], key);
      }
      for (const label of p.answerLabels) {
        const matching = inputs.filter(e => !seen.has(e) && descriptor(e, form)?.label === label);
        if (!matching.length) continue;
        if (new Set(matching.map(e => selectorFor(e, form))).size !== 1 || !add(matching[0], 'question:' + label)) return null;
      }
      if (!mapping.some(f => f.key === 'email') || (['greenhouse', 'workable', 'rippling', 'branded', 'jazzhr'].includes(p.portal) ?
          !mapping.some(f => f.key === 'firstName') || !mapping.some(f => f.key === 'lastName') :
          !mapping.some(f => f.key === 'fullName'))) return null;
      if (p.portal === 'branded' && ['phone', 'city'].some(key => !mapping.some(f => f.key === key))) return null;
      const blocked = [];
      let unmapped = false;
      for (const e of form.querySelectorAll('input, select, textarea, [aria-required=true], [contenteditable=true]')) {
        if (seen.has(e) || e.type === 'hidden' || e.disabled || ['submit', 'button', 'reset'].includes(e.type)) continue;
        // react-select uses an unlabelled validation input alongside its labelled combobox.
        const control = e.closest('[class*=select__container]')?.querySelector('[aria-autocomplete]');
        if (e.getAttribute('aria-hidden') === 'true' && !e.id && !e.name && control && seen.has(control)) continue;
        if (required(e) || (['checkbox', 'radio'].includes(e.type) ? e.checked : Boolean(e.value)) || e.isContentEditable) {
          const field = descriptor(e, form);
          if (field && !blocked.some(other => other.id === field.id)) blocked.push(field);
          else if (!field) unmapped = true;
        }
      }
      if (!p.filename && (!resume || !resumeTarget || one(form, resumeTarget) !== resume ||
          resume.disabled || resume.form !== nativeOwner || resume.files.length)) return null;
      if (!p.values || blocked.length || unmapped) return {mapping, blocked: blocked.slice(0, 40), unmapped, resumeTarget};
      for (const field of mapping) {
        const group = [...form.querySelectorAll(field.selector)];
        const e = group[0], value = p.values[field.key];
        const current = e ? readValue(e, field.type, group) : undefined;
        if (!e || (value !== undefined ? !matchesAnswer(e, field.type, value, group) : hasAnswer(current)) ||
            (field.required && value === undefined) || group.some(x => !x.validity?.valid || x.getAttribute('aria-invalid') === 'true')) return null;
      }
      if (p.filename) {
        const attached = resume?.files.length === 1 && resume.files[0].name === p.filename;
        const named = [...(greenhouseResumeWidget?.querySelectorAll('span, p, div') ?? [])].some(e =>
          !e.children.length && shown(e) && e.textContent.trim() === p.filename);
        if (!attached && !named && !(p.portal === 'rippling' && ripplingResumePresent(form, p.filename))) return null;
        if (p.portal === 'branded' && (!attached || resume.files[0].size > ${brandedResumeMaxBytes})) return null;
      }
      if (sms && (!p.smsChoice || !smsMatches(sms.radios, p.smsChoice))) return null;
      if (!p.submit) return true;
      if (p.portal === 'branded' && !brandedVerified(form)) return null;
      if (p.portal === 'jazzhr' && !jazzCaptcha.verified) return null;
      if (submit.disabled || submit.getAttribute('aria-disabled') === 'true' || submit.getAttribute('data-disabled') === 'true' ||
          (nativeForm && !form.checkValidity()) ||
          form.querySelector('[aria-invalid=true]')) return null;
      if (nativeForm && form.method.toLowerCase() !== 'post') {
        // Block the native GET fallback of an unhydrated application form.
        window.addEventListener('submit', event => {
          if (event.target === form) event.preventDefault();
        }, {once: true});
      }
      submit.click();
      return true;
    })(''' + config + ')')

def set_combobox(selector, kind, value):
    choices = value if kind == 'combobox-multi' else [value]
    for choice in choices:
        if not same_listing(js('location.href')):
            return False
        if kind == 'combobox-multi' and js('''(([s, v]) => {
          ''' + controls_script() + value_script() + '''
          const e = document.querySelector(s);
          return Boolean(e && readValue(e, 'combobox-multi').includes(v));
        })(''' + json.dumps([selector, choice]) + ')'):
            continue
        opened = js('''(s => {
          const e = document.querySelector(s);
          if (!(e instanceof HTMLInputElement)) return false;
          e.focus();
          return document.activeElement === e;
        })(''' + json.dumps(selector) + ')')
        if not opened:
            return False
        search = choice.split(' - ', 1)[1] if portal == 'rippling' and 'phone_number-code' in selector else choice
        fill_input(selector, search)
        press_key('ArrowDown')
        for _ in range(10):
            picked = js('''(([s, v]) => {
              ''' + controls_script() + '''
              const e = document.querySelector(s), list = document.getElementById(e?.getAttribute('aria-controls'));
              if (!list || list.getAttribute('role') !== 'listbox') return false;
              const options = [...list.querySelectorAll('[role=option]')].filter(o =>
                o.getAttribute('aria-disabled') !== 'true' && squash(o.textContent) === v && o.getClientRects().length);
              if (options.length !== 1) return false;
              options[0].click();
              return true;
            })(''' + json.dumps([selector, choice]) + ')')
            if picked:
                break
            time.sleep(.2)
        else:
            return False
    if kind == 'combobox-multi' and js('''(s => document.activeElement === document.querySelector(s))(''' + json.dumps(selector) + ')'):
        press_key('Escape')
    return verify_control(selector, kind, value)

def verify_control(selector, kind, value):
    return js('''(([s, t, v]) => {
      ''' + controls_script() + value_script() + '''
      const group = [...document.querySelectorAll(s)], e = group[0];
      return Boolean(e && matchesAnswer(e, t, v, group) &&
        (!['combobox', 'combobox-multi'].includes(t) || e.getAttribute('aria-expanded') === 'false' ||
          (ripplingField(e)?.id === 'location' && !e.hasAttribute('aria-controls'))));
    })(''' + json.dumps([selector, kind, value]) + ')')

def set_control(field, value):
    selector = ':is(' + form_selector + ') ' + field['selector']
    kind = field['type']
    if kind in ('combobox', 'combobox-multi'):
        return set_combobox(selector, kind, value)
    if kind in ('text', 'email', 'tel', 'url'):
        fill_input(selector, value)
        return verify_control(selector, kind, value)

    data = json.dumps([selector, kind, value])
    changed = js('''(([s, t, v]) => {
          ''' + controls_script() + value_script() + '''
          const group = [...document.querySelectorAll(s)], e = group[0];
          if (!e || (group.length !== 1 && !['radio', 'checkbox-group'].includes(t)) ||
              group.some(n => n.disabled || n.readOnly)) return false;
          if (t === 'select') {
            const options = [...e.options].filter(o => o.value && !o.disabled && optionText(o.textContent) === v);
            if (options.length !== 1) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, options[0].value);
            e.dispatchEvent(new Event('input', {bubbles: true}));
            e.dispatchEvent(new Event('change', {bubbles: true}));
          } else if (t === 'checkbox' && e.checked !== v) {
            e.click();
          } else if (t === 'checkbox-group') {
            if (!Array.isArray(v) || v.some(value => group.filter(o => labelFor(o) === value).length !== 1)) return false;
            for (const option of group) {
              if (option.checked !== v.includes(labelFor(option))) option.click();
            }
          } else if (t === 'radio') {
            const options = group.filter(o => labelFor(o) === v);
            if (options.length !== 1) return false;
            if (!options[0].checked) (workableRadio(options[0]) ?? options[0]).click();
          } else if (['number', 'date', 'textarea'].includes(t)) {
            const prototype = t === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, v);
            e.dispatchEvent(new Event('input', {bubbles: true}));
            e.dispatchEvent(new Event('change', {bubbles: true}));
          }
          return true;
        })(''' + data + ')')
    return changed and verify_control(selector, kind, value)

def needs_answers(questions=(), variables=(), gate=None):
    if started:
        questions = [question for question in questions if question in blank_questions]
    emit('manual_required', questions=list(questions)[:40], variables=list(dict.fromkeys(variables))[:12],
         **({'gate': gate} if gate else {}))
    return None

def use_local_field_map(private):
    saved = private.get('fieldMaps', {}).get(params['listingUrl'], [])
    if not isinstance(saved, list):
        return False
    bindings = params['fieldMap'] + saved
    if len(bindings) > 20:
        return False
    for b in bindings:
        if not isinstance(b, dict) or set(b) != {'id', 'label', 'key'} or not isinstance(b['id'], str) or not re.fullmatch(
            r'[a-zA-Z0-9_][a-zA-Z0-9_:.\[\]-]{0,100}', b['id']) or not isinstance(b['label'], str) or not (
            0 < len(b['label']) <= ${fieldLabelMax}) or b['key'] not in params['privateKeyNames']:
            return False
    if any(len({b[k] for b in bindings}) != len(bindings) for k in ('id', 'key')):
        return False
    params['fieldMap'] = bindings
    return True

def local_answers(mapping, personal, answers):
    values, questions, variables = {}, [], []
    for field in mapping:
        key, kind = field['key'], field['type']
        if key.startswith('question:'):
            answer = answers[key.removeprefix('question:')]
            shape = ('boolean' if kind == 'checkbox' else 'options' if kind in ('checkbox-group', 'combobox-multi') else
                     'option' if kind in ('select', 'combobox', 'radio') else 'text')
            value = answer.get('value') if isinstance(answer, dict) and answer.get('type') == shape else None
        else:
            value = personal.get(key)
        if kind == 'checkbox':
            valid = isinstance(value, bool) and (value or not field['required'])
        elif kind in ('checkbox-group', 'combobox-multi'):
            valid = (isinstance(value, list) and len(value) <= 30 and (bool(value) or not field['required']) and
                     all(isinstance(item, str) and 0 < len(item) <= 200 and item == item.strip() for item in value) and
                     len(set(value)) == len(value))
        else:
            valid = (isinstance(value, str) and value.strip() and len(value) <= (2000 if kind == 'textarea' else 255) and
                     '\0' not in value and (kind == 'textarea' or not any(c in value for c in '\r\n')))
        if kind == 'checkbox-group' and valid and field['question'] and re.search(
                r'\(please choose one\)', field['question']['label'], re.IGNORECASE) and len(value) != 1:
            valid = False
        if portal == 'branded' and kind == 'select' and field['question'] and (
                not valid or value.strip() not in field['question']['options']):
            questions.append(field['question'])
            continue
        if not valid:
            if field['required'] or (value is not None and (not isinstance(value, str) or value.strip())) or key.startswith('question:'):
                if key.startswith('question:') and field['question']:
                    questions.append(field['question'])
                elif not key.startswith('question:'):
                    variables.append(key)
            continue
        values[key] = value.strip() if isinstance(value, str) else value
    return values, questions, variables

def attach_pdf(shape, file):
    if not same_listing(js('location.href')):
        return False
    document = cdp('DOM.getDocument')['root']['nodeId']
    upload = ':is(' + form_selector + ') ' + shape['resumeTarget']
    node = cdp('DOM.querySelector', nodeId=document, selector=upload)['nodeId']
    if not node:
        return False
    cdp('DOM.setFileInputFiles', nodeId=node, files=[str(file)])
    return True

def rippling_receipt(state):
    url = urlsplit(state['url'])
    query = {**expected_query, 'step': ['confirmation']}
    if (state['challenge'] or not same_url(state['url'], expected_path) or url.fragment or
        parse_qs(url.query, keep_blank_values=True) != query or normalized(state['title']) != normalized(site['applicationTitle'])):
        return False
    return js('''(([url, heading]) => {
      const root = document.querySelector('main#main-content');
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible';
      return Boolean(location.href === url && root && ![...root.querySelectorAll('form')].some(visible) && [...root.querySelectorAll('*')].some(e =>
        !e.children.length && visible(e) && e.textContent.trim() === heading));
    })(''' + json.dumps([state['url'], site['receiptHeading']]) + ')') is True

def branded_receipt(state):
    if state['challenge'] or not same_listing(state['url']) or state['title'] != site['pageTitle']:
        return False
    return js('''(([url, receipt]) => {
      const root = document.querySelector(receipt.rootSelector);
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible';
      if (location.href !== url || !root || root.querySelector('form')) return false;
      const titles = [...root.querySelectorAll('h3')].filter(e => visible(e) && e.textContent.trim() === receipt.heading);
      const reference = titles.length === 1 ? titles[0].nextElementSibling : null;
      if (!reference?.matches('p') || !visible(reference)) return false;
      const text = reference.textContent.trim();
      return text.startsWith(receipt.prefix) && text.endsWith(receipt.suffix) &&
        /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/.test(text.slice(receipt.prefix.length, -receipt.suffix.length));
    })(''' + json.dumps([state['url'], site['receipt']]) + ')') is True


def rippling_phone(number, dial):
    match = re.fullmatch(r'\+(\d{1,4}) [A-Z]{2} - .+', dial or '')
    if not match or not isinstance(number, str) or not re.fullmatch(r'\+?[\d(). -]+', number):
        return None
    digits = re.sub(r'\D', '', number)
    if number.startswith('+'):
        if not digits.startswith(match[1]):
            return None
        digits = digits[len(match[1]):]
    return digits if 7 <= len(digits) <= 15 else None

def clear_unapproved_rippling_company(answers):
    if 'Current company' in answers:
        return True
    selector = ':is(' + form_selector + ') input[data-testid=input-current_company][data-input=current_company]'
    if not js('''(s => Boolean(document.querySelector(s)?.value))(''' + json.dumps(selector) + ')'):
        return True
    if not same_listing(js('location.href')):
        return False
    fill_input(selector, '')
    return verify_control(selector, 'text', '')

def submit():
    global started, clicked, submission_context, blank_questions
    submission_context = cdp('Target.createBrowserContext')['browserContextId']
    tab = cdp('Target.createTarget', url='about:blank', browserContextId=submission_context, background=True)['targetId']
    switch_tab(tab)
    state = open_target()
    if state is None:
        return 'manual_required'
    if not listing_identity(state) or state['challenge']:
        return 'manual_required'
    gate = current_gate()
    if portal == 'taleo':
        return needs_answers(gate=gate)
    if state['consent']:
        return 'manual_required'
    shape = inspect_form()
    if not shape:
        return 'manual_required'
    file = Path(params['pdfPath'])
    if not file.is_file() or file.suffix.lower() != '.pdf':
        return 'runner_unavailable'
    if portal == 'branded' and not 0 < file.stat().st_size <= branded_max_bytes:
        return 'runner_unavailable'
    with open(params['privateConfigPath'], encoding='utf-8') as config_file:
        private = json.load(config_file)
    personal = private['personal']
    missing = [key for key in ('firstName', 'lastName', 'email') if not isinstance(personal.get(key), str) or
               not personal[key].strip() or len(personal[key]) > 255 or any(c in personal[key] for c in '\r\n\0')]
    if missing:
        return needs_answers(shape['blocked'], missing)
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', personal['email'].strip()):
        return needs_answers(shape['blocked'], ['email'])
    personal['fullName'] = f"{personal['firstName'].strip()} {personal['lastName'].strip()}"
    answers = private.get('answers', {}).get(params['listingUrl'], {})
    if not isinstance(answers, dict) or len(answers) > 40 or any(not isinstance(label, str) or not 0 < len(label) <= ${fieldLabelMax} for label in answers):
        return 'manual_required'
    if not use_local_field_map(private):
        return 'manual_required'
    if answers or params['fieldMap']:
        shape = inspect_form(answers)
        if not shape:
            return 'manual_required'
    mapping = shape['mapping']
    values, questions, variables = local_answers(mapping, personal, answers)
    if portal == 'rippling':
        sms, terms = (answers.get(label) for label in (sms_label, rippling_terms_label))
        if not isinstance(sms, dict) or sms.get('type') != 'option' or sms.get('value') not in rippling_sms_options.values():
            questions.append(rippling_policy_questions()[0])
        else:
            params['smsChoice'] = sms['value']
        if not isinstance(terms, dict) or terms.get('type') != 'boolean' or terms.get('value') is not True:
            questions.append(rippling_policy_questions()[1])
    if shape['blocked'] or shape['unmapped'] or questions or variables or gate:
        return needs_answers(shape['blocked'] + questions, variables, gate)
    for key in ('linkedin', 'website'):
        if key in values:
            url = urlsplit(values[key])
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                return needs_answers(variables=[key])
    if portal == 'rippling':
        dial = values.get('question:Phone country calling code')
        phone = rippling_phone(values.get('phone'), dial)
        if phone is None:
            dial_fields = [field['question'] for field in mapping if field['key'] == 'question:Phone country calling code']
            return needs_answers(dial_fields, ['phone'])
        values['phone'] = phone
    if portal == 'branded' and not await_branded_verification():
        return 'manual_required'
    if portal == 'workable':
        cookies = workable_cookies()
        if cookies is False:
            return 'manual_required'
        if cookies:
            cookie = answers.get(cookie_label)
            choice = 'Decline all' if cookie is None else cookie.get('value') if isinstance(cookie, dict) and cookie.get('type') == 'option' else None
            if choice not in cookies:
                return 'manual_required'
            if not same_listing(js('location.href')) or workable_cookies(choice) is not True:
                return 'manual_required'
            for _ in range(12):
                if workable_cookies() is None:
                    break
                time.sleep(.15)
            else:
                return 'manual_required'
            if not same_listing(js('location.href')) or inspect_form(answers) != shape:
                return 'manual_required'
    blank_questions = [field['question'] for field in mapping if field['question']] + shape['blocked']
    started = True
    emit('write_started')
    if portal == 'rippling' and (not attach_pdf(shape, file) or not await_rippling_parse(file.name) or
                                not clear_unapproved_rippling_company(answers)):
        return 'manual_required'
    for field in mapping:
        if field['key'] not in values:
            continue
        for _ in range(2):
            if not same_listing(js('location.href')):
                return 'manual_required'
            if set_control(field, values[field['key']]):
                break
        else:
            return needs_answers([field['question']] if field['question'] else [],
                                 [] if field['key'].startswith('question:') else [field['key']])
    if portal == 'rippling' and (not same_listing(js('location.href')) or not rippling_sms(params['smsChoice'])):
        return 'manual_required'
    state = page()
    verified = (inspect_form(answers, values, file.name) if portal == 'rippling' else
                inspect_form(answers, values, resume_target=shape['resumeTarget']))
    if isinstance(verified, dict):
        return needs_answers(verified['blocked'])
    if state['challenge'] or state['consent'] or verified is not True:
        return 'manual_required'
    if portal != 'rippling':
        if not attach_pdf(shape, file):
            return 'manual_required'
        for _ in range(12):
            if inspect_form(answers, values, file.name) is True:
                break
            time.sleep(.25)
        else:
            return 'manual_required'
    state = page()
    if state['challenge'] or state['consent']:
        return 'manual_required'
    if not await_submit_ack():
        return 'runner_unavailable'
    clicked = True
    if inspect_form(answers, values, file.name, submit=True) is not True:
        return 'submission_uncertain'
    if portal == 'jazzhr':
        return 'submission_uncertain'
    receipt_path = params['listingPath'] + {
        'lever': '/thanks', 'greenhouse': '/confirmation', 'ashby': '/application/confirmation', 'manatal': '/apply',
        'workable': '/apply', 'rippling': '/apply', 'branded': '',
    }[portal]
    receipt_markers = {'thank you for applying', 'your application has been submitted', 'application submitted',
                       'your application was successfully submitted', 'application successfully submitted'}
    for _ in range(24):
        time.sleep(.5)
        state = page()
        if portal == 'rippling':
            if rippling_receipt(state):
                return 'confirmation_page'
            continue
        if portal == 'branded':
            if branded_receipt(state):
                return 'confirmation_message'
            continue
        confirmed_path = not bound_query and portal not in ('manatal', 'workable') and same_url(state['url'], receipt_path)
        same_application = same_listing(state['url']) if bound_query else same_url(state['url'], expected_path)
        if state['challenge'] or (not confirmed_path and not same_application):
            continue
        markers = {text.rstrip('!.') for text in map(normalized, state['headings'])}
        confirmed_message = ({'thank you for your application', 'your application was successfully submitted'} <= markers
                             if portal == 'manatal' else bool(markers & receipt_markers))
        if confirmed_message and not js(
            'Boolean([...document.querySelectorAll(' + json.dumps(form_selector) + ')].some(f => f.getClientRects().length))'):
            return 'confirmation_page' if confirmed_path else 'confirmation_message'
    return 'submission_uncertain'

status = None
try:
    status = discover() if params.get('mode') == 'discover' else submit()
    if status is not None:
        emit(status)
except Exception:
    status = 'submission_uncertain' if started or clicked else 'runner_unavailable'
    emit(status)
finally:
    if submission_context and status != 'submission_uncertain':
        try:
            cdp('Target.disposeBrowserContext', browserContextId=submission_context)
        except Exception:
            pass
`;

async function localDebuggerUrl(input: string | undefined): Promise<string | undefined> {
  const url = input && URL.parse(input);
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password) return;
  try {
    const response = await fetch(`${url.origin}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return;
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    const ws = typeof version.webSocketDebuggerUrl === 'string' && URL.parse(version.webSocketDebuggerUrl);
    if (ws && ws.protocol === 'ws:' && ws.host === url.host && !ws.username && !ws.password && !ws.search && !ws.hash &&
        /^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(ws.pathname)) return ws.href;
  } catch {
    return;
  }
}

const failed = (code: FailureCode): BrowserResult => ({ kind: 'failed', code });

async function openSubmitAcknowledgment() {
  // Bun can close extra child pipes while the approval is pending.
  const directory = await mkdtemp('/tmp/qs-jobs-ack-');
  const path = join(directory, 'approval.sock');
  const decision = Promise.withResolvers<'0' | '1'>();
  let peer: Socket | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer(socket => {
    if (closing || peer) {
      socket.destroy();
      return;
    }
    peer = socket;
    socket.on('error', () => {});
    void decision.promise.then(byte => {
      if (!socket.destroyed) socket.end(byte);
    });
  });
  server.on('error', () => decision.resolve('0'));
  try {
    await once(server.listen(path), 'listening');
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    decide: decision.resolve,
    close() {
      if (!closing) {
        decision.resolve('0');
        peer?.destroy();
        closing = new Promise<void>(done => server.close(() => done()))
          .then(() => rm(directory, { recursive: true, force: true }));
      }
      return closing;
    },
  };
}

export async function runBrowserProgram(command: string, env: NodeJS.ProcessEnv, cwd: string, program = BROWSER_PROGRAM,
  privateInput?: Uint8Array, beforeSubmit?: () => Promise<void>): Promise<{
  exitCode: number | null;
  messages: unknown[];
}> {
  const ack = beforeSubmit ? await openSubmitAcknowledgment().catch(() => undefined) : undefined;
  if (beforeSubmit && !ack) return { exitCode: null, messages: [] };
  const onSubmitGate = ack && beforeSubmit
    ? () => Promise.resolve().then(beforeSubmit).then(() => ack.decide('1'), () => ack.decide('0'))
    : undefined;
  const closeApproval = ack ? () => ack.close().catch(() => {}) : undefined;
  const childEnv = { ...env, QS_JOBS_SUBMIT_ACK_SOCKET: ack?.path };
  try {
    return await runBrowserChild(command, childEnv, cwd, program, privateInput, onSubmitGate, closeApproval);
  } finally {
    await closeApproval?.();
  }
}

function runBrowserChild(command: string, env: NodeJS.ProcessEnv, cwd: string, program: string,
  privateInput?: Uint8Array, onSubmitGate?: () => Promise<void>, closeApproval?: () => Promise<void>): Promise<{
  exitCode: number | null;
  messages: unknown[];
}> {
  return new Promise((done) => {
    const stdio: Array<'pipe' | 'ignore'> = ['pipe', 'pipe', 'ignore'];
    if (privateInput) stdio.push('pipe');
    const child = spawn(command, [], { cwd, env, stdio });
    if (closeApproval) child.once('exit', () => { void closeApproval(); });
    let gateOperation: Promise<void> | undefined;
    let output = '';
    let overflow = false;
    const messages: unknown[] = [];
    const timeout = setTimeout(() => {
      void closeApproval?.();
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      for (const character of chunk) {
        if (character !== '\n') {
          if (output.length < 128_000) output += character;
          else overflow = true;
          continue;
        }
        if (!overflow && output.startsWith('{"qsJobsBrowser":') && messages.length < 3) {
          try {
            const message = JSON.parse(output);
            if (onSubmitGate && message?.qsJobsBrowser === 'submit_gate' && Object.keys(message).length === 1) {
              if (gateOperation) child.kill('SIGKILL');
              else gateOperation = onSubmitGate();
            } else messages.push(message);
          } catch {
            // No subprocess text enters the returned error.
          }
        }
        output = '';
        overflow = false;
      }
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(program);
    if (privateInput) {
      const privatePipe = child.stdio[3] as import('node:stream').Writable;
      privatePipe.on('error', () => {});
      privatePipe.end(privateInput);
    }
    async function finish(exitCode: number | null) {
      clearTimeout(timeout);
      await closeApproval?.();
      await gateOperation;
      done({ exitCode, messages });
    }
    child.once('error', () => { void finish(null); });
    child.once('close', (exitCode) => { void finish(exitCode); });
  });
}

const statusMessage = z.object({ qsJobsBrowser: z.enum(['write_started', 'confirmation_page',
  'confirmation_message', 'manual_required', 'submission_uncertain', 'runner_unavailable']) }).strict();

export async function runBrowser(command: string, env: NodeJS.ProcessEnv, cwd: string, program = BROWSER_PROGRAM,
  beforeSubmit?: () => Promise<void>): Promise<BrowserResult> {
  const { exitCode, messages } = await runBrowserProgram(command, env, cwd, program, undefined, beforeSubmit);
  const statuses = messages.map(message => (statusMessage.safeParse(message).data ?? attention.safeParse(message).data)?.qsJobsBrowser);
  const started = statuses.includes('write_started');
  if (exitCode !== 0 || statuses.length !== (started ? 2 : 1) || (started && statuses[0] !== 'write_started')) {
    return failed(started ? 'submission_uncertain' : 'runner_unavailable');
  }
  const status = statuses.at(-1);
  if (started && (status === 'confirmation_page' || status === 'confirmation_message')) {
    return { kind: 'applied', receiptCode: status };
  }
  if (status === 'manual_required') {
    const info = attention.safeParse(messages.at(-1));
    return info.success ? { kind: 'failed', code: status, attention: { questions: info.data.questions, variables: info.data.variables },
      ...(info.data.gate ? { gate: info.data.gate } : {}),
      ...(beforeSubmit && !started && !info.data.gate ? { safeToResume: true } : {}) } : failed(status);
  }
  if (status === 'submission_uncertain') return failed(status);
  return failed(started ? 'submission_uncertain' : 'runner_unavailable');
}

export async function withBrowser<T>(
  options: BrowserConnection,
  params: Record<string, unknown>,
  unavailable: T,
  run: (command: string, env: NodeJS.ProcessEnv, runtime: string) => Promise<T>,
): Promise<T> {
  const name = options.browserUseCommand ?? 'browser-use';
  const command = isAbsolute(name) ? name : Bun.which(name);
  if (!command) return unavailable;
  const debuggerUrl = await localDebuggerUrl(options.cdpUrl);
  if (!debuggerUrl) return unavailable;
  const runtime = await mkdtemp('/tmp/qs-jobs-').catch(() => undefined);
  if (!runtime) return unavailable;
  const env = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: runtime,
    XDG_CONFIG_HOME: runtime,
    BH_RUNTIME_DIR: runtime,
    BH_TMP_DIR: runtime,
    BH_RECORD: '0',
    BH_TAB_MARKER: '0',
    ANONYMIZED_TELEMETRY: 'false',
    BU_CDP_WS: debuggerUrl,
    QS_JOBS_BROWSER_INPUT: JSON.stringify(params),
  };
  try {
    return await run(command, env, runtime);
  } finally {
    // This detaches the private daemon. The separately launched Chrome and its tab stay open.
    await new Promise<void>((done) => {
      const stop = spawn(command, ['--reload'], { cwd: runtime, env, stdio: 'ignore' });
      const timeout = setTimeout(() => stop.kill('SIGKILL'), 3000);
      stop.once('close', () => { clearTimeout(timeout); done(); });
      stop.once('error', () => { clearTimeout(timeout); done(); });
    });
    await rm(runtime, { recursive: true, force: true }).catch(() => {});
  }
}

async function alternateAdapter(sourceUrl: string) {
  const smart = await import('./browser-smartrecruiters');
  const smartTarget = smart.smartRecruitersTarget(sourceUrl);
  if (smartTarget) {
    return {
      submit: (work: BrowserSubmitWork, options: BrowserOptions) => smart.submitSmartRecruiters(work, options, smartTarget),
      discover: (work: Parameters<typeof smart.discoverSmartRecruiters>[0], options: BrowserConnection) =>
        smart.discoverSmartRecruiters(work, options, smartTarget),
    };
  }
  const multistep = await import('./browser-multistep');
  const multistepTarget = multistep.multistepTarget(sourceUrl);
  if (multistepTarget) {
    return {
      submit: (work: BrowserSubmitWork, options: BrowserOptions) => multistep.submitMultistep(work, options, multistepTarget),
      discover: (work: Parameters<typeof multistep.discoverMultistep>[0], options: BrowserConnection) =>
        multistep.discoverMultistep(work, options, multistepTarget),
    };
  }
  const workday = await import('./browser-workday');
  if (workday.workdayTarget(sourceUrl)) {
    return { submit: workday.submitWorkday, discover: workday.discoverWorkday };
  }
  const indeed = await import('./browser-indeed');
  return indeed.reviewedIndeedAdapter(sourceUrl);
}

function matchesReviewedIdentity(expected: Pick<BrowserSubmitWork, 'company' | 'role'>,
  actual: Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>) {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return (actual.company === undefined && actual.role === undefined) ||
    (actual.company !== undefined && actual.role !== undefined &&
      normalize(actual.company) === normalize(expected.company) && normalize(actual.role) === normalize(expected.role));
}

export async function submitApplication(work: BrowserSubmitWork, options: BrowserOptions): Promise<BrowserResult> {
  const target = portalFor(work.sourceUrl);
  if (!target) {
    const adapter = await alternateAdapter(work.sourceUrl);
    return adapter ? adapter.submit(work, options) : failed('unsupported_portal');
  }
  if (target.site && !matchesReviewedIdentity(target.site, work)) return failed('manual_required');
  const bindings = z.array(fieldBinding).max(20).safeParse(options.fieldMap ?? []);
  if (!bindings.success || new Set(bindings.data.map(binding => binding.id)).size !== bindings.data.length ||
      new Set(bindings.data.map(binding => binding.key)).size !== bindings.data.length) return failed('manual_required');
  const identityAlias = configuredIdentity(work, target.listingUrl, options.candidateRules);
  return withBrowser(options, { ...target, identityAlias, role: work.role, company: work.company, fieldMap: bindings.data,
    privateKeyNames, pdfPath: resolve(options.pdfPath), privateConfigPath: resolve(options.privateConfigPath) },
  failed('runner_unavailable'), (command, env, cwd) => runBrowser(command, env, cwd, undefined, options.beforeSubmit));
}

export type BrowserDiscovery =
  | { kind: 'discovered'; listingUrl: string; fields: FormFieldDescriptor[]; gate?: BrowserGate }
  | { kind: 'failed'; code: 'unsupported_portal' | 'identity_mismatch' | 'manual_required' | 'runner_unavailable'; gate?: BrowserGate };

function configuredIdentity(work: Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>,
  listingUrl: string, rules?: CandidateRules,
) {
  if (!work.company || !work.role) return;
  const { company, role } = work;
  const identity = matchCandidateRules({ sourceUrl: listingUrl, company, role }, rules ?? readCandidateRules())?.pageIdentity;
  if (identity) return { company, role, pageCompany: identity.company, pageRole: identity.role };
}

export async function discoverForm(work: Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>,
  options: BrowserConnection): Promise<BrowserDiscovery> {
  const target = portalFor(work.sourceUrl);
  if (!target) {
    const adapter = await alternateAdapter(work.sourceUrl);
    return adapter ? adapter.discover(work, options) : { kind: 'failed', code: 'unsupported_portal' };
  }
  if (target.site && !matchesReviewedIdentity(target.site, work)) return { kind: 'failed', code: 'identity_mismatch' };
  const identityAlias = configuredIdentity(work, target.listingUrl, options.candidateRules);
  return withBrowser<BrowserDiscovery>(options, { ...target, identityAlias, mode: 'discover', company: work.company, role: work.role },
    { kind: 'failed', code: 'runner_unavailable' },
    async (command, env, cwd) => {
      const { exitCode, messages } = await runBrowserProgram(command, env, cwd);
      if (exitCode !== 0) return { kind: 'failed', code: 'runner_unavailable' };
      const result = messages.length === 1 && discovered.safeParse(messages[0]);
      if (result && result.success) return { kind: 'discovered', listingUrl: target.listingUrl, fields: result.data.fields,
        ...(result.data.gate ? { gate: result.data.gate } : {}) };
      if (messages.length === 1 && z.object({ qsJobsBrowser: z.literal('identity_mismatch') }).strict().safeParse(messages[0]).success) {
        return { kind: 'failed', code: 'identity_mismatch' };
      }
      const blocked = messages.length === 1 && attention.safeParse(messages[0]);
      if (blocked && blocked.success && blocked.data.gate) return { kind: 'failed', code: 'manual_required', gate: blocked.data.gate };
      return { kind: 'failed', code: 'manual_required' };
    });
}
