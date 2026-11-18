import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import { discoverForm, type BrowserConnection, type BrowserDiscovery } from './browser';
import { publicResumeLinkField, readMultistepTargets } from './browser-multistep';
import { readReviewedIndeedScreening } from './browser-indeed';
import { applyCandidateAnswers, candidateReusableValues, hasCandidateReusableValues, parseCandidateContext, workdayContextKey } from './candidate-context';
import { api, readLocal, tracks, type JobsApiConfig, type PrivateConfig, type Track } from './config';
import { emailApplicationRoute, readEmailRoutes, type EmailRoutes } from './email-routes';
import { matchCandidateRules, type CandidateRules } from './candidate-rules';
import { readCandidateRules } from './local-candidate-rules';

const personalFields = {
  firstName: ['First name', 'text'], lastName: ['Last name', 'text'], fullName: ['Full name', 'text'],
  email: ['Application email', 'email'], phone: ['Phone number', 'phone'],
  city: ['City', 'text'], region: ['State or province', 'text'], country: ['Country', 'text'],
  postalCode: ['Postal code', 'text'], addressLine1: ['Street address', 'text'],
  linkedin: ['LinkedIn URL', 'url'], website: ['Website URL', 'url'],
} as const;
type PersonalKey = keyof typeof personalFields;
const personalKeys = Object.keys(personalFields) as PersonalKey[];
const isPersonalKey = (key: string): key is PersonalKey => Object.hasOwn(personalFields, key);

const scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('track'), track: z.enum(tracks) }),
  z.strictObject({ kind: z.literal('listing'), applicationId: z.uuid() }),
]);
const fieldType = z.enum(['text', 'email', 'phone', 'url', 'number', 'date', 'boolean', 'option', 'options']);
export const requirementMetadata = z.strictObject({
  key: z.string().min(1).max(128), label: z.string().trim().min(1).max(400), type: fieldType, scope,
  options: z.array(z.string().min(1).max(200)).max(30).optional(),
});
export type Requirement = z.infer<typeof requirementMetadata>;
const value = z.union([z.string().max(4_000), z.boolean(), z.array(z.string().max(200)).max(30)]);
const candidateContextResponse = z.object({ markdown: z.string().max(50_000), version: z.number().int().nonnegative() });
const resolvedFields = z.strictObject({
  fields: z.array(requirementMetadata.extend({ value })).max(300),
  candidateContext: candidateContextResponse,
});
const normalizeLabel = (label: string) => label.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const questionKey = (label: string) => `question.${createHash('sha256').update(normalizeLabel(label)).digest('hex')}`;

type FormField = Extract<BrowserDiscovery, { kind: 'discovered' }>['fields'][number];
export const publicFormField = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_:.\[\]-]{0,100}$/),
  label: z.string().min(1).max(400),
  type: z.enum(['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'textarea', 'select', 'combobox',
    'combobox-multi', 'checkbox', 'checkbox-group', 'radio']),
  required: z.boolean(), options: z.array(z.string().min(1).max(200)).max(30),
});
const publicForm = z.object({ sourceUrl: z.url(), listingUrl: z.url(), company: z.string(), role: z.string(),
  kind: z.literal('discovered'), identityCheck: z.literal('verified'), fields: z.array(publicFormField).max(40) });
type PublicForm = z.infer<typeof publicForm>;

function emailQuestions(row: Pick<PublicForm, 'sourceUrl' | 'company' | 'role'>, routes: ReturnType<typeof readEmailRoutes>): PublicForm | undefined {
  const route = emailApplicationRoute(row, routes);
  if (!route) return;
  return { ...row, kind: 'discovered', identityCheck: 'verified', listingUrl: row.sourceUrl,
    fields: route.questions.map((label, index) => ({ id: `email-question-${index}`, label, type: 'textarea', required: true, options: [] })) };
}

