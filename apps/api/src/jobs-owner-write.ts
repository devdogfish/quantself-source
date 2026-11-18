import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { fingerprintIdempotentRequest, runIdempotentCommand } from "./idempotency";
import { JobsError } from "./jobs-error";
import { jobsImportApplicationsInput, type JobsAddApplicationInput, type JobsImportApplication, type JobsResolution } from "./jobs-owner-contract";
import { authorizeJobsPilotIntake, bindJobsPilotDraft } from "./jobs-pilot-permit";
import { pilotReviewOf } from "./jobs-pilot-review";
import { JobsProviderImportRace, planProviderImports, type PendingJobImport } from "./jobs-provider-import";
import { readJobsPrivateSourceRules, type JobsPrivateSourceRule } from "./jobs-private-source-rules";
import { readJobsResumeTemplate } from "./jobs-resume-template";
import { toJobReviewRow } from "./jobs-review-read";
import { canonicalJobUrl, isExpiredSubmission, readJob } from "./jobs-application";
import { jobsOwnerAttestation } from "./jobs-work-contract";
import { findJobsSubmissionStart, hasSesSubmissionPreflight, isSesSubmissionStart, pendingOwnerAttestation } from "./jobs-work-service";
import { recordTrackedApplicationSent } from "./tracked-links-store";

async function planUrlImports(tx: Prisma.TransactionClient, ownerId: string, inputs: JobsImportApplication[], privateRules: readonly JobsPrivateSourceRule[]) {
  const pending = new Map<string, PendingJobImport>();
  for (const input of inputs) {
    const source = canonicalJobUrl(input.sourceUrl, privateRules);
    if (!pending.has(source.sourceKey)) pending.set(source.sourceKey, { input, source });
  }
  const existing = await tx.jobApplication.findMany({
    where: { ownerId, sourceKey: { in: [...pending.keys()] } }, select: { sourceKey: true },
  });
  for (const { sourceKey } of existing) pending.delete(sourceKey);
  return [...pending.values()];
}

async function createJobsApplications(
  tx: Prisma.TransactionClient, ownerId: string, inputs: JobsImportApplication[], ownerEdited: boolean,
  privateRules: readonly JobsPrivateSourceRule[], pilotHeldAt?: Date,
) {
  const identified = inputs.some(input => input.sourceIdentity);
  const { pending, links } = identified
    ? await planProviderImports(tx, ownerId, inputs, privateRules)
    : { pending: await planUrlImports(tx, ownerId, inputs, privateRules), links: [] };
  if (pilotHeldAt && !pending.length) throw new JobsError(409, "The approved posting already has a Jobs application.");

  const defaults = new Map<JobsAddApplicationInput["track"], Promise<string>>();
  const templates = await Promise.all(pending.filter(({ input }) => !input.recordedStatus).map(async ({ input, source: { sourceKey } }) => {
    if (input.resumeMarkdown !== undefined) return [sourceKey, await readJobsResumeTemplate(input.track, input.resumeMarkdown)] as const;
    let template = defaults.get(input.track);
    if (!template) {
      template = readJobsResumeTemplate(input.track);
      defaults.set(input.track, template);
    }
    return [sourceKey, await template] as const;
  }));
  const markup = new Map(templates);
  const data: Prisma.JobApplicationCreateManyInput[] = pending.map(({ source, input, id }) => ({
    ownerId, id, ...source, company: input.company, role: input.role, resumeTrack: input.track,
    sourceLabel: input.source ?? null, location: input.location, salary: input.salary,
    description: input.postingText, dueAt: input.dueAt ? new Date(input.dueAt) : null,
    status: input.recordedStatus ?? "draft", revision: 0, ...(ownerEdited && { lastOwnerEditedAt: new Date() }),
    ...(pilotHeldAt && { pilotHeldAt }),
  }));
  const created = data.length ? await tx.jobApplication.createManyAndReturn({ data, skipDuplicates: true }) : [];
  if (identified && created.length !== data.length) throw new JobsProviderImportRace();
  if (links.length) {
    const { count } = await tx.jobProviderPosting.createMany({ data: links, skipDuplicates: true });
    if (count !== links.length) throw new JobsProviderImportRace();
  }
  const drafts = created.filter(job => job.status === "draft");
  if (drafts.length) {
    await tx.jobWorkItem.createMany({ data: drafts.map(job => ({
      ownerId, applicationId: job.id, revision: job.revision, kind: "enrich", payload: { resumeMarkdown: markup.get(job.sourceKey)! },
    })) });
  }
  if (created.length) await tx.jobEvent.createMany({ data: created.map(job => ({
    ownerId, applicationId: job.id, revision: job.revision, kind: "imported", payload: { status: job.status },
  })) });
  return created;
}

