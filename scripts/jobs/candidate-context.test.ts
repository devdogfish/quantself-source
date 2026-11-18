import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCandidateAnswers as applyAnswers, candidateQuestionAnswer as questionAnswer, candidateReusableValues, hasCandidateReusableValues, parseCandidateContext } from './candidate-context';
import { candidateRulesDisplay } from './candidate-rules';
import { candidateRules, experiencePosting, screeningPosting } from './candidate-rules.fixture';
import { readCandidateRules } from './local-candidate-rules';

const applyCandidateAnswers: typeof applyAnswers = (posting, fields, entries, answers, country) =>
  applyAnswers(posting, fields, entries, answers, country, candidateRules);
const candidateQuestionAnswer: typeof questionAnswer = (posting, label, entries, options) =>
  questionAnswer(posting, label, entries, options, candidateRulesDisplay(posting, candidateRules));

const field = (number: number, label: string, type: string, options: string[] = []) =>
  ({ id: `question_${number}`, label, type, required: true, options });
const years = field(1001, 'How many years of clinical research experience do you have?', 'text');
const source = field(1003, 'Have you created Source documentation before?', 'combobox', ['Yes', 'No']);
const salary = field(1005, 'What is your expected monthly salary in USD?', 'textarea');
const notice = field(1006, 'What is your notice period if successful?', 'combobox', ['Immediate', '1 week', '1 month']);
const repeatedNotice = field(1007, 'What is your notice period?', 'combobox', ['Immediately available', '1 Week', '4 weeks', '1 calendar month']);
const referred = field(1008, 'Were you referred by an employee?', 'textarea');
const referrer = field(1009, 'If yes, enter their name.', 'textarea');
const policy = '## Application answers\n- resume-only-experience: Yes\n- screening-referred: No\n- screening-notice-period: 1 week\n';

