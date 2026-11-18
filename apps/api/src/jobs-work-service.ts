import { randomUUID } from "node:crypto";
import { minorDigits } from "@quantself/budgeting";
import { Prisma, type JobWorkItemKind, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { z } from "zod";
import { parseResumeDocument, replaceDocumentSummary } from "../../../scripts/jobs/resume-document";
import { currencyCode, type CurrencyConverter } from "./budget-fx";
import { getCandidateContext } from "./jobs-candidate-context";
import { JobsError } from "./jobs-error";
import { isPrismaWriteConflict } from "./idempotency";
import { authorizeJobsPilotReview } from "./jobs-pilot-permit";
import { pilotReviewOf } from "./jobs-pilot-review";
import { preparePrivatePause } from "./jobs-private-fields";
import { hashJobWorkToken } from "./jobs-private-pause";
import {
  codexWorkKinds, jobsEnrichOutput, jobsOwnerAttestation, jobsSummaryOutput, jobsWorkClaimInput, jobsWorkClaimOutput,
  jobsWorkCompleteInput, jobsWorkFailInput, runnerWorkKinds,
} from "./jobs-work-contract";
import { recordTrackedApplicationSent } from "./tracked-links-store";

type Transaction = Prisma.TransactionClient;
export type JobsWorker = { ownerId: string; role: "codex" | "runner" };
const workKindsFor = ({ role }: JobsWorker): readonly JobWorkItemKind[] => role === "codex" ? codexWorkKinds : runnerWorkKinds;
const leaseMs = 10 * 60_000;
const rateLimitDelayMs = 60_000;
const stale = () => new JobsError(409, "This Jobs work lease is no longer active.");
const includeApplication = { application: { select: {
  ownerId: true, id: true, revision: true, approvedRevision: true, approvedPreviewDigest: true, pilotHeldAt: true,
  status: true, createdAt: true, resumeTrack: true, company: true, role: true, sourceUrl: true, applicationAddress: true,
  description: true, brief: true,
} } } as const satisfies Prisma.JobWorkItemInclude;
type WorkWithApplication = Prisma.JobWorkItemGetPayload<{ include: typeof includeApplication }>;

export async function withJobsWorkTransaction<T>(db: PrismaClient, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(operation, { isolationLevel: "Serializable" }); }
    catch (error) {
      if (attempt >= 2 || !isPrismaWriteConflict(error)) throw error;
    }
  }
}

const workRevisionKey = ({ ownerId, applicationId, revision }: WorkWithApplication) => ({ ownerId, applicationId, revision });
export const jobWorkRevision = (tx: Pick<Transaction, "jobRevision">, work: WorkWithApplication) =>
  tx.jobRevision.findUnique({ where: { ownerId_applicationId_revision: workRevisionKey(work) } });

function matchesApplication(work: WorkWithApplication, claiming: boolean) {
  const app = work.application;
  if (app.revision !== work.revision) return false;
  if (work.kind === "render") {
    // Only reports from a preview claimed before the switch can still reach review.
    return app.status === "approved" && app.approvedRevision === work.revision ||
      !claiming && app.status === "review" && app.approvedRevision === null;
  }
  if (work.kind === "submit") return app.approvedRevision === work.revision && app.status === (claiming ? "queued" : "submitting");
  return app.status === "draft";
}

function isUnapprovedPreview(work: WorkWithApplication) {
  return work.kind === "render" && work.application.status === "review" && work.application.approvedRevision === null;
}

const workPayload = z.object({
  resumeMarkdown: z.string().optional(), instructions: z.string().optional(), next: z.literal("revise").optional(),
});
const payload = (work: WorkWithApplication) => workPayload.safeParse(work.payload).data ?? {};
const submitPayload = z.object({ ownerAttestation: jobsOwnerAttestation.optional() });

export function pendingOwnerAttestation(
  work: Pick<WorkWithApplication, "id" | "attempts" | "payload">, revision: number, approvedPreviewDigest: string | null,
) {
  const ownerAttestation = submitPayload.safeParse(work.payload).data?.ownerAttestation;
  if (ownerAttestation?.previousWorkId === work.id && ownerAttestation.previousAttempt <= work.attempts &&
      ownerAttestation.approvedRevision === revision && ownerAttestation.sha256 === approvedPreviewDigest) {
    return ownerAttestation;
  }
}

