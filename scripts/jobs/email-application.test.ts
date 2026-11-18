import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailApplicationRoute as route, mailSha256, prepareEmailApplication as prepare, type EmailClaim } from './email-application';
import { applicationQuestions, emailRoutes } from './email-routes.fixture';
import { readEmailRoutes } from './email-routes';

const emailApplicationRoute = (posting: Parameters<typeof route>[0]) => route(posting, emailRoutes);
const prepareEmailApplication = (...args: Parameters<typeof prepare>) => prepare(args[0], args[1], args[2], emailRoutes);

const work: EmailClaim = {
  id: '00000000-0000-4000-8000-000000000003', token: '00000000-0000-4000-8000-000000000004', kind: 'submit', applicationAddress: 'luigi.k7mq@luigigirke.com',
  applicationId: '00000000-0000-4000-8000-000000000001', revision: 2, resumeTrack: 'web', summary: 'Owner-approved fixture summary.',
  company: 'Example Creative', role: 'Freelance Content Coordinator',
  sourceUrl: 'https://creative.example.test/jobs/content',
};
const sender = work.applicationAddress;
const privateSnapshot = { personal: { firstName: 'Example', lastName: 'Candidate', email: sender }, answers: {
  [work.sourceUrl]: Object.fromEntries(applicationQuestions.map((question, i) => [question, { type: 'text', value: `Saved answer ${i + 1}.` }])),
} };
const pdf = Buffer.from('%PDF-synthetic document');
const artifact = { applicationId: work.applicationId, revision: work.revision, resumeTrack: work.resumeTrack, pdf, sha256: mailSha256(pdf) };

test('email route settings require a private regular file and an unambiguous identity', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'email-route-test-'));
  const path = join(folder, 'routes.json');
  const link = join(folder, 'route-link.json');
  const previous = process.env.QUANTSELF_JOBS_EMAIL_ROUTES;
  process.env.QUANTSELF_JOBS_EMAIL_ROUTES = path;
  try {
    expect(readEmailRoutes).toThrow('invalid_email_routes');
    await writeFile(path, JSON.stringify(emailRoutes), { mode: 0o600 });
    expect(route(work)?.questions).toEqual(applicationQuestions);
    expect(route(work, [...emailRoutes, emailRoutes[0]])).toBeUndefined();
    await chmod(path, 0o644);
    expect(readEmailRoutes).toThrow('invalid_email_routes');
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify([{ ...emailRoutes[0], subjectNamePrefix: 'Subject\nBcc: injected' }]));
    expect(readEmailRoutes).toThrow('invalid_email_routes');
    await symlink(path, link);
    process.env.QUANTSELF_JOBS_EMAIL_ROUTES = link;
    expect(readEmailRoutes).toThrow('invalid_email_routes');
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_EMAIL_ROUTES;
    else process.env.QUANTSELF_JOBS_EMAIL_ROUTES = previous;
    await rm(folder, { recursive: true, force: true });
  }
});

test('email destinations and public questions require the exact verified listing identity', () => {
  expect(emailApplicationRoute(work)?.questions).toEqual(applicationQuestions);
  expect(emailApplicationRoute({ ...work, sourceUrl: work.sourceUrl + '/' })).toEqual(emailApplicationRoute(work));
  for (const candidate of [
    { ...work, sourceUrl: `${work.sourceUrl}?to=untrusted@example.test` },
    { ...work, sourceUrl: work.sourceUrl + '//' },
    { ...work, sourceUrl: work.sourceUrl.replace('creative.example.test', 'creative.example.test.example.test') },
    { ...work, sourceUrl: work.sourceUrl.replace('https://', 'https://user@') },
    { ...work, role: 'Another Role' },
    { ...work, company: 'Another Company' },
  ]) {
    expect(prepareEmailApplication(candidate, privateSnapshot, artifact)).toEqual({ kind: 'failed', code: 'unsupported_portal' });
  }
});