test('local candidate rules are optional and malformed or ambiguous mappings are rejected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'candidate-rules-'));
  const previous = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = home;
  try {
    const path = join(home, 'candidate-rules.json');
    expect(readCandidateRules()).toEqual([]);
    await writeFile(path, JSON.stringify(candidateRules), { mode: 0o600 });
    expect(readCandidateRules()).toEqual(candidateRules);
    await chmod(path, 0o644);
    expect(readCandidateRules).toThrow('invalid_candidate_rules');
    await chmod(path, 0o600);
    const link = join(home, 'saved-rules.json');
    await writeFile(link, JSON.stringify(candidateRules), { mode: 0o600 });
    await rm(path);
    await symlink(link, path);
    expect(readCandidateRules).toThrow('invalid_candidate_rules');
    await rm(path);
    await writeFile(path, JSON.stringify(candidateRules), { mode: 0o600 });
    await writeFile(path, JSON.stringify([...candidateRules, candidateRules[0]]));
    expect(readCandidateRules).toThrow('invalid_candidate_rules');
    await writeFile(path, '{');
    expect(readCandidateRules).toThrow('invalid_candidate_rules');
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('the exact screening form applies résumé-only defaults and the owner’s notice and referral choices', () => {
  const answers = { [referrer.label]: { type: 'text', value: 'Legacy referrer' } };
  applyCandidateAnswers(screeningPosting, [years, source, salary, notice, repeatedNotice, referred, referrer], parseCandidateContext(policy), answers);
  expect(answers).toEqual({
    [years.label]: { type: 'text', value: '0' }, [source.label]: { type: 'option', value: 'No' },
    [notice.label]: { type: 'option', value: '1 week' }, [repeatedNotice.label]: { type: 'option', value: '1 Week' },
    [referred.label]: { type: 'text', value: 'No' }, [referrer.label]: { type: 'text', value: 'N/A' },
  });
});

test('field or posting mismatches and ambiguous choices remain unanswered, while saved answers win', () => {
  const entries = parseCandidateContext(policy + '- screening-clinical-research-years: 1.5\n- screening-monthly-salary-usd: 1000.00\n');
  const answers = { [referred.label]: { type: 'text', value: 'Yes' }, [notice.label]: { type: 'option', value: 'Immediate' } };
  applyCandidateAnswers(screeningPosting, [years, { ...source, options: ['No', 'No'] }, salary, notice, repeatedNotice, referred, referrer], entries, answers);
  expect(answers).toEqual({
    [years.label]: { type: 'text', value: '1.5' }, [salary.label]: { type: 'text', value: '1000.00' },
    [referred.label]: { type: 'text', value: 'Yes' }, [notice.label]: { type: 'option', value: 'Immediate' },
  });
  const mismatch = {};
  applyCandidateAnswers({ ...screeningPosting, role: 'Other' }, [years], entries, mismatch);
  applyCandidateAnswers(screeningPosting, [{ ...years, id: 'other' }], entries, mismatch);
  expect(mismatch).toEqual({});
});

test('a single calendar-month preference maps exactly to both dropdowns', () => {
  const entries = parseCandidateContext('## Application answers\n- screening-notice-period: 1 calendar month\n');
  const answers = {};
  applyCandidateAnswers(screeningPosting, [notice, repeatedNotice], entries, answers);
  expect(answers).toEqual({
    [notice.label]: { type: 'option', value: '1 month' }, [repeatedNotice.label]: { type: 'option', value: '1 calendar month' },
  });
  expect(candidateQuestionAnswer(screeningPosting, repeatedNotice.label, entries, ['4 weeks'])).toBeUndefined();
});

test('only named Markdown entries count, and masks, duplicates, and fenced examples cannot fill answers', () => {
  const entries = parseCandidateContext(policy + [
    '- screening-clinical-research-years: 3', '- screening-clinical-research-years: 2',
    '- screening-monthly-salary-usd: {{private.salary}}', '```md', '- english-fluent: Yes', '```',
    '## Résumé', '- screening-concurrent-clinical-studies: 42',
  ].join('\n'));
  const answers = {};
  applyCandidateAnswers(screeningPosting, [years, salary], entries, answers);
  expect(answers).toEqual({});
  expect(entries.has('english-fluent')).toBeFalse();
  expect(entries.has('screening-concurrent-clinical-studies')).toBeFalse();
  expect(candidateReusableValues(parseCandidateContext('## Application answers\n- english-level: C2'), {
    languages: 'English — C1\nFrench: B2',
  }).languages).toBe('English: C2\nFrench: B2');
});

test('Indeed experience needs a confirmed duration and residence never supplies work eligibility', () => {
  const work = experiencePosting;
  const eligibility = { ...field(1, 'Are you legally authorized to work in Canada?', 'select', ['Yes', 'No']), id: 'indeed-work-authorization' };
  const residence = { ...candidateRules[1].residence!.field, required: true, options: ['Yes', 'No'] };
  const experience = { ...candidateRules[1].rules[0], required: true, options: [] };
  const fields = [eligibility, residence, experience];
  const answers: Record<string, unknown> = {};
  applyCandidateAnswers(work, fields, parseCandidateContext(policy), answers, 'Canada');
  expect(answers).toEqual({ [residence.label]: { type: 'option', value: 'Yes' } });
  applyCandidateAnswers(work, fields, parseCandidateContext(policy + '- listing-similar-role-years: 0'), answers, 'Canada');
  expect(answers[experience.label]).toEqual({ type: 'text', value: '0' });
  expect(answers[eligibility.label]).toBeUndefined();
});

test('a general notice interval fills only exact unambiguous notice controls', () => {
  const posting = { sourceUrl: 'https://example.test/jobs/3', company: 'Example', role: 'Engineer' };
  const entries = parseCandidateContext('## Application answers\n- notice-period: 1 week');
  const fields = [
    field(1, 'Notice period', 'text'),
    field(2, 'What is your notice period?', 'select', ['Immediately', '7 days', '2 weeks']),
    field(3, 'What is your current notice period?', 'radio', ['One week', '2 weeks']),
    field(4, 'What is your notice period if successful?', 'combobox', ['1 Week', '2 weeks']),
    field(5, 'Notice period (if applicable)', 'combobox', ['One week', '7 days']),
    field(6, 'Notice period (if applicable)', 'text'),
    field(7, 'What is your earliest start date?', 'text'),
    field(8, 'What is your availability?', 'text'),
    field(9, 'Notice period in days', 'number'),
    field(10, 'How much notice do you need to give?', 'select', ['One week', '7 days']),
    field(11, 'How soon can you start after accepting an offer?', 'combobox', ['1 Week', '2 weeks']),
  ];
  const answers = { [fields[3].label]: { type: 'option', value: '2 weeks' } };
  expect(hasCandidateReusableValues(entries)).toBe(true);
  applyCandidateAnswers(posting, fields, entries, answers);
  expect(answers).toEqual({
    'Notice period': { type: 'text', value: '1 week' },
    'What is your notice period?': { type: 'option', value: '7 days' },
    'What is your current notice period?': { type: 'option', value: 'One week' },
    'What is your notice period if successful?': { type: 'option', value: '2 weeks' },
    'How soon can you start after accepting an offer?': { type: 'option', value: '1 Week' },
  });
  for (const invalid of ['- notice-period: 2026-12-01', '- notice-period: {{private.start}}', '- notice-period: 1 week\n- notice-period: 1 week']) {
    const unanswered = {};
    applyCandidateAnswers(posting, fields, parseCandidateContext('## Application answers\n' + invalid), unanswered);
    expect(unanswered).toEqual({});
  }
});

test('the screening notice override wins over general context and exact listing answers win over both', () => {
  const general = '## Application answers\n- notice-period: 1 week';
  const generalAnswers = {};
  applyCandidateAnswers(screeningPosting, [notice, repeatedNotice], parseCandidateContext(general), generalAnswers);
  expect(generalAnswers).toEqual({
    [notice.label]: { type: 'option', value: '1 week' }, [repeatedNotice.label]: { type: 'option', value: '1 Week' },
  });
  const overridden = parseCandidateContext(general + '\n- screening-notice-period: Immediate');
  expect(candidateQuestionAnswer(screeningPosting, notice.label, overridden, notice.options)).toBe('immediate');
  const saved = { [notice.label]: { type: 'option', value: '1 month' } };
  applyCandidateAnswers(screeningPosting, [notice, repeatedNotice], overridden, saved);
  expect(saved).toEqual({ [notice.label]: { type: 'option', value: '1 month' } });
  const changedId = {};
  applyCandidateAnswers(screeningPosting, [{ ...notice, id: 'other' }], parseCandidateContext(general), changedId);
  expect(changedId).toEqual({});
});

test('Workday phone preferences use only explicit context and matching current options', () => {
  const device = { id: 'phoneNumber--phoneType', label: 'Phone Device Type', type: 'combobox', required: true, options: ['Mobile', 'Landline'] };
  const country = { id: 'phoneNumber--countryPhoneCode', label: 'Country Phone Code', type: 'combobox', required: true, options: [] };
  const entries = parseCandidateContext('## Application answers\n- phone-device-type: Mobile\n- phone-country-code: Canada (+1)');
  const answers: Record<string, unknown> = { 'Phone Device Type': { type: 'option', value: 'Landline' } };
  applyCandidateAnswers(screeningPosting, [device, country], entries, answers);
  expect(answers).toEqual({ 'Phone Device Type': { type: 'option', value: 'Mobile' }, 'Country Phone Code': { type: 'option', value: 'Canada (+1)' } });
  const missing: Record<string, unknown> = {};
  applyCandidateAnswers(screeningPosting, [{ ...device, options: ['Fax'] }, { ...country, id: 'unverified' }], entries, missing);
  expect(missing).toEqual({});
  const duplicate: Record<string, unknown> = {};
  applyCandidateAnswers(screeningPosting, [device, device], entries, duplicate);
  expect(duplicate).toEqual({});
});

test('Workday phone facts are discoverable context questions, scoped to Workday', async () => {
  const { candidateQuestion, canonicalQuestionTarget } = await import('./candidate-context');
  const posting = { ...screeningPosting, sourceUrl: 'https://example.wd3.myworkdayjobs.com/jobs/1' };
  const entries = parseCandidateContext('## Application answers\n- phone-device-type: Mobile\n- phone-country-code: Canada (+1)');
  expect(candidateQuestion(posting, 'Phone Device Type')?.key).toBe('phone-device-type');
  expect(candidateQuestionAnswer(posting, 'Phone Device Type', entries, ['Mobile', 'Landline'])).toBe('Mobile');
  expect(candidateQuestionAnswer(posting, 'Phone Device Type', entries, ['Fax'])).toBeUndefined();
  expect(candidateQuestionAnswer(posting, 'Country Phone Code', entries, [])).toBe('Canada (+1)');
  expect(candidateQuestion(screeningPosting, 'Phone Device Type')).toBeUndefined();
  expect(canonicalQuestionTarget('Country', screeningPosting)).toBeUndefined();
});
