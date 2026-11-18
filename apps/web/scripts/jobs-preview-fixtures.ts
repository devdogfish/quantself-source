// Sample implementation of the Jobs API contract (app/jobs/jobs-client.ts) for `bun run preview:jobs`.
// In-memory only; it doubles as a behavioural reference for the backend. No database, no network.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApplicationDetail, ApplicationRow, ApplicationsPage, ApplicationsQuery, Brief, Decision, JobLifecycle, Overview, Resolution, Status, Submission, Submissions, TabKey,
} from "../app/jobs/jobs-client";
import { agentVerdict, dueAt, jobBrief, NOW, sampleApplications, sampleResume, splitResume, tailorSummary } from "./jobs-preview-sample-data";

const USD_TO_CAD = 1.38; // Preview only; the API converts with the Budgeting FX converter.
const HOURS_PER_YEAR = 2080;
const tabs: Record<TabKey, Status[] | null> = {
  all: null, review: ["review"], progress: ["draft", "approved", "queued", "submitting"], attention: ["needs_attention"],
  applied: ["applied"], closed: ["rejected", "skipped", "disqualified", "saved_for_later"],
};

type State = { status: Status; issue: ApplicationRow["issue"]; revision: number; approvedRevision: number | null; summary?: string; resume?: string };
const state = new Map<string, State>(sampleApplications.map((a) => [a.id, {
  status: a.status, issue: a.issueCode, revision: a.revision, approvedRevision: a.approvedRevision,
}]));
let paused = false;

function pay(salary: string | null, usd: boolean): Brief["pay"] {
  const numbers = (salary?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (numbers.length < 2) return { hourlyCad: null, original: null, converted: false };
  const rate = usd ? USD_TO_CAD : 1;
  const hourly = (k: number) => Math.round((k * 1000 * rate) / HOURS_PER_YEAR);
  return {
    hourlyCad: { min: hourly(numbers[0]), max: hourly(numbers[1]) },
    original: usd ? `US$${numbers[0]}k–$${numbers[1]}k a year` : null,
    converted: usd,
  };
}

function brief(a: (typeof sampleApplications)[number]): Brief {
  const b = jobBrief(a);
  const usd = a.location === "Remote";
  const people = Number((b.size.label.match(/[\d,]+/)?.[0] ?? "").replace(/,/g, "")) || null;
  return {
    doing: b.doing,
    remote: b.remote.confirmed ? "confirmed" : /hybrid/i.test(b.remote.label) ? "hybrid" : "not_stated",
    pay: pay(a.salary, usd),
    companySize: { people, label: b.size.label },
    automatable: b.automatable.toLowerCase() as Brief["automatable"],
    humanContact: { level: b.contact.startsWith("High") ? "high" : "low", note: b.contact.replace(/^\w+: (\w)/, (_m, c: string) => c.toUpperCase()) },
    meetings: { level: /daily/i.test(b.meetings) ? "daily" : /weekly/i.test(b.meetings) ? "weekly" : "rare", note: b.meetings },
  };
}

function row(a: (typeof sampleApplications)[number]): ApplicationRow {
  const s = state.get(a.id)!;
  const due = dueAt(a);
  return {
    id: a.id, company: a.company, role: a.role, track: a.resumeTrack, status: s.status, issue: s.issue,
    verdict: s.issue === "model_error" ? null : agentVerdict(a).level, dueAt: due === null ? null : new Date(due).toISOString(),
    source: a.sourceLabel, sourceUrl: a.sourceUrl, updatedAt: a.updatedAt, appliedAt: a.appliedAt,
  };
}

const reviewable = (r: ApplicationRow) => r.status === "review" || (r.status === "needs_attention" && r.issue === "model_error");
const score = (r: ApplicationRow) => (r.verdict === "strong" ? 3 : r.verdict === "review" ? 2 : r.verdict === "weak" ? 1 : 0);

function filtered(query: ApplicationsQuery, withTab: boolean) {
  const days = (iso: string | null) => (iso === null ? null : Math.round((Date.parse(iso) - NOW) / 86_400_000));
  return sampleApplications.map(row).filter((r) => {
    const d = days(r.dueAt);
    if (query.track && r.track !== query.track) return false;
    if (query.status && r.status !== query.status) return false;
    if (query.verdict && r.verdict !== query.verdict) return false;
    if (query.due === "none" && d !== null) return false;
    if (query.due === "overdue" && (d === null || d >= 0)) return false;
    if (query.due === "week" && (d === null || d < 0 || d > 7)) return false;
    if (query.due === "fortnight" && (d === null || d < 0 || d > 14)) return false;
    if (query.q && !`${r.company} ${r.role}`.toLowerCase().includes(query.q.toLowerCase())) return false;
    const statuses = withTab ? tabs[query.tab ?? "all"] : null;
    return !statuses || statuses.includes(r.status);
  }).sort((a, b) => query.sort === "match" ? score(b) - score(a)
    : query.sort === "updated" ? b.updatedAt.localeCompare(a.updatedAt)
    : (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
}

export function applicationLifecycle(id: string): JobLifecycle | null {
  const sample = sampleApplications.find((application) => application.id === id);
  return sample ? {
    application: row(sample), revision: 0, changedAt: null,
    transitions: [], sourceReplyLinked: false, sourceReplyUrl: null, appointments: [],
  } : null;
}

export function applications(query: ApplicationsQuery): ApplicationsPage {
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 15));
  const all = filtered(query, true);
  const base = filtered(query, false);
  const page = Math.max(1, query.page ?? 1);
  const tabCounts = Object.fromEntries(Object.entries(tabs).map(([k, statuses]) => [k, base.filter((r) => !statuses || statuses.includes(r.status)).length])) as Record<TabKey, number>;
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, pageSize, tabCounts };
}