export async function addJobApplication(tx: Prisma.TransactionClient, ownerId: string, input: JobsAddApplicationInput, ownerEdited = true) {
  const privateRules = readJobsPrivateSourceRules();
  const [created] = await createJobsApplications(tx, ownerId, [input], ownerEdited, privateRules);
  if (!created) {
    const { sourceKey } = canonicalJobUrl(input.sourceUrl, privateRules);
    const where = { ownerId_sourceKey: { ownerId, sourceKey } };
    const existing = await tx.jobApplication.findUnique({ where });
    if (!existing) throw new JobsError(409, "The listing changed. Retry adding it.");
    return { application: toJobReviewRow(existing), duplicate: true };
  }
  return { application: toJobReviewRow(created), duplicate: false };
}

export async function importJobsApplications(
  tx: Prisma.TransactionClient, ownerId: string, inputs: JobsImportApplication[], ownerEdited: boolean,
) {
  const created = await createJobsApplications(tx, ownerId, inputs, ownerEdited, readJobsPrivateSourceRules());
  return { imported: created.length, duplicates: inputs.length - created.length };
}

type PilotIntakeApproval = { id: string; ownerId: string; sourceIdentity: string };

export function parseHeldJobsPosting(posting: unknown, approvedIdentity?: string) {
  const parsed = jobsImportApplicationsInput.shape.applications.element.safeParse(posting);
  if (!parsed.success || parsed.data.recordedStatus || parsed.data.resumeMarkdown !== undefined) {
    throw new JobsError(400, "The pilot intake accepts one draft using its configured résumé template.");
  }
  const input = parsed.data;
  if (approvedIdentity !== undefined && input.sourceIdentity !== approvedIdentity) {
    throw new JobsError(403, "The pilot approval does not cover this posting.");
  }
  if (!input.sourceIdentity) throw new JobsError(400, "The pilot intake requires a Greenhouse identity.");
  const url = new URL(canonicalJobUrl(input.sourceUrl).sourceUrl);
  if (url.protocol !== "https:" || !/^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(url.host)) {
    throw new JobsError(400, "The pilot intake requires a hosted Greenhouse posting.");
  }
  return { ...input, sourceIdentity: input.sourceIdentity };
}

async function createHeldJobsDraft(tx: Prisma.TransactionClient, ownerId: string, input: JobsImportApplication, now: Date) {
  const [draft] = await createJobsApplications(tx, ownerId, [input], false, readJobsPrivateSourceRules(), now);
  if (!draft) throw new JobsProviderImportRace();
  return { applicationId: draft.id, revision: draft.revision };
}

export async function importScreenedJobsPilotDraft(
  tx: Prisma.TransactionClient, ownerId: string, permitId: string, posting: unknown, now = () => new Date(),
) {
  const input = parseHeldJobsPosting(posting);
  const target = { ownerId, permitId, sourceIdentity: input.sourceIdentity };
  await authorizeJobsPilotIntake(tx, target, fingerprintIdempotentRequest({ posting: input }), now);
  const draft = await createHeldJobsDraft(tx, ownerId, input, now());
  await bindJobsPilotDraft(tx, { ...target, ...draft }, now);
  return draft;
}

// Internal offline seam. The fixture supplies the pre-authorized posting and owner.
export async function intakeHeldJobsDraft(
  db: PrismaClient, approval: PilotIntakeApproval, ownerId: string, posting: unknown, now = new Date(),
) {
  if (ownerId !== approval.ownerId || !approval.id) throw new JobsError(403, "The pilot approval does not cover this owner.");
  const input = parseHeldJobsPosting(posting, approval.sourceIdentity);

  const result = await runIdempotentCommand({
    clientId: `jobs-pilot:${ownerId}`, operation: "intakeHeldJobsDraft", idempotencyKey: approval.id, request: { input },
    async execute(tx) {
      const draft = await createHeldJobsDraft(tx, ownerId, input, now);
      return { kind: "success", status: 200, body: { ownerId, ...draft } };
    },
  }, db);
  if (result.kind === "conflict") throw new JobsError(409, result.message);
  return result.body;
}

