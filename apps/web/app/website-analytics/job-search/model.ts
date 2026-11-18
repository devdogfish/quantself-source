// Job search definitions, shared by every section of the page. Scanner visits never move an application forward.
import type { Application, Visit } from "../contract";

export type Stage = "sent" | "opened" | "engaged" | "intent" | "response";
export const stages: Stage[] = ["sent", "opened", "engaged", "intent", "response"];
export const stageLabel: Record<Stage, string> = { sent: "Sent", opened: "Opened", engaged: "Engaged", intent: "Contact intent", response: "Response" };
export const definitions = "Opened: a person (not a link scanner) opened a link. Engaged: 30 s active or 2+ pages. Contact intent: email or résumé click. Response: reply or interview, recorded in Jobs.";
const intentClicks = new Set(["Email", "Résumé", "Download résumé"]);

const dayMs = 86_400_000;
export const people = (a: Application) => a.visits.filter((v) => !v.scanner);
export const scans = (a: Application) => a.visits.length - people(a).length;
export const visitActiveSeconds = (v: Visit) => v.pages.reduce((s, p) => s + p.activeSeconds, 0);
export const activeSeconds = (a: Application) => people(a).reduce((s, v) => s + visitActiveSeconds(v), 0);
export const lastSeen = (a: Application) => people(a).reduce<string | null>((m, v) => (!m || v.at > m ? v.at : m), null);

export function reached(a: Application, stage: Stage) {
  if (!a.sentAt) return false;
  const p = people(a);
  switch (stage) {
    case "sent": return true;
    case "opened": return p.length > 0;
    case "engaged": return activeSeconds(a) >= 30 || p.some((v) => v.pages.length >= 2);
    case "intent": return p.some(v => v.ctas.some(cta => intentClicks.has(cta)));
    case "response": return a.outcome === "replied" || a.outcome === "interview";
  }
}

// Furthest stage reached; skipped stages still count as passed (a reply without a visit is a response).
export function stageOf(a: Application): Stage | null {
  if (!a.sentAt) return null;
  if (a.outcome !== "none") return "response";
  return [...stages].reverse().find((s) => reached(a, s)) ?? "sent";
}

// Warm: no response yet, and a person opened something in the last 7 days or more than once.
export function isWarm(a: Application, now: number) {
  const seen = lastSeen(a);
  return !!a.sentAt && a.outcome === "none" && !!seen && (now - Date.parse(seen) <= 7 * dayMs || people(a).length >= 2);
}

export type Status = "follow" | "waiting" | "responded" | "rejected";
export const statusLabel: Record<Status, string> = { follow: "Follow up", waiting: "Waiting", responded: "Responded", rejected: "Rejected" };
export function statusOf(a: Application, now: number): Status {
  if (a.outcome === "rejected") return "rejected";
  if (a.outcome !== "none") return "responded";
  return isWarm(a, now) ? "follow" : "waiting";
}

export const jobTypeLabels = {
  frontend: "Frontend", backend: "Backend", devops: "DevOps", "full-stack": "Full Stack",
  "web-cms": "Web / CMS", "admin-excel": "Admin / Excel", other: "General software",
};
const jobTypePatterns = [
  ["frontend", /\b(?:front[\s-]*end|ui (?:developer|engineer))\b/i],
  ["backend", /\b(?:back[\s-]*end|api (?:developer|engineer))\b/i],
  ["devops", /\b(?:dev[\s-]*ops|sre|site reliability)\b/i],
] as const;

export function jobType(a: Application): keyof typeof jobTypeLabels | null {
  if (a.resume !== "software") {
    return Object.hasOwn(jobTypeLabels, a.resume) && a.resume !== "other"
      ? a.resume as keyof typeof jobTypeLabels
      : null;
  }
  if (/\bfull[\s-]*stack\b/i.test(a.role)) return "full-stack";
  const matches = jobTypePatterns.filter(([, pattern]) => pattern.test(a.role));
  return matches.length === 1 ? matches[0][0] : "other";
}

export type Filters = { range: string; resume: string; status: string; jobType?: string };
export function filterApplications(apps: Application[], f: Filters, now: number) {
  const selectedType = f.jobType === "all" ? undefined : f.jobType;
  return apps.filter((a) =>
    (f.range === "all" || (a.sentAt && now - Date.parse(a.sentAt) <= Number(f.range) * dayMs)) &&
    (selectedType ? jobType(a) === selectedType : f.resume === "all" || a.resume === f.resume) &&
    (f.status === "all" || statusOf(a, now) === f.status));
}

// Person visits counted by the link they opened, most first.
export function linkCounts(apps: Application[]) {
  const counts = new Map<string, number>();
  for (const v of apps.flatMap(people)) counts.set(v.link, (counts.get(v.link) ?? 0) + 1);
  return [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

// Active time per portfolio page across a person's visits, most first.
export function timePerPage(a: Application) {
  const totals = new Map<string, number>();
  for (const v of people(a)) for (const p of v.pages) totals.set(p.title, (totals.get(p.title) ?? 0) + p.activeSeconds);
  return [...totals].map(([title, seconds]) => ({ title, seconds })).sort((x, y) => y.seconds - x.seconds);
}

export function duration(seconds: number) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  return m ? `${m}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.round(seconds)}s`;
}
export function when(iso: string, now: number) {
  const days = Math.floor((now - Date.parse(iso)) / dayMs);
  return days < 1 ? "Today" : days < 2 ? "Yesterday" : `${days}d ago`;
}