function auditedQuestions(row: Pick<PublicForm, 'sourceUrl' | 'company' | 'role'>, routes: ReturnType<typeof readEmailRoutes>,
  indeedScreening: ReturnType<typeof readReviewedIndeedScreening>): PublicForm | undefined {
  const indeed = indeedScreening?.(row);
  return indeed
    ? { ...row, ...indeed, kind: 'discovered', identityCheck: 'verified' }
    : emailQuestions(row, routes);
}

async function knownForms() {
  const report = await readLocal<{ forms: unknown[] }>('public-candidate-form-manifests.json').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { forms: [] };
    throw error;
  });
  if (!Array.isArray(report.forms)) throw new Error('invalid_private_field_manifest');
  const forms = new Map<string, PublicForm>();
  for (const row of report.forms) {
    const parsed = publicForm.safeParse(row);
    if (parsed.success) forms.set(parsed.data.sourceUrl, parsed.data);
  }
  return forms;
}

const contactLabels = new Map<string, PersonalKey>([
  ['first name', 'firstName'], ['last name', 'lastName'], ['name', 'fullName'], ['full name', 'fullName'],
  ['first & last name', 'fullName'], ['preferred name', 'fullName'], ['please enter your full name', 'fullName'],
  ['email', 'email'], ['email address', 'email'], ['personal email', 'email'], ['please share your email address', 'email'],
  ['confirm your email', 'email'], ['phone', 'phone'], ['phone number', 'phone'], ['city', 'city'],
  ['country', 'country'], ['state or province', 'region'], ['postal code', 'postalCode'], ['street address', 'addressLine1'],
  ['linkedin', 'linkedin'], ['linkedin profile', 'linkedin'], ['linkedin profile url', 'linkedin'], ['linkedin url', 'linkedin'],
  ['website', 'website'], ['website url', 'website'],
]);
function contactAlias(field: FormField): PersonalKey | undefined {
  if (field.type === 'text' && field.id === 'name--legalName--firstName' && field.label === 'Legal First Name') return 'firstName';
  if (field.type === 'text' && field.id === 'name--legalName--lastName' && field.label === 'Legal Last Name') return 'lastName';
  // The exact Workday selectors resolve a saved contact value against their native options.
  if (field.type === 'combobox' && field.id === 'country--country' && field.label === 'Country') return 'country';
  if (field.type === 'combobox' && field.id === 'address--countryRegion' && field.label === 'Province or Territory') return 'region';
  // Other provider autocompletes need their own selected value.
  if (!['text', 'email', 'tel', 'url'].includes(field.type)) return;
  return contactLabels.get(normalizeLabel(field.label).toLowerCase().replace(/:$/, ''));
}

const questionTypes = {
  text: 'text', email: 'email', tel: 'phone', url: 'url', number: 'number', date: 'date', textarea: 'text',
  select: 'option', combobox: 'option', 'combobox-multi': 'options', checkbox: 'boolean',
  'checkbox-group': 'options', radio: 'option',
} as const;

export function listingRequirements(applicationId: string, fields: FormField[], resumeLinkFieldId?: string): Requirement[] {
  const result = new Map<string, Requirement>();
  const duplicates = new Set<string>();
  for (const field of fields) {
    if (!field.required || field.type === 'file' || contactAlias(field) || workdayContextKey(field)) continue;
    if (/^(?:yes|no|select|none|other)\.?$/i.test(normalizeLabel(field.label))) continue;
    // The public résumé link must also match the exact approved PDF digest.
    if (field.id === resumeLinkFieldId) continue;
    const key = questionKey(field.label);
    if (result.has(key)) duplicates.add(key);
    const type = questionTypes[field.type];
    const options = [...new Set(field.options.map(option => option.trim()))].filter(Boolean);
    result.set(key, { key, label: field.label, type, scope: { kind: 'listing', applicationId },
      ...(['option', 'options'].includes(type) && options.length ? { options } : {}) });
  }
  return [...result.values()].filter(row => !duplicates.has(row.key));
}

