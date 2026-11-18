import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobsWorkFailInput, runnerWorkKinds } from '../../apps/api/src/jobs-work-contract';
import { submitApplication, type BrowserResult } from './browser';
import { jobsHome, submissionPaused } from './config';
import { emailApplicationRoute, readEmailRoutes } from './email-routes';
import { JobsEmailJournalReadError, submitApprovedClaimEmail } from './email-ses';
import { ensureLocalBrowser } from './local-browser';
import { readCandidateRules } from './local-candidate-rules';
import { continuationRequirements, withResolvedClaimPrivateConfig } from './private-fields';
import { renderApprovedArtifact } from './preview';
import { replaceDocumentSummary } from './resume-document';
import { createJobsWorkClient, JobsWorkTransportError, type JobsWorkClient, type RunnerWork,
  type WorkFailure, type WorkReport, verifiedPdf } from './work-client';
import { createJobsWorkOutbox } from './work-outbox';
import { acquireWorkerLock } from './worker-lock';

type Options = {
  api: JobsWorkClient;
  outbox: ReturnType<typeof createJobsWorkOutbox>;
  workerId: string;
  cdpUrl: string;
  paused?: boolean;
  render?: typeof renderApprovedArtifact;
  submit?: typeof submitApplication;
  emailEnabled?: boolean;
  deliverEmail?: Parameters<typeof submitApprovedClaimEmail>[2]['deliver'];
  prepareBrowser?: typeof ensureLocalBrowser;
  now?: () => number;
};
const sha = (pdf: Uint8Array) => createHash('sha256').update(pdf).digest('hex');

async function renderWork(work: Extract<RunnerWork, { kind: 'render' }>, api: JobsWorkClient,
  outbox: Options['outbox'], render: typeof renderApprovedArtifact, resultId: string,
) {
  const { track: resumeTrack, applicationAddress, summaryMarkdown, resumeMarkdown, ...posting } = work.input;
  const identity = { ...posting, resumeTrack, applicationAddress, applicationId: work.applicationId };
  let pdf: Uint8Array;
  try {
    const emailRoutes = readEmailRoutes();
    const { markdown } = replaceDocumentSummary(resumeMarkdown, summaryMarkdown);
    pdf = await withResolvedClaimPrivateConfig(identity, () => api.privateFields(work), async privateConfigPath => {
      const artifact = await render({ ...posting, applicationId: work.applicationId, revision: work.revision,
        resumeTrack, summary: summaryMarkdown, resumeMarkdown: markdown }, { purpose: 'draft', privateConfigPath, emailRoutes });
      return verifiedPdf(artifact.pdf);
    }, { emailRoutes });
  } catch {
    await outbox.report({ id: work.id, action: 'fail', body: { leaseToken: work.leaseToken, resultId, code: 'runner_unavailable' } });
    return;
  }
  // PDF PUT settles render work. A transport error may mean the server already stored it.
  await api.uploadPdf(work, pdf, sha(pdf));
}

