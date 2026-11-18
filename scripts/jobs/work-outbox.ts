import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { jobsWorkCompleteInput, jobsWorkFailInput } from '../../apps/api/src/jobs-work-contract';
import { JobsWorkTransportError, type JobsWorkClient, type WorkReport } from './work-client';

const reportSchema = z.discriminatedUnion('action', [
  z.strictObject({ id: z.uuid(), action: z.literal('fail'), body: jobsWorkFailInput }),
  z.strictObject({
    id: z.uuid(), action: z.literal('complete'), kind: z.enum(['enrich', 'tailor', 'revise', 'submit']),
    body: z.union([jobsWorkCompleteInput.enrich, jobsWorkCompleteInput.tailor, jobsWorkCompleteInput.submit]),
  }),
]);
const emailIntentSchema = z.strictObject({
  report: z.strictObject({ id: z.uuid(), action: z.literal('fail'), body: jobsWorkFailInput }),
  reportReady: z.literal(true).optional(),
  email: z.strictObject({
    applicationId: z.uuid(),
    approvalRevision: z.number().int().nonnegative(),
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
}).refine(entry => entry.reportReady || entry.report.body.code === 'submission_uncertain');
type EmailJournalScope = z.infer<typeof emailIntentSchema>['email'];
const entrySchema = z.union([reportSchema, emailIntentSchema]);

async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureDirectory(directory: string) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!created) return;
  const existingParent = dirname(resolve(created));
  for (let parent = resolve(directory); parent !== existingParent; parent = dirname(parent)) await syncDirectory(parent);
  await syncDirectory(existingParent);
}

async function writeWorkJournal(path: string, value: unknown) {
  const directory = dirname(path);
  await ensureDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}

async function acknowledgeWorkJournal(path: string) {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

function isSesReceipt(report: WorkReport) {
  if (report.action !== 'complete' || report.kind !== 'submit') return false;
  return Boolean(jobsWorkCompleteInput.submit.safeParse(report.body).data?.result.receipt.sesMessageId);
}

export function createJobsWorkOutbox(directory: string, api: Pick<JobsWorkClient, 'report'>) {
  const pathFor = (resultId: string) => join(directory, `${z.uuid().parse(resultId)}.json`);
  async function stage(report: WorkReport) {
    await writeWorkJournal(pathFor(report.body.resultId), reportSchema.parse(report));
  }
  async function deliver(resultId: string) {
    const path = pathFor(resultId);
    const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
    if (raw === undefined) return;
    const entry = entrySchema.parse(JSON.parse(raw));
    let report: WorkReport = 'email' in entry ? entry.report : entry;
    if (report.body.resultId !== resultId && report.id !== resultId) throw new Error('invalid_jobs_work_journal');
    if ('email' in entry) {
      if (entry.report.body.resultId !== resultId) throw new Error('invalid_jobs_work_journal');
      if (!entry.reportReady) {
        // A restart may leave the staged hold alongside a confirmed provider acceptance.
        // If the SES journal cannot be read, preserve the link and retry before reporting.
        const { readApprovedEmailOutcome } = await import('./email-ses');
        const outcome = await readApprovedEmailOutcome({ ...entry.email, claimId: entry.report.id, resultId });
        if (outcome?.kind === 'accepted') {
          report = { id: entry.report.id, action: 'complete', kind: 'submit', body: {
            leaseToken: entry.report.body.leaseToken, resultId, result: { receipt: { code: 'confirmation_message', ...outcome.receipt } },
          } };
          await stage(report);
        } else {
          if (outcome?.kind === 'not_sent') {
            report = { id: entry.report.id, action: 'fail', body: {
              leaseToken: entry.report.body.leaseToken, resultId, code: 'runner_unavailable', emailNotSent: true,
            } };
          }
          await writeWorkJournal(path, { ...entry, report, reportReady: true });
        }
      }
    }
    try {
      await api.report(report);
    } catch (error) {
      if (!(error instanceof JobsWorkTransportError) || error.status !== 409 || !('email' in entry || isSesReceipt(report))) throw error;
      await rename(path, join(directory, `${resultId}.${randomUUID()}.conflict`));
      await syncDirectory(directory);
      return;
    }
    await acknowledgeWorkJournal(path);
  }
  return {
    async drain() {
      await ensureDirectory(directory);
      for (const name of (await readdir(directory)).sort()) {
        if (name.endsWith('.json')) await deliver(name.slice(0, -5));
      }
    },
    stage,
    async stageEmailIntent(report: Extract<WorkReport, { action: 'fail' }>, email: EmailJournalScope) {
      await writeWorkJournal(pathFor(report.body.resultId), emailIntentSchema.parse({ report, email }));
    },
    async reportEmailFailure(report: Extract<WorkReport, { action: 'fail' }>, email: EmailJournalScope) {
      const { resultId } = report.body;
      await writeWorkJournal(pathFor(resultId), emailIntentSchema.parse({ report, email, reportReady: true }));
      await deliver(resultId);
    },
    deliver,
    async report(report: WorkReport) {
      await stage(report);
      await deliver(report.body.resultId);
    },
  };
}