export function continuationRequirements(
  work: { applicationId: string; resumeTrack: Track; previewDigest?: string | null; sourceUrl?: string }, outcome: unknown,
): Requirement[] | undefined {
  const parsed = z.object({
    kind: z.literal('failed'), code: z.literal('manual_required'), safeToResume: z.literal(true),
    gate: z.undefined().optional(),
    attention: z.strictObject({ questions: z.array(publicFormField.strict()).max(40), variables: z.array(z.string()).max(12) }),
  }).safeParse(outcome);
  if (!parsed.success) return;
  const { questions, variables } = parsed.data.attention;
  const listing = listingRequirements(work.applicationId, questions, work.sourceUrl && publicResumeLinkField(work.sourceUrl));
  // A verified pause must account for every reported requirement.
  if (questions.some(field => workdayContextKey(field)) || variables.some(key => !isPersonalKey(key))) return;
  const aliases = questions.map(contactAlias).filter((key): key is PersonalKey => Boolean(key));
  if (listing.length + aliases.length !== questions.length || (work.previewDigest && (variables.length || aliases.length))) return;
  const contacts = [...new Set([...variables, ...aliases])].map((key): Requirement => {
    const [label, type] = personalFields[key as PersonalKey];
    return { key, label, type, scope: key === 'email' ? { kind: 'track', track: work.resumeTrack } : { kind: 'global' } };
  });
  const fields = [...listing, ...contacts];
  if (fields.length && fields.length <= 40) return fields;
}

function reusableRequirements(): Requirement[] {
  return personalKeys.flatMap<Requirement>(key => {
    const [label, type] = personalFields[key];
    return key === 'email'
      ? tracks.map(track => ({ key, label, type, scope: { kind: 'track' as const, track } }))
      : [{ key, label, type, scope: { kind: 'global' as const } }];
  });
}

const application = z.object({ id: z.uuid(), sourceUrl: z.url(), company: z.string(), role: z.string(),
  status: z.enum(['draft', 'review', 'approved', 'queued', 'submitting', 'applied', 'skipped', 'disqualified', 'saved_for_later', 'rejected', 'needs_attention']) });
const page = z.object({ rows: z.array(application).max(100), total: z.number().int().nonnegative() });

export async function syncPrivateRequirements(config: JobsApiConfig, browser: BrowserConnection = {},
  discover: typeof discoverForm = discoverForm) {
  const routes = readEmailRoutes();
  const discovery = browser.cdpUrl ? { ...browser, candidateRules: browser.candidateRules ?? readCandidateRules() } : browser;
  const forms = await knownForms();
  const active = new Map<string, z.infer<typeof application>>();
  for (let index = 1; ; index++) {
    const query = new URLSearchParams({ page: String(index), pageSize: '100' });
    const data = page.safeParse(await api<unknown>(config, `/applications?${query}`));
    if (!data.success) throw new Error('invalid_private_field_application_list');
    for (const row of data.data.rows) {
      if (['draft', 'review', 'approved', 'needs_attention'].includes(row.status)) active.set(row.id, row);
    }
    if (index * 100 >= data.data.total || !data.data.rows.length) break;
  }

  const candidates = [...active.values()];
  const indeedScreening = readReviewedIndeedScreening();
  const ready = new Map<string, PublicForm>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
    for (;;) {
      const row = candidates[next++];
      if (!row) break;
      const known = auditedQuestions(row, routes, indeedScreening) ?? forms.get(row.sourceUrl);
      if (known && known.company === row.company && known.role === row.role) {
        ready.set(row.id, known);
      } else if (browser.cdpUrl) {
        const result = await discover(row, discovery);
        if (result.kind === 'discovered') ready.set(row.id, { ...row, ...result, identityCheck: 'verified' });
      }
    }
  }));

  const multistepTargets = readMultistepTargets();
  const rows = [...reusableRequirements(), ...candidates.flatMap(row => {
    const form = ready.get(row.id);
    return form ? listingRequirements(row.id, form.fields, publicResumeLinkField(row.sourceUrl, multistepTargets)) : [];
  })];
  let registered = 0;
  for (let offset = 0; offset < rows.length; offset += 25) {
    const fields = rows.slice(offset, offset + 25).map(row => requirementMetadata.parse(row));
    const result = await api<{ registered: number }>(config, '/private-fields/requirements', { fields });
    if (!Number.isInteger(result.registered) || result.registered < 0 || result.registered > fields.length) {
      throw new Error('invalid_private_field_registration');
    }
    registered += result.registered;
  }
  return { applications: candidates.length, forms: ready.size, requirements: rows.length, registered };
}