export function reviewableIds(query: ApplicationsQuery) {
  return { ids: filtered(query, true).filter(reviewable).map((r) => r.id) };
}

// The Owner's real base résumés, read from the local runner config (development only, never copied).
let resumes: Record<string, string> | undefined;
async function localResumes(): Promise<Record<string, string>> {
  if (resumes) return resumes;
  try {
    const home = process.env.QUANTSELF_JOBS_HOME || join(homedir(), ".local/share/quantself/jobs");
    const config = JSON.parse(await readFile(join(home, "private.json"), "utf8")) as { resumePaths?: Record<string, string> };
    resumes = Object.fromEntries(await Promise.all(Object.entries(config.resumePaths ?? {}).map(async ([t, p]) => [t, await readFile(p, "utf8").catch(() => sampleResume)])));
  } catch { resumes = {}; }
  return resumes ?? {};
}

export async function reviewSession(ids: string[]): Promise<{ items: ApplicationDetail[] }> {
  const base = await localResumes();
  const items = ids.map((id) => sampleApplications.find((a) => a.id === id)).filter((a) => a !== undefined).map((a) => {
    const s = state.get(a.id)!;
    const parts = splitResume(base[a.resumeTrack] ?? sampleResume);
    const summary = s.summary ?? tailorSummary(parts.bullets, jobBrief(a).size.band).map((b) => `- ${b}`).join("\n");
    const resume = s.resume ?? [parts.head.trim(), "## Summary", summary, parts.tail.trim()].join("\n\n");
    return {
      ...row(a), brief: s.issue === "model_error" ? null : brief(a), postingText: a.description, revision: s.revision, approvedRevision: s.approvedRevision,
      summaryMarkdown: summary, resumeMarkdown: resume,
      pdfUrl: s.approvedRevision === s.revision ? `/api/v1/jobs/applications/${a.id}/resume.pdf?track=${a.resumeTrack}` : null,
    } satisfies ApplicationDetail;
  });
  return { items };
}

export async function saveResume(id: string, body: { expectedRevision: number; summaryMarkdown?: string; resumeMarkdown?: string }) {
  const s = state.get(id);
  if (!s) return null;
  if (body.expectedRevision !== s.revision) return "conflict" as const;
  s.revision += 1;
  if (body.summaryMarkdown !== undefined) s.summary = body.summaryMarkdown;
  if (body.resumeMarkdown !== undefined) {
    s.resume = body.resumeMarkdown;
    s.summary = splitResume(body.resumeMarkdown).bullets.map((b) => `- ${b}`).join("\n");
  }
  return (await reviewSession([id])).items[0];
}

export function decide(id: string, body: { expectedRevision: number } & Decision) {
  const s = state.get(id);
  if (!s) return null;
  if (body.expectedRevision !== s.revision) return "conflict" as const;
  const next: Record<Decision["action"], Status> = { approve: "approved", skip: "skipped", later: "saved_for_later", reject: "rejected", revise: "draft", retry_draft: "draft", reopen: "review" };
  s.status = next[body.action];
  if (body.action === "approve") s.approvedRevision = s.revision;
  if (body.action === "retry_draft") s.issue = null;
  return row(sampleApplications.find((a) => a.id === id)!);
}

function runner(): Overview["runner"] {
  const submitting = [...state.values()].some((s) => s.status === "submitting");
  return { state: paused ? "paused" : submitting ? "submitting" : "idle", host: "mac-studio", lastHeartbeatAt: new Date(NOW - 40_000).toISOString() };
}

