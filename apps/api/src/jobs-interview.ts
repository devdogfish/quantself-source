import { getPublicOrigin } from "@quantself/auth/public-origin";
import type { AccessContext } from "@quantself/auth";
import type { AgentWriteAudit, JobApplicationStatus, JobInterview, JobInterviewAppointment, PrismaClient } from "@quantself/db/generated/prisma/client";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";
import type {
  JobInterviewInput, JobInterviewResult, NativeJobInterviewCommand, NativeJobInterviewDetail, NativeJobInterviewRange, ScheduleJobInterviewResult,
} from "./jobs-lifecycle-contract";
import { TodoWriteError, type TodoWriter } from "./todos-write";

export const jobInterviewAuditResource = "jobInterviewAppointment";
const ownerEditWindowMs = 180_000;
const schedulableStatuses = new Set<JobApplicationStatus>(["applied", "interviewing", "offer"]);

type InterviewWithAppointment = JobInterview & { appointment: JobInterviewAppointment | null };

export function jobInterviewResult(row: InterviewWithAppointment): JobInterviewResult {
  if (row.source === "native") {
    const appointment = row.appointment;
    if (!appointment) throw new JobsError(503, "The native Appointment is unavailable.");
    return {
      id: row.id, source: "native", start: appointment.startAt.toISOString(), end: appointment.endAt.toISOString(),
      revision: appointment.revision, cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
    };
  }
  if (row.todoNumber === null) throw new JobsError(503, "The Owner must retry the original time to reconcile the GitHub Appointment.");
  return { id: row.id, source: "github", start: row.startAt.toISOString(), end: row.endAt.toISOString(), todoNumber: row.todoNumber };
}

type AppointmentRead = Pick<JobInterviewAppointment, "id" | "startAt" | "endAt" | "revision" | "cancelledAt" | "beforeMinutes" | "afterMinutes" | "alertMinutes"> &
  Pick<JobInterview, "title" | "applicationId">;

function nativeAppointmentView(row: AppointmentRead): NativeJobInterviewDetail {
  return {
    id: row.id, source: "native", start: row.startAt.toISOString(), end: row.endAt.toISOString(),
    revision: row.revision, cancelledAt: row.cancelledAt?.toISOString() ?? null,
    title: row.title, applicationId: row.applicationId, fixed: true, allDay: false, category: "Job search",
    beforeMinutes: row.beforeMinutes, afterMinutes: row.afterMinutes, alertMinutes: row.alertMinutes,
  };
}

const nativeAppointmentRows = Prisma.sql`
  SELECT a."id", a."startAt", a."endAt", a."revision", a."cancelledAt", a."beforeMinutes", a."afterMinutes", a."alertMinutes",
         i."title", i."applicationId"
  FROM "job_interview_appointment" a
  JOIN "job_interview" i ON i."id" = a."id"`;

export async function readNativeJobInterview(db: PrismaClient, ownerId: string, id: string) {
  const [row] = await db.$queryRaw<AppointmentRead[]>`
    ${nativeAppointmentRows}
    WHERE a."id" = ${id}::uuid AND i."ownerId" = ${ownerId} AND i."source" = 'native'`;
  if (!row) throw new JobsError(404, "Appointment not found.");
  return nativeAppointmentView(row);
}

export async function listNativeJobInterviews(db: PrismaClient, ownerId: string, range: NativeJobInterviewRange) {
  const { limit, afterId, afterStart } = range;
  const from = new Date(range.from).toISOString(), to = new Date(range.to).toISOString();
  const cursor = afterStart && afterId
    ? Prisma.sql`AND (a."startAt", a."id") > (${new Date(afterStart).toISOString()}::timestamptz AT TIME ZONE 'UTC', ${afterId}::uuid)`
    : Prisma.empty;
  const rows = await db.$queryRaw<AppointmentRead[]>`
    ${nativeAppointmentRows}
    WHERE i."ownerId" = ${ownerId} AND i."source" = 'native' AND a."cancelledAt" IS NULL
      AND a."startAt" < (${to}::timestamptz AT TIME ZONE 'UTC') + interval '1440 minutes'
      AND a."startAt" - a."beforeMinutes" * interval '1 minute' < (${to}::timestamptz AT TIME ZONE 'UTC')
      AND a."endAt" + a."afterMinutes" * interval '1 minute' > (${from}::timestamptz AT TIME ZONE 'UTC')
      ${cursor}
    ORDER BY a."startAt", a."id"
    LIMIT ${limit + 1}`;
  const appointments = rows.slice(0, limit).map(nativeAppointmentView);
  const last = appointments.at(-1);
  return { appointments, nextCursor: rows.length > limit && last ? { afterStart: last.start, afterId: last.id } : null };
}