type ClaimIdentity = { applicationId: string; applicationAddress?: string; sourceUrl: string; resumeTrack: Track; company: string; role: string };
type LocalPrivate = PrivateConfig & {
  fieldMaps?: Record<string, unknown>;
  coverLetters?: Record<string, unknown>;
  resumeLinks?: Record<string, unknown>;
};

const reusableTypes = {
  workAuthorization: 'text', sponsorshipRequired: 'boolean', languages: 'text', hourlyRate: 'number',
  rateCurrency: 'option', availability: 'text', startDate: 'date',
} as const;
type ReusableKey = keyof typeof reusableTypes;
type Reusable = Partial<Record<ReusableKey, string | boolean>> & { availabilityEst?: string; idealSchedule?: string };
const isReusableKey = (key: string): key is ReusableKey => Object.hasOwn(reusableTypes, key);

function namedValues(text: unknown, name: string) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(.+?)(?::\s*|\s+—\s+)(.+)$/);
    return match?.[1].trim().toLowerCase() === name.toLowerCase() ? [match[2].trim()] : [];
  });
}

function namedValue(text: unknown, name: string) {
  const candidates = namedValues(text, name);
  if (candidates.length === 1) return candidates[0];
}

function canadianAuthorization(text: Reusable['workAuthorization']) {
  if (typeof text !== 'string') return;
  const answers = new Set(namedValues(text, 'Canada').filter(value => value === 'Yes' || value === 'No'));
  for (const line of text.split(/\r?\n/)) {
    if (/^authorized to work in canada\.?$/i.test(line.trim())) answers.add('Yes');
    if (/^not authorized to work in canada\.?$/i.test(line.trim())) answers.add('No');
  }
  if (answers.size === 1) return [...answers][0];
}

export function applyContactAnswers(fields: FormField[], personal: Partial<Record<PersonalKey, string>>, answers: Record<string, unknown>) {
  const bindings = [
    { label: 'Please share your LinkedIn profile', key: 'linkedin', type: 'text' },
    { label: 'In which province are you located?', key: 'region', type: 'combobox' },
    { label: 'Current Country of Residence', key: 'country', type: 'text' },
    { label: 'Please provide your current ZIP or Postal Code to determine appropriate pay band', key: 'postalCode', type: 'text' },
    { label: 'Please share the link of your portfolio', key: 'website', type: 'textarea' },
  ] as const;
  for (const { label, key, type } of bindings) {
    const matches = fields.filter(field => field.label === label);
    const field = matches[0];
    const value = personal[key];
    if (matches.length !== 1 || !field.required || field.type !== type ||
        Object.hasOwn(answers, label) || !value || value.length > 255 || /[\r\n\0]/.test(value)) continue;
    if (key === 'linkedin' || key === 'website') {
      const url = URL.parse(value);
      if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port) continue;
      if (key === 'linkedin' && (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname) || !/^\/in\/[^/]+\/?$/.test(url.pathname))) continue;
    }
    if (type === 'combobox' && field.options.filter(option => option === value).length !== 1) continue;
    answers[label] = { type: type === 'combobox' ? 'option' : 'text', value };
  }

  const province = fields.filter(field => field.label === 'Province');
  const listedProvinces = ['Ontario', 'Quebec', 'Alberta', 'British Columbia'];
  const otherProvinces = ['Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Northwest Territories',
    'Nova Scotia', 'Nunavut', 'Prince Edward Island', 'Saskatchewan', 'Yukon'];
  if (province.length === 1 && province[0].id === 'province' && province[0].type === 'select' && province[0].required &&
      province[0].options.length === 5 && [...listedProvinces, 'Other'].every(option => province[0].options.includes(option)) &&
      personal.country === 'Canada' && personal.region && !Object.hasOwn(answers, 'Province')) {
    if (listedProvinces.includes(personal.region)) answers.Province = { type: 'option', value: personal.region };
    else if (otherProvinces.includes(personal.region)) answers.Province = { type: 'option', value: 'Other' };
  }
}

