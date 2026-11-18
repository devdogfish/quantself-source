import { candidateRules, screeningPosting } from './candidate-rules.fixture';
import { applicationQuestions, emailRoutes } from './email-routes.fixture';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeLocal } from './config';
import { applyContactAnswers, applyRepeatedNoticePeriod, applyReusableAnswers, applyVerifiedPhoneCountry,
  listingRequirements, questionKey, syncPrivateRequirements, withResolvedClaimPrivateConfig } from './private-fields';

const originalHome = process.env.QUANTSELF_JOBS_HOME;
const originalFetch = globalThis.fetch;
let directory: string;
const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'synthetic-key', cdpUrl: 'http://127.0.0.1:9222' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, status = 'review') => ({
  id: id(n), sourceUrl: `https://example.test/jobs/${n}`, company: 'Example', role: 'Editor', status,
});
const question = (i: number) => ({ id: `question-${i}`, label: `Exact question ${i}?`, type: 'text' as const, required: true, options: [] });
const emailField = { id: 'email', label: 'Email Address', type: 'email' as const, required: true, options: [] };
const cityField = { id: 'location', label: 'City', type: 'combobox' as const, required: true, options: [] };
const privacy = { id: 'consent', label: 'I agree to the exact test privacy notice.', type: 'checkbox' as const, required: true, options: [] };
const workHistory = { id: 'workHistory', label: 'Work History', type: 'textarea' as const, required: true, options: [] };
const educationHistory = { id: 'educationHistory', label: 'Education', type: 'textarea' as const, required: true, options: [] };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qs-private-fields-test-'));
  process.env.QUANTSELF_JOBS_HOME = directory;
  await writeLocal('email-routes.json', emailRoutes);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
  else process.env.QUANTSELF_JOBS_HOME = originalHome;
  await rm(directory, { recursive: true, force: true });
});

test('question metadata preserves exact labels, typed options, and ambiguous or non-answer exclusions', () => {
  const fields = listingRequirements(id(1), [emailField, cityField, privacy,
    { ...question(9), type: 'select', options: ['Yes', 'No', 'No'] },
    { ...question(1), label: 'Same question?' }, { ...question(2), label: 'Same   question?' },
    { ...question(3), label: 'Yes', type: 'checkbox' },
    workHistory,
    { ...question(5), type: 'file' }]);
  expect(questionKey(' Ｑｕｅｓｔｉｏｎ　\t here ')).toBe(questionKey('Question here'));
  expect(fields).toEqual([
    { key: questionKey(cityField.label), label: cityField.label, type: 'option', scope: { kind: 'listing', applicationId: id(1) } },
    { key: questionKey(privacy.label), label: privacy.label, type: 'boolean', scope: { kind: 'listing', applicationId: id(1) } },
    { key: questionKey(question(9).label), label: question(9).label, type: 'option', scope: { kind: 'listing', applicationId: id(1) }, options: ['Yes', 'No'] },
    { key: questionKey(workHistory.label), label: workHistory.label, type: 'text', scope: { kind: 'listing', applicationId: id(1) } },
  ]);
});

test('verified Workday legal names reuse contact fields without duplicate requirements', () => {
  const fields = [
    { ...question(1), id: 'name--legalName--firstName', label: 'Legal First Name' },
    { ...question(2), id: 'name--legalName--lastName', label: 'Legal Last Name' },
  ];
  expect(listingRequirements(id(1), fields)).toEqual([]);
  expect(listingRequirements(id(1), [{ ...fields[0], id: 'unverified-control' }])).toHaveLength(1);
  expect(listingRequirements(id(1), [{ ...fields[0], type: 'number' }])).toHaveLength(1);
});