async function lockInterviewApplication(tx: Prisma.TransactionClient, ownerId: string, applicationId: string) {
  const [application] = await tx.$queryRaw<{
    company: string; role: string; status: JobApplicationStatus; lifecycleRevision: number; lastOwnerEditedAt: Date | null;
  }[]>`SELECT "company", "role", "status"::text AS "status", "lifecycleRevision", "lastOwnerEditedAt"
       FROM "job_application" WHERE "ownerId" = ${ownerId} AND "id" = ${applicationId} FOR UPDATE`;
  if (!application) throw new JobsError(404, "Application not found.");
  return application;
}

async function requireAvailableInterviewStart(
  tx: Prisma.TransactionClient, ownerId: string, applicationId: string, startAt: Date, excludingId?: string,
) {
  const collision = await tx.jobInterview.findFirst({
    where: {
      ownerId, applicationId, ...(excludingId && { id: { not: excludingId } }),
      OR: [
        { source: "github", startAt },
        { source: "native", appointment: { is: { startAt, cancelledAt: null } } },
      ],
    },
    select: { id: true },
  });
  if (collision) throw new JobsError(409, "Another Appointment occupies this interview start time.");
}

export async function reserveNativeJobInterview(
  tx: Prisma.TransactionClient,
  access: AccessContext,
  applicationId: string,
  input: JobInterviewInput & { expectedRevision?: number },
): Promise<ScheduleJobInterviewResult | null> {
  const { owner, client } = access;
  const startAt = new Date(input.start);
  const endAt = new Date(input.end);
  // Serialize reservations and moves through their application row.
  // Use READ COMMITTED so a waiter sees the slot the preceding transaction committed.
  const application = await lockInterviewApplication(tx, owner.id, applicationId);

  const slot = { ownerId: owner.id, applicationId, startAt };
  const existing = await tx.jobInterview.findUnique({
    where: { ownerId_applicationId_startAt: slot },
    include: { appointment: { include: { creationAudit: { select: { id: true, clientId: true } } } } },
  });
  if (existing) {
    if (existing.endAt.getTime() !== endAt.getTime()) throw new JobsError(409, "This interview start time already has a different end time.");
    if (existing.source === "github" && existing.todoNumber === null && client.kind === "web") return null;
    const appointment = jobInterviewResult(existing);
    const audit = existing.appointment?.creationAudit;
    return { appointment, ...(client.kind === "agent" && audit?.clientId === client.id && { auditId: audit.id }) };
  }
  if (!schedulableStatuses.has(application.status)) throw new JobsError(409, "Schedule interviews for active, submitted applications.");
  if (client.kind === "agent") {
    if (application.lifecycleRevision !== input.expectedRevision) throw new JobsError(409, "The lifecycle revision changed. Refresh the application.");
    if (application.lastOwnerEditedAt && Date.now() - application.lastOwnerEditedAt.getTime() < ownerEditWindowMs) {
      throw new JobsError(409, "The Owner edited this application within the last 3 minutes. Try again later.");
    }
  }
  await requireAvailableInterviewStart(tx, owner.id, applicationId, startAt);

  const id = crypto.randomUUID();
  const appointment = {
    id, source: "native" as const, start: startAt.toISOString(), end: endAt.toISOString(),
    revision: 1, cancelledAt: null,
  };
  const audit = client.kind === "agent" ? await tx.agentWriteAudit.create({
    data: {
      ownerId: owner.id, clientId: client.id, clientName: client.name, resourceType: jobInterviewAuditResource, resourceId: id,
      revisionBefore: 0, revisionAfter: 1, before: { exists: false }, after: { ...appointment, applicationId },
    },
    select: { id: true },
  }) : null;
  await tx.jobInterview.create({
    data: {
      id, ...slot, endAt, source: "native",
      title: interviewTitle(application), applicationUrl: appointmentApplicationUrl(applicationId),
      appointment: { create: { startAt, endAt, creationAuditId: audit?.id } },
    },
    select: { id: true },
  });
  return { appointment, ...(audit && { auditId: audit.id }) };
}