export function applyRepeatedNoticePeriod(fields: FormField[], answers: Record<string, unknown>,
  rules: CandidateRules[number]['rules'] = [],
) {
  const candidates = rules.filter(rule => rule.format === 'notice' && rule.type === 'combobox');
  if (candidates.length !== 2) return;
  const noticeFields = candidates.map(({ id, label }) => {
    const matches = fields.filter(field => field.id === id && field.label === label && field.type === 'combobox' && field.required);
    return matches.length === 1 ? matches[0] : undefined;
  });
  const [first, second] = noticeFields;
  if (!first || !second || Object.hasOwn(answers, first.label) === Object.hasOwn(answers, second.label)) return;
  const [source, target] = Object.hasOwn(answers, first.label) ? [first, second] : [second, first];
  const answer = answers[source.label] as { type?: string; value?: unknown } | undefined;
  const value = answer?.value;
  if (answer?.type !== 'option' || typeof value !== 'string' || !source.options.includes(value)) return;
  const choice = (text: string) => text === 'Immediately available' ? 'immediate' : text.toLowerCase();
  const options = target.options.filter(option => choice(option) === choice(value));
  if (options.length === 1) answers[target.label] = { type: 'option', value: options[0] };
}

export function applyVerifiedPhoneCountry(
  posting: Pick<ClaimIdentity, 'sourceUrl' | 'company' | 'role'>, fields: FormField[], phone: string | undefined,
  answers: Record<string, unknown>, configured: CandidateRules,
) {
  if (!matchCandidateRules(posting, configured)?.phoneCountry ||
      Object.hasOwn(answers, 'Country') || !phone || !/^\+[1-9][\d ().-]{7,40}$/.test(phone)) return;
  if (fields.filter(f => f.id === 'country' && f.label === 'Country' && f.type === 'combobox' && f.required).length !== 1 ||
      fields.filter(f => f.id === 'phone' && f.label === 'Phone' && f.type === 'tel' && f.required).length !== 1) return;

  const international = phone.replace(/[ ().-]/g, '');
  const number = parsePhoneNumberFromString(international, { extract: false });
  const kind = number?.getType();
  if (!number?.country || number.number !== international || !number.isValid() || !kind || kind === 'TOLL_FREE' ||
      number.getPossibleCountries().length !== 1) return;

  // These exact options were observed on the blank posting. The browser
  // adapter still requires a unique matching option on the current form.
  const options = new Map([['CA:1', 'Canada +1'], ['US:1', 'United States +1'], ['GB:44', 'United Kingdom +44']]);
  const value = options.get(`${number.country}:${number.countryCallingCode}`);
  if (value) answers.Country = { type: 'option', value };
}