async function claimInput(tx: Transaction, work: WorkWithApplication) {
  const { application: app } = work;
  const track = app.resumeTrack;
  if (work.kind === "render" || work.kind === "submit") {
    const revision = await jobWorkRevision(tx, work);
    const shared = { track, company: app.company, role: app.role, sourceUrl: app.sourceUrl, applicationAddress: app.applicationAddress };
    if (work.kind === "render") return { ...shared, summaryMarkdown: revision?.summaryMarkdown, resumeMarkdown: revision?.resumeMarkdown };
    if (!revision?.pdfReference || !revision.pdfSha256 || revision.pdfSha256 !== app.approvedPreviewDigest) return null;
    return { ...shared, sha256: revision.pdfSha256 };
  }
  const { markdown: candidateContext } = await getCandidateContext(tx, app.ownerId);
  if (work.kind === "enrich") {
    if (URL.parse(app.sourceUrl)?.hostname === "weworkremotely.com") {
      return { track, candidateContext, postingText: "", publicPosting: { sourceUrl: app.sourceUrl, role: app.role } };
    }
    return { track, candidateContext, postingText: app.description };
  }
  const input = payload(work);
  const document = work.kind === "revise" ? await jobWorkRevision(tx, work) : null;
  let resumeMarkdown;
  try { resumeMarkdown = parseResumeDocument((work.kind === "tailor" ? input.resumeMarkdown : document?.resumeMarkdown) ?? "").markdown; }
  catch { return null; }
  return {
    track, candidateContext, brief: app.brief, resumeMarkdown,
    ...(work.kind === "revise" && { summaryMarkdown: document?.summaryMarkdown, instructions: input.instructions }),
  };
}

export async function claimJobsWork(tx: Transaction, worker: JobsWorker, input: z.infer<typeof jobsWorkClaimInput>, now: Date, pilotReview = false) {
  const allowed = workKindsFor(worker);
  if (input.kinds.some(kind => !allowed.includes(kind))) throw new JobsError(403, "This credential cannot claim the requested Jobs work.");
  const { ownerId } = worker;
  const runner = input.kinds.includes("submit")
    ? await tx.jobRunner.findUnique({ where: { ownerId }, select: { paused: true } })
    : null;
  const kinds = runner?.paused ? input.kinds.filter(kind => kind !== "submit") : input.kinds;
  if (!kinds.length) return { work: null };
  const eligibility: Prisma.JobWorkItemWhereInput[] = [];
  if (kinds.includes("render")) {
    eligibility.push({ OR: [{ kind: { not: "render" } }, { application: { status: "approved" } }] });
  }
  if (!input.supportsOwnerAttestation && kinds.includes("submit")) {
    eligibility.push({ OR: [{ kind: { not: "submit" } }, { payload: { path: ["ownerAttestation"], equals: Prisma.AnyNull } }] });
  }
  if (worker.role === "runner" && pilotReview) eligibility.push({ OR: [
    { application: { pilotHeldAt: null } },
    { application: { pilotHeldAt: { not: null } }, payload: { path: ["pilotReview", "permitId"], not: Prisma.AnyNull } },
  ] });
  else eligibility.push({ application: { pilotHeldAt: null } });
  const work = await tx.jobWorkItem.findFirst({
    where: { ownerId, kind: { in: kinds }, OR: [
      { state: "queued", availableAt: { lte: now } },
      { state: "claimed", kind: { not: "submit" }, leaseUntil: { lte: now } },
    ], AND: eligibility }, include: includeApplication, orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (!work) return { work: null };
  if (work.application.pilotHeldAt) {
    try { await requirePilotRunnerAuthorization(tx, work); }
    catch (error) {
      if (!(error instanceof JobsError) || ![404, 409].includes(error.status)) throw error;
      await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId, id: work.id } }, data: {
        state: "failed", failureCode: "superseded", leaseTokenHash: null, leaseUntil: null,
      } });
      return { work: null };
    }
  }
  return leaseJobsWork(tx, worker, work, input, now);
}

export async function requirePilotRunnerAuthorization(tx: Transaction, work: WorkWithApplication) {
  if (!work.application.pilotHeldAt) return;
  const approval = pilotReviewOf(work.payload);
  if (!approval || work.application.approvedRevision !== work.revision || work.application.revision !== work.revision ||
      approval.sha256 !== work.application.approvedPreviewDigest || (work.kind === "submit") !== (approval.sha256 !== null)) {
    throw new JobsError(409, "The pilot work is outside the Owner's exact approval.");
  }
  await authorizeJobsPilotReview(tx, { ...workRevisionKey(work), permitId: approval.permitId });
}