export async function updateNativeJobInterview(
  tx: Prisma.TransactionClient, ownerId: string, id: string, command: NativeJobInterviewCommand,
) {
  const [interview] = await tx.$queryRaw<Pick<JobInterview, "title" | "applicationId">[]>`
    SELECT i."title", i."applicationId"
    FROM "job_interview" i
    JOIN "job_application" j ON (j."ownerId", j."id") = (i."ownerId", i."applicationId")
    WHERE i."id" = ${id}::uuid AND i."ownerId" = ${ownerId} AND i."source" = 'native'
    FOR UPDATE OF j`;
  if (!interview) throw new JobsError(404, "Appointment not found.");

  const data: Prisma.JobInterviewAppointmentUpdateManyMutationInput = { revision: { increment: 1 } };
  if (command.action === "cancel") {
    data.cancelledAt = new Date();
  } else {
    const { start, end, beforeMinutes, afterMinutes, alertMinutes } = command;
    if (start !== undefined && end !== undefined) {
      data.startAt = new Date(start);
      data.endAt = new Date(end);
      await requireAvailableInterviewStart(tx, ownerId, interview.applicationId, data.startAt, id);
    }
    if (beforeMinutes !== undefined) data.beforeMinutes = beforeMinutes;
    if (afterMinutes !== undefined) data.afterMinutes = afterMinutes;
    if (alertMinutes !== undefined) data.alertMinutes = alertMinutes;
  }
  const [saved] = await tx.jobInterviewAppointment.updateManyAndReturn({
    // Creation Undo uses the same revision, so only one can win.
    where: { id, revision: command.expectedRevision, cancelledAt: null, interview: { ownerId, source: "native" } },
    data,
  });
  if (!saved) throw new JobsError(409, "The Appointment changed. Refresh it before trying again.");
  return nativeAppointmentView({ ...saved, ...interview });
}

export async function undoNativeJobInterview(tx: Prisma.TransactionClient, audit: AgentWriteAudit) {
  const saved = await tx.jobInterviewAppointment.updateMany({
    where: {
      id: audit.resourceId, revision: audit.revisionAfter, cancelledAt: null, creationAuditId: audit.id,
      interview: { ownerId: audit.ownerId, source: "native" },
    },
    data: { cancelledAt: new Date(), revision: { increment: 1 } },
  });
  if (!saved.count) throw new JobsError(409, "The Appointment changed after creation. Undo is no longer available.");
}

function interviewTitle(application: { company: string; role: string }) {
  return `Interview · ${application.company} · ${application.role}`.slice(0, 256).trim();
}

function appointmentApplicationUrl(id: string) {
  const base = getPublicOrigin();
  if (!base) throw new JobsError(503, "The dashboard address is unavailable.");
  const url = new URL("/jobs/applications", base);
  url.searchParams.set("applicationId", id);
  return url.href;
}

export async function saveJobInterview(db: PrismaClient, writeTodo: TodoWriter | undefined, ownerId: string, id: string, input: JobInterviewInput, allowNew = true): Promise<JobInterviewResult> {
  const startAt = new Date(input.start);
  const endAt = new Date(input.end);
  const key = { ownerId, applicationId: id, startAt };
  const where = { ownerId_applicationId_startAt: key };
  let interview = await db.jobInterview.findUnique({ where, include: { appointment: true } });
  if (!interview) {
    if (!allowNew) throw new JobsError(409, "The existing GitHub reservation changed. Refresh the application.");
    interview = await db.$transaction(async tx => {
      const app = await lockInterviewApplication(tx, ownerId, id);
      const existing = await tx.jobInterview.findUnique({ where, include: { appointment: true } });
      if (existing) return existing;
      if (!schedulableStatuses.has(app.status)) {
        throw new JobsError(409, "Schedule interviews for active, submitted applications.");
      }
      if (!writeTodo) throw new JobsError(503, "The To-Do service is unavailable.");
      await requireAvailableInterviewStart(tx, ownerId, id, startAt);
      const [created] = await tx.jobInterview.createManyAndReturn({
        skipDuplicates: true,
        data: { ...key, endAt, title: interviewTitle(app), applicationUrl: appointmentApplicationUrl(id) },
      });
      return created ? { ...created, appointment: null } : await tx.jobInterview.findUniqueOrThrow({ where, include: { appointment: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  if (interview.endAt.getTime() !== endAt.getTime()) throw new JobsError(409, "This interview start time already has a different end time.");
  if (interview.source === "native" || interview.todoNumber !== null) return jobInterviewResult(interview);
  if (!writeTodo) throw new JobsError(503, "The To-Do service is unavailable.");

  try {
    const result = await writeTodo(`jobs-interview:${ownerId}`, {
      commandId: interview.id, title: interview.title, start: interview.startAt.toISOString(), end: interview.endAt.toISOString(),
      fixed: true, allDay: false, fields: { Category: "Job search", URL: interview.applicationUrl },
    });
    if (!result.todo || ["issue", "type", "timing", "Category", "URL"].some(field => result.outcomes[field] !== "saved")) {
      throw new JobsError(503, "Retry the same time to confirm the appointment.");
    }
    const [saved] = await db.jobInterview.updateManyAndReturn({
      where: { id: interview.id, source: "github", todoNumber: null }, data: { todoNumber: result.todo.number },
    });
    const persisted = saved ?? await db.jobInterview.findUniqueOrThrow({ where });
    if (persisted.todoNumber !== result.todo.number) throw new JobsError(409, "The linked appointment changed.");
    return jobInterviewResult({ ...persisted, appointment: null });
  } catch (error) {
    if (error instanceof TodoWriteError) throw new JobsError(error.status, error.message);
    throw error;
  }
}
