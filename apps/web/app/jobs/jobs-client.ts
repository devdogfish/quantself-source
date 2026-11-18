// Jobs API contract (v2) and its client. The redesigned Jobs pages read and write only through this module.
// The backend implementing it is specified in the Jobs backend issue; the `preview:jobs` stub serves sample data.
import type { components, operations } from "@/lib/generated/quantself-api-schema";
import { appointmentHref } from "../../lib/native-appointment-link";

export type Track = "engineering" | "web" | "admin";
export type Status = components["schemas"]["JobApplicationStatus"];
export type JobLifecycle = components["schemas"]["JobLifecycle"];
export type JobLifecycleChange = components["schemas"]["JobLifecycleChange"];
export type JobInterview = components["schemas"]["JobInterview"];
export type JobInterviewInput = components["schemas"]["JobInterviewInput"];
export type IssueCode = "model_error" | "unsupported_portal" | "manual_required" | "runner_unavailable" | "submission_uncertain";
export type Verdict = "strong" | "review" | "weak";
export type Level = "low" | "medium" | "high";

export function jobInterviewHref(appointment: JobInterview | (Omit<Extract<JobInterview, { source: "github" }>, "source"> & { source?: undefined })) {
  return appointment.source === "native" ? appointmentHref(appointment.id) : `/todo?task=${appointment.todoNumber}`;
}

/** Pay normalised by the API: always hourly CAD; `original` is the posting's own wording when it was converted. */
export type Pay = { hourlyCad: { min: number; max: number } | null; original: string | null; converted: boolean };

/** The posting boiled down by the enrichment step, in the Owner's words. */
export type Brief = {
  doing: string;
  remote: "confirmed" | "hybrid" | "onsite" | "not_stated";
  pay: Pay;
  companySize: { people: number | null; label: string };
  automatable: Level;
  humanContact: { level: Level; note: string };
  meetings: { level: "rare" | "weekly" | "daily"; note: string };
};

export type ApplicationRow = {
  id: string;
  company: string;
  role: string;
  track: Track;
  status: Status;
  issue: IssueCode | null;
  verdict: Verdict | null;
  dueAt: string | null;
  source: string | null;
  sourceUrl: string;
  updatedAt: string;
  appliedAt: string | null;
};

export type ApplicationDetail = ApplicationRow & {
  brief: Brief | null;
  postingText: string;
  revision: number;
  approvedRevision: number | null;
  /** The tailored Summary as Markdown bullets; the only part of the résumé that changes per job. */
  summaryMarkdown: string;
  /** The whole résumé as Markdown, Summary included. */
  resumeMarkdown: string;
  /** Rendered PDF of `revision`, or null until the runner has rendered it. */
  pdfUrl: string | null;
  /** Reusable-detail keys the runner paused for (status needs_attention, issue manual_required). */
  privatePauseFieldKeys?: string[];
};

export type TabKey = "all" | "review" | "progress" | "attention" | "applied" | "closed";
export type ApplicationsQuery = {
  tab?: TabKey; q?: string; track?: Track | ""; status?: Status | ""; due?: "" | "overdue" | "week" | "fortnight" | "none";
  verdict?: Verdict | ""; sort?: "due" | "match" | "updated"; page?: number;
  /** Rows per page; default 15, at most 500 (the board asks for all). */
  pageSize?: number;
};
export type ApplicationsPage = { rows: ApplicationRow[]; total: number; pageSize: number; tabCounts: Record<TabKey, number> };

export type RunnerState = "idle" | "submitting" | "paused" | "offline";
export type Runner = { state: RunnerState; host: string | null; lastHeartbeatAt: string | null };

export type Overview = {
  waitingOnYou: number;
  waitingOnRunner: number;
  runner: Runner;
  metrics: { applied: number; approvalRate: number; responseRate: number; medianDaysToApply: number | null };
  pipeline: { drafted: number; reviewed: number; approved: number; applied: number };
  weekly: { week: string; drafted: number; applied: number }[];
  alignment: { verdict: Verdict; drafts: number; approved: number; skipped: number; rejected: number }[];
};

export type StepState = "done" | "running" | "failed" | "pending";
export type Submission = ApplicationRow & {
  approvedRevision: number | null;
  phase: string | null;
  durationMs: number | null;
  receipt: "confirmation_page" | "confirmation_message" | null;
  steps: { label: string; state: StepState; durationMs: number | null; attempts: { at: string; error: string }[] }[];
  /** Reusable-detail keys the runner paused for; answered inline in Submissions. */
  privatePauseFieldKeys?: string[];
};
export type Submissions = { runner: Runner; items: Submission[] };

export type Decision =
  | { action: "approve" | "skip" | "later" | "retry_draft" | "reopen" }
  | { action: "reject"; reasons: string[] }
  | { action: "revise"; instructions: string };
export type Resolution = { action: "mark_applied" | "mark_not_sent" | "requeue" | "skip"; confirmation?: string; expectedUpdatedAt?: string };

