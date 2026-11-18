import { Prisma, type JobApplication } from "@quantself/db/generated/prisma/client";
import { parseResumeDocument, replaceDocumentSummary, resumeHeader } from "../../../scripts/jobs/resume-document";
import { JobsError } from "./jobs-error";
import { pilotReviewOf } from "./jobs-pilot-review";
import type { JobsOwnerDecision } from "./jobs-owner-contract";
import { fillLegacyResume, readJobsResumeTemplate } from "./jobs-resume-template";
import type { JobsPostingDetails, JobsReviewEdit, JobsSaveBrief } from "./jobs-review-contract";
import { toJobReviewDetail, toJobReviewRow } from "./jobs-review-read";
import { jobsBrief } from "./jobs-work-contract";

type Transaction = Prisma.TransactionClient;

export async function saveMissingJobBrief(tx: Transaction, ownerId: string, id: string, input: JobsSaveBrief) {
  const result = await tx.jobApplication.updateMany({
    where: { ownerId, id, revision: input.expectedRevision, status: "review", brief: { equals: Prisma.AnyNull } },
    data: { brief: input.brief },
  });
  if (result.count === 1) return { id };
  const application = await tx.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id } }, select: { id: true } });
  if (!application) throw new JobsError(404, "Application not found.");
  throw new JobsError(409, "The draft changed or already has a brief. Refresh before continuing.");
}

async function currentRevision(tx: Transaction, ownerId: string, id: string, expectedRevision: number) {
  const application = await tx.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id } } });
  if (!application) throw new JobsError(404, "Application not found.");
  if (application.revision !== expectedRevision) throw new JobsError(409, "The application revision changed. Refresh before continuing.");
  if (application.issueCode === "submission_uncertain") {
    throw new JobsError(409, "Resolve existing work before changing this application.");
  }
  return application;
}

function revisionKey(row: JobApplication) {
  return { ownerId: row.ownerId, applicationId: row.id, revision: row.revision };
}

export async function saveJobPostingDetails(tx: Transaction, ownerId: string, id: string, input: JobsPostingDetails) {
  const result = await tx.jobApplication.updateMany({
    where: { ownerId, id, revision: input.expectedRevision, description: input.previousText,
      status: { in: ["review", "needs_attention", "saved_for_later"] } },
    data: { description: input.postingText },
  });
  if (result.count !== 1) throw new JobsError(409, "The draft or saved posting changed. Refresh before continuing.");
  return { id };
}

async function hasFailedUnapprovedPreview(tx: Transaction, row: JobApplication) {
  if (row.status !== "needs_attention" || row.issueCode !== "runner_unavailable" || row.approvedRevision !== null) return false;
  return Boolean(await tx.jobWorkItem.findFirst({
    where: { ...revisionKey(row), kind: "render", state: "failed" },
    select: { id: true },
  }));
}

async function snapshot(tx: Transaction, row: JobApplication) {
  const key = revisionKey(row);
  const saved = await tx.jobRevision.findUnique({ where: { ownerId_applicationId_revision: key } });
  if (!saved) throw new JobsError(409, "The saved résumé revision is unavailable.");
  return saved;
}

async function change(tx: Transaction, row: JobApplication, data: Prisma.JobApplicationUpdateManyMutationInput) {
  const [saved] = await tx.jobApplication.updateManyAndReturn({
    where: { ownerId: row.ownerId, id: row.id, revision: row.revision, status: row.status },
    data: { lastOwnerEditedAt: new Date(), ...data },
  });
  if (!saved) throw new JobsError(409, "The application changed. Refresh before continuing.");
  return saved;
}