test('reusable values fill only equivalent known prompts and exact answers win', () => {
  const options = (label: string, choices: string[]) => ({ ...question(2), label, type: 'select' as const, options: choices });
  const facts = {
    workAuthorization: 'Canada: Work permit', sponsorshipRequired: true, languages: 'English: C1\nFrench: B1',
    hourlyRate: '25', rateCurrency: 'USD', availability: 'EST: Weekdays 9–3', startDate: '2027-02-01',
  };
  const fields = [
    options('Work authorization in Canada', ['Work permit', 'Canadian citizen']),
    options('Are you legally authorized to work in Canada?', ['Yes', 'No']),
    options('Do you require work sponsorship?', ['Yes', 'No']),
    options('Would you need a future work sponsorship arrangement with Example Works?', ['Yes', 'No']),
    options('English level', ['C1', 'Native']), options('French level', ['B1', 'C1']),
    options('What is your English proficiency level?', ['Professional', 'Native']),
    { ...question(3), label: 'What is your expected hourly rate?' },
    { ...question(4), label: 'Desired salary amount (USD)', type: 'number' as const },
    options('Desired salary period', ['Hourly', 'Monthly']),
    { ...question(5), label: 'What are your working hours in EST?' },
    { ...question(6), label: 'Earliest start date', type: 'date' as const },
  ];
  const answers: Record<string, unknown> = { 'English level': { type: 'option', value: 'Native' } };
  applyReusableAnswers(fields, facts, answers);
  expect(answers).toEqual({
    'Work authorization in Canada': { type: 'option', value: 'Work permit' },
    'Do you require work sponsorship?': { type: 'option', value: 'Yes' },
    'English level': { type: 'option', value: 'Native' },
    'French level': { type: 'option', value: 'B1' },
    'What is your expected hourly rate?': { type: 'text', value: 'USD 25 per hour' },
    'Desired salary amount (USD)': { type: 'text', value: '25' },
    'Desired salary period': { type: 'option', value: 'Hourly' },
    'What are your working hours in EST?': { type: 'text', value: 'Weekdays 9–3' },
    'Earliest start date': { type: 'text', value: '2027-02-01' },
  });
  const exactMonthly = { 'Desired salary period': { type: 'option', value: 'Monthly' } };
  applyReusableAnswers(fields.filter(field => field.label.startsWith('Desired salary')), facts, exactMonthly);
  expect(exactMonthly).toEqual({ 'Desired salary period': { type: 'option', value: 'Monthly' } });
});

test('literal saved wording supplies exact boolean facts without inferring eligibility or fluency', () => {
  const canada = 'Are you legally entitled to work in Canada?';
  const english = 'Do you speak English fluently?';
  const fields = [canada, english].map(label => ({ ...question(1), label, type: 'select' as const, options: ['Yes', 'No'] }));
  const answers = {};
  applyReusableAnswers(fields, { workAuthorization: 'Authorized to work in Canada', languages: 'English — fluent' }, answers);
  expect(answers).toEqual({ [canada]: { type: 'option', value: 'Yes' }, [english]: { type: 'option', value: 'Yes' } });
  for (const workAuthorization of ['Canada: Work permit', 'Canada: Yes\nCanada: No\nAuthorized to work in Canada']) {
    const unresolved = {};
    applyReusableAnswers(fields, { workAuthorization, languages: 'English: C1' }, unresolved);
    expect(unresolved).toEqual({});
  }
  const conflicting = {};
  applyReusableAnswers(fields, { languages: 'English — fluent\nEnglish fluent: No' }, conflicting);
  expect(conflicting).toEqual({});
});

test('only exact compatible personal bindings reuse facts and listing answers take precedence', () => {
  const linkedin = 'Please share your LinkedIn profile';
  const region = 'In which province are you located?';
  const country = 'Current Country of Residence';
  const postalCode = 'Please provide your current ZIP or Postal Code to determine appropriate pay band';
  const portfolio = 'Please share the link of your portfolio';
  const fields = [
    { ...question(1), label: linkedin },
    { ...question(2), label: region, type: 'combobox' as const, options: ['Ontario', 'Quebec'] },
    { ...question(3), label: country },
    { ...question(4), label: postalCode },
    { ...question(5), label: portfolio, type: 'textarea' as const },
  ];
  const personal = { linkedin: 'https://www.linkedin.com/in/synthetic-person', region: 'Ontario', country: 'Canada',
    postalCode: 'A0A 0A0', website: 'https://portfolio.example.test' };
  const explicitPostal = { type: 'text', value: 'B0B 0B0' };
  const answers = { [postalCode]: explicitPostal };
  applyContactAnswers(fields, personal, answers);
  expect(answers).toEqual({
    [linkedin]: { type: 'text', value: personal.linkedin },
    [region]: { type: 'option', value: 'Ontario' },
    [country]: { type: 'text', value: 'Canada' },
    [postalCode]: explicitPostal,
    [portfolio]: { type: 'text', value: personal.website },
  });
  const unresolved = {};
  applyContactAnswers([fields[0], fields[1], fields[2], fields[2]], { ...personal, linkedin: 'https://example.test', region: 'Nova Scotia' }, unresolved);
  expect(unresolved).toEqual({});
});