export function setPaused(value: boolean) { paused = value; return { runner: runner() }; }

export function overview(): Overview {
  const rows = sampleApplications.map(row);
  return {
    waitingOnYou: rows.filter((r) => r.status === "review" || r.status === "needs_attention").length,
    waitingOnRunner: rows.filter((r) => ["approved", "queued", "submitting"].includes(r.status)).length,
    runner: runner(),
    metrics: { applied: 52, approvalRate: 0.75, responseRate: 0.21, medianDaysToApply: 1.4 },
    pipeline: { drafted: 197, reviewed: 171, approved: 128, applied: 114 },
    weekly: [
      ["Sep 7", 14, 6], ["Sep 14", 18, 9], ["Sep 21", 11, 7], ["Sep 28", 22, 12], ["Oct 5", 19, 10],
      ["Oct 12", 25, 15], ["Oct 19", 16, 11], ["Oct 26", 21, 13], ["Nov 2", 27, 17], ["Nov 9", 24, 14],
    ].map(([week, drafted, applied]) => ({ week: week as string, drafted: drafted as number, applied: applied as number })),
    alignment: [
      { verdict: "strong", drafts: 64, approved: 58, skipped: 4, rejected: 2 },
      { verdict: "review", drafts: 72, approved: 42, skipped: 21, rejected: 9 },
      { verdict: "weak", drafts: 35, approved: 3, skipped: 22, rejected: 10 },
    ],
  };
}

const stepLabels = ["Approved", "Queued", "Runner claimed", "Portal opened", "Form filled", "Submitted", "Receipt captured"];
function steps(r: ApplicationRow, receipt: Submission["receipt"]): Submission["steps"] {
  const failAt = r.issue === "unsupported_portal" ? 3 : r.issue === "manual_required" ? 4 : r.issue === "submission_uncertain" ? 5 : r.issue === "runner_unavailable" ? 2 : -1;
  const reached = r.status === "applied" ? 7 : r.status === "submitting" ? 4 : r.status === "queued" ? 2 : r.status === "approved" ? 1 : failAt;
  const error = r.issue === "submission_uncertain" ? "Clicked Submit; no confirmation page within 60s"
    : r.issue === "unsupported_portal" ? "Workday tenant uses a custom login flow"
    : r.issue === "manual_required" ? "Portal asked for a work authorization document" : "Runner stopped responding";
  return stepLabels.map((label, i) => {
    let s: Submission["steps"][number]["state"] = i < reached ? "done" : "pending";
    if (i === reached && r.status === "submitting") s = "running";
    if (i === failAt && r.status === "needs_attention") s = "failed";
    if (r.status === "applied" && i === 6 && !receipt) s = "pending";
    return { label, state: s, durationMs: s === "done" ? (12 + i * 7) * 1000 : null,
      attempts: s === "failed" ? [{ at: new Date(NOW - 3_600_000).toISOString(), error }] : [] };
  });
}

export function submissions(): Submissions {
  const items = sampleApplications.map((a) => ({ a, r: row(a) }))
    .filter(({ r }) => ["approved", "queued", "submitting", "applied", "needs_attention"].includes(r.status) && r.issue !== "model_error")
    .map(({ a, r }) => {
      const receipt = r.status === "applied" ? a.receiptCode : null;
      return {
        ...r, approvedRevision: state.get(a.id)!.approvedRevision, receipt, steps: steps(r, receipt),
        privatePauseFieldKeys: r.issue === "manual_required" ? pausedFieldKeys(a.id) : undefined,
        phase: r.status === "submitting" ? "Filling form" : null,
        durationMs: ["queued", "approved"].includes(r.status) ? null : (40 + ((Number(a.id.slice(-2)) * 53) % 170)) * 1000,
      } satisfies Submission;
    });
  return { runner: runner(), items };
}

export function resolve(id: string, body: Resolution) {
  const s = state.get(id);
  if (!s) return null;
  s.status = body.action === "mark_applied" ? "applied" : body.action === "skip" ? "skipped" : "queued";
  s.issue = null;
  return { submission: submissions().items.find((i) => i.id === id) ?? null };
}

