// Shared by the submission runner and the Owner's candidate-context panel.
import { matchCandidateRules, type CandidateRule as Rule, type CandidateRules, type CandidateRuleDisplay, type CandidateRulesDisplay } from './candidate-rules';

type Posting = { sourceUrl: string; company: string; role: string };
type FormField = { id: string; label: string; type: string; required: boolean; options: string[] };
type Answer = { type: 'text' | 'option'; value: string };

// Exact labels already stored on older Workday listing requirements.
export function canonicalQuestionTarget(label: string, posting: Pick<Posting, 'sourceUrl'> | undefined): 'firstName' | 'lastName' | 'country' | 'phone-device-type' | 'phone-country-code' | undefined {
  try {
    const url = new URL(posting?.sourceUrl ?? '');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.myworkdayjobs.com')) return;
  } catch { return; }
  const targets: Record<string, 'firstName' | 'lastName' | 'country' | 'phone-device-type' | 'phone-country-code'> = {
    'Legal First Name': 'firstName', 'Legal Last Name': 'lastName', 'Country': 'country',
    'Phone Device Type': 'phone-device-type', 'Country Phone Code': 'phone-country-code' };
  return targets[label];
}

export function workdayContextKey(field: FormField): 'phone-device-type' | 'phone-country-code' | undefined {
  if (field.type !== 'combobox') return;
  if (field.id === 'phoneNumber--phoneType' && field.label === 'Phone Device Type') return 'phone-device-type';
  if (field.id === 'phoneNumber--countryPhoneCode' && field.label === 'Country Phone Code') return 'phone-country-code';
}

const workdayPhoneRules: Rule[] = [
  { id: 'phoneNumber--phoneType', label: 'Phone Device Type', type: 'combobox', key: 'phone-device-type',
    title: 'Phone device type', help: 'Use the option that describes your phone, such as Mobile or Landline.' },
  { id: 'phoneNumber--countryPhoneCode', label: 'Country Phone Code', type: 'combobox', key: 'phone-country-code',
    title: 'Phone country code', help: 'Use the exact option for your phone number, such as Canada (+1).' },
];

const reusableNoticeLabels = ['What is your notice period if successful?', 'What is your notice period?',
  'Notice period', 'Notice period (if applicable)', 'What is your current notice period?',
  'How much notice do you need to give?', 'How soon can you start after accepting an offer?'];

export function parseCandidateContext(markdown: string) {
  const entries = new Map<string, string>();
  let inAnswers = false;
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    const heading = /^ {0,3}#{1,6}\s+/.exec(line);
    if (heading) inAnswers = /^ {0,3}##\s+Application answers\s*$/i.test(line);
    if (!inAnswers) continue;
    const entry = /^ {0,3}[-*]\s+([a-z][a-z0-9-]{0,63}):[ \t]*(.*)$/.exec(line);
    if (!entry) continue;
    const [, key, raw] = entry;
    const value = raw.trim();
    // A malformed or duplicate entry blocks fallback for the same key.
    entries.set(key, !entries.has(key) && value.length <= 512 && !/[{}\u0000-\u001f]/.test(value) ? value : '');
  }
  return entries;
}

function noticeValue(choice: string) {
  const interval = choice.trim().toLowerCase();
  if (['immediate', 'immediately', 'immediately available'].includes(interval)) return 'immediate';
  if (['one week', '7 days'].includes(interval)) return '1 week';
  if (['1 month', '1 calendar month'].includes(interval)) return '1 calendar month';
  return interval;
}

function knownNoticeValue(value: string | undefined) {
  if (!value) return;
  const interval = noticeValue(value);
  if (['immediate', '1 week', '2 weeks', '1 calendar month', '2 months', '3 months'].includes(interval)) return interval;
}

function matchingNoticeOption(options: string[], value: string) {
  const interval = noticeValue(value);
  const matches = options.filter(option => noticeValue(option) === interval);
  if (matches.length === 1) return matches[0];
}

