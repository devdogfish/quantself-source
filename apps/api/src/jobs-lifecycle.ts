import type { AccessContext } from "@quantself/auth";
import { Prisma, type AgentWriteAudit, type JobApplicationStatus, type JobInterview, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { z } from "@hono/zod-openapi";
import { readJob } from "./jobs-application";
import { JobsError } from "./jobs-error";
import { jobSourceReply, nextJobStatus, type JobLifecycleChange, type JobSourceReply } from "./jobs-lifecycle-contract";
import { jobReviewRowSelect, toJobReviewRow } from "./jobs-review-read";
import { jobInterviewResult } from "./jobs-interview";

const handOffMs = 180_000;
const transitionTable = {
  applied: ["interviewing", "offer", "rejected", "withdrawn"],
  interviewing: ["offer", "rejected", "withdrawn"],
  offer: ["rejected", "withdrawn"],
} satisfies Partial<Record<JobApplicationStatus, z.output<typeof nextJobStatus>[]>>;

function transitions(status: JobApplicationStatus): z.output<typeof nextJobStatus>[] {
  if (status === "applied" || status === "interviewing" || status === "offer") return transitionTable[status];
  return [];
}

const lifecycleAuditState = z.object({
  kind: z.literal("post-application-status"),
  status: z.enum(["applied", "interviewing", "offer", "rejected", "withdrawn"]),
  changedAt: z.iso.datetime().nullable(),
  sourceReply: jobSourceReply.nullable(),
});
export const isLifecycleAudit = (data: unknown) => lifecycleAuditState.safeParse(data).success;
type LifecycleFields = { status: JobApplicationStatus; lifecycleChangedAt: Date | null; sourceReply: Prisma.JsonValue | null };

function sourceReplyOf(value: unknown) {
  return jobSourceReply.safeParse(value).data ?? null;
}

function auditSnapshot(row: LifecycleFields) {
  return lifecycleAuditState.parse({
    kind: "post-application-status", status: row.status, changedAt: row.lifecycleChangedAt?.toISOString() ?? null,
    sourceReply: sourceReplyOf(row.sourceReply),
  });
}

export function roundcubeReplyUrl(reply: JobSourceReply | null, base = process.env.QUANTSELF_JOBS_ROUNDCUBE_URL) {
  if (!base || !reply) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    url.search = new URLSearchParams({ _task: "mail", _action: "show", _mbox: reply.folder, _uid: String(reply.uid) }).toString();
    return url.href;
  } catch { return null; }
}

export async function readJobLifecycle(db: Pick<PrismaClient, "jobApplication">, ownerId: string, id: string, showReplyUrl: boolean) {
  const row = await db.jobApplication.findUnique({
    where: { ownerId_id: { ownerId, id } },
    select: {
      ...jobReviewRowSelect, lifecycleRevision: true, lifecycleChangedAt: true, sourceReply: true,
      interviews: {
        where: { OR: [
          { source: "github", todoNumber: { not: null } },
          { source: "native", appointment: { is: { cancelledAt: null } } },
        ] },
        include: { appointment: true },
      },
    },
  });
  if (!row) throw new JobsError(404, "Application not found.");
  const reply = sourceReplyOf(row.sourceReply);
  return {
    application: toJobReviewRow(row), revision: row.lifecycleRevision, changedAt: row.lifecycleChangedAt?.toISOString() ?? null,
    transitions: transitions(row.status), sourceReplyLinked: Boolean(reply), sourceReplyUrl: showReplyUrl ? roundcubeReplyUrl(reply) : null,
    appointments: row.interviews.map(jobInterviewResult).sort((a, b) => a.start.localeCompare(b.start)),
  };
}

export async function changeJobLifecycle(
  tx: Prisma.TransactionClient, ownerId: string, id: string, input: JobLifecycleChange, client: AccessContext["client"], now = new Date(),
) {
  const row = await readJob(tx, ownerId, id);
  if (row.lifecycleRevision !== input.expectedRevision) throw new JobsError(409, "The lifecycle revision changed. Refresh the application.");
  if (!transitions(row.status).includes(input.status)) throw new JobsError(409, "Choose a status available from the current stage.");
  if (client.kind === "agent" && row.lastOwnerEditedAt && now.getTime() - row.lastOwnerEditedAt.getTime() < handOffMs) {
    throw new JobsError(409, "The Owner edited this application within the last 3 minutes. Try again later.");
  }
  const [saved] = await tx.jobApplication.updateManyAndReturn({
    where: { ownerId, id, status: row.status, lifecycleRevision: row.lifecycleRevision, updatedAt: row.updatedAt },
    data: {
      status: input.status, lifecycleRevision: { increment: 1 }, lifecycleChangedAt: now,
      ...(input.sourceReply !== undefined && { sourceReply: input.sourceReply ?? Prisma.DbNull }),
      ...(client.kind === "web" && { lastOwnerEditedAt: now }),
    },
  });
  if (!saved) throw new JobsError(409, "The application changed. Refresh the application.");
  const from = auditSnapshot(row);
  const to = auditSnapshot(saved);
  const audit = client.kind === "agent" ? await tx.agentWriteAudit.create({
    data: {
      ownerId, clientId: client.id, clientName: client.name, resourceType: "jobApplication", resourceId: id,
      revisionBefore: row.lifecycleRevision, revisionAfter: saved.lifecycleRevision, before: from, after: to,
    }, select: { id: true },
  }) : null;
  await tx.jobEvent.create({ data: {
    ownerId, applicationId: id, revision: saved.revision, kind: "lifecycle_changed", payload: { from: from.status, to: to.status },
  } });
  const detail = await readJobLifecycle(tx, ownerId, id, client.kind === "web");
  return { ...detail, ...(audit && { auditId: audit.id }) };
}

export async function undoJobLifecycleChange(tx: Prisma.TransactionClient, audit: AgentWriteAudit) {
  const before = lifecycleAuditState.parse(audit.before);
  const after = lifecycleAuditState.parse(audit.after);
  const [saved] = await tx.jobApplication.updateManyAndReturn({
    where: { ownerId: audit.ownerId, id: audit.resourceId, lifecycleRevision: audit.revisionAfter, status: after.status },
    data: {
      status: before.status, sourceReply: before.sourceReply ?? Prisma.DbNull,
      lifecycleChangedAt: before.changedAt === null ? null : new Date(before.changedAt),
      lifecycleRevision: { increment: 1 }, lastOwnerEditedAt: new Date(),
    },
    select: { revision: true },
  });
  if (!saved) throw new JobsError(409, "The lifecycle changed after the Agent edit. Refresh the application.");
  await tx.jobEvent.create({ data: {
    ownerId: audit.ownerId, applicationId: audit.resourceId, revision: saved.revision, kind: "lifecycle_undone",
    payload: { undoneAuditId: audit.id, from: after.status, to: before.status },
  } });
}