export function applyReusableAnswers(fields: FormField[], reusable: Reusable, answers: Record<string, unknown>) {
  const set = (label: string, candidate: string | boolean | string[] | undefined) => {
    const matches = fields.filter(field => field.label === label);
    if (candidate === undefined || matches.length !== 1 || Object.hasOwn(answers, label)) return;
    const field = matches[0];
    switch (field.type) {
      case 'file': return;
      case 'checkbox':
        if (typeof candidate === 'boolean') answers[label] = { type: 'boolean', value: candidate };
        return;
      case 'checkbox-group':
      case 'combobox-multi':
        if (Array.isArray(candidate) && candidate.length && candidate.every(option => field.options.includes(option))) {
          answers[label] = { type: 'options', value: candidate };
        }
        return;
      case 'select':
      case 'combobox':
      case 'radio':
        if (typeof candidate === 'string' && field.options.includes(candidate)) answers[label] = { type: 'option', value: candidate };
        return;
      case 'number':
        if (typeof candidate === 'string' && /^-?\d+(?:\.\d+)?$/.test(candidate)) answers[label] = { type: 'text', value: candidate };
        return;
      case 'date':
        if (typeof candidate === 'string' && z.iso.date().safeParse(candidate).success) answers[label] = { type: 'text', value: candidate };
        return;
      case 'text':
      case 'textarea':
        if (typeof candidate === 'string') answers[label] = { type: 'text', value: candidate };
    }
  };
  const canada = namedValue(reusable.workAuthorization, 'Canada');
  const us = namedValue(reusable.workAuthorization, 'United States');
  const canadaStatus = canada ?? (reusable.workAuthorization === 'Canadian citizen' ? reusable.workAuthorization : undefined);
  set('Work authorization in Canada', canadaStatus);
  const canadaAllowed = canadianAuthorization(reusable.workAuthorization);
  for (const label of ['Are you legally authorized to work in Canada?', 'Are you legally entitled to work in Canada?']) {
    set(label, canadaAllowed);
  }
  set('Are you authorized to work in the United States?', us === 'Yes' || us === 'No' ? us : undefined);
  if (typeof reusable.sponsorshipRequired === 'boolean') {
    for (const label of ['Do you require work sponsorship?', 'Do you require sponsorship?']) {
      const field = fields.find(field => field.label === label);
      set(label, field?.type === 'checkbox' ? reusable.sponsorshipRequired : reusable.sponsorshipRequired ? 'Yes' : 'No');
    }
  }
  const english = namedValue(reusable.languages, 'English');
  set('English level', english);
  set('French level', namedValue(reusable.languages, 'French'));
  set('What is your English proficiency level?', english);
  const competency = 'What is your level of competency in English:';
  if (english && /^(?:A0\/A1|A2|B1|B2|C1|C2)$/.test(english)) {
    const matches = fields.find(field => field.label === competency)?.options.filter(option => option.startsWith(`${english} English `));
    if (matches?.length === 1) set(competency, matches[0]);
  }
  const fluency = new Set(namedValues(reusable.languages, 'English fluent').filter(value => value === 'Yes' || value === 'No'));
  if (english?.toLowerCase() === 'fluent') fluency.add('Yes');
  if (fluency.size === 1) set('Do you speak English fluently?', [...fluency][0]);
  const others = namedValue(reusable.languages, 'Other proficient languages');
  set('Are you proficient in any other languages?', others ? [...new Set(others.split(',').map(value => value.trim()))] : undefined);
  const rate = typeof reusable.hourlyRate === 'string' && /^\d+(?:\.\d+)?$/.test(reusable.hourlyRate) ? reusable.hourlyRate : undefined;
  const currency = typeof reusable.rateCurrency === 'string' && /^[A-Z]{3}$/.test(reusable.rateCurrency) ? reusable.rateCurrency : undefined;
  set('Preferred currency', currency);
  if (rate && currency) {
    const hourlyQuestion = 'What is your expected hourly rate?';
    if (fields.some(field => field.label === hourlyQuestion && ['text','textarea'].includes(field.type))) {
      set(hourlyQuestion, `${currency} ${rate} per hour`);
    }
    const amount = 'Desired salary amount (USD)', period = 'Desired salary period';
    const selectedPeriod = answers[period] as { type?: string; value?: unknown } | undefined;
    if (currency === 'USD' && !Object.hasOwn(answers, amount) &&
        fields.some(field => field.label === amount && field.type === 'number') &&
        fields.some(field => field.label === period && field.options.includes('Hourly')) &&
        (!Object.hasOwn(answers, period) || (selectedPeriod?.type === 'option' && selectedPeriod.value === 'Hourly'))) {
      set(amount, rate);
      set(period, 'Hourly');
    }
  }
  if (typeof reusable.availability === 'string') {
    set('Availability and time zone', reusable.availability);
    set('What is your availability?', reusable.availability);
  }
  set('What are your working hours in EST?', reusable.availabilityEst ?? namedValue(reusable.availability, 'EST'));
  set('EST required during training - Schedule can be reevaluated later down the road. What is your ideal schedule?',
    reusable.idealSchedule ?? namedValue(reusable.availability, 'Ideal schedule'));
  if (typeof reusable.startDate === 'string' && z.iso.date().safeParse(reusable.startDate).success) {
    for (const label of ['Earliest start date', 'What is your earliest start date?', 'When can you start?']) set(label, reusable.startDate);
  }
}