function candidateValue(rule: Pick<Rule, 'key' | 'format' | 'resumeOnlyValue'>, entries: ReadonlyMap<string, string>) {
  if (rule.format === 'notice') return knownNoticeValue(entries.get(rule.key) ?? entries.get('notice-period'));
  const value = entries.get(rule.key) ?? (/^yes$/i.test(entries.get('resume-only-experience') ?? '') ? rule.resumeOnlyValue : undefined);
  if (!value) return;
  if (rule.format === 'yes-no') return /^yes$/i.test(value) ? 'Yes' : /^no$/i.test(value) ? 'No' : undefined;
  if (rule.format === 'count' && !/^\d+(?:\.\d+)?$/.test(value)) return;
  if (rule.format === 'integer' && !/^\d+$/.test(value)) return;
  if (rule.format === 'salary' && !/^\d+(?:\.\d{1,2})?$/.test(value)) return;
  return value;
}

function matchField(fields: FormField[], rule: { id: string; label: string; type: string }) {
  const matches = fields.filter(field => field.label === rule.label);
  const field = matches[0];
  return matches.length === 1 && field.id === rule.id && field.type === rule.type && field.required ? field : undefined;
}

export function applyCandidateAnswers(posting: Posting, fields: FormField[], entries: ReadonlyMap<string, string>, answers: Record<string, unknown>, countryOfResidence?: string, configured: CandidateRules = []) {
  for (const field of fields) {
    const key = workdayContextKey(field);
    const value = key && entries.get(key);
    if (!key || !value || fields.filter(other => other.id === field.id || other.label === field.label).length !== 1) continue;
    if (field.options.length && field.options.filter(option => option === value).length !== 1) continue;
    answers[field.label] = { type: 'option', value } satisfies Answer;
  }
  const config = matchCandidateRules(posting, configured);
  const rules = config?.rules ?? [];
  const noticeLabels = rules.filter(rule => rule.format === 'notice').map(rule => rule.label);
  const savedNotice = noticeLabels.some(label => Object.hasOwn(answers, label));
  for (const rule of rules) {
    const field = matchField(fields, rule);
    const value = candidateValue(rule, entries);
    if (!field || value === undefined || Object.hasOwn(answers, rule.label) || (rule.format === 'notice' && savedNotice)) continue;
    if (field.type === 'combobox') {
      const choices = field.options.filter(option => option === value);
      const selected = rule.format === 'notice' ? matchingNoticeOption(field.options, value) : choices.length === 1 ? choices[0] : undefined;
      if (selected !== undefined) answers[field.label] = { type: 'option', value: selected } satisfies Answer;
    } else {
      answers[field.label] = { type: 'text', value } satisfies Answer;
    }
  }

  const notice = knownNoticeValue(entries.get('notice-period'));
  if (notice) {
    for (const label of reusableNoticeLabels) {
      if (Object.hasOwn(answers, label) || noticeLabels.includes(label)) continue;
      const matches = fields.filter(field => field.label === label);
      if (matches.length !== 1) continue;
      const field = matches[0];
      if (field.type === 'text' || field.type === 'textarea') {
        answers[label] = { type: 'text', value: notice === 'immediate' ? 'Immediate' : notice } satisfies Answer;
      } else if (['select', 'radio', 'combobox'].includes(field.type)) {
        const selected = matchingNoticeOption(field.options, notice);
        if (selected !== undefined) answers[label] = { type: 'option', value: selected } satisfies Answer;
      }
    }
  }

  const residence = config?.residence;
  if (residence && countryOfResidence?.trim().toLowerCase() === residence.country.toLowerCase()) {
    const field = matchField(fields, residence.field);
    if (!Object.hasOwn(answers, residence.field.label) && field?.options.filter(option => option === 'Yes').length === 1) {
      answers[residence.field.label] = { type: 'option', value: 'Yes' } satisfies Answer;
    }
  }
  const referral = config?.referral;
  if (!referral) return;
  const referring = matchField(fields, referral.question);
  const name = matchField(fields, referral.name);
  const referralAnswer = answers[referral.question.label] as Partial<Answer> | undefined;
  if (referring && name && referralAnswer?.type === 'text' && /^no$/i.test(referralAnswer.value ?? '')) {
    // This portal marks the name field required even when the applicant answers No.
    answers[referral.name.label] = { type: 'text', value: 'N/A' } satisfies Answer;
  }
}

