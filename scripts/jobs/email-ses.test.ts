import { applicationQuestions, emailRoutes } from './email-routes.fixture';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeLocal } from './config';
import { mailSha256, type EmailClaim, type EmailPacket } from './email-application';
import { readApprovedEmailOutcome, submitApprovedClaimEmail, submitClaimEmail } from './email-ses';
import { deliverSes, type SesDelivery } from './ses-transport';
import { LocalContactRequired } from './local-files';
import { JobsWorkTransportError, type WorkReport } from './work-client';
import { createJobsWorkOutbox } from './work-outbox';

const originalHome = process.env.QUANTSELF_JOBS_HOME;
const work: EmailClaim = {
  id: '00000000-0000-4000-8000-000000000003', token: '00000000-0000-4000-8000-000000000004', kind: 'submit', applicationAddress: 'luigi.k7mq@luigigirke.com',
  applicationId: '00000000-0000-4000-8000-000000000001', revision: 2, resumeTrack: 'admin', summary: 'Approved fixture.',
  company: 'Example Services', role: 'Accounts Payable Clerk',
  sourceUrl: 'https://listings.example.test/jobs?posting_id=1234',
};
const sender = 'luigi.k7mq@luigigirke.com';
const otherSender = 'luigi.k8mq@luigigirke.com';
const config = { region: 'us-east-1', profile: 'jobs-test' };
const accepted = { kind: 'accepted', messageId: 'ses-fixture-id' } as const;
const pdf = Buffer.from('%PDF-synthetic artifact');
const render = async () => ({ path: '/synthetic/resume.pdf', pdf });
const snapshot = { personal: { email: sender } };
let directory: string;
let privateConfigPath: string;
const withPrivateConfig = <T>(run: (path: string) => Promise<T>) => run(privateConfigPath);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jobs-ses-'));
  process.env.QUANTSELF_JOBS_HOME = directory;
  privateConfigPath = join(directory, 'snapshot.json');
  await Promise.all([
    writeLocal('mail-ses.json', config),
    writeLocal('email-routes.json', emailRoutes),
    writeFile(privateConfigPath, JSON.stringify(snapshot), { mode: 0o600 }),
  ]);
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
  else process.env.QUANTSELF_JOBS_HOME = originalHome;
  await rm(directory, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function journalPath(name = 'ses-result.json') {
  return join(directory, 'applications', work.applicationId, String(work.revision), name);
}

const resultId = '00000000-0000-4000-8000-000000000005';
const approvedWork = {
  id: work.id, token: 'mac-fixture-lease-token', kind: work.kind, applicationId: work.applicationId,
  applicationAddress: work.applicationAddress, revision: work.revision, resumeTrack: work.resumeTrack,
  company: work.company, role: work.role, sourceUrl: work.sourceUrl,
};
const approvedPdf = { pdf, sha256: mailSha256(pdf) };
const recovery = { applicationId: work.applicationId, approvalRevision: work.revision, claimId: work.id, resultId, pdfSha256: approvedPdf.sha256 };

test('an Owner attestation replaces only the matching settled pending attempt', async () => {
  const active = deferred<void>();
  const finish = deferred<SesDelivery>();
  let calls = 0;
  const options = { approvedPdf, resultId, attempt: 1,
    beforeSend: async () => {}, deliver: async () => { calls++; active.resolve(); return finish.promise; } };
  const old = submitApprovedClaimEmail(approvedWork, withPrivateConfig, options);
  await Promise.race([active.promise, old.then(() => { throw new Error('prior send did not start'); })]);
  const ownerAttestation = {
    previousWorkId: work.id, previousAttempt: 1, previousResultId: resultId,
    previousLeaseTokenHash: mailSha256(approvedWork.token),
    approvedRevision: work.revision, sha256: approvedPdf.sha256, resolvedAt: '2026-11-14T11:00:10.000Z',
  };
  const retry = { ...options, attempt: 2, ownerAttestation,
    resultId: '00000000-0000-4000-8000-000000000007', deliver: async () => { calls++; return accepted; } };
  const nextWork = { ...approvedWork, token: 'replacement-lease-token' };
  const run = (settings: typeof retry) => submitApprovedClaimEmail(nextWork, withPrivateConfig, settings);
  const hold = { kind: 'failed', code: 'submission_uncertain' };
  expect(await run(retry)).toEqual(hold);
  finish.resolve({ kind: 'uncertain' });
  expect(await old).toEqual(hold);
  expect(await run({ ...retry, ownerAttestation: { ...ownerAttestation, previousLeaseTokenHash: 'f'.repeat(64) } })).toEqual(hold);
  expect(calls).toBe(1);
  expect(await run(retry)).toMatchObject({ kind: 'applied', sesMessageId: accepted.messageId });
  expect(await run({ ...retry, resultId: '00000000-0000-4000-8000-000000000008' })).toEqual(hold);
  expect(calls).toBe(2);
  const names = await readdir(dirname(journalPath()));
  expect(names).toContain('ses-reconciled-1.json');
});

test('the same Owner decision can reach the original reservation after two pre-send failures', async () => {
  let sends = 0;
  const submitOptions = { approvedPdf, resultId, attempt: 1,
    beforeSend: async () => {}, deliver: async () => { sends++; return { kind: 'uncertain' } as const; } };
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, submitOptions))
    .toMatchObject({ kind: 'failed', code: 'submission_uncertain' });
  const ownerAttestation = {
    previousWorkId: work.id, previousAttempt: 1, previousResultId: resultId,
    previousLeaseTokenHash: mailSha256(approvedWork.token),
    approvedRevision: work.revision, sha256: approvedPdf.sha256, resolvedAt: '2026-11-14T11:00:10.000Z',
  };
  const unavailableSnapshot = async () => { throw new Error('snapshot unavailable'); };
  for (const attempt of [2, 3]) {
    const failure = await submitApprovedClaimEmail({ ...approvedWork, token: `replacement-token-${attempt}` }, unavailableSnapshot, {
      ...submitOptions, ownerAttestation, attempt, resultId: crypto.randomUUID(),
    });
    expect(failure).toMatchObject({ kind: 'failed', code: 'runner_unavailable' });
  }
  const outcome = await submitApprovedClaimEmail({ ...approvedWork, token: 'replacement-token-4' }, withPrivateConfig, {
    ...submitOptions, ownerAttestation, attempt: 4, resultId: crypto.randomUUID(),
    deliver: async () => { sends++; return accepted; },
  });
  expect(outcome).toMatchObject({ kind: 'applied', sesMessageId: accepted.messageId });
  expect(sends).toBe(2);
});