export async function setJobsRunnerPaused(tx: Prisma.TransactionClient, ownerId: string, paused: boolean, now = new Date()) {
  const { host, lastHeartbeatAt } = await tx.jobRunner.upsert({
    where: { ownerId }, create: { ownerId, paused }, update: { paused },
    select: { host: true, lastHeartbeatAt: true },
  });
  const identity = { host, lastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null };
  if (paused) return { runner: { ...identity, state: "paused" as const } };
  if (!lastHeartbeatAt || now.getTime() - lastHeartbeatAt.getTime() >= 120_000) {
    return { runner: { ...identity, state: "offline" as const } };
  }
  const current = await tx.jobApplication.findFirst({
    where: { ownerId, status: "submitting", submitLeaseUntil: { gt: now } }, select: { id: true },
  });
  return { runner: { ...identity, state: current ? "submitting" as const : "idle" as const } };
}

export async function resolveJobSubmission(tx: Prisma.TransactionClient, ownerId: string, id: string, input: JobsResolution, now = new Date()) {
  const row = await readJob(tx, ownerId, id);
  const expired = isExpiredSubmission(row, now);
  if (row.status !== "needs_attention" && !expired) {
    throw new JobsError(409, "This submission has no issue to resolve.");
  }
  if (row.issueCode === "model_error") throw new JobsError(409, "Retry the draft from Jobs Review.");
  const uncertain = row.issueCode === "submission_uncertain" || expired;
  const { action } = input;
  if (uncertain && action !== "mark_applied" && action !== "mark_not_sent") {
    throw new JobsError(409, "Confirm whether the employer received this application.");
  }
  if (!uncertain && action === "mark_not_sent") throw new JobsError(409, "The delivery of this application is already known.");
  if (action === "requeue" && row.privatePause) throw new JobsError(409, "Save the requested private answers to resume this application.");
  const expectedUpdatedAt = "expectedUpdatedAt" in input ? input.expectedUpdatedAt : undefined;
  if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== row.updatedAt.getTime()) {
    throw new JobsError(409, "The submission changed. Refresh before resolving it.");
  }

  const key = { ownerId, applicationId: id, revision: row.revision };
  const priorSubmit = uncertain || (action === "requeue" && row.approvedPreviewDigest) ? await tx.jobWorkItem.findUnique({
    where: { ownerId_applicationId_kind_revision: { ...key, kind: "submit" } },
    select: { id: true, attempts: true, state: true, failureCode: true, leaseUntil: true, leaseTokenHash: true, resultId: true, payload: true },
  }) : null;
  const priorFailed = priorSubmit?.state === "failed" && priorSubmit.failureCode === "submission_uncertain";
  const priorExpired = expired && priorSubmit?.state === "claimed" && priorSubmit.leaseUntil !== null && priorSubmit.leaseUntil <= now;
  const priorAttempt = priorSubmit && priorSubmit.attempts > 0 && (priorFailed || priorExpired)
    ? { ...key, id: priorSubmit.id, attempts: priorSubmit.attempts } : null;
  const priorStart = priorAttempt ? await findJobsSubmissionStart(tx, priorAttempt) : null;
  const sesStarted = isSesSubmissionStart(priorStart);
  const sesAttempt = priorStart ? sesStarted : priorAttempt && await hasSesSubmissionPreflight(tx, priorAttempt);
  if (sesAttempt && !expectedUpdatedAt) throw new JobsError(409, "Refresh the submission before confirming delivery.");
  if (sesStarted && action === "mark_not_sent" && priorExpired && now.getTime() - priorSubmit.leaseUntil!.getTime() < 30_000) {
    throw new JobsError(409, "Wait 30 seconds after the submit claim expires before confirming it was not sent.");
  }
  let status: "applied" | "skipped" | "queued" | "approved" | "review";
  let confirmation: string | undefined;
  let requeue: "render" | "submit" | undefined;
  switch (action) {
    case "mark_applied":
      confirmation = input.confirmation;
      status = "applied";
      break;
    case "skip":
      status = "skipped";
      break;
    default: {
      const saved = await tx.jobRevision.findUnique({ where: { ownerId_applicationId_revision: key } });
      if (saved?.pdfReference && saved.pdfSha256 && row.approvedRevision === row.revision && saved.pdfSha256 === row.approvedPreviewDigest) {
        status = "queued";
        requeue = "submit";
      } else if (action === "requeue" && !row.approvedPreviewDigest && saved?.resumeMarkdown && row.approvedRevision === row.revision && row.issueCode === "runner_unavailable") {
        status = "approved";
        requeue = "render";
      } else if (action === "mark_not_sent" && await tx.jobEvent.findUnique({
        where: { ownerId_applicationId_eventKey: { ownerId, applicationId: id, eventKey: "legacy-cutover" } },
        select: { id: true },
      })) {
        // Historical approvals may predate stored PDFs. The Owner can review and approve a new PDF.
        status = "review";
      } else {
        throw new JobsError(409, "The approved résumé PDF is unavailable.");
      }
    }
  }
  const change = await tx.jobApplication.updateMany({
    where: { ownerId, id, revision: row.revision, updatedAt: row.updatedAt, status: row.status },
    data: {
      status, issueCode: null, privatePause: Prisma.DbNull,
      submitLeaseUntil: null, lastOwnerEditedAt: now,
      ...(status === "applied" && {
        appliedAt: now, receiptCode: confirmation ? "confirmation_message" : null,
        receipt: { source: "owner", capturedAt: now.toISOString(), ...(confirmation && { confirmation }) },
      }),
      ...((status === "skipped" || status === "review") && { approvedRevision: null, approvedPreviewDigest: null }),
    },
  });
  if (!change.count) throw new JobsError(409, "The submission changed. Refresh before resolving it.");
  if (status === "applied") await recordTrackedApplicationSent(tx, id, now);
  const resetLease = { claimedBy: null, leaseTokenHash: null, leaseUntil: null };
  const pendingAttestation = requeue === "submit" && priorSubmit && !priorStart
    ? pendingOwnerAttestation(priorSubmit, row.revision, row.approvedPreviewDigest) : undefined;
  const retainedAttempt = pendingAttestation && { ...key, id: pendingAttestation.previousWorkId, attempts: pendingAttestation.previousAttempt };
  const retainedStart = retainedAttempt ? await findJobsSubmissionStart(tx, retainedAttempt) : null;
  const retainedAttestation = retainedAttempt && (retainedStart ? isSesSubmissionStart(retainedStart) : await hasSesSubmissionPreflight(tx, retainedAttempt))
    ? pendingAttestation : undefined;
  const ownerAttestation = retainedAttestation ?? (action === "mark_not_sent" && requeue === "submit" && priorSubmit && sesAttempt
    ? jobsOwnerAttestation.safeParse({
      previousWorkId: priorSubmit.id, previousAttempt: priorSubmit.attempts, previousLeaseTokenHash: priorSubmit.leaseTokenHash,
      ...(priorFailed && priorSubmit.resultId && { previousResultId: priorSubmit.resultId }),
      approvedRevision: row.revision, sha256: row.approvedPreviewDigest, resolvedAt: now.toISOString(),
    }).data : undefined);
  if (requeue) {
    const pilotReview = pilotReviewOf(priorSubmit?.payload);
    await tx.jobWorkItem.upsert({
      where: { ownerId_applicationId_kind_revision: { ...key, kind: requeue } }, create: { ...key, kind: requeue },
      update: {
        state: "queued", availableAt: now, failureCode: null, ...resetLease,
        ...(requeue === "submit" && { payload: { ...(ownerAttestation && { ownerAttestation }), ...(pilotReview && { pilotReview }) } }),
      },
    });
  } else {
    await tx.jobWorkItem.updateMany({
      where: { ...key, state: { in: ["queued", "claimed"] }, kind: { in: ["render", "submit"] } },
      data: { ...resetLease, state: "failed", failureCode: "resolved" },
    });
  }
  await tx.jobEvent.create({ data: {
    ...key, kind: "submission_resolved", payload: { action, status, ...(action === "mark_not_sent" && ownerAttestation && { ownerAttestation }) },
  } });
}