// Held model work is available to the offline pilot dispatcher and lease fixtures.
export async function claimHeldJobsModelWork(tx: Transaction, worker: JobsWorker, input: {
  workerId: string; applicationId: string; revision: number;
}, now: Date, kind: "enrich" | "tailor") {
  if (worker.role !== "codex") throw new JobsError(403, "Only a Jobs model worker can claim held model work.");
  const { ownerId } = worker;
  const { applicationId, revision } = input;
  const work = await tx.jobWorkItem.findUnique({
    where: {
      ownerId_applicationId_kind_revision: { ownerId, applicationId, kind, revision },
      state: "queued", attempts: 0, availableAt: { lte: now },
      application: { revision, status: "draft", pilotHeldAt: { not: null } },
    },
    include: includeApplication,
  });
  if (!work) return { work: null };
  return leaseJobsWork(tx, worker, work, input, now);
}

export function claimHeldJobsEnrichment(tx: Transaction, worker: JobsWorker, input: {
  workerId: string; applicationId: string; revision: number;
}, now: Date) {
  return claimHeldJobsModelWork(tx, worker, input, now, "enrich");
}

async function leaseJobsWork(tx: Transaction, worker: JobsWorker, work: WorkWithApplication, {
  workerId, supportsOwnerAttestation,
}: Pick<z.infer<typeof jobsWorkClaimInput>, "workerId" | "supportsOwnerAttestation">, now: Date) {
  const { ownerId } = worker;
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const current = matchesApplication(work, true);
  const ownerAttestation = work.kind === "submit" && supportsOwnerAttestation
    ? pendingOwnerAttestation(work, work.revision, work.application.approvedPreviewDigest) : undefined;
  const parsed = current ? jobsWorkClaimOutput.safeParse({ work: {
    id: work.id, applicationId: work.applicationId, revision: work.revision, kind: work.kind,
    leaseToken, leaseUntil: leaseUntil.toISOString(), input: await claimInput(tx, work),
    ...(work.kind === "submit" && supportsOwnerAttestation && {
      attempt: work.attempts + 1, ...(ownerAttestation && { ownerAttestation }),
    }),
  } }) : null;
  const where = { ownerId_id: { ownerId, id: work.id } };
  if (!parsed?.success) {
    await tx.jobWorkItem.update({ where, data: {
      state: "failed", failureCode: current ? "invalid_input" : "stale_revision",
    } });
    if (current) await tx.jobApplication.update({
      where: { ownerId_id: { ownerId, id: work.applicationId } },
      data: { status: isUnapprovedPreview(work) ? "review" : "needs_attention", issueCode: worker.role === "codex" ? "model_error" : "runner_unavailable" },
    });
    return { work: null };
  }
  await tx.jobWorkItem.update({ where, data: {
    state: "claimed", claimedBy: workerId, attempts: { increment: 1 }, leaseTokenHash: hashJobWorkToken(leaseToken), leaseUntil,
    ...(work.kind === "submit" && { resultId: null }),
  } });
  if (work.kind === "submit") await tx.jobApplication.update({
    where: { ownerId_id: { ownerId, id: work.applicationId } }, data: { status: "submitting", submitLeaseUntil: leaseUntil },
  });
  return parsed.data;
}

export async function requireJobsWork(tx: Pick<Transaction, "jobWorkItem">, worker: JobsWorker, id: string, token: string) {
  const work = await tx.jobWorkItem.findUnique({ where: { ownerId_id: { ownerId: worker.ownerId, id } }, include: includeApplication });
  if (!work) throw new JobsError(404, "Jobs work not found.");
  if (!workKindsFor(worker).includes(work.kind)) throw new JobsError(403, "This credential cannot access this Jobs work.");
  if (work.leaseTokenHash !== hashJobWorkToken(token)) throw stale();
  return work;
}

export async function lockJobsWork(tx: Transaction, ownerId: string, id: string) {
  await tx.$queryRaw`SELECT 1 FROM job_work_item WHERE "ownerId" = ${ownerId} AND id = ${id} FOR UPDATE`;
}

export function requireCurrentJobsClaim(work: WorkWithApplication) {
  if (work.state !== "claimed" || !work.leaseUntil || !matchesApplication(work, false)) throw stale();
  return work.leaseUntil;
}

export function requireActiveJobsWork(work: WorkWithApplication, now: Date) {
  if (requireCurrentJobsClaim(work) <= now) throw stale();
}