test('a replacement reserved before a crash can reuse its grant until it records a send start', async () => {
  const enteringGate = deferred<void>();
  const gate = deferred<void>();
  let sends = 0;
  const initial = { approvedPdf, resultId, attempt: 1,
    beforeSend: async () => {}, deliver: async () => { sends++; return { kind: 'uncertain' } as const; } };
  await submitApprovedClaimEmail(approvedWork, withPrivateConfig, initial);
  const ownerAttestation = {
    previousWorkId: work.id, previousAttempt: 1, previousResultId: resultId,
    previousLeaseTokenHash: mailSha256(approvedWork.token),
    approvedRevision: work.revision, sha256: approvedPdf.sha256, resolvedAt: '2026-11-14T11:00:10.000Z',
  };
  const replacement = submitApprovedClaimEmail({ ...approvedWork, token: 'replacement-token-2' }, withPrivateConfig, {
    ...initial, ownerAttestation, attempt: 2, resultId: crypto.randomUUID(),
    beforeSend: async () => { enteringGate.resolve(); await gate.promise; },
  });
  await Promise.race([enteringGate.promise, replacement.then(() => { throw new Error('replacement did not request the gate'); })]);
  const reservedBeforeStart = await readFile(journalPath());
  gate.resolve();
  expect(await replacement).toMatchObject({ code: 'submission_uncertain' });
  const retry = () => submitApprovedClaimEmail({ ...approvedWork, token: 'replacement-token-3' }, withPrivateConfig, {
    ...initial, ownerAttestation, attempt: 3, resultId: crypto.randomUUID(), deliver: async () => { sends++; return accepted; },
  });
  expect(await retry()).toMatchObject({ code: 'submission_uncertain' });
  expect(sends).toBe(2);

  // Restore the durable bytes that would remain if the process stopped before the gate returned.
  await writeFile(journalPath(), reservedBeforeStart);
  expect(await retry()).toMatchObject({ kind: 'applied', sesMessageId: accepted.messageId });
  expect(sends).toBe(3);
});