test('the packet contains the literal scoped answers and a copy of the exact approved PDF', () => {
  const original = Buffer.from(pdf);
  const prepared = prepareEmailApplication(work, privateSnapshot, { ...artifact, pdf: original });
  expect(prepared.kind).toBe('ready');
  if (prepared.kind !== 'ready') return;
  original.fill(0);
  expect(prepared.packet).toMatchObject({
    applicationId: work.applicationId, revision: work.revision, from: sender, to: 'jobs@creative.example.test',
    subject: 'Content Coordinator – Example Candidate',
    attachment: { filename: 'Resume.pdf', contentType: 'application/pdf', sha256: artifact.sha256 },
  });
  for (const [i, question] of applicationQuestions.entries()) expect(prepared.packet.body).toContain(`${question}\nSaved answer ${i + 1}.`);
  expect(Buffer.from(prepared.packet.attachment.bytes)).toEqual(pdf);
  expect(prepareEmailApplication(work, privateSnapshot, artifact)).toEqual(prepared);
});

test('stale artifacts, different sender, missing exact answers and header injection stop preparation', () => {
  for (const changed of [
    { ...artifact, revision: 3 },
    { ...artifact, applicationId: '00000000-0000-4000-8000-000000000002' },
    { ...artifact, resumeTrack: 'admin' as const },
    { ...artifact, pdf: Buffer.from('%PDF-replaced bytes') },
  ]) expect(prepareEmailApplication(work, privateSnapshot, changed)).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  expect(prepareEmailApplication(work, { ...privateSnapshot, personal: { ...privateSnapshot.personal, email: 'other@example.test' } }, artifact)).toMatchObject({ kind: 'failed', attention: 'application_address' });
  expect(prepareEmailApplication(work, { ...privateSnapshot, answers: {} }, artifact)).toMatchObject({ kind: 'failed', attention: 'answers' });
  expect(prepareEmailApplication(work, { ...privateSnapshot, personal: { ...privateSnapshot.personal, lastName: 'Candidate\r\nBcc:' } }, artifact))
    .toMatchObject({ kind: 'failed', attention: 'name' });
});

test('Example Services uses a résumé-only introduction and does not assert qualifications', () => {
  const mega: EmailClaim = {
    ...work, applicationAddress: 'luigi.k8mq@luigigirke.com', company: 'Example Services', role: 'Accounts Payable Clerk', resumeTrack: 'admin',
    sourceUrl: 'https://listings.example.test/jobs?posting_id=1234',
  };
  expect(prepareEmailApplication(mega, { personal: { email: mega.applicationAddress } }, { ...artifact, resumeTrack: 'admin' })).toMatchObject({
    kind: 'ready', packet: { from: mega.applicationAddress, to: 'apply@services.example.test', subject: mega.role,
      body: `Hello,\n\nPlease find my résumé attached for the ${mega.role} position.\n\nThank you.` },
  });
  expect(emailApplicationRoute({ ...mega, sourceUrl: mega.sourceUrl.replace('1234', '1235') })).toBeUndefined();
});

test('a continued approval keeps its message key while binding the current claim artifact', () => {
  const original = prepareEmailApplication(work, privateSnapshot, artifact);
  if (original.kind !== 'ready') throw new Error('Original email could not be prepared.');
  const next = { ...work, revision: 4 };
  const nextArtifact = { ...artifact, revision: next.revision };
  const continued = prepareEmailApplication({ ...next, originalApprovalRevision: work.revision }, privateSnapshot, nextArtifact);
  expect(continued).toMatchObject({ kind: 'ready', packet: { revision: 4, messageKey: original.packet.messageKey } });
  const newApproval = prepareEmailApplication(next, privateSnapshot, nextArtifact);
  if (newApproval.kind !== 'ready') throw new Error('Newly approved email could not be prepared.');
  expect(newApproval.packet.messageKey).not.toBe(original.packet.messageKey);
});