test('the verified Province menu uses Other only for a known unlisted Canadian province', () => {
  const province = { ...question(1), id: 'province', label: 'Province', type: 'select' as const,
    options: ['Ontario', 'Quebec', 'Alberta', 'British Columbia', 'Other'] };
  const answers = {};
  applyContactAnswers([province], { country: 'Canada', region: 'Nova Scotia' }, answers);
  expect(answers).toEqual({ Province: { type: 'option', value: 'Other' } });
  const unknown = {};
  applyContactAnswers([province], { country: 'Canada', region: 'Atlantis' }, unknown);
  applyContactAnswers([province], { country: 'United States', region: 'Virginia' }, unknown);
  applyContactAnswers([{ ...province, id: 'unverified' }], { country: 'Canada', region: 'Nova Scotia' }, unknown);
  expect(unknown).toEqual({});
});

test('duplicate notice-period controls reuse the same interval without overriding explicit answers', () => {
  const first = { ...question(1), id: 'question_1006', label: 'What is your notice period if successful?',
    type: 'combobox' as const, options: ['Immediate', '2 weeks', '1 month'] };
  const second = { ...question(2), id: 'question_1007', label: 'What is your notice period?',
    type: 'combobox' as const, options: ['Immediately available', '2 Weeks', '4 weeks', '1 calendar month'] };
  const answers = { [first.label]: { type: 'option', value: '2 weeks' } };
  applyRepeatedNoticePeriod([first, second], answers, candidateRules[0].rules);
  expect(answers[second.label]).toEqual({ type: 'option', value: '2 Weeks' });
  const explicit = { [first.label]: { type: 'option', value: '2 weeks' }, [second.label]: { type: 'option', value: '4 weeks' } };
  applyRepeatedNoticePeriod([first, second], explicit, candidateRules[0].rules);
  expect(explicit[second.label].value).toBe('4 weeks');
  const ambiguous = { [first.label]: { type: 'option', value: '1 month' } };
  applyRepeatedNoticePeriod([first, second], ambiguous, candidateRules[0].rules);
  expect(ambiguous[second.label]).toBeUndefined();
});

test('the configured phone-country widget resolves only verified international region options', () => {
  const posting = screeningPosting;
  const fields = [
    { ...question(1), id: 'country', label: 'Country', type: 'combobox' as const, options: ['United States +1'] },
    { ...question(2), id: 'phone', label: 'Phone', type: 'tel' as const },
  ];
  for (const [phone, option] of [['+1 416 555 0134', 'Canada +1'], ['+1 (212) 555-0134', 'United States +1']]) {
    const answers = {};
    applyVerifiedPhoneCountry(posting, fields, phone, answers, candidateRules);
    expect(answers).toEqual({ Country: { type: 'option', value: option } });
  }
  for (const phone of ['416 555 0134', '+1 800 555 0134', '+1 111 555 0134', '+1 416 555 0134 ext 7', '+800 1234 5678']) {
    const unresolved = {};
    applyVerifiedPhoneCountry(posting, fields, phone, unresolved, candidateRules);
    expect(unresolved).toEqual({});
  }
  const exact = { Country: { type: 'option', value: 'United States +1' } };
  applyVerifiedPhoneCountry(posting, fields, '+1 416 555 0134', exact, candidateRules);
  expect(exact.Country.value).toBe('United States +1');
  const wrongPosting = {};
  applyVerifiedPhoneCountry({ ...posting, sourceUrl: posting.sourceUrl + '?different=true' }, fields, '+1 416 555 0134', wrongPosting, candidateRules);
  expect(wrongPosting).toEqual({});
  const wrongWidget = {};
  applyVerifiedPhoneCountry(posting, [{ ...fields[0], id: 'residenceCountry' }, fields[1]], '+1 416 555 0134', wrongWidget, candidateRules);
  expect(wrongWidget).toEqual({});
});