export function candidateQuestion(posting: Posting | undefined, label: string, configured?: CandidateRulesDisplay): CandidateRuleDisplay | undefined {
  return configured?.rules.find(rule => rule.label === label) ??
    (canonicalQuestionTarget(label, posting)?.startsWith('phone-') ? workdayPhoneRules.find(rule => rule.label === label) : undefined);
}

export function candidateQuestionAnswer(posting: Posting | undefined, label: string, entries: ReadonlyMap<string, string>, options: string[], configured?: CandidateRulesDisplay) {
  const rule = candidateQuestion(posting, label, configured);
  if (!rule) return;
  const value = candidateValue(rule, entries);
  if (rule.type !== 'combobox' || value === undefined || (workdayPhoneRules.some(phone => phone === rule) && !options.length)) return value;
  if (rule.format === 'notice' ? matchingNoticeOption(options, value) !== undefined
    : options.filter(option => option === value).length === 1) return value;
}

export function referralNameField(label: string, configured?: CandidateRulesDisplay) {
  const referral = configured?.referral;
  return referral?.nameLabel === label ? referral : undefined;
}

export function referralDeclined(posting: Posting | undefined, fields: { label: string; hasValue: boolean }[], entries: ReadonlyMap<string, string>, configured?: CandidateRulesDisplay) {
  const referral = configured?.referral;
  return referral && !fields.some(field => field.label === referral.questionLabel && field.hasValue) &&
    candidateQuestionAnswer(posting, referral.questionLabel, entries, [], configured) === 'No';
}

export function hasCandidateReusableValues(entries: ReadonlyMap<string, string>) {
  return Boolean(knownNoticeValue(entries.get('notice-period'))) || ['phone-device-type', 'phone-country-code', 'english-level', 'english-fluent', 'french-level', 'other-proficient-languages', 'preferred-hourly-rate',
    'preferred-currency', 'availability', 'availability-est', 'ideal-schedule', 'start-date'].some(key => Boolean(entries.get(key)));
}

export function candidateReusableValues(entries: ReadonlyMap<string, string>, legacy: { languages?: string | boolean }) {
  const named = (key: string, label: string) => {
    const value = entries.get(key);
    return value ? [`${label}: ${value}`] : [];
  };
  const languageLines = [...named('english-level', 'English'), ...named('english-fluent', 'English fluent'),
    ...named('french-level', 'French'), ...named('other-proficient-languages', 'Other proficient languages')];
  const languageName = (line: string) => line.split(/:|\s+—\s+/, 1)[0].trim().toLowerCase();
  const writtenLanguages = new Set(languageLines.map(languageName));
  const otherLanguages = typeof legacy.languages === 'string'
    ? legacy.languages.split(/\r?\n/).filter(line => !writtenLanguages.has(languageName(line))) : [];
  const availability = entries.get('availability');
  return {
    ...(languageLines.length ? { languages: [...languageLines, ...otherLanguages].join('\n') } : {}),
    ...(entries.get('preferred-hourly-rate') ? { hourlyRate: entries.get('preferred-hourly-rate') } : {}),
    ...(entries.get('preferred-currency') ? { rateCurrency: entries.get('preferred-currency') } : {}),
    ...(availability ? { availability } : {}),
    ...(entries.get('start-date') ? { startDate: entries.get('start-date') } : {}),
    availabilityEst: entries.get('availability-est'),
    idealSchedule: entries.get('ideal-schedule'),
  };
}