export class JobsApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const base = "/api/v1/jobs";

async function request<T>(path: string, init: RequestInit = {}, root = base): Promise<T> {
  const options: RequestInit & { cache: "no-store" } = {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  };
  const response = await fetch(`${root}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new JobsApiError(typeof body?.message === "string" ? body.message : "Jobs request failed. Try again.", response.status);
  }
  return response.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const ownerJobs = "/api/owner/jobs";
const originalReplies = (applicationId: string) => `/applications/${encodeURIComponent(applicationId)}/replies`;
export type JobReplyPage = { replies: NonNullable<JobLifecycle["verifiedOriginalReplies"]>; before: string | null };

export function readOlderJobReplies(applicationId: string, before: string) {
  return request<JobReplyPage>(`${originalReplies(applicationId)}?${new URLSearchParams({ before })}`, {}, ownerJobs);
}

export function confirmJobReply(applicationId: string, messageId: string) {
  return request<{ id: string }>(`${originalReplies(applicationId)}/confirmation`, json("PUT", { messageId }), ownerJobs);
}
async function reviewCommand<T>(path: string, method: string, body: unknown, idempotencyKey: string = crypto.randomUUID()) {
  const init = { ...json(method, body), headers: { "Idempotency-Key": idempotencyKey } };
  try {
    return await request<T>(path, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return request<T>(path, init);
  }
}

type ReviewableResponse = operations["getJobReviewableIds"]["responses"][200]["content"]["application/json"];
type ReviewSessionResponse = operations["getJobReviewSession"]["responses"][200]["content"]["application/json"];

function applicationQuery(query: ApplicationsQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
}

export const jobsClient = {
  overview: (signal?: AbortSignal) => request<Overview>("/overview", { signal }),
  applications: (query: ApplicationsQuery, signal?: AbortSignal) =>
    request<ApplicationsPage>(`/applications?${applicationQuery(query)}`, { signal }),
  /** IDs of every application matching a query that can be reviewed now (for "Review all"). */
  reviewableIds: (query: ApplicationsQuery, signal?: AbortSignal) =>
    request<ReviewableResponse>(`/applications/reviewable?${applicationQuery(query)}`, { signal }),
  /** One application, e.g. for answers scoped to a single listing in Reusable details. */
  application: (id: string, signal?: AbortSignal) =>
    request<{ application: ApplicationDetail }>(`/applications/${encodeURIComponent(id)}`, { signal }),
  lifecycle: (id: string, signal?: AbortSignal) =>
    request<JobLifecycle>(`/applications/${encodeURIComponent(id)}/lifecycle`, { signal }),
  changeLifecycle: (id: string, change: JobLifecycleChange, idempotencyKey?: string) =>
    reviewCommand<JobLifecycle>(`/applications/${encodeURIComponent(id)}`, "PATCH", change, idempotencyKey),
  scheduleInterview: (id: string, input: JobInterviewInput) =>
    request<JobInterview>(`/applications/${encodeURIComponent(id)}/interviews`, json("POST", input)),
  /** One request for a whole review session. */
  reviewSession: (ids: string[], signal?: AbortSignal) =>
    request<ReviewSessionResponse>(`/review-session?ids=${ids.map(encodeURIComponent).join(",")}`, { signal }),
  saveResume: (id: string, expectedRevision: number, change: { summaryMarkdown?: string; resumeMarkdown?: string }, idempotencyKey?: string) =>
    reviewCommand<{ application: ApplicationDetail }>(`/applications/${encodeURIComponent(id)}`, "PATCH", { expectedRevision, ...change }, idempotencyKey),
  saveBrief: (id: string, expectedRevision: number, brief: Brief, idempotencyKey: string) =>
    reviewCommand<operations["saveMissingJobBrief"]["responses"][200]["content"]["application/json"]>(
      `/applications/${encodeURIComponent(id)}/brief`, "PATCH", { expectedRevision, brief }, idempotencyKey),
  decide: (id: string, expectedRevision: number, decision: Decision, idempotencyKey?: string) => {
    const path = `/applications/${encodeURIComponent(id)}/decision`;
    const body = { expectedRevision, ...decision };
    return reviewCommand<{ application: ApplicationRow }>(path, "POST", body, idempotencyKey);
  },
  submissions: (signal?: AbortSignal) => request<Submissions>("/submissions", { signal }),
  resolve: (id: string, resolution: Resolution, idempotencyKey?: string) =>
    reviewCommand<{ submission: Submission }>(`/submissions/${encodeURIComponent(id)}/resolve`, "POST", resolution, idempotencyKey),
  setRunnerPaused: (paused: boolean, idempotencyKey?: string) => reviewCommand<{ runner: Runner }>("/runner", "PATCH", { paused }, idempotencyKey),
  pairRunner: () => request<operations["pairJobsRunner"]["responses"][200]["content"]["application/json"]>("/runner/pairing", json("POST", {})),
};