const recordText = z.string().trim().min(1).max(255).regex(/^[^\r\n\u0000]+$/);
const recordExtras = { startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
  summary: z.string().trim().min(1).max(2_000).optional() };
const workRecord = z.strictObject({ company: recordText, title: recordText, ...recordExtras });
const educationRecord = z.strictObject({ school: recordText, field: recordText, ...recordExtras });
function historyAnswer(field: FormField | undefined, value: string) {
  const schema = field?.id === 'workHistory' && field.label === 'Work History' ? workRecord
    : field?.id === 'educationHistory' && field.label === 'Education' ? educationRecord : undefined;
  if (!schema) return;
  try {
    const parsed = z.array(schema).min(1).max(10).safeParse(JSON.parse(value));
    if (parsed.success && parsed.data.every(row => !row.startDate || !row.endDate || row.startDate <= row.endDate)) {
      return { type: 'records', value: parsed.data };
    }
  } catch { /* An invalid owner entry remains an unanswered listing question. */ }
}

function scopedMap(source: Record<string, unknown> | undefined, urls: string[]) {
  return Object.fromEntries(urls.flatMap(url => source && Object.hasOwn(source, url) ? [[url, source[url]]] : []));
}

type PrivateSnapshotOptions = { cdpUrl?: string; emailRoutes?: EmailRoutes; candidateRules?: CandidateRules };