test('bulk registration lists 234 applications in three pages and writes only metadata in bounded batches', async () => {
  const apps = Array.from({ length: 234 }, (_, i) => row(i + 1, i === 0 || i === 100 || i === 233 ? 'review' : 'skipped'));
  await writeLocal('public-candidate-form-manifests.json', { forms: [{
    ...apps[0], kind: 'discovered', identityCheck: 'verified', listingUrl: apps[0].sourceUrl,
    fields: [emailField, ...Array.from({ length: 30 }, (_, i) => question(i))],
  }] });
  const pages: string[] = [];
  const batches: { key: string; scope: { kind: string; applicationId?: string; track?: string } }[][] = [];
  globalThis.fetch = (async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/applications')) {
      const index = parsed.searchParams.get('page') ?? '';
      pages.push(index);
      expect(parsed.searchParams.get('pageSize')).toBe('100');
      const offset = (Number(index) - 1) * 100;
      return Response.json({ rows: apps.slice(offset, offset + 100), total: apps.length });
    }
    expect(parsed.pathname).toBe('/api/v1/jobs/private-fields/requirements');
    const { fields } = JSON.parse(String(options?.body));
    expect(fields.every((field: object) => !('value' in field))).toBe(true);
    batches.push(fields);
    return Response.json({ registered: fields.length });
  }) as typeof fetch;
  const discovered: string[] = [];
  const result = await syncPrivateRequirements(config, config, async work => {
    discovered.push(work.sourceUrl);
    return work.sourceUrl === apps[100].sourceUrl
      ? { kind: 'discovered', listingUrl: work.sourceUrl, fields: [privacy] }
      : { kind: 'failed', code: 'unsupported_portal' };
  });
  expect(result).toEqual({ applications: 3, forms: 2, requirements: 45, registered: 45 });
  expect(pages).toEqual(['1', '2', '3']);
  expect(discovered.sort()).toEqual([apps[100].sourceUrl, apps[233].sourceUrl].sort());
  expect(batches.map(batch => batch.length)).toEqual([25, 20]);
  expect(batches.flat().filter(field => field.key === 'email').map(field => field.scope.track)).toEqual(['engineering', 'web', 'admin']);
  expect(batches.flat().find(field => field.key === questionKey(privacy.label))?.scope.applicationId).toBe(id(101));
});

test('the verified email listing registers its exact questions without opening an employer page', async () => {
  const posting = { ...row(1), company: 'Example Creative', role: 'Freelance Content Coordinator',
    sourceUrl: 'https://creative.example.test/jobs/content/' };
  const listingKeys: string[] = [];
  globalThis.fetch = (async (url, options) => {
    if (String(url).includes('/applications?')) return Response.json({ rows: [posting], total: 1 });
    const { fields } = JSON.parse(String(options?.body));
    listingKeys.push(...fields.filter((field: { scope: { kind: string } }) => field.scope.kind === 'listing')
      .map((field: { key: string }) => field.key));
    return Response.json({ registered: fields.length });
  }) as typeof fetch;
  await syncPrivateRequirements(config, config, async () => {
    throw new Error('employer_page_must_not_open');
  });
  expect(listingKeys).toEqual(applicationQuestions.map(questionKey));
});

