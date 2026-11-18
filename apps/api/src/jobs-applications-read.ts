import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";
import type { JobsApplicationsPage, JobsApplicationsQuery, JobsReviewableQuery } from "./jobs-review-contract";

const tabFilters = {
  all: Prisma.sql`true`,
  review: Prisma.sql`status = 'review'`,
  progress: Prisma.sql`status IN ('draft', 'approved', 'queued', 'submitting')`,
  attention: Prisma.sql`status = 'needs_attention'`,
  applied: Prisma.sql`status IN ('applied', 'interviewing', 'offer')`,
  closed: Prisma.sql`status IN ('rejected', 'skipped', 'disqualified', 'saved_for_later', 'withdrawn')`,
} satisfies Record<keyof JobsApplicationsPage["tabCounts"], Prisma.Sql>;

const ordering = {
  due: Prisma.sql`"dueAt" ASC NULLS LAST, "updatedAt" DESC, id`,
  match: Prisma.sql`CASE verdict WHEN 'strong' THEN 3 WHEN 'review' THEN 2 WHEN 'weak' THEN 1 ELSE 0 END DESC, "updatedAt" DESC, id`,
  updated: Prisma.sql`"updatedAt" DESC, id`,
};

function filteredApplications(ownerId: string, query: JobsReviewableQuery, now: Date) {
  const today = new Date(now.toISOString().slice(0, 10));
  const dayAfter = (days: number) => new Date(today.getTime() + days * 86_400_000);
  const due = {
    overdue: Prisma.sql`AND "dueAt" < ${today}`,
    week: Prisma.sql`AND "dueAt" >= ${today} AND "dueAt" < ${dayAfter(8)}`,
    fortnight: Prisma.sql`AND "dueAt" >= ${today} AND "dueAt" < ${dayAfter(15)}`,
    none: Prisma.sql`AND "dueAt" IS NULL`,
  };
  const expired = Prisma.sql`status = 'submitting' AND "submitLeaseUntil" <= ${now}`;
  const effectiveStatus = Prisma.sql`CASE WHEN ${expired} THEN 'needs_attention' ELSE status END`;
  return Prisma.sql`
    SELECT id, company, role, location, "resumeTrack" AS track, "sourceLabel" AS source, "sourceUrl", verdict,
      "dueAt", "updatedAt", "appliedAt",
      ${effectiveStatus} AS status,
      CASE WHEN ${expired} THEN 'submission_uncertain' ELSE "issueCode" END AS issue
    FROM job_application WHERE "ownerId" = ${ownerId}
      ${query.status ? Prisma.sql`AND (${effectiveStatus}) = ${query.status}::"JobApplicationStatus"` : Prisma.empty}
      ${query.track ? Prisma.sql`AND "resumeTrack" = ${query.track}::"JobResumeTrack"` : Prisma.empty}
      ${query.q ? Prisma.sql`AND strpos(lower(company || ' ' || role), lower(${query.q})) > 0` : Prisma.empty}
      ${query.verdict ? Prisma.sql`AND verdict = ${query.verdict}::"JobVerdict"` : Prisma.empty}
      ${query.due ? due[query.due] : Prisma.empty}`;
}

export async function readJobsApplications(
  db: Pick<PrismaClient, "$queryRaw">, ownerId: string, query: JobsApplicationsQuery, now = new Date(),
): Promise<JobsApplicationsPage> {
  const tab = query.tab ?? "all";
  const countPairs = Object.entries(tabFilters).map(([name, filter]) =>
    Prisma.sql`${name}::text, COUNT(*) FILTER (WHERE ${filter})::int`);
  const order = ordering[query.sort ?? "due"];
  const [result] = await db.$queryRaw<Omit<JobsApplicationsPage, "total" | "pageSize">[]>`
    WITH matching AS MATERIALIZED (${filteredApplications(ownerId, query, now)}),
    counts AS (SELECT jsonb_build_object(${Prisma.join(countPairs)}) AS "tabCounts" FROM matching),
    page AS (
      SELECT id, company, role, track, source, "sourceUrl", verdict, status, issue,
        "dueAt", "updatedAt", "appliedAt"
      FROM matching WHERE ${tabFilters[tab]} ORDER BY ${order}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    )
    SELECT "tabCounts", COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY ${order}) FROM page), '[]'::jsonb) AS rows FROM counts`;
  const rows = result.rows.map(row => ({
    ...row, updatedAt: utcTimestamp(row.updatedAt), dueAt: row.dueAt && utcTimestamp(row.dueAt),
    appliedAt: row.appliedAt && utcTimestamp(row.appliedAt),
  }));
  return { rows, tabCounts: result.tabCounts, total: result.tabCounts[tab], pageSize: query.pageSize };
}

// Prisma stores these DateTime columns as UTC timestamps without a zone.
const utcTimestamp = (value: string) => new Date(value + "Z").toISOString();

export async function readJobApplicationId(
  db: Pick<PrismaClient, "jobApplication">,
  ownerId: string,
  evidence: { applicationAddress: string; sesMessageId?: string } | { sesMessageId: string },
) {
  const application = await db.jobApplication.findUnique({
    where: { ...evidence, ownerId }, select: { id: true },
  });
  if (!application) throw new JobsError(404, "Application not found.");
  return application;
}

export async function readReviewableJobIds(
  db: Pick<PrismaClient, "$queryRaw">, ownerId: string, query: JobsReviewableQuery, now = new Date(),
) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM (${filteredApplications(ownerId, query, now)}) AS matching
    WHERE ${tabFilters[query.tab ?? "all"]} AND (status = 'review' OR (status = 'needs_attention' AND issue = 'model_error'))
    ORDER BY ${ordering[query.sort ?? "due"]}`;
  return { ids: rows.map(row => row.id) };
}

export async function exportJobsApplications(
  db: Pick<PrismaClient, "$queryRaw">, ownerId: string, query: JobsReviewableQuery & { format: "ids" | "csv" }, now = new Date(),
) {
  const order = ordering[query.sort ?? "due"];
  const rows = await db.$queryRaw<{ id: string; company: string; role: string; location: string | null; status: string; updatedAt: Date }[]>`
    SELECT id, company, role, location, status, "updatedAt"
    FROM (${filteredApplications(ownerId, query, now)}) AS matching
    WHERE ${tabFilters[query.tab ?? "all"]} ORDER BY ${order}`;
  if (query.format === "ids") return { ids: rows.map(row => row.id) };
  return { rows: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })) };
}