async function updateApplication(tx: Transaction, work: WorkWithApplication, data: Prisma.JobApplicationUpdateInput) {
  await tx.jobApplication.update({ where: { ownerId_id: { ownerId: work.ownerId, id: work.applicationId } }, data });
}

async function recordEvent(tx: Transaction, work: WorkWithApplication, kind: string, metadata: Prisma.InputJsonObject, eventKey?: string) {
  await tx.jobEvent.create({ data: { ...workRevisionKey(work), kind, eventKey, payload: { ...metadata, workId: work.id, attempt: work.attempts } } });
}

type SubmissionAttempt = Pick<WorkWithApplication, "ownerId" | "applicationId" | "revision" | "id" | "attempts">;

const submissionAttemptEvents = ({ ownerId, applicationId, revision, id, attempts }: SubmissionAttempt) => ({
  ownerId, applicationId, revision, AND: [
    { payload: { path: ["workId"], equals: id } },
    { payload: { path: ["attempt"], equals: attempts } },
  ],
});

export async function findJobsSubmissionStart(tx: Transaction, work: SubmissionAttempt) {
  return tx.jobEvent.findFirst({
    where: { ...submissionAttemptEvents(work), kind: "submit_started" }, select: { payload: true },
  });
}

export async function hasSesSubmissionPreflight(tx: Transaction, work: SubmissionAttempt) {
  const where = submissionAttemptEvents(work);
  return Boolean(await tx.jobEvent.findFirst({
    where: { ...where, kind: "submission_step", AND: [...where.AND,
      { payload: { path: ["step"], equals: "runner_claimed" } },
      { payload: { path: ["state"], equals: "done" } },
      { payload: { path: ["channel"], equals: "ses" } },
    ] }, select: { id: true },
  }));
}

export function isSesSubmissionStart(event: Awaited<ReturnType<typeof findJobsSubmissionStart>>) {
  return z.object({ channel: z.literal("ses") }).safeParse(event?.payload).success;
}

async function normalizeEnrichment(result: z.output<typeof jobsEnrichOutput>, date: string, rates: CurrencyConverter) {
  const { eligible, ineligibleReason, verdict, dueDate, pay, ...brief } = result;
  if (!pay) return { brief: { ...brief, pay: { hourlyCad: null, original: null, converted: false } }, eligible, ineligibleReason, verdict, dueDate, pay, quote: null };
  const currency = currencyCode.parse(pay.currency);
  if (pay.min > pay.max) throw new JobsError(400, "Invalid Jobs pay range.");
  const divisor = { hour: 1, week: 40, month: 2080 / 12, year: 2080 }[pay.period];
  const converted = currency !== "CAD";
  const conversions = converted ? await rates.convertMany([pay.min, pay.max].map(amount => ({
    money: { amountMinor: Math.round(amount * 10 ** minorDigits(currency)), currency }, target: "CAD", date,
  }))) : [];
  const [min, max] = converted ? conversions.map(conversion => conversion.converted.amountMinor / 100 / divisor) : [pay.min / divisor, pay.max / divisor];
  return { brief: { ...brief, pay: { hourlyCad: { min, max }, original: `${currency} ${pay.min}–${pay.max} per ${pay.period}`, converted } },
    eligible, ineligibleReason, verdict, dueDate, pay, quote: conversions.find(item => item.quote)?.quote ?? null };
}

async function completeEnrichment(tx: Transaction, work: WorkWithApplication, result: z.output<typeof jobsEnrichOutput>, rates: CurrencyConverter) {
  const value = await normalizeEnrichment(result, work.application.createdAt.toISOString().slice(0, 10), rates);
  await updateApplication(tx, work, { brief: value.brief, verdict: value.verdict,
    ...(value.dueDate && { dueAt: new Date(`${value.dueDate}T00:00:00Z`) }), status: value.eligible ? "draft" : "disqualified", issueCode: null });
  if (value.eligible) {
    const input = payload(work);
    const kind = input.next ?? "tailor";
    const key = workRevisionKey(work);
    await tx.jobWorkItem.upsert({
      where: { ownerId_applicationId_kind_revision: { ...key, kind } },
      create: { ...key, kind, payload: input },
      update: { state: "queued", payload: input, failureCode: null, availableAt: new Date(), leaseTokenHash: null, leaseUntil: null, claimedBy: null },
    });
  }
  await recordEvent(tx, work, "enriched", { eligible: value.eligible, reason: value.ineligibleReason ?? null, pay: value.pay, quote: value.quote });
}