test('active claim writes a private snapshot with scoped values from the API', async () => {
  const work = { ...row(1), applicationId: id(1), resumeTrack: 'web' as const };
  const listingUrl = 'https://example.test/application/1';
  const english = { id: 'english', label: 'Do you speak English fluently?', type: 'select' as const, required: true, options: ['Yes', 'No'] };
  const unrelated = 'https://example.test/jobs/2';
  const original = {
    personal: { firstName: 'Synthetic', lastName: 'Person', email: 'fallback@example.test', phone: '5550100' },
    resumePaths: { web: '/local/current.md', engineering: '/local/unrelated.md', admin: '/local/unrelated.md' },
    answers: { [listingUrl]: { 'Locally saved': { type: 'text', value: 'Synthetic fallback' } },
      [unrelated]: { 'Unrelated data': { type: 'text', value: 'Never copy' } } },
    resumeLinks: { [listingUrl]: { url: 'https://example.test/local-approved' }, [unrelated]: { url: 'https://example.test/unrelated' } },
  };
  await writeLocal('private.json', original);
  await writeLocal('public-candidate-form-manifests.json', { forms: [{
    ...row(1), kind: 'discovered', identityCheck: 'verified', listingUrl, fields: [emailField, cityField, privacy, workHistory, educationHistory, english],
  }] });
  let calls = 0;
  const resolveFields = async () => {
    calls++;
    return { candidateContext: { markdown: '## Application answers\n- english-fluent: Yes\n## Notes\nA context-only fact', version: 1 }, fields: [
      { key: 'email', label: 'Application email', type: 'email', scope: { kind: 'track', track: 'web' }, value: 'web-alias@example.test' },
      { key: 'firstName', label: 'First name', type: 'text', scope: { kind: 'global' }, value: 'Synthetic' },
      { key: questionKey(privacy.label), label: privacy.label, type: 'boolean', scope: { kind: 'listing', applicationId: work.applicationId }, value: true },
      { key: questionKey(cityField.label), label: cityField.label, type: 'option', scope: { kind: 'listing', applicationId: work.applicationId }, value: 'Synthetic City' },
      { key: questionKey(workHistory.label), label: workHistory.label, type: 'text', scope: { kind: 'listing', applicationId: work.applicationId },
        value: JSON.stringify([{ company: 'Synthetic Employer', title: 'Editor', startDate: '2020-01-01', endDate: '2021-01-01' }]) },
      { key: questionKey(educationHistory.label), label: educationHistory.label, type: 'text', scope: { kind: 'listing', applicationId: work.applicationId },
        value: JSON.stringify([{ school: 'Synthetic School', field: 'Writing', startDate: '2022-01-01', endDate: '2021-01-01' }]) },
      { key: 'workAuthorization', label: 'Work authorization details', type: 'text', scope: { kind: 'global' }, value: 'Unmapped reusable fact' },
    ] };
  };
  const paths: string[] = [];
  await Promise.all([1, 2].map(() => withResolvedClaimPrivateConfig(work, resolveFields, async path => {
    paths.push(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    expect(snapshot.personal).toEqual({ firstName: 'Synthetic', email: 'web-alias@example.test' });
    expect(snapshot.resumePaths).toEqual({ web: '/local/current.md' });
    expect(snapshot.answers[listingUrl]).toEqual({
      [english.label]: { type: 'option', value: 'Yes' },
      [privacy.label]: { type: 'boolean', value: true }, [cityField.label]: { type: 'option', value: 'Synthetic City' },
      [workHistory.label]: { type: 'records', value: [{ company: 'Synthetic Employer', title: 'Editor', startDate: '2020-01-01', endDate: '2021-01-01' }] },
    });
    expect(snapshot.answers[unrelated]).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('Unmapped reusable fact');
    expect(JSON.stringify(snapshot)).not.toContain('A context-only fact');
    expect(snapshot.resumeLinks[unrelated]).toBeUndefined();
    expect(snapshot.fieldMaps[listingUrl]).toEqual([{ id: 'email', label: 'Email Address', key: 'email' }]);
  })));
  expect(calls).toBe(2);
  expect(new Set(paths).size).toBe(2);
  for (const path of paths) await expect(stat(path)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(directory, 'private.json'), 'utf8'))).toEqual(original);
});

test('a foreign claim scope or an unavailable private endpoint stops before rendering', async () => {
  await writeLocal('private.json', { personal: {}, resumePaths: { web: '/local/current.md' } });
  const work = { ...row(1), applicationId: id(1), resumeTrack: 'web' as const };
  const unreachable = async () => { throw new Error('renderer_must_not_run'); };
  const foreign = { candidateContext: { markdown: '', version: 0 }, fields: [
    { key: questionKey(privacy.label), label: privacy.label, type: 'boolean', scope: { kind: 'listing', applicationId: id(2) }, value: true },
  ] };
  await expect(withResolvedClaimPrivateConfig(work, async () => foreign, unreachable)).rejects.toThrow('invalid_private_field_scope');
  await expect(withResolvedClaimPrivateConfig(work, async () => { throw new Error('jobs_work_api_503'); }, unreachable))
    .rejects.toThrow('jobs_work_api_503');
});

