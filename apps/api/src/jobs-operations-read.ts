import { z } from "@hono/zod-openapi";
import { Prisma, type JobApplication, type JobRunner, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { issueCode, receiptCode } from "./jobs-contract";
import { readPrivatePauseFieldKeys } from "./jobs-private-pause";
import { jobReviewRow } from "./jobs-review-contract";

const count = z.number().int().nonnegative();
const duration = count.nullable();
const rate = z.number().min(0).max(1);
const runnerOutput = z.object({
  state: z.enum(["idle", "submitting", "paused", "offline"]),
  host: z.string().nullable(), lastHeartbeatAt: z.iso.datetime().nullable(),
});
const weeklyOutput = z.array(z.object({ week: z.string(), drafted: count, applied: count }));
const verdict = jobReviewRow.shape.verdict.unwrap();
const alignmentOutput = z.array(z.object({ verdict, drafts: count, approved: count, skipped: count, rejected: count }));
export const jobsOverviewOutput = z.object({
  waitingOnYou: count, waitingOnRunner: count, runner: runnerOutput,
  metrics: z.object({ applied: count, approvalRate: rate, responseRate: rate, medianDaysToApply: z.number().nonnegative().nullable() }),
  pipeline: z.object({ drafted: count, reviewed: count, approved: count, applied: count }),
  weekly: weeklyOutput, alignment: alignmentOutput,
});

const stepOutput = z.object({
  label: z.string(), state: z.enum(["done", "running", "failed", "pending"]), durationMs: duration,
  attempts: z.array(z.object({ at: z.iso.datetime(), error: z.string() })),
});
export const submissionOutput = jobReviewRow.extend({
  approvedRevision: count.nullable(), phase: z.string().nullable(), durationMs: duration, receipt: receiptCode.nullable(),
  steps: z.array(stepOutput), privatePauseFieldKeys: z.array(z.string()).optional(),
});
export const jobsSubmissionsOutput = z.object({ runner: runnerOutput, items: z.array(submissionOutput) });
export type JobsOverview = z.output<typeof jobsOverviewOutput>;
export type JobsSubmissions = z.output<typeof jobsSubmissionsOutput>;

type RunnerRow = Pick<JobRunner, "host" | "lastHeartbeatAt" | "paused">;
type OperationsDb = Pick<PrismaClient, "$queryRaw"> & {
  jobRunner: {
    findUnique(args: { where: { ownerId: string }; select: Record<keyof RunnerRow, true> }): PromiseLike<RunnerRow | null>;
  };
};
const heartbeatWindowMs = 120_000;
const appliedHistoryLimit = 100;
const eventsPerSubmission = 64;
const attemptsPerStep = 5;

function runnerState(row: RunnerRow | null, submitting: boolean, now: Date): JobsOverview["runner"] {
  const heartbeat = row?.lastHeartbeatAt ?? null;
  const state = row?.paused ? "paused" : !heartbeat || now.getTime() - heartbeat.getTime() >= heartbeatWindowMs
    ? "offline" : submitting ? "submitting" : "idle";
  return { state, host: row?.host ?? null, lastHeartbeatAt: heartbeat?.toISOString() ?? null };
}

const readRunner = (db: OperationsDb, ownerId: string) => db.jobRunner.findUnique({
  where: { ownerId }, select: { host: true, lastHeartbeatAt: true, paused: true },
});

type OverviewAggregate = {
  waitingOnYou: number; waitingOnRunner: number; submitting: boolean;
  drafted: number; reviewed: number; approved: number; applied: number; appliedRecently: number; medianDays: number | null;
  weekly: JobsOverview["weekly"]; alignment: JobsOverview["alignment"];
};

export async function readJobsOverview(db: OperationsDb, ownerId: string, now = new Date()): Promise<JobsOverview> {
  const [runner, [result]] = await Promise.all([readRunner(db, ownerId), db.$queryRaw<OverviewAggregate[]>`
    WITH clock AS (
      SELECT ${now}::timestamptz AT TIME ZONE 'UTC' AS now
    ), history AS (
      SELECT "applicationId",
        bool_or(kind IN ('approved', 'receipt_recorded')) AS approved,
        bool_or(kind IN ('rejected', 'skipped', 'saved_for_later', 'revision_edited')) AS reviewed,
        (array_agg(kind ORDER BY "occurredAt" DESC, id DESC)
          FILTER (WHERE kind IN ('approved', 'rejected', 'skipped', 'saved_for_later', 'reopened')))[1] AS last_decision
      FROM job_event
      WHERE "ownerId" = ${ownerId}
        AND kind IN ('approved', 'receipt_recorded', 'rejected', 'skipped', 'saved_for_later', 'revision_edited', 'reopened')
      GROUP BY "applicationId"
    ), applications AS (
      SELECT a."createdAt" AS created_at, a."appliedAt" AS applied_at, a.verdict,
        a.status = 'submitting' AND a."submitLeaseUntil" <= clock.now AS expired,
        a.status::text AS status,
        (a."approvedRevision" IS NOT NULL OR a.status IN ('approved', 'queued', 'submitting', 'applied')
          OR a."appliedAt" IS NOT NULL) AS current_approval,
        coalesce(h.approved, false) AS prior_approval, coalesce(h.reviewed, false) AS prior_review,
        CASE
          WHEN a.status IN ('skipped', 'rejected', 'saved_for_later', 'disqualified') THEN a.status::text
          WHEN a.status IN ('approved', 'queued', 'submitting', 'applied') OR a."approvedRevision" IS NOT NULL THEN 'approved'
          ELSE h.last_decision
        END AS decision
      FROM job_application a
      CROSS JOIN clock
      LEFT JOIN history h ON h."applicationId" = a.id
      WHERE a."ownerId" = ${ownerId}
    ), weeks AS (
      SELECT generate_series(date_trunc('week', now) - interval '9 weeks', date_trunc('week', now), interval '1 week') AS week
      FROM clock
    ), activity AS (
      SELECT date_trunc('week', activity.at) AS week, count(*) FILTER (WHERE activity.drafted)::int AS drafted,
        count(*) FILTER (WHERE NOT activity.drafted)::int AS applied
      FROM applications a
      CROSS JOIN LATERAL (VALUES (a.created_at, true), (a.applied_at, false)) AS activity(at, drafted)
      WHERE activity.at >= (SELECT min(week) FROM weeks) AND activity.at <= (SELECT now FROM clock)
      GROUP BY 1
    ), alignment AS (
      SELECT verdict, count(*)::int AS drafts,
        count(*) FILTER (WHERE decision = 'approved')::int AS approved,
        count(*) FILTER (WHERE decision = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE decision = 'rejected')::int AS rejected
      FROM applications WHERE verdict IS NOT NULL GROUP BY verdict
    )
    SELECT
      count(*) FILTER (WHERE status IN ('review', 'needs_attention') OR expired)::int AS "waitingOnYou",
      count(*) FILTER (WHERE status IN ('approved', 'queued', 'submitting') AND expired IS NOT TRUE)::int AS "waitingOnRunner",
      coalesce(bool_or(status = 'submitting' AND expired IS NOT TRUE), false) AS submitting,
      count(*)::int AS drafted,
      count(*) FILTER (WHERE current_approval OR prior_approval OR prior_review OR status IN ('skipped', 'rejected', 'saved_for_later'))::int AS reviewed,
      count(*) FILTER (WHERE current_approval OR prior_approval)::int AS approved,
      count(*) FILTER (WHERE applied_at IS NOT NULL OR status = 'applied')::int AS applied,
      count(*) FILTER (WHERE applied_at BETWEEN (SELECT now - interval '30 days' FROM clock) AND (SELECT now FROM clock))::int AS "appliedRecently",
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM applied_at - created_at) / 86400)
        FILTER (WHERE applied_at >= created_at AND applied_at <= (SELECT now FROM clock)))::numeric, 1)::float8 AS "medianDays",
      (SELECT jsonb_agg(jsonb_build_object('week', to_char(w.week, 'Mon FMDD'),
        'drafted', coalesce(a.drafted, 0), 'applied', coalesce(a.applied, 0)) ORDER BY w.week)
        FROM weeks w LEFT JOIN activity a USING (week)) AS weekly,
      (SELECT coalesce(jsonb_agg(to_jsonb(alignment)), '[]'::jsonb) FROM alignment) AS alignment
    FROM applications
  `]);
  const { waitingOnYou, waitingOnRunner, submitting, drafted, reviewed, approved, applied, appliedRecently, medianDays, weekly } = result;
  const alignment = verdict.options.map(value => result.alignment.find(row => row.verdict === value) ??
    { verdict: value, drafts: 0, approved: 0, skipped: 0, rejected: 0 });
  return {
    waitingOnYou, waitingOnRunner, runner: runnerState(runner, submitting, now),
    metrics: {
      applied: appliedRecently, approvalRate: reviewed ? approved / reviewed : 0,
      // Employer response events are required to calculate this rate.
      responseRate: 0, medianDaysToApply: medianDays,
    },
    pipeline: { drafted, reviewed, approved, applied }, weekly, alignment,
  };
}

type SubmissionRow = Pick<JobApplication,
  "id" | "company" | "role" | "resumeTrack" | "sourceLabel" | "sourceUrl" | "status" | "issueCode" |
  "verdict" | "dueAt" | "updatedAt" | "appliedAt" | "approvedRevision" | "receiptCode" | "privatePause" | "resumeMarkdown" | "summary"
> & { events: unknown[] };

const labels = ["Approved", "Queued", "Runner claimed", "Portal opened", "Form filled", "Submitted", "Receipt captured"];
const runnerPhases = ["Claiming submission", "Opening portal", "Filling form", "Submitting application", "Capturing receipt"];
const eventSteps = { runner_claimed: 2, portal_opened: 3, form_filled: 4, submit_started: 5, submitted: 5, receipt_captured: 6 } as const;
const errorLabels = {
  unsupported_portal: { index: 3, message: "The runner cannot submit through this portal." },
  manual_required: { index: 4, message: "The form needs Owner input." },
  runner_unavailable: { index: 2, message: "The runner could not complete this step." },
  submission_uncertain: { index: 5, message: "The runner could not confirm whether the application was sent." },
  model_error: { index: 2, message: "The worker could not complete this step." },
} satisfies Record<z.output<typeof issueCode>, { index: number; message: string }>;
const eventOutput = z.object({
  kind: z.enum(["submission_step", "submit_started", "work_failed", "receipt_recorded"]),
  at: z.iso.datetime(), attempt: count.nullish(), step: z.enum(Object.keys(eventSteps) as (keyof typeof eventSteps)[]).nullish(),
  state: z.enum(["done", "running", "failed"]).nullish(), durationMs: count.nullish(), code: issueCode.nullish(),
});
type SubmissionEvent = z.output<typeof eventOutput>;

function submissionTimeline(row: SubmissionRow, now: Date): Pick<JobsSubmissions["items"][number], "steps" | "phase" | "durationMs"> {
  const steps: z.output<typeof stepOutput>[] = labels.map(label => ({ label, state: "pending", durationMs: null, attempts: [] }));
  const events = row.events.flatMap(value => {
    const result = eventOutput.safeParse(value);
    return result.success ? [result.data] : [];
  });
  const attempt = events.reduce((last, event) => Math.max(last, event.attempt ?? 0), 0);
  const attempted = row.status !== "queued" && row.status !== "approved";
  const current = attempted ? events.filter(event => (event.attempt ?? 0) === attempt) : [];
  // A claim or terminal status already implies the Approval and Queue milestones.
  steps[0].state = "done";
  if (row.status !== "approved") steps[1].state = "done";
  const failures = new Set<string>();
  for (const event of events) {
    if (event.kind !== "work_failed" && event.state !== "failed") continue;
    const failure = event.code ? errorLabels[event.code] : null;
    const index = event.step ? eventSteps[event.step] : failure?.index;
    if (index === undefined) continue;
    const key = `${index}:${event.attempt ?? event.at}`;
    if (failures.has(key) || steps[index].attempts.length === attemptsPerStep) continue;
    failures.add(key);
    steps[index].attempts.unshift({ at: event.at, error: failure?.message ?? "The runner could not complete this step." });
  }
  // Events arrive newest first. Apply them oldest first so a later completion replaces a running step.
  for (const event of [...current].reverse()) {
    const index = event.kind === "receipt_recorded" ? 6 : event.step ? eventSteps[event.step] : undefined;
    if (index !== undefined) {
      steps[index].state = event.state ?? "done";
      steps[index].durationMs = event.durationMs ?? steps[index].durationMs;
    }
  }
  if (row.status === "applied") {
    for (const step of steps.slice(0, -1)) step.state = "done";
    if (row.receiptCode) steps[6].state = "done";
  }
  if (row.status === "needs_attention" && row.issueCode) steps[errorLabels[row.issueCode].index].state = "failed";

  let phase: string | null = null;
  if (row.status === "submitting") {
    const running = steps.findIndex(step => step.state === "running");
    const index = running === -1 ? steps.findIndex(step => step.state === "pending") : running;
    if (index !== -1) {
      steps[index].state = "running";
      phase = runnerPhases[index - eventSteps.runner_claimed];
    }
  }
  const started = current.find(event => event.step === "runner_claimed");
  const terminal = current.find(event => event.kind === "receipt_recorded" || event.kind === "work_failed");
  const endedAt = row.status === "submitting" ? now.getTime() : terminal ? Date.parse(terminal.at) : null;
  const durationMs = started && endedAt !== null ? Math.max(0, endedAt - Date.parse(started.at)) : null;
  return { steps, phase, durationMs };
}

async function readSubmissionRows(db: Pick<OperationsDb, "$queryRaw">, ownerId: string, now: Date, id?: string) {
  const candidates = id ? Prisma.sql`
      SELECT id, "ownerId", "updatedAt",
        status = 'submitting' AND "submitLeaseUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC') AS expired, 0 AS priority
      FROM job_application WHERE "ownerId" = ${ownerId} AND id = ${id}
  ` : Prisma.sql`
      SELECT id, "ownerId", "updatedAt", expired,
        CASE WHEN status = 'submitting' AND expired IS NOT TRUE THEN 0
             WHEN status = 'needs_attention' OR expired THEN 1 ELSE 2 END AS priority
      FROM job_application
      CROSS JOIN LATERAL (SELECT status = 'submitting' AND "submitLeaseUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC') AS expired) x
      WHERE "ownerId" = ${ownerId} AND status IN ('approved', 'queued', 'submitting', 'needs_attention')
        AND "issueCode" IS DISTINCT FROM 'model_error'
      UNION ALL
      SELECT id, "ownerId", "updatedAt", false AS expired, 3 AS priority
      FROM (
        SELECT id, "ownerId", "updatedAt" FROM job_application
        WHERE "ownerId" = ${ownerId}
          AND (status = 'applied' OR ("appliedAt" IS NOT NULL AND status IN ('interviewing', 'offer', 'withdrawn', 'rejected')))
        ORDER BY coalesce("appliedAt", "updatedAt") DESC, id
        LIMIT ${appliedHistoryLimit}
      ) recent_applied
  `;
  const rows = await db.$queryRaw<SubmissionRow[]>`
    WITH candidates AS (${candidates})
    SELECT a.id, a.company, a.role, a."resumeTrack", a."sourceLabel", a."sourceUrl", a.verdict,
      a."dueAt", a."updatedAt", a."appliedAt", a."approvedRevision", a."receiptCode",
      CASE WHEN c.expired THEN 'needs_attention'
        WHEN a."appliedAt" IS NOT NULL AND a.status IN ('interviewing', 'offer', 'withdrawn', 'rejected') THEN 'applied'
        ELSE a.status::text END AS status,
      CASE WHEN c.expired THEN 'submission_uncertain' ELSE a."issueCode"::text END AS "issueCode",
      CASE WHEN a."issueCode" = 'manual_required' THEN a."privatePause" END AS "privatePause",
      CASE WHEN a."issueCode" = 'manual_required' THEN a.summary ELSE '' END AS summary,
      CASE WHEN a."issueCode" = 'manual_required' THEN a."resumeMarkdown" END AS "resumeMarkdown",
      event_window.events
    FROM candidates c
    JOIN job_application a ON a."ownerId" = c."ownerId" AND a.id = c.id
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'at', to_char(e."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'attempt', e.payload->'attempt', 'step', e.payload->'step', 'state', e.payload->'state',
        'durationMs', e.payload->'durationMs', 'code', CASE WHEN e.kind <> 'receipt_recorded' THEN e.payload->'code' END
      ) ORDER BY e."occurredAt" DESC, e.id DESC), '[]'::jsonb) AS events
      FROM (
        SELECT kind, payload, "occurredAt", id FROM job_event
        WHERE "ownerId" = a."ownerId" AND "applicationId" = a.id AND revision = coalesce(a."approvedRevision", a.revision)
          AND (kind IN ('submission_step', 'submit_started', 'receipt_recorded')
            OR (kind = 'work_failed' AND payload->>'code' IN ('unsupported_portal', 'manual_required', 'runner_unavailable', 'submission_uncertain')))
        ORDER BY "occurredAt" DESC, id DESC LIMIT ${eventsPerSubmission}
      ) e
    ) event_window
    ORDER BY c.priority, c."updatedAt" DESC, c.id
  `;
  return rows.map(row => {
    const privatePauseFieldKeys = readPrivatePauseFieldKeys(row);
    return {
      id: row.id, company: row.company, role: row.role, track: row.resumeTrack, status: row.status,
      issue: row.issueCode, verdict: row.verdict, source: row.sourceLabel, sourceUrl: row.sourceUrl,
      updatedAt: row.updatedAt.toISOString(), appliedAt: row.appliedAt?.toISOString() ?? null, dueAt: row.dueAt?.toISOString() ?? null,
      approvedRevision: row.approvedRevision, receipt: row.status === "applied" ? row.receiptCode : null,
      ...submissionTimeline(row, now), ...(privatePauseFieldKeys && { privatePauseFieldKeys }),
    };
  });
}

export async function readJobSubmission(db: Pick<OperationsDb, "$queryRaw">, ownerId: string, id: string, now = new Date()) {
  return (await readSubmissionRows(db, ownerId, now, id))[0];
}

export async function readJobsSubmissions(db: OperationsDb, ownerId: string, now = new Date()): Promise<JobsSubmissions> {
  const [runner, items] = await Promise.all([readRunner(db, ownerId), readSubmissionRows(db, ownerId, now)]);
  return { items, runner: runnerState(runner, items.some(item => item.status === "submitting"), now) };
}