async function stagedEmailReceipt(pdfSha256 = approvedPdf.sha256, onReport?: (report: WorkReport) => void) {
  const reports: WorkReport[] = [];
  const outboxDirectory = join(directory, 'outbox');
  const openOutbox = () => createJobsWorkOutbox(outboxDirectory, { report: async report => {
    reports.push(report);
    onReport?.(report);
  } });
  const fallback = { id: approvedWork.id, action: 'fail', body: {
    leaseToken: approvedWork.token, resultId, code: 'submission_uncertain',
  } } as const;
  const outcome = await submitApprovedClaimEmail(approvedWork, withPrivateConfig, {
    approvedPdf, resultId, deliver: async () => accepted,
    beforeSend: () => openOutbox().stageEmailIntent(fallback, {
      applicationId: approvedWork.applicationId, approvalRevision: approvedWork.revision, pdfSha256,
    }),
  });
  expect(outcome.kind).toBe('applied');
  return { reports, openOutbox, fallback, path: join(outboxDirectory, `${resultId}.json`) };
}

test.each(['open', 'stat'] as const)('a transient journal %s error keeps the staged receipt link for recovery', async operation => {
  const { reports, openOutbox, path } = await stagedEmailReceipt();
  const staged = await readFile(path, 'utf8');
  const open = fs.open;
  const fail = () => { throw Object.assign(new Error('private filesystem detail'), { code: 'EIO' }); };
  const spy = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (args[0] !== journalPath()) return open(...args);
    if (operation === 'open') fail();
    return Object.assign(await open(...args), { stat: fail });
  });
  try {
    await expect(openOutbox().drain()).rejects.toThrow('jobs_email_journal_read_unavailable');
    expect(reports).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(staged);
  } finally { spy.mockRestore(); }
  await openOutbox().drain();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ action: 'complete', body: {
    resultId, result: { receipt: { sesMessageId: accepted.messageId } },
  } });
  await expect(stat(path)).rejects.toThrow();
});

test.each(['corrupt', 'mismatched'] as const)('a %s recovery journal sends only the staged hold', async problem => {
  const { reports, openOutbox, fallback, path } = await stagedEmailReceipt(problem === 'mismatched' ? 'a'.repeat(64) : undefined);
  if (problem === 'corrupt') await writeFile(journalPath(), '{truncated');
  await openOutbox().drain();
  expect(reports).toEqual([fallback]);
  await expect(stat(path)).rejects.toThrow();
});

test('an I/O retry followed by a lost hold response never changes the dispatched report', async () => {
  let firstReport = true;
  const { reports, openOutbox, fallback } = await stagedEmailReceipt(undefined, () => {
    if (!firstReport) return;
    firstReport = false;
    throw new JobsWorkTransportError(503);
  });
  const raw = await readFile(journalPath());
  const open = fs.open;
  const spy = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (args[0] === journalPath()) throw Object.assign(new Error('fixture read unavailable'), { code: 'EIO' });
    return open(...args);
  });
  try {
    await expect(openOutbox().drain()).rejects.toThrow('jobs_email_journal_read_unavailable');
    expect(reports).toEqual([]);
  } finally { spy.mockRestore(); }
  await writeFile(journalPath(), '{truncated');
  await expect(openOutbox().drain()).rejects.toThrow('jobs_work_api_503');
  await writeFile(journalPath(), raw);
  await openOutbox().drain();
  expect(reports).toEqual([fallback, fallback]);
});