export async function editJobReviewRevision(tx: Transaction, ownerId: string, id: string, input: JobsReviewEdit) {
  const row = await currentRevision(tx, ownerId, id, input.expectedRevision);
  if (row.status !== "review" && row.status !== "approved" && row.status !== "queued" &&
    !await hasFailedUnapprovedPreview(tx, row)) {
    throw new JobsError(409, "This application is outside résumé review.");
  }
  const previous = await snapshot(tx, row);
  const legacy = input.resumeMarkdown === undefined && previous.resumeMarkdown === null && input.summaryMarkdown !== undefined
    ? await fillLegacyResume(row.resumeTrack, input.summaryMarkdown)
    : null;
  let summary: string;
  let resumeMarkdown: string | null;
  try {
    const parsed = input.resumeMarkdown !== undefined
      ? parseResumeDocument(input.resumeMarkdown)
      : legacy ? parseResumeDocument(legacy)
      : replaceDocumentSummary(previous.resumeMarkdown ?? `${resumeHeader}## Summary\n- Summary\n`, input.summaryMarkdown!);
    if (input.summaryMarkdown !== undefined && parsed.summary !== input.summaryMarkdown) throw new Error("inconsistent_resume_summary");
    summary = parsed.summary;
    resumeMarkdown = input.resumeMarkdown !== undefined || previous.resumeMarkdown !== null || legacy !== null ? parsed.markdown : null;
  } catch {
    throw new JobsError(400, "Use the résumé template placeholders and a valid Summary section. Keep contact details outside the editor.");
  }
  const saved = await change(tx, row, {
    revision: { increment: 1 }, summary, resumeMarkdown, hasResumeMarkdown: resumeMarkdown !== null, status: "review",
    approvedRevision: null, approvedPreviewDigest: null, privatePause: Prisma.DbNull, issueCode: null,
  });
  const key = revisionKey(saved);
  await tx.jobRevision.create({ data: { ...key, summaryMarkdown: summary, resumeMarkdown, author: "owner" } });
  await tx.jobWorkItem.updateMany({
    where: { ...revisionKey(row), OR: [{ kind: "render", state: { in: ["queued", "claimed"] } }, { kind: "submit", state: "queued" }] },
    data: { state: "failed", failureCode: "stale_revision", leaseTokenHash: null, leaseUntil: null },
  });
  await tx.jobEvent.create({ data: { ...key, kind: "revision_edited", payload: { previousRevision: row.revision, clearedApproval: row.approvedRevision !== null } } });
  return { application: toJobReviewDetail(saved) };
}

export async function approveJobReviewRevision(tx: Transaction, ownerId: string, id: string, expectedRevision: number) {
  const row = await currentRevision(tx, ownerId, id, expectedRevision);
  if (row.status !== "review" && !await hasFailedUnapprovedPreview(tx, row)) {
    throw new JobsError(409, "This application is outside résumé review.");
  }
  const revision = await snapshot(tx, row);
  if (revision.summaryMarkdown !== row.summary || revision.resumeMarkdown !== row.resumeMarkdown) {
    throw new JobsError(409, "The saved résumé revision no longer matches this application.");
  }
  if (!revision.summaryMarkdown.trim()) throw new JobsError(409, "Save a résumé Summary before approving.");
  const document = revision.resumeMarkdown || await fillLegacyResume(row.resumeTrack, revision.summaryMarkdown);
  if (!document) throw new JobsError(409, "Save a full résumé before approving it for rendering.");
  const ready = revision.pdfReference !== null && revision.pdfSha256 !== null;
  const saved = await change(tx, row, {
    status: ready ? "queued" : "approved", approvedRevision: row.revision, approvedPreviewDigest: revision.pdfSha256, issueCode: null,
    ...(!revision.resumeMarkdown && { resumeMarkdown: document, hasResumeMarkdown: true }),
  });
  const key = revisionKey(saved);
  if (!revision.resumeMarkdown) {
    await tx.jobRevision.update({ where: { ownerId_applicationId_revision: key }, data: { resumeMarkdown: document } });
  }
  const kind = ready ? "submit" : "render";
  const work = await tx.jobWorkItem.upsert({
    where: { ownerId_applicationId_kind_revision: { ...key, kind } },
    create: { ...key, kind }, update: {}, select: { id: true, payload: true },
  });
  if (row.pilotHeldAt && pilotReviewOf(work.payload)) {
    const { pilotReview: _pilotReview, ...payload } = work.payload as Prisma.JsonObject;
    await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId, id: work.id } }, data: { payload } });
  }
  await tx.jobWorkItem.updateMany({
    where: { ...key, kind, state: "failed", failureCode: {
      in: kind === "render" ? ["superseded", "runner_unavailable", "invalid_input"] : ["superseded"],
    } },
    data: { state: "queued", failureCode: null, availableAt: new Date() },
  });
  await tx.jobEvent.create({ data: { ...key, kind: "approved", payload: { pdfSha256: revision.pdfSha256 } } });
  return { application: toJobReviewRow(saved) };
}