async function markWorkDone(tx: Transaction, work: WorkWithApplication, resultId: string) {
  await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId: work.ownerId, id: work.id } }, data: { state: "done", resultId, failureCode: null } });
}

export async function completeHeldJobsModelWork(tx: Transaction, target: {
  ownerId: string; applicationId: string; revision: number; workerId: string;
}, claim: { workId: string; leaseTokenHash: string; resultId: string }, result: unknown, now: Date, rates: CurrencyConverter,
kind: "enrich" | "tailor") {
  const { ownerId, applicationId, revision, workerId } = target;
  const work = await tx.jobWorkItem.findUnique({
    where: {
      ownerId_id: { ownerId, id: claim.workId },
      applicationId, revision, kind, state: "claimed", claimedBy: workerId,
      leaseTokenHash: claim.leaseTokenHash, leaseUntil: { gt: now },
      application: { revision, status: "draft", pilotHeldAt: { not: null } },
    },
    include: includeApplication,
  });
  if (!work) return false;
  if (kind === "enrich") await completeEnrichment(tx, work, jobsEnrichOutput.parse(result), rates);
  else await completeSummary(tx, work, jobsSummaryOutput.parse(result).summaryMarkdown);
  await markWorkDone(tx, work, claim.resultId);
  return true;
}

async function completeSummary(tx: Transaction, work: WorkWithApplication, summary: string) {
  const key = workRevisionKey(work);
  const template = work.kind === "tailor" ? payload(work).resumeMarkdown : (await jobWorkRevision(tx, work))?.resumeMarkdown;
  let document;
  try { document = replaceDocumentSummary(template ?? "", summary); }
  catch { throw new JobsError(400, "The Jobs Summary cannot be applied to the saved résumé."); }
  const revision = work.revision + 1;
  await tx.jobRevision.create({ data: { ...key, revision, author: "agent", summaryMarkdown: document.summary, resumeMarkdown: document.markdown } });
  await updateApplication(tx, work, { revision, status: "review", summary: document.summary, resumeMarkdown: document.markdown, hasResumeMarkdown: true,
    approvedRevision: null, approvedPreviewDigest: null, issueCode: null });
  await recordEvent(tx, work, work.kind === "tailor" ? "tailored" : "revised", { revision });
}

export async function completeJobsWork(tx: Transaction, work: WorkWithApplication, raw: unknown, rates: CurrencyConverter) {
  let resultId: string;
  switch (work.kind) {
    case "enrich": {
      const input = jobsWorkCompleteInput.enrich.parse(raw);
      resultId = input.resultId;
      await completeEnrichment(tx, work, input.result, rates);
      break;
    }
    case "tailor":
    case "revise": {
      const input = jobsWorkCompleteInput[work.kind].parse(raw);
      resultId = input.resultId;
      await completeSummary(tx, work, jobsSummaryOutput.parse(input.result).summaryMarkdown);
      break;
    }
    case "submit": {
      const input = jobsWorkCompleteInput.submit.parse(raw);
      resultId = input.resultId;
      const start = await findJobsSubmissionStart(tx, work);
      if (!start) throw new JobsError(409, "Record submission start before reporting a receipt.");
      const receipt = input.result.receipt;
      const { code, capturedAt, sesMessageId } = receipt;
      if (isSesSubmissionStart(start) !== (sesMessageId !== undefined)) {
        throw new JobsError(409, "The receipt does not match the recorded submission channel.");
      }
      const appliedAt = new Date(capturedAt);
      try {
        await updateApplication(tx, work, {
          status: "applied", receipt, receiptCode: code, appliedAt, issueCode: null, submitLeaseUntil: null,
          ...(sesMessageId && { sesMessageId }),
        });
      } catch (error) {
        if (sesMessageId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new JobsError(409, "This SES receipt is already associated with a Job Application.");
        }
        throw error;
      }
      await recordTrackedApplicationSent(tx, work.applicationId, appliedAt);
      await recordEvent(tx, work, "receipt_recorded", { code, capturedAt });
      break;
    }
    case "render": throw new JobsError(400, "Upload the Jobs PDF to complete render work.");
  }
  await markWorkDone(tx, work, resultId);
}