test('a conflicting recovered SES receipt is archived intact and the outbox drains unrelated reports', async () => {
  const { reports, openOutbox, fallback, path } = await stagedEmailReceipt(undefined, report => {
    if (report.action === 'complete') throw new JobsWorkTransportError(409);
  });
  const unrelated = { ...fallback, body: { ...fallback.body, resultId: '00000000-0000-4000-8000-000000000006' } };
  await openOutbox().stage(unrelated);
  await openOutbox().drain();
  expect(reports).toHaveLength(2);
  expect(reports[1]).toEqual(unrelated);
  const names = await readdir(dirname(path));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(new RegExp(`^${resultId}\\..*conflict$`));
  expect(JSON.parse(await readFile(join(dirname(path), names[0]), 'utf8'))).toEqual(reports[0]);
  await openOutbox().drain();
  expect(reports).toHaveLength(2);
});

test('a conflicting direct SES receipt is archived without changing its bytes', async () => {
  const { reports, openOutbox, path } = await stagedEmailReceipt(undefined, () => { throw new JobsWorkTransportError(409); });
  const receipt = { id: work.id, action: 'complete', kind: 'submit', body: {
    leaseToken: approvedWork.token, resultId, result: {
      receipt: { code: 'confirmation_message', capturedAt: '2026-11-14T11:00:00.000Z', sesMessageId: accepted.messageId },
    },
  } } as const;
  await openOutbox().stage(receipt);
  const staged = await readFile(path, 'utf8');
  await openOutbox().drain();
  expect(reports).toEqual([receipt]);
  const [archive, ...others] = await readdir(dirname(path));
  expect(archive).toEndWith('.conflict');
  expect(others).toEqual([]);
  expect(await readFile(join(dirname(path), archive), 'utf8')).toBe(staged);
});

test('a stale SES hold is archived while a conflict on an unrelated report stays staged', async () => {
  const { reports, openOutbox, fallback, path } = await stagedEmailReceipt('a'.repeat(64), () => { throw new JobsWorkTransportError(409); });
  const otherResult = '00000000-0000-4000-8000-000000000006';
  const unrelated = { ...fallback, body: { ...fallback.body, resultId: otherResult } };
  await openOutbox().stage(unrelated);
  await expect(openOutbox().drain()).rejects.toThrow('jobs_work_api_409');
  expect(reports).toEqual([fallback, unrelated]);
  const [archive, other] = (await readdir(dirname(path))).sort();
  expect(other).toBe(`${otherResult}.json`);
  expect(archive).toEndWith('.conflict');
  expect(JSON.parse(await readFile(join(dirname(path), archive), 'utf8'))).toMatchObject({ report: fallback });
});

test('approved email durably reserves before the gate and recovers the precise provider receipt', async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const capturedAt = '2026-11-14T11:00:00.000Z';
  let calls = 0;
  const options = {
    approvedPdf, resultId, now: () => Date.parse(capturedAt),
    beforeSend: async () => {
      entered.resolve();
      await gate.promise;
    },
    deliver: async (packet: EmailPacket) => {
      calls++;
      expect(Buffer.from(packet.attachment.bytes)).toEqual(pdf);
      return accepted;
    },
  };
  const pending = submitApprovedClaimEmail(approvedWork, withPrivateConfig, options);
  await Promise.race([entered.promise, pending.then(() => { throw new Error('send gate skipped'); })]);
  expect(JSON.parse(await readFile(journalPath(), 'utf8'))).toMatchObject({ state: 'pending' });
  expect(await readApprovedEmailOutcome(recovery)).toBeUndefined();
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, options))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(0);
  gate.resolve();
  const receipt = { sesMessageId: accepted.messageId, capturedAt };
  expect(await pending).toEqual({ kind: 'applied', receiptCode: 'confirmation_message', ...receipt });
  expect(await readApprovedEmailOutcome(recovery)).toEqual({ kind: 'accepted', receipt });
  expect(await readApprovedEmailOutcome({ ...recovery, pdfSha256: 'a'.repeat(64) })).toBeUndefined();
  expect(await readApprovedEmailOutcome({ ...recovery, resultId: '00000000-0000-4000-8000-000000000006' })).toBeUndefined();
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, options))
    .toEqual({ kind: 'applied', receiptCode: 'confirmation_message', ...receipt });
  expect(calls).toBe(1);
  expect(await readFile(journalPath(), 'utf8')).not.toContain(approvedWork.token);
});