/** The most recent runner-rendered PDF for a track, from the local Jobs home (development only). */
export async function localPdf(track: string | null) {
  const root = join(process.env.QUANTSELF_JOBS_HOME || join(homedir(), ".local/share/quantself/jobs"), "applications");
  const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  const found: { path: string; time: number; track: string | null }[] = [];
  for (const app of await list(root)) {
    const revisions = await list(join(root, app));
    let appTrack: string | null = null;
    for (const rev of revisions) {
      const approved = await readFile(join(root, app, rev, "approved.json"), "utf8").catch(() => null);
      if (approved) { appTrack = (JSON.parse(approved) as { resumeTrack?: string }).resumeTrack ?? null; break; }
    }
    for (const rev of revisions) for (const folder of (await list(join(root, app, rev))).filter((f) => f.startsWith("pdf-"))) {
      const path = join(root, app, rev, folder, "resume.pdf");
      const info = await stat(path).catch(() => null);
      if (info) found.push({ path, time: info.mtimeMs, track: appTrack });
    }
  }
  found.sort((a, b) => b.time - a.time);
  const pick = found.find((f) => f.track === track) ?? found[0];
  return pick ? readFile(pick.path) : null;
}

// ---- Profile: candidate context and reusable details (existing API shapes), sample values only ----

let context = { markdown: "# Candidate context\n\n## Application defaults\n\n- Can start one week after accepting an offer.\n- Prior work experience beyond the résumé: no.", version: 1 };
export const candidateContext = () => context;
export function saveCandidateContext(body: { markdown: string; expectedVersion: number }) {
  if (body.expectedVersion !== context.version) return null;
  context = { markdown: body.markdown, version: context.version + 1 };
  return context;
}

type Scope = { kind: "global" } | { kind: "track"; track: string } | { kind: "listing"; applicationId: string };
type Field = { id: string; key: string; label: string; type: string; scope: Scope; options: string[]; hasValue: boolean; version: number; updatedAt: string; value: unknown };
const pausedId = sampleApplications.find((a) => a.status === "needs_attention" && a.issueCode === "manual_required")?.id;
const scopeKey = (scope: Scope) => scope.kind === "global" ? "global" : scope.kind === "track" ? `track:${scope.track}` : `listing:${scope.applicationId}`;
const fields = new Map<string, Field>();
const seed = (key: string, label: string, type: string, value: unknown, scope: Scope = { kind: "global" }) =>
  fields.set(`${scopeKey(scope)}:${key}`, { id: `${scopeKey(scope)}:${key}`, key, label, type, scope, options: [], hasValue: value !== null, version: 1, updatedAt: new Date(NOW).toISOString(), value });
seed("firstName", "First name", "text", "Sample");
seed("lastName", "Last name", "text", "Owner");
seed("phone", "Phone number", "phone", "+1 902 555 0123");
seed("linkedin", "LinkedIn profile", "url", "https://www.linkedin.com/in/sample-owner");
seed("website", "Website or portfolio", "url", "https://example.com");
seed("city", "City", "text", "Halifax");
seed("country", "Country of residence", "text", "Canada");
seed("website", "Website or portfolio", "url", "https://example.com/engineering", { kind: "track", track: "engineering" });
if (pausedId) seed("question.work-authorization-document", "Work authorization document link", "url", null, { kind: "listing", applicationId: pausedId });

export const pausedFieldKeys = (id: string) => (id === pausedId ? ["question.work-authorization-document"] : undefined);
const visible = (applicationId?: string) => [...fields.values()].filter((f) => f.scope.kind !== "listing" || f.scope.applicationId === applicationId);
const metadata = ({ value: _value, ...f }: Field) => f;
export const privateValues = (applicationId?: string) => ({ fields: visible(applicationId) });
export const privateMetadata = (applicationId?: string) => ({ fields: visible(applicationId).map(metadata) });
export function savePrivateFields(body: { fields: Array<{ key: string; label: string; type: string; scope: Scope; options: string[]; expectedVersion: number | null; value: unknown }> }) {
  const saved: Field[] = [];
  for (const write of body.fields) {
    const id = `${scopeKey(write.scope)}:${write.key}`;
    const current = fields.get(id);
    if ((current?.version ?? null) !== write.expectedVersion && !(current === undefined && write.expectedVersion === null)) return null;
    const next = { id, key: write.key, label: write.label, type: write.type, scope: write.scope, options: write.options ?? [], hasValue: write.value !== null && write.value !== "",
      version: (current?.version ?? 0) + 1, updatedAt: new Date().toISOString(), value: write.value };
    fields.set(id, next);
    saved.push(next);
  }
  // Answering every listing question the runner paused for resumes that application.
  const resumedApplicationIds: string[] = [];
  if (pausedId && saved.some((f) => f.key === "question.work-authorization-document" && f.hasValue)) {
    const s = state.get(pausedId);
    if (s && s.status === "needs_attention") { s.status = "queued"; s.issue = null; resumedApplicationIds.push(pausedId); }
  }
  return { fields: saved.map(metadata), resumedApplicationIds };
}