async function sendWork(work: Extract<RunnerWork, { kind: 'submit' }>, {
  api, outbox, cdpUrl, submit = submitApplication, prepareBrowser = ensureLocalBrowser,
  now = Date.now,
  emailEnabled = process.env.QUANTSELF_JOBS_MAC_SES === '1', deliverEmail,
}: Options, resultId: string) {
  const { track: resumeTrack, sha256, applicationAddress, ...posting } = work.input;
  const identity = { ...posting, resumeTrack, applicationAddress, applicationId: work.applicationId };
  const reportIdentity = { leaseToken: work.leaseToken, resultId };
  const failure = (code: WorkFailure['code']): Extract<WorkReport, { action: 'fail' }> =>
    ({ id: work.id, action: 'fail', body: jobsWorkFailInput.parse({ ...reportIdentity, code }) });
  const event = (step: Parameters<JobsWorkClient['submissionEvent']>[1]['step'], state: 'running' | 'done', channel?: 'ses') =>
    api.submissionEvent(work.applicationId, { workId: work.id, leaseToken: work.leaseToken, eventId: randomUUID(), step, state, channel });
  let intentRecorded = false;
  let emailIntentStaged = false;
  let isEmail = false;
  let startedAcknowledged = false;
  let gateRequested = false;
  const emailJournalScope = { applicationId: work.applicationId, approvalRevision: work.revision, pdfSha256: sha256 };
  const reportFailure = (code: WorkFailure['code']) => isEmail
    ? outbox.reportEmailFailure(failure(code), emailJournalScope)
    : outbox.report(failure(code));
  async function beforeSubmit(isEmail = false) {
    if (gateRequested || Date.parse(work.leaseUntil) <= now()) throw new Error('submit_gate_unavailable');
    gateRequested = true;
    // The browser requests the gate once the listing, form and attachment pass verification.
    if (!isEmail) {
      await event('portal_opened', 'done');
      await event('form_filled', 'done');
    }
    if (Date.parse(work.leaseUntil) <= now()) throw new Error('submit_gate_unavailable');
    if (isEmail) {
      await outbox.stageEmailIntent(failure('submission_uncertain'), emailJournalScope);
      emailIntentStaged = true;
    } else await outbox.stage(failure('submission_uncertain'));
    intentRecorded = true;
    await event('submit_started', 'running', isEmail ? 'ses' : undefined);
    if (Date.parse(work.leaseUntil) <= now()) throw new Error('submit_gate_unavailable');
    startedAcknowledged = true;
  }

  let outcome: BrowserResult;
  let emailReceipt: { sesMessageId: string; capturedAt: string } | undefined;
  try {
    const emailRoutes = readEmailRoutes();
    const configuredEmail = Boolean(emailApplicationRoute(identity, emailRoutes));
    isEmail = configuredEmail && emailEnabled;
    await event('runner_claimed', 'done', isEmail ? 'ses' : undefined);
    if (configuredEmail && !emailEnabled) throw new Error('email_route_requires_review');
    const pdf = await api.downloadPdf(work);
    if (sha(pdf) !== sha256) throw new Error('approved_pdf_digest_mismatch');
    if (isEmail) {
      const email = await submitApprovedClaimEmail({
        ...identity, kind: 'submit', id: work.id, token: work.leaseToken, revision: work.revision,
      }, use => withResolvedClaimPrivateConfig(identity, () => api.privateFields(work), use, { emailRoutes }), {
        approvedPdf: { pdf, sha256 }, resultId, emailRoutes, now,
        attempt: work.attempt, ownerAttestation: work.ownerAttestation,
        deliver: deliverEmail, beforeSend: () => beforeSubmit(true),
        canSend: () => Date.parse(work.leaseUntil) > now(),
      });
      outcome = email.kind === 'failed' ? { kind: email.kind, code: email.code } : email;
      if (email.kind === 'applied') emailReceipt = { sesMessageId: email.sesMessageId, capturedAt: email.capturedAt };
    } else {
      const candidateRules = readCandidateRules();
      const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-approved-pdf-'));
      try {
        const pdfPath = join(directory, 'resume.pdf');
        await writeFile(pdfPath, pdf, { flag: 'wx', mode: 0o600 });
        await prepareBrowser(cdpUrl);
        outcome = await withResolvedClaimPrivateConfig(identity, () => api.privateFields(work), async privateConfigPath => {
          return submit({ kind: 'submit', ...identity }, { cdpUrl, pdfPath, privateConfigPath, candidateRules, beforeSubmit: () => beforeSubmit() });
        }, { cdpUrl, emailRoutes, candidateRules });
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (error) {
    if (emailIntentStaged) {
      await outbox.deliver(resultId);
      return;
    }
    const code = intentRecorded ? 'submission_uncertain'
      : error instanceof Error && error.message === 'email_route_requires_review' ? 'unsupported_portal' : 'runner_unavailable';
    await reportFailure(code);
    return;
  }

  if (outcome.kind === 'applied' && startedAcknowledged) {
    const report = { id: work.id, action: 'complete', kind: 'submit', body: { ...reportIdentity,
      result: { receipt: { code: outcome.receiptCode, ...(emailReceipt ?? { capturedAt: new Date(now()).toISOString() }) } } } } as const;
    await outbox.stage(report);
    try {
      await event('submitted', 'done');
      await event('receipt_captured', 'done');
    } catch { /* The known receipt is retained and still reported. */ }
    await outbox.deliver(resultId);
    return;
  }
  if (emailIntentStaged) {
    await outbox.deliver(resultId);
    return;
  }
  if (outcome.kind === 'applied' || intentRecorded) {
    await outbox.report(failure('submission_uncertain'));
    return;
  }
  const requirements = continuationRequirements({ ...identity, previewDigest: sha256 }, outcome);
  if (requirements?.length && requirements.length <= 25 && outcome.code === 'manual_required') {
    await outbox.report({ id: work.id, action: 'fail', body: { ...reportIdentity, code: 'manual_required', requirements } });
    return;
  }
  await reportFailure(outcome.code);
}

export async function runJobsMacOnce(options: Options) {
  const { api, outbox, workerId, paused = submissionPaused(), render = renderApprovedArtifact, now = Date.now } = options;
  await outbox.drain();
  const kinds = paused ? ['render' as const] : [...runnerWorkKinds];
  const work = await api.claim({ workerId, kinds, supportsOwnerAttestation: true });
  if (!work) return false;
  if (work.kind !== 'render' && (work.kind !== 'submit' || paused)) throw new Error('invalid_mac_jobs_claim');
  if (Date.parse(work.leaseUntil) <= now()) return false;
  const resultId = randomUUID();
  if (work.kind === 'render') await renderWork(work, api, outbox, render, resultId);
  else await sendWork(work, options, resultId);
  return true;
}

async function main() {
  const baseUrl = process.env.JOBS_RUNNER_BASE_URL;
  const secret = process.env.JOBS_RUNNER_SECRET;
  const cdpUrl = process.env.JOBS_RUNNER_CDP_URL;
  if (!baseUrl || !secret || !cdpUrl) throw new Error('jobs_runner_configuration_required');
  const api = createJobsWorkClient({ baseUrl, secret });
  const runnerHost = process.env.JOBS_RUNNER_ID?.trim() || `jobs-mac-${hostname()}`;
  const outbox = createJobsWorkOutbox(join(jobsHome(), 'worker-v2', 'outbox'), api);
  const unlock = await acquireWorkerLock('worker-v2');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const once = process.argv.includes('--once');
    let nextHeartbeat = 0;
    let delay = 5_000;
    do {
      try {
        if (Date.now() >= nextHeartbeat) {
          await api.heartbeat(runnerHost);
          nextHeartbeat = Date.now() + 30_000;
        }
        const handled = await runJobsMacOnce({ api, outbox, cdpUrl, workerId: runnerHost });
        delay = 5_000;
        if (once || stopped) break;
        if (!handled) await Bun.sleep(delay);
      } catch (error) {
        const retry = error instanceof JobsEmailJournalReadError || (error instanceof JobsWorkTransportError &&
          (error.status === undefined || error.status === 429 || error.status >= 500));
        if (stopped || once || !retry) throw error;
        console.warn(error.message);
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    } while (!stopped);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await unlock();
  }
}

if (import.meta.main) {
  await main().catch(error => {
    const code = error instanceof Error ? error.message : '';
    console.error(/^(?:jobs_runner_configuration_required|runner_already_running|runner_lock_requires_review|jobs_email_journal_read_unavailable|jobs_work_api_(?:unavailable|\d{3}))$/.test(code)
      ? code : 'jobs_mac_runner_failed');
    process.exitCode = 1;
  });
}