test('a failed approved-send gate records that SES was never called', async () => {
  let calls = 0;
  const options = {
    approvedPdf, resultId,
    beforeSend: async () => { throw new Error('lost gate acknowledgement'); },
    deliver: async () => { calls++; return accepted; },
  };
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, options))
    .toEqual({ kind: 'failed', code: 'runner_unavailable' });
  expect(calls).toBe(0);
  expect(JSON.parse(await readFile(journalPath(), 'utf8'))).toMatchObject({ state: 'not_sent' });
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, { ...options, beforeSend: async () => {} }))
    .toMatchObject({ kind: 'applied', sesMessageId: accepted.messageId });
  expect(calls).toBe(1);
});

test('ambiguous approved SES delivery leaves the approval held across a new lease', async () => {
  let calls = 0;
  let gates = 0;
  const options = {
    approvedPdf, resultId,
    beforeSend: async () => { gates++; },
    deliver: async () => { calls++; throw new Error('lost provider acknowledgement'); },
  };
  expect(await submitApprovedClaimEmail(approvedWork, withPrivateConfig, options))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(await readApprovedEmailOutcome(recovery)).toBeUndefined();
  await rm(join(directory, 'mail-ses.json'));
  expect(await submitApprovedClaimEmail({ ...approvedWork, token: 'replacement-fixture-lease' }, withPrivateConfig, options))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(1);
  expect(gates).toBe(1);
});

test('a modified approved PDF blocks the submission gate and SES', async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('unexpected send preparation'); };
  const result = await submitApprovedClaimEmail(approvedWork, withPrivateConfig, {
    approvedPdf: { ...approvedPdf, pdf: Buffer.from('%PDF-modified approved artifact') },
    resultId, beforeSend: unexpected, deliver: unexpected,
  });
  expect(result).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  expect(calls).toBe(0);
  await expect(stat(journalPath())).rejects.toThrow();
});

test('historical SES acceptance holds the same approval without creating a current receipt', async () => {
  expect(await submitClaimEmail(work, withPrivateConfig, { render, deliver: async () => accepted }))
    .toEqual({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId: accepted.messageId });
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('unexpected send preparation'); };
  expect(await submitApprovedClaimEmail(approvedWork, unexpected, {
    approvedPdf, resultId, beforeSend: unexpected, deliver: unexpected,
  })).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(await readApprovedEmailOutcome(recovery)).toBeUndefined();
  expect(calls).toBe(0);
});

test('no render or SES call occurs for missing configuration, absent authorization or a different Application Address', async () => {
  let calls = 0;
  const options = { render: async () => { calls++; return render(); }, deliver: async () => { calls++; return accepted; } };
  await writeLocal('mail-ses.json', { ...config, profile: undefined });
  expect(await submitClaimEmail(work, withPrivateConfig, options)).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  await writeLocal('mail-ses.json', config);
  expect(await submitClaimEmail({ ...work, token: '' }, withPrivateConfig, options)).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  await writeFile(privateConfigPath, JSON.stringify({ personal: { email: 'different@example.test' } }));
  expect(await submitClaimEmail(work, withPrivateConfig, options)).toEqual({ kind: 'failed', code: 'manual_required', attention: 'application_address' });
  expect(calls).toBe(0);
});

