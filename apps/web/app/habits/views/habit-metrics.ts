export type State = "done" | "minimum" | "skipped" | "missed" | "none" | "open";
export type Stack = { id: string; name: string; cue: string; anchor: string; minutes: number; place: string; scheduleLabel?: string };
export type Habit = {
  id: string; name: string; stack: string; kind: "build" | "break"; status: "testing" | "building" | "established" | "pending" | "paused";
  identity: string; minimum: string; full: string; fallback?: string; started: string; startedDate?: string; cue?: string;
  gate: { window: number; required: number }; weekly?: boolean;
  triggers?: string[]; protocol?: string[]; substitution?: string; untracked?: boolean;
};


export const DAYS = 364;
export const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-CA", o);
export const feelings = ["Tired", "Low energy", "Busy", "Anxious", "Bored", "Away from home", "Unmotivated"];
export type Ask = { id?: string; outcomeRevision?: number | null; date?: string; at?: string; day: string; feeling: string; habit: string; outcome: "did minimum" | "did full" | "skipped" | "unknown" };
// ---- Derived metrics. Minimum counts as a rep (Clear: "don't put up a zero"). Skips are excluded.
export const counts = (s: State) => s === "done" || s === "minimum";
export function chain(h: State[]) {
  let n = 0, misses = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    const s = h[i]!;
    if (s === "open" || s === "none" || s === "skipped") { if (s === "none" && n) break; continue; }
    if (s === "missed") { misses++; if (misses >= 2) break; continue; }
    misses = 0; n++;
  }
  return n;
}
export function recent(h: State[], days: number) {
  const slice = h.slice(-days).filter((s) => s !== "none" && s !== "skipped" && s !== "open");
  return { reps: slice.filter(counts).length, eligible: slice.length, misses: slice.filter((s) => s === "missed").length };
}
// The gate window: the last N scheduled occurrences, not counting today while it is still open.
export function gateCells(habit: Habit, h: State[]) {
  const base = h.at(-1) === "open" ? h.slice(0, -1) : h;
  return base.filter((s) => s !== "none").slice(-habit.gate.window);
}
export function gate(habit: Habit, h: State[]) {
  const cells = gateCells(habit, h);
  const w = recent(cells, cells.length);
  const allowed = habit.gate.window - habit.gate.required;
  const left = allowed - w.misses;
  const state: "pending" | "pass" | "fail" = w.eligible < habit.gate.window ? "pending" : w.reps >= habit.gate.required ? "pass" : "fail";
  return { ...w, allowed, left, state };
}
// Never miss twice: the last logged occurrence before today was a miss and today is still open.
export function atRisk(h: State[]) {
  const today = h[h.length - 1];
  const prev = [...h.slice(0, -1)].reverse().find((s) => s !== "none" && s !== "skipped");
  return today === "open" && prev === "missed";
}

// ---- Insight helpers (no extra logging: everything comes from done / minimum / missed).
// Clear, ch. 11: habits form on frequency, not time. Learning-curve estimate: automaticity = 1 - e^(-reps/k).
export const AUTOMATIC_K = 30; // ≈ 66 reps to reach ~90%, in line with Lally et al. (median 66 days)
export const automaticity = (reps: number) => 1 - Math.exp(-reps / AUTOMATIC_K);
export const lifetimeReps = (h: State[]) => h.filter(counts).length;
// Share of reps done at the full version, in 4-week buckets (oldest first). Rising = getting easier.
export function fullShare(h: State[], buckets = 3, size = 28) {
  return Array.from({ length: buckets }, (_, b) => {
    const end = h.length - (buckets - 1 - b) * size;
    const s = h.slice(Math.max(0, end - size), end).filter(counts);
    return s.length ? s.filter((x) => x === "done").length / s.length : null;
  });
}
// Misses by weekday (0 = Sunday) across the whole history.
export function missesByWeekday(h: State[], dates: Date[]) {
  const out = Array(7).fill(0) as number[];
  h.forEach((s, i) => { if (s === "missed") out[dates[i]!.getDay()]!++; });
  return out;
}

// ---- Objective-led helpers (research/08-objectives.md).
// Identity: votes (done + minimum) per week, oldest first.
export function weeklyVotes(h: State[], weeks = 13) {
  return Array.from({ length: weeks }, (_, w) => h.slice(h.length - (weeks - w) * 7, h.length - (weeks - w - 1) * 7).filter(counts).length);
}
// Never miss twice: of the misses followed by another occurrence, how many were followed by a rep.
export function recovery(h: State[]) {
  const occ = h.slice(0, -1).filter((s) => s !== "none" && s !== "skipped" && s !== "open");
  let misses = 0, recovered = 0;
  occ.forEach((s, i) => { if (s === "missed" && i < occ.length - 1) { misses++; if (counts(occ[i + 1]!)) recovered++; } });
  return { misses, recovered };
}
