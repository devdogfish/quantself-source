import { z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { AgentWriteAudit, JobApplication, Prisma } from "@quantself/db/generated/prisma/client";
import { parseResumeDocument, resumeHeader } from "../../../scripts/jobs/resume-document";
import { readJob } from "./jobs-application";
import { resumeTrack } from "./jobs-contract";
import { JobsError } from "./jobs-error";
import { isLifecycleAudit, undoJobLifecycleChange } from "./jobs-lifecycle";
import type { JobsReviewEdit } from "./jobs-review-contract";
import { toJobReviewDetail } from "./jobs-review-read";

const handOffMs = 180_000;
const maxUndoableRevision = 2_147_483_644;
const auditState = z.object({
  summary: z.string(), resumeTrack, reviewLane: z.enum(["quick", "tailored"]),
  status: z.enum(["draft", "review"]), updatedAt: z.iso.datetime(),
});
const snapshot = (row: JobApplication) => auditState.parse({ ...row, updatedAt: row.updatedAt.toISOString() });

export async function editJobSummaryAsClient(
  tx: Prisma.TransactionClient, ownerId: string, id: string, input: JobsReviewEdit, client: AccessContext["client"],
) {
  const row = await readJob(tx, ownerId, id);
  if (input.expectedRevision !== row.revision) throw new JobsError(409, "The application revision changed.");
  if (input.resumeMarkdown !== undefined || row.resumeMarkdown !== null || !input.summaryMarkdown) {
    throw new JobsError(403, "An Owner session is required to edit a saved résumé.");
  }
  if (client.kind === "agent" && row.lastOwnerEditedAt && Date.now() - row.lastOwnerEditedAt.getTime() < handOffMs) {
    throw new JobsError(409, "The Owner edited this application within the last 3 minutes. Try again later.");
  }
  const job = { ownerId, applicationId: id, revision: row.revision };
  const pending = await tx.jobWorkItem.findFirst({
    where: { ...job, state: { in: ["queued", "claimed"] } }, select: { id: true },
  });
  if ((row.status !== "draft" && row.status !== "review") || row.approvedRevision !== null ||
      row.issueCode !== null || pending || row.revision > maxUndoableRevision) {
    throw new JobsError(409, "This draft has approval, pending work, or an issue.");
  }
  let summary: string;
  try { summary = parseResumeDocument(`${resumeHeader}## Summary\n\n${input.summaryMarkdown}`).summary; }
  catch { throw new JobsError(400, "Use a valid Summary without personal contact details."); }
  const [saved] = await tx.jobApplication.updateManyAndReturn({
    where: { ownerId, id, revision: row.revision, updatedAt: row.updatedAt, status: row.status },
    data: { summary, status: "review", revision: { increment: 1 } },
  });
  if (!saved) throw new JobsError(409, "The application changed.");
  const key = { ...job, revision: saved.revision };
  await tx.jobRevision.create({ data: { ...key, summaryMarkdown: saved.summary, author: "agent" } });
  await tx.jobEvent.create({ data: { ...key, kind: "revision_edited", payload: { previousRevision: row.revision } } });
  if (client.kind !== "agent") return { application: toJobReviewDetail(saved) };
  const audit = await tx.agentWriteAudit.create({
    data: {
      ownerId, clientId: client.id, clientName: client.name, resourceType: "jobApplication", resourceId: id,
      revisionBefore: row.revision, revisionAfter: saved.revision, before: snapshot(row), after: snapshot(saved),
    },
    select: { id: true },
  });
  return { application: toJobReviewDetail(saved), auditId: audit.id };
}

export async function undoJobAgentWrite(tx: Prisma.TransactionClient, audit: AgentWriteAudit) {
  if (isLifecycleAudit(audit.after)) return undoJobLifecycleChange(tx, audit);
  const before = auditState.parse(audit.before);
  const after = auditState.parse(audit.after);
  const [saved] = await tx.jobApplication.updateManyAndReturn({
    where: {
      ownerId: audit.ownerId, id: audit.resourceId, revision: audit.revisionAfter, approvedRevision: null,
      summary: after.summary, resumeTrack: after.resumeTrack, reviewLane: after.reviewLane,
      status: after.status, updatedAt: new Date(after.updatedAt),
    },
    data: {
      summary: before.summary, resumeTrack: before.resumeTrack, reviewLane: before.reviewLane,
      status: before.status, revision: { increment: 1 }, lastOwnerEditedAt: new Date(),
    },
  });
  if (!saved) throw new JobsError(409, "This application changed after the Agent edit. Undo is no longer available.");
  const key = { ownerId: saved.ownerId, applicationId: saved.id, revision: saved.revision };
  await tx.jobRevision.create({ data: { ...key, summaryMarkdown: saved.summary, author: "owner" } });
  await tx.jobEvent.create({ data: { ...key, kind: "revision_edited", payload: { undoneAuditId: audit.id } } });
}