test('the durable pending record precedes provider delivery and serializes simultaneous attempts', async () => {
  const started = deferred<EmailPacket>();
  const result = deferred<SesDelivery>();
  let calls = 0;
  const deliver = async (packet: EmailPacket) => { calls++; started.resolve(packet); return result.promise; };
  const pending = submitClaimEmail(work, withPrivateConfig, { render, deliver });
  const packet = await started.promise;
  expect(packet).toMatchObject({ from: sender, to: 'apply@services.example.test', revision: 2, attachment: { sha256: mailSha256(pdf) } });
  expect(JSON.parse(await readFile(journalPath(), 'utf8'))).toMatchObject({ state: 'pending', messageKey: packet.messageKey });
  expect((await stat(journalPath())).mode & 0o777).toBe(0o600);
  expect(await submitClaimEmail(work, withPrivateConfig, { render, deliver })).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  result.resolve(accepted);
  expect(await pending).toEqual({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId: accepted.messageId });
  expect(await submitClaimEmail(work, withPrivateConfig, { render, deliver })).toEqual({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId: accepted.messageId });
  expect(await submitClaimEmail(work, withPrivateConfig, { render: async () => ({ path: '', pdf: Buffer.from('%PDF-different') }), deliver }))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(1);
  const safe = await readFile(journalPath(), 'utf8');
  expect(JSON.parse(safe)).toMatchObject({ state: 'accepted', messageId: accepted.messageId });
  expect(safe).not.toContain(sender);
  expect(safe).not.toContain(packet.body);
});

test('missing contact in the renderer reports the exact private field before calling SES', async () => {
  const result = await submitClaimEmail(work, withPrivateConfig, {
    render: async () => { throw new LocalContactRequired(['phone']); },
    deliver: async () => { throw new Error('unexpected SES call'); },
  });
  expect(result).toEqual({ kind: 'failed', code: 'manual_required', attention: { questions: [], variables: ['phone'] } });
  await expect(stat(journalPath())).rejects.toThrow();
});

test('a reviewed email attachment cannot fall back to a fresh PDF', async () => {
  const previewDigest = mailSha256(pdf);
  let deliveries = 0;
  const result = await submitClaimEmail({ ...work, previewDigest }, withPrivateConfig, {
    render: async (_work, options) => {
      expect(options?.previewDigest).toBe(previewDigest);
      throw new Error('resume_preview_missing');
    },
    deliver: async () => { deliveries++; return accepted; },
  });
  expect(result).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  expect(deliveries).toBe(0);
  await expect(stat(journalPath())).rejects.toThrow();
});