const decisionStatuses = { skip: "skipped", later: "saved_for_later", reject: "rejected" } as const;

export async function decideJobReview(tx: Transaction, ownerId: string, id: string, input: JobsOwnerDecision) {
  if (input.action === "approve") return approveJobReviewRevision(tx, ownerId, id, input.expectedRevision);
  const row = await currentRevision(tx, ownerId, id, input.expectedRevision);
  const key = revisionKey(row);
  const { action } = input;
  const editable = row.status === "review" || (row.status === "needs_attention" && row.issueCode === "model_error");
  const canUndo = ["skipped", "saved_for_later", "rejected", "approved", "queued", "draft"].includes(row.status);
  let status: JobApplication["status"];
  let work: { kind: "enrich" | "tailor" | "revise"; payload: Prisma.InputJsonObject } | undefined;
  switch (action) {
    case "skip":
    case "later":
    case "reject":
      if (!editable && !await hasFailedUnapprovedPreview(tx, row)) {
        throw new JobsError(409, "This application is outside résumé review.");
      }
      status = decisionStatuses[action];
      break;
    case "reopen":
      if (!canUndo) throw new JobsError(409, "This application cannot be reopened from its current status.");
      if (row.status === "draft" && !row.summary) throw new JobsError(409, "Review starts after the first draft is ready.");
      status = row.summary ? "review" : "needs_attention";
      break;
    case "revise": {
      if (row.status !== "review") throw new JobsError(409, "Review the saved résumé before asking for a revision.");
      const saved = await snapshot(tx, row);
      if (!saved.resumeMarkdown) throw new JobsError(409, "Save a full résumé before asking for a revision.");
      const payload = { instructions: input.instructions };
      work = jobsBrief.safeParse(row.brief).success
        ? { kind: "revise", payload }
        : { kind: "enrich", payload: { ...payload, next: "revise", resumeMarkdown: saved.resumeMarkdown } };
      status = "draft";
      break;
    }
    case "retry_draft": {
      if (row.status !== "needs_attention" || row.issueCode !== "model_error") throw new JobsError(409, "This application has no failed draft to retry.");
      const failed = await tx.jobWorkItem.findFirst({
        where: { ...key, kind: { in: ["enrich", "tailor", "revise"] }, state: "failed" },
        orderBy: { updatedAt: "desc" }, select: { kind: true, payload: true },
      });
      work = failed ? {
        kind: failed.kind as "enrich" | "tailor" | "revise",
        payload: failed.payload as Prisma.InputJsonObject,
      } : { kind: "enrich", payload: { resumeMarkdown: await readJobsResumeTemplate(row.resumeTrack, row.resumeMarkdown ?? undefined) } };
      status = "draft";
      break;
    }
  }

  const saved = await change(tx, row, {
    status, issueCode: status === "needs_attention" ? "model_error" : null,
    approvedRevision: null, approvedPreviewDigest: null, privatePause: Prisma.DbNull,
  });
  await tx.jobWorkItem.updateMany({
    where: { ...key, state: { in: ["queued", "claimed"] } },
    data: { state: "failed", failureCode: "superseded", leaseTokenHash: null, leaseUntil: null },
  });
  if (work) {
    const { kind, payload } = work;
    await tx.jobWorkItem.upsert({
      where: { ownerId_applicationId_kind_revision: { ...key, kind } }, create: { ...key, kind, payload },
      update: { state: "queued", payload, availableAt: new Date(), failureCode: null, leaseTokenHash: null, leaseUntil: null, claimedBy: null },
    });
  }
  const eventKind = { ...decisionStatuses, reopen: "reopened", revise: "revision_requested", retry_draft: "draft_retried" }[action];
  await tx.jobEvent.create({ data: { ...key, kind: eventKind, payload: {
    previousStatus: row.status, ...(action === "reject" && { reasons: input.reasons }),
  } } });
  return { application: toJobReviewRow(saved) };
}
