import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import type { JobsReviewSession } from "./jobs-review-contract";
import { JobsError } from "./jobs-error";
import { readPrivatePauseFieldKeys } from "./jobs-private-pause";
import { isExpiredSubmission } from "./jobs-application";
import { jobsBrief } from "./jobs-work-contract";
import { fillLegacyResume, readJobsResumeTemplate } from "./jobs-resume-template";

export const jobReviewRowSelect = {
  id: true, company: true, role: true, resumeTrack: true, status: true, issueCode: true, sourceLabel: true,
  sourceUrl: true, updatedAt: true, appliedAt: true, dueAt: true, verdict: true,
} satisfies Prisma.JobApplicationSelect;

const reviewDetailSelect = {
  ...jobReviewRowSelect, description: true, revision: true, approvedRevision: true,
  summary: true, resumeMarkdown: true, brief: true,
} satisfies Prisma.JobApplicationSelect;

type ReviewDetail = Prisma.JobApplicationGetPayload<{ select: typeof reviewDetailSelect }>;
type Track = ReviewDetail["resumeTrack"];

function missingDraftResume(row: ReviewDetail) {
  return !row.resumeMarkdown && Boolean(row.summary.trim()) && row.approvedRevision === null &&
    (row.status === "review" || row.status === "needs_attention" || row.status === "saved_for_later");
}

export function toJobReviewRow(row: Prisma.JobApplicationGetPayload<{ select: typeof jobReviewRowSelect }>) {
  return {
    id: row.id, company: row.company, role: row.role, track: row.resumeTrack, status: row.status, issue: row.issueCode,
    source: row.sourceLabel, sourceUrl: row.sourceUrl, updatedAt: row.updatedAt.toISOString(), appliedAt: row.appliedAt?.toISOString() ?? null,
    verdict: row.verdict, dueAt: row.dueAt?.toISOString() ?? null,
  };
}

export function toJobReviewDetail(row: ReviewDetail, hasPdf = false): JobsReviewSession["items"][number] {
  return {
    ...toJobReviewRow(row), brief: jobsBrief.safeParse(row.brief).data ?? null,
    postingText: row.description, revision: row.revision, approvedRevision: row.approvedRevision,
    summaryMarkdown: row.summary, resumeMarkdown: row.resumeMarkdown ?? "",
    pdfUrl: hasPdf ? `/api/v1/jobs/applications/${row.id}/resume.pdf?revision=${row.revision}` : null,
  };
}

export async function readJobReviewApplication(db: Pick<PrismaClient, "jobApplication">, ownerId: string, id: string, includePrivate = true) {
  const row = await db.jobApplication.findUnique({
    where: { ownerId_id: { ownerId, id } }, select: {
      ...reviewDetailSelect, resumeMarkdown: includePrivate, privatePause: includePrivate, submitLeaseUntil: true,
      revisions: includePrivate && { orderBy: { revision: "desc" }, take: 1, select: { revision: true, pdfReference: true, pdfSha256: true } },
    },
  });
  if (!row) throw new JobsError(404, "Application not found.");
  const pdf = row.revisions?.[0];
  const application = toJobReviewDetail(row, pdf?.revision === row.revision && Boolean(pdf.pdfReference && pdf.pdfSha256));
  if (includePrivate && missingDraftResume(row)) {
    application.resumeMarkdown = await fillLegacyResume(row.resumeTrack, row.summary) ?? "";
  }
  if (isExpiredSubmission(row, new Date())) {
    application.status = "needs_attention";
    application.issue = "submission_uncertain";
  }
  const privatePauseFieldKeys = includePrivate ? readPrivatePauseFieldKeys(row) : undefined;
  return { application: { ...application, ...(privatePauseFieldKeys && { privatePauseFieldKeys }) } };
}

export async function readJobReviewSession(db: Pick<PrismaClient, "$queryRaw">, ownerId: string, ids: string[]): Promise<JobsReviewSession> {
  const unique = [...new Set(ids)];
  const rows = await db.$queryRaw<Array<ReviewDetail & { hasPdf: boolean }>>`
    SELECT app.id, app.company, app.role, app."resumeTrack", app.status, app."issueCode", app."sourceLabel",
      app."sourceUrl", app."updatedAt", app."appliedAt", app.description, app.revision, app."approvedRevision",
      app.summary, app."resumeMarkdown", app.brief, app."dueAt", app.verdict,
      (saved."pdfReference" IS NOT NULL AND saved."pdfSha256" IS NOT NULL) AS "hasPdf"
    FROM job_application app
    LEFT JOIN job_revision saved
      ON saved."ownerId" = app."ownerId" AND saved."applicationId" = app.id AND saved.revision = app.revision
    WHERE app."ownerId" = ${ownerId} AND app.id IN (${Prisma.join(unique)})
  `;
  const byId = new Map(rows.map(row => [row.id, row]));
  const templates = new Map<Track, Promise<string>>();
  const items = await Promise.all(ids.flatMap(id => {
    const row = byId.get(id);
    if (!row) return [];
    const application = toJobReviewDetail(row, row.hasPdf);
    if (!missingDraftResume(row)) return [Promise.resolve(application)];
    let template = templates.get(row.resumeTrack);
    if (!template) templates.set(row.resumeTrack, template = readJobsResumeTemplate(row.resumeTrack));
    return [fillLegacyResume(row.resumeTrack, row.summary, template).then(resumeMarkdown => ({
      ...application, resumeMarkdown: resumeMarkdown ?? "",
    }))];
  }));
  return { items };
}

export async function readJobPdfReference(db: Pick<PrismaClient, "$queryRaw">, ownerId: string, id: string, expectedRevision?: number) {
  const [row] = await db.$queryRaw<Array<{ pdfReference: string | null; revision: number }>>`
    SELECT saved."pdfReference", app.revision
    FROM job_application app
    LEFT JOIN job_revision saved
      ON saved."ownerId" = app."ownerId" AND saved."applicationId" = app.id
      AND saved.revision = app.revision AND saved."pdfSha256" IS NOT NULL
    WHERE app."ownerId" = ${ownerId} AND app.id = ${id}
  `;
  if (!row) throw new JobsError(404, "Application not found.");
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new JobsError(409, "This résumé revision changed.");
  if (!row.pdfReference) throw new JobsError(404, "The current résumé PDF is not ready.");
  return row.pdfReference;
}