test('lost SES acknowledgment blocks replay but explicit rejection allows a future attempt', async () => {
  let calls = 0;
  const refused = { render, deliver: async () => { calls++; return { kind: 'not_sent' } as const; } };
  expect(await submitClaimEmail(work, withPrivateConfig, refused)).toEqual({ kind: 'failed', code: 'runner_unavailable' });
  await expect(stat(journalPath())).rejects.toThrow();
  const interrupted = { render, deliver: async () => { calls++; throw new Error('private fixture transport detail'); } };
  expect(await submitClaimEmail(work, withPrivateConfig, interrupted)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(await submitClaimEmail(work, withPrivateConfig, interrupted)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(2);
});

test('an uncertain approval stays blocked through a restart and continued revision even without SES configuration', async () => {
  let calls = 0;
  const options = { render, deliver: async () => { calls++; return { kind: 'uncertain' } as const; } };
  expect(await submitClaimEmail(work, withPrivateConfig, options)).toEqual({ kind: 'failed', code: 'submission_uncertain' });
  await rm(join(directory, 'mail-ses.json'));
  expect(await submitClaimEmail({ ...work, revision: 4, originalApprovalRevision: work.revision }, withPrivateConfig, options))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(1);
});

test('a historical SMTP reservation blocks SES even without SES configuration', async () => {
  await mkdir(dirname(journalPath()), { recursive: true });
  await writeFile(journalPath('smtp-result.json'), JSON.stringify({ state: 'pending', digest: 'a'.repeat(64) }), { mode: 0o600 });
  await rm(join(directory, 'mail-ses.json'));
  const forbidden = async () => { throw new Error('must not render or send'); };
  expect(await submitClaimEmail(work, withPrivateConfig, { render: forbidden, deliver: forbidden }))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  await expect(stat(journalPath())).rejects.toThrow();
});

test('an accepted SMTP receipt for a different sender prevents a new send across the cutover', async () => {
  await mkdir(dirname(journalPath()), { recursive: true });
  const key = mailSha256(JSON.stringify([work.applicationId, work.revision, 'jobs-email-v1']));
  const digest = mailSha256(JSON.stringify([key, 'old@example.test', 'apply@services.example.test', work.role,
    'Hello,\n\nPlease find my résumé attached for the Accounts Payable Clerk position.\n\nThank you.', mailSha256(pdf)]));
  await writeFile(journalPath('smtp-result.json'), JSON.stringify({ state: 'accepted', digest }), { mode: 0o600 });
  let calls = 0;
  const deliver = async () => { calls++; return accepted; };
  expect(await submitClaimEmail(work, withPrivateConfig, { render, deliver }))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(await submitClaimEmail(work, withPrivateConfig, { render: async () => ({ path: '', pdf: Buffer.from('%PDF-changed') }), deliver }))
    .toEqual({ kind: 'failed', code: 'submission_uncertain' });
  expect(calls).toBe(0);
});

test('a Jobs home override with a trailing slash still sends once', async () => {
  process.env.QUANTSELF_JOBS_HOME = directory + '/';
  let calls = 0;
  const options = { render, deliver: async () => { calls++; return accepted; } };
  expect(await submitClaimEmail(work, withPrivateConfig, options))
    .toEqual({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId: accepted.messageId });
  expect(calls).toBe(1);
});

test('a private snapshot cleanup error stops preparation before calling SES', async () => {
  const failingCleanup = async <T>(run: (path: string) => Promise<T>) => {
    await run(privateConfigPath);
    throw new Error('synthetic cleanup failure');
  };
  let calls = 0;
  const options = { render, deliver: async () => { calls++; return accepted; } };
  expect(await submitClaimEmail(work, failingCleanup, options))
    .toEqual({ kind: 'failed', code: 'runner_unavailable' });
  expect(calls).toBe(0);
  await expect(stat(journalPath())).rejects.toThrow();
});

test('both approved routes send through SES from their own Application Address', async () => {
  const questionPosting: EmailClaim = {
    ...work, applicationId: '00000000-0000-4000-8000-000000000002', applicationAddress: otherSender, resumeTrack: 'web',
    company: 'Example Creative', role: 'Freelance Content Coordinator',
    sourceUrl: 'https://creative.example.test/jobs/content',
  };
  const requests: { from?: string; to?: string[]; subject?: string; pdf?: Uint8Array }[] = [];
  const deliver = (packet: EmailPacket, mail: typeof config) => deliverSes(packet, mail, {
    async send({ input }) {
      requests.push({ from: input.FromEmailAddress, to: input.Destination?.ToAddresses,
        subject: input.Content?.Simple?.Subject?.Data, pdf: input.Content?.Simple?.Attachments?.[0].RawContent });
      return { MessageId: 'ses-fixture-id' };
    },
  });
  const answers = { [questionPosting.sourceUrl]: Object.fromEntries(applicationQuestions.map(question =>
    [question, { type: 'text', value: 'Saved answer.' }])) };
  for (const posting of [work, questionPosting]) {
    await writeFile(privateConfigPath, JSON.stringify({
      personal: { email: posting.applicationAddress, firstName: 'Example', lastName: 'Candidate' },
      answers,
    }));
    expect(await submitClaimEmail(posting, withPrivateConfig, { render, deliver }))
      .toEqual({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId: accepted.messageId });
  }
  expect(requests).toEqual([
    { from: sender, to: ['apply@services.example.test'], subject: work.role, pdf: new Uint8Array(pdf) },
    { from: otherSender, to: ['jobs@creative.example.test'], subject: 'Content Coordinator – Example Candidate', pdf: new Uint8Array(pdf) },
  ]);
});

test('a claim uses the same verified email routes through rendering and send preparation', async () => {
  const result = await submitClaimEmail(work, withPrivateConfig, {
    emailRoutes,
    render: async (_work, options) => {
      expect(options?.emailRoutes).toBe(emailRoutes);
      await writeLocal('email-routes.json', [{ ...emailRoutes[1], recipient: 'different@example.test' }]);
      return render();
    },
    deliver: async packet => {
      expect(packet.to).toBe(emailRoutes[1].recipient);
      return accepted;
    },
  });
  expect(result.kind).toBe('applied');
});