test('Workday shared prompts avoid private questions and only contacts produce safe continuations', async () => {
  const { continuationRequirements } = await import('./private-fields');
  const first = { ...question(1), id: 'name--legalName--firstName', label: 'Legal First Name' };
  const device = { ...question(2), id: 'phoneNumber--phoneType', label: 'Phone Device Type', type: 'combobox' as const, options: ['Mobile'] };
  expect(listingRequirements(id(1), [first, device])).toEqual([]);
  const pause = (questions: typeof first[]) => ({ kind: 'failed', code: 'manual_required', safeToResume: true, attention: { questions, variables: [] } });
  expect(continuationRequirements({ applicationId: id(1), resumeTrack: 'admin' }, pause([first]))).toEqual([
    { key: 'firstName', label: 'First name', type: 'text', scope: { kind: 'global' } },
  ]);
  expect(continuationRequirements({ applicationId: id(1), resumeTrack: 'admin' }, pause([first, device as typeof first]))).toBeUndefined();
});

test('shared Workday contact and context override stale listing answers without deleting them', async () => {
  const work = { ...row(1), applicationId: id(1), resumeTrack: 'web' as const };
  const first = { ...question(1), id: 'name--legalName--firstName', label: 'Legal First Name' };
  const device = { ...question(2), id: 'phoneNumber--phoneType', label: 'Phone Device Type', type: 'combobox' as const, options: ['Mobile', 'Landline'] };
  await writeLocal('private.json', { resumePaths: { web: '/local/test.md' } });
  await writeLocal('public-candidate-form-manifests.json', { forms: [{ ...row(1), kind: 'discovered', identityCheck: 'verified', listingUrl: work.sourceUrl, fields: [first, device] }] });
  const oldFirst = { key: questionKey(first.label), label: first.label, type: 'text', scope: { kind: 'listing', applicationId: work.applicationId }, value: 'Stale' };
  const oldDevice = { key: questionKey(device.label), label: device.label, type: 'option', scope: { kind: 'listing', applicationId: work.applicationId }, value: 'Landline' };
  const remote = { candidateContext: { markdown: '## Application answers\n- phone-device-type: Mobile', version: 1 }, fields: [oldFirst, oldDevice,
    { key: 'firstName', label: 'First name', type: 'text', scope: { kind: 'global' }, value: 'Current' }] };
  await withResolvedClaimPrivateConfig(work, async () => remote, async path => {
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    expect(snapshot.personal.firstName).toBe('Current');
    expect(snapshot.answers[work.sourceUrl][first.label]).toBeUndefined();
    expect(snapshot.answers[work.sourceUrl][device.label]).toEqual({ type: 'option', value: 'Mobile' });
    expect(snapshot.fieldMaps[work.sourceUrl]).toContainEqual({ id: first.id, label: first.label, key: 'firstName' });
  });
  expect(remote.fields).toContain(oldFirst);
  expect(remote.fields).toContain(oldDevice);
});

test('a claim rejects a saved email that differs from its Application Address', async () => {
  await writeLocal('private.json', { personal: {}, resumePaths: { web: '/local/current.md' } });
  const work = { ...row(1), applicationId: id(1), resumeTrack: 'web' as const,
    applicationAddress: 'luigi.k7mq@luigigirke.com' };
  const field = { key: 'email', type: 'email', label: 'Application Address',
    scope: { kind: 'listing', applicationId: work.applicationId }, value: 'luigi.k8mq@luigigirke.com' };
  const resolveFields = async () => ({ fields: [field], candidateContext: { markdown: '', version: 0 } });
  let rendered = false;
  await expect(withResolvedClaimPrivateConfig(work, resolveFields, async () => { rendered = true; })).rejects.toThrow('application_address_mismatch');
  expect(rendered).toBe(false);
});