export async function failJobsWork(tx: Transaction, work: WorkWithApplication, raw: unknown, now: Date) {
  const input = jobsWorkFailInput.parse(raw);
  const rateLimited = input.code === "rate_limited";
  if (rateLimited && (work.kind === "submit" || work.kind === "render")) throw new JobsError(400, "This Jobs work does not use the model.");
  const emailNotSent = "emailNotSent" in input;
  if (emailNotSent && work.kind !== "submit") throw new JobsError(400, "An SES delivery result requires a submit claim.");
  const submitExpired = work.kind === "submit" && work.leaseUntil !== null && work.leaseUntil <= now;
  const start = work.kind === "submit" && (!submitExpired || emailNotSent) && input.code !== "submission_uncertain"
    ? await findJobsSubmissionStart(tx, work) : null;
  const definitiveEmailRefusal = emailNotSent && isSesSubmissionStart(start);
  if (emailNotSent && start !== null && !definitiveEmailRefusal) {
    throw new JobsError(409, "An SES delivery result requires an SES submission start.");
  }
  const uncertain = work.kind === "submit" && !definitiveEmailRefusal &&
    (input.code === "submission_uncertain" || submitExpired || start !== null);
  const failure = uncertain ? "submission_uncertain" : input.code;
  let prepared: Awaited<ReturnType<typeof preparePrivatePause>>;
  if (work.kind === "submit" && !uncertain && input.code === "manual_required" && input.requirements && work.leaseUntil) {
    const revision = await jobWorkRevision(tx, work);
    if (revision?.pdfReference && revision.pdfSha256 && revision.pdfSha256 === work.application.approvedPreviewDigest) {
      const snapshot = { ...work.application, summary: revision.summaryMarkdown, resumeMarkdown: revision.resumeMarkdown };
      prepared = await preparePrivatePause(tx, work.ownerId, snapshot, input.requirements, work.revision,
        revision.pdfSha256, new Date(work.leaseUntil.getTime() - leaseMs));
    }
  }
  const requeue = rateLimited || prepared?.ready;
  await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId: work.ownerId, id: work.id } }, data: {
    state: requeue ? "queued" : "failed", resultId: input.resultId, failureCode: failure,
    ...(requeue && { availableAt: rateLimited ? new Date(now.getTime() + rateLimitDelayMs) : now, leaseTokenHash: null, leaseUntil: null, claimedBy: null }),
  } });
  if (failure !== "rate_limited") await updateApplication(tx, work, {
    status: isUnapprovedPreview(work) ? "review" : prepared?.ready ? "queued" : "needs_attention",
    issueCode: prepared?.ready ? null : failure,
    submitLeaseUntil: null, ...(work.kind === "submit" && { privatePause: prepared && !prepared.ready ? prepared.pause : Prisma.DbNull }),
  });
  await recordEvent(tx, work, "work_failed", { code: failure, ...(prepared && { requirements: prepared.pause.fields }) });
  if (prepared?.ready) await recordEvent(tx, work, "private_details_resumed", {});
}

export async function markJobsPdfReady(tx: Transaction, work: WorkWithApplication, reference: string, sha256: string) {
  const revision = await jobWorkRevision(tx, work);
  if (!revision || (revision.pdfSha256 !== null && revision.pdfSha256 !== sha256)) throw stale();
  const key = workRevisionKey(work);
  await tx.jobRevision.update({ where: { ownerId_applicationId_revision: key }, data: { pdfReference: reference, pdfSha256: sha256 } });
  await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId: work.ownerId, id: work.id } }, data: { state: "done" } });
  if (work.application.status === "approved" && work.application.approvedRevision === work.revision) {
    await updateApplication(tx, work, { status: "queued", approvedPreviewDigest: sha256 });
    await tx.jobWorkItem.upsert({ where: { ownerId_applicationId_kind_revision: { ...key, kind: "submit" } }, create: { ...key, kind: "submit" }, update: {} });
  }
  await recordEvent(tx, work, "rendered", { sha256 });
}

export async function recordJobsSubmissionEvent(tx: Transaction, work: WorkWithApplication, event: {
  eventId: string; step: string; state: string; durationMs?: number; code?: string; channel?: "ses";
}) {
  const { eventId, ...metadata } = event;
  const started = metadata.step === "submit_started" && metadata.state !== "failed";
  if (started && await findJobsSubmissionStart(tx, work)) throw new JobsError(409, "Submission has already started for this attempt.");
  await recordEvent(tx, work, started ? "submit_started" : "submission_step", metadata, eventId);
  if (started && work.payload && typeof work.payload === "object" && "ownerAttestation" in work.payload) {
    const pilotReview = pilotReviewOf(work.payload);
    await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId: work.ownerId, id: work.id } }, data: { payload: pilotReview ? { pilotReview } : {} } });
  }
}