export async function withResolvedClaimPrivateConfig<T>(
  work: ClaimIdentity, readResponse: () => Promise<unknown>, run: (path: string) => Promise<T>,
  { cdpUrl, emailRoutes = readEmailRoutes(), candidateRules = readCandidateRules() }: PrivateSnapshotOptions = {},
): Promise<T> {
  const [local, forms, response] = await Promise.all([readLocal<LocalPrivate>('private.json'), knownForms(), readResponse()]);
  const remote = resolvedFields.safeParse(response);
  if (!remote.success || new Set(remote.data.fields.map(row => row.key)).size !== remote.data.fields.length) {
    throw new Error('invalid_private_field_response');
  }
  if (remote.data.fields.some(row => (row.scope.kind === 'track' && row.scope.track !== work.resumeTrack) ||
      (row.scope.kind === 'listing' && row.scope.applicationId !== work.applicationId))) {
    throw new Error('invalid_private_field_scope');
  }
  if (work.applicationAddress && !remote.data.fields.some(row =>
    row.key === 'email' && row.type === 'email' && row.scope.kind === 'listing' && row.value === work.applicationAddress
  )) throw new Error('application_address_mismatch');
  const candidateEntries = parseCandidateContext(remote.data.candidateContext.markdown);
  const cached = auditedQuestions(work, emailRoutes, readReviewedIndeedScreening()) ?? forms.get(work.sourceUrl);
  let known = cached?.company === work.company && cached.role === work.role ? cached : undefined;
  if (!known && cdpUrl && (hasCandidateReusableValues(candidateEntries) ||
      remote.data.fields.some(row => row.key.startsWith('question.') || isReusableKey(row.key)))) {
    const result = await discoverForm(work, { cdpUrl, candidateRules });
    if (result.kind === 'discovered') known = { ...work, ...result, identityCheck: 'verified' };
  }
  const listingUrl = known?.listingUrl ?? work.sourceUrl;
  const urls = [...new Set([work.sourceUrl, listingUrl])];
  const personal: Partial<Record<PersonalKey, string>> = {};
  const answers: Record<string, unknown> = Object.create(null);
  const reusable: Reusable = {};
  for (const row of remote.data.fields) {
    if (isPersonalKey(row.key) && row.type === personalFields[row.key][1] && typeof row.value === 'string') {
      personal[row.key] = row.value;
    } else if (row.key.startsWith('question.') && row.scope.kind === 'listing' && row.key === questionKey(row.label)) {
      const type = ['option', 'options', 'boolean'].includes(row.type) ? row.type : 'text';
      const compatible = type === 'boolean' ? typeof row.value === 'boolean' :
        type === 'options' ? Array.isArray(row.value) : typeof row.value === 'string';
      if (!compatible) throw new Error('invalid_private_field_response');
      const field = known?.fields.find(field => questionKey(field.label) === row.key);
      const label = field?.label ?? row.label;
      if (field && (workdayContextKey(field) || (contactAlias(field) && remote.data.fields.some(item => item.key === contactAlias(field) && typeof item.value === 'string' && item.value)))) continue;
      if (field?.id === 'workHistory' || field?.id === 'educationHistory') {
        const records = typeof row.value === 'string' ? historyAnswer(field, row.value) : undefined;
        delete answers[label];
        if (records) answers[label] = records;
      } else {
        answers[label] = { type, value: row.value };
      }
    } else if (isReusableKey(row.key) && reusableTypes[row.key] === row.type &&
        (typeof row.value === 'string' || typeof row.value === 'boolean')) {
      reusable[row.key] = row.value;
    } else if (isPersonalKey(row.key) || row.key.startsWith('question.')) {
      throw new Error('invalid_private_field_response');
    }
  }
  if (known) {
    applyRepeatedNoticePeriod(known.fields, answers, matchCandidateRules(work, candidateRules)?.rules);
    applyCandidateAnswers(work, known.fields, candidateEntries, answers, personal.country, candidateRules);
    applyReusableAnswers(known.fields, { ...reusable, ...candidateReusableValues(candidateEntries, reusable) }, answers);
    applyContactAnswers(known.fields, personal, answers);
    applyVerifiedPhoneCountry(work, known.fields, personal.phone, answers, candidateRules);
  }
  const fieldMaps = scopedMap(local.fieldMaps, urls);
  if (known) {
    const supplied = fieldMaps[listingUrl] ?? fieldMaps[work.sourceUrl];
    const mapped = Array.isArray(supplied) ? [...supplied] : [];
    for (const field of known.fields.filter(field => field.required)) {
      const key = contactAlias(field);
      if (key && !mapped.some(row => row.id === field.id || row.key === key) && mapped.length < 20) {
        mapped.push({ id: field.id, label: field.label, key });
      }
    }
    if (mapped.length) fieldMaps[listingUrl] = mapped;
  }
  const snapshot = {
    personal, resumePaths: { [work.resumeTrack]: local.resumePaths[work.resumeTrack] },
    rendererPath: local.rendererPath, rendererPython: local.rendererPython,
    resumeTrackingLinks: local.resumeTrackingLinks,
    applicationTracking: local.applicationTracking,
    answers: Object.fromEntries(urls.map(url => [url, answers])), fieldMaps,
    coverLetters: scopedMap(local.coverLetters, urls), resumeLinks: scopedMap(local.resumeLinks, urls),
  };
  const directory = await mkdtemp(join(tmpdir(), 'qs-job-private-'));
  const path = join(directory, 'private.json');
  try {
    await writeFile(path, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
