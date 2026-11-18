import { gateRule, gate, bucketDays, isRep, isResolved, observationDay, shiftHabitDate, type Observation } from "./habits-insights-facts";
import { recoveryFacts } from "./habits-catalog-facts";
import type { HabitProjection } from "./habits-definition";
import type { HabitChange } from "./habits-catalog";
import { eligible } from "./habits-definition";

export type CatalogRevision = { at: string; changes: HabitChange[] };
type Day = ReturnType<typeof observationDay>;
type TimelineHabit = { id: string; name: string; kind: string; status: string; stack: string; startDate?: string };
const pct = (n: number, d: number) => d ? Math.round(n / d * 100) : 0;
const active = (h: { kind: string; status: string }) => h.kind === "build" && ["testing", "building", "established"].includes(h.status);
const labelDate = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
const halifaxDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit" });
const localDate = (s: string) => halifaxDate.format(new Date(s));
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const automaticity = (reps: number) => 1 - Math.exp(-reps / 30);

/** Recorded status transitions, never an age-based guess about autopilot. */
export function catalogTimeline(projection: HabitProjection, revisions: CatalogRevision[], today: string) {
  const events: { date: string; h: TimelineHabit }[] = [];
  const current = new Map<string, TimelineHabit>();
  const started = new Map<string, string>();
  const autopilot = new Map<string, string>();
  const add = (date: string, h: TimelineHabit) => {
    current.set(h.id, h);
    if (active(h) && (!started.has(h.id) || date < started.get(h.id)!)) started.set(h.id, h.startDate ?? date);
    if (h.status === "established" && !autopilot.has(h.id)) autopilot.set(h.id, date);
    events.push({ date, h: { ...h } });
  };
  for (const revision of revisions) {
    const date = localDate(revision.at);
    if (date > today) continue;
    for (const change of revision.changes) {
      if (change.type === "upsertHabit") {
        const h: TimelineHabit = { id: change.id, name: change.name, kind: change.kind, status: change.status, stack: change.stack, startDate: change.startDate };
        // A recorded start date establishes activity, but never backdates autopilot.
        if (!current.has(h.id) && h.startDate && h.startDate < date && active(h)) add(h.startDate, { ...h, status: "building" });
        add(date, h);
      } else if (change.type === "setStatus") {
        const h = current.get(change.habitId) ?? projection.habits.find(h => h.id === change.habitId);
        if (h) add(date, { ...h, status: change.status });
      } else if (change.type === "archive") {
        for (const h of current.values()) if (change.target === "habit" ? h.id === change.id : h.stack === change.id) add(date, { ...h, status: "archived" });
      }
    }
  }
  for (const h of projection.habits) {
    if (!current.has(h.id) && h.startDate && active(h)) add(h.startDate, { ...h, status: "building" });
    if (!current.has(h.id) || current.get(h.id)!.status !== h.status) add(today, h);
    if (h.startDate && (!started.has(h.id) || h.startDate < started.get(h.id)!)) started.set(h.id, h.startDate);
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  const at = (date: string) => {
    const state = new Map<string, TimelineHabit>();
    for (const e of events) { if (e.date > date) break; state.set(e.h.id, e.h); }
    return [...state.values()].filter(h => active(h) && (!h.startDate || h.startDate <= date));
  };
  return { at, started, autopilot };
}

export function computeHabitSummary({ projection, revisions, occurrences, today, lifetimeReps = {} }: {
  projection: HabitProjection; revisions: CatalogRevision[]; occurrences: Observation[]; today: string; lifetimeReps?: Record<string, number>;
}) {
  const from = shiftHabitDate(today, -363), timeline = catalogTimeline(projection, revisions, today);
  const byHabit = new Map<string, Day[]>();
  for (const row of occurrences) {
    if (row.date > today) continue;
    const days = byHabit.get(row.habitId) ?? [];
    days.push(observationDay(row, today)); byHabit.set(row.habitId, days);
  }
  for (const days of byHabit.values()) days.sort((a, b) => a.date.localeCompare(b.date));
  for (const h of eligible(projection, today)) {
    const days = byHabit.get(h.id) ?? [];
    if (!days.some(d => d.date === today)) days.push({ date: today, state: "open" });
    byHabit.set(h.id, days);
  }
  const stacks = new Map(projection.stacks.map(s => [s.id, s]));
  const build = projection.habits.filter(active);
  const tracked = build.filter(h => h.tracked);
  // The live Catalog and the Habits preview use different IDs for Sunday review.
  const reviewId = byHabit.has("weekly-review") || projection.habits.some(h => h.id === "weekly-review") ? "weekly-review" : "review";
  const daysFor = (id: string, start: string, end = today) => (byHabit.get(id) ?? []).filter(d => d.date >= start && d.date <= end);
  const ruleFor = (h: HabitProjection["habits"][number]) => {
    const schedule = h.schedule ?? stacks.get(h.stack)?.days;
    const weekly = Array.isArray(schedule) && schedule.length === 1;
    return { weekly, rule: gateRule(projection, h, weekly) };
  };
  const gateFor = (h: HabitProjection["habits"][number], end = today) => {
    const { weekly, rule } = ruleFor(h);
    return gate(bucketDays((byHabit.get(h.id) ?? []).filter(d => d.date <= end), weekly), rule).gate;
  };
  const doubleDates = new Map<string, Set<string>>();
  for (const [id, days] of byHabit) {
    const doubles = new Set<string>(); let previous: Day | undefined;
    for (const d of days.filter(isResolved)) { if (d.state === "missed" && previous?.state === "missed") doubles.add(d.date); previous = d; }
    doubleDates.set(id, doubles);
  }
  const doublesSince = (id: string, start: string) => [...(doubleDates.get(id) ?? [])].filter(d => d >= start).length;
  const nWeeks = 52;
  const load = Array.from({ length: nWeeks }, (_, i) => {
    const date = shiftHabitDate(today, -(nWeeks - i - 1) * 7), live = timeline.at(date);
    return { label: labelDate(date), auto: live.filter(h => h.status === "established").length, building: live.filter(h => h.status !== "established").length };
  });
  const recoverySince = (start: string, end = today) => tracked.reduce((a, h) => {
    const r = recoveryFacts(daysFor(h.id, start, end)); return { m: a.m + r.misses, r: a.r + r.recovered };
  }, { m: 0, r: 0 });
  const healthAt = (end: string) => {
    const start = shiftHabitDate(end, -27), live = timeline.at(end);
    const rows = tracked.filter(h => h.id !== reviewId).flatMap(h => daysFor(h.id, start, end)).filter(isResolved);
    const r = recoverySince(shiftHabitDate(end, -55), end);
    const beingBuilt = live.filter(h => h.status !== "established");
    const evaluations = beingBuilt.flatMap(h => { const definition = projection.habits.find(d => d.id === h.id); return definition ? [gateFor(definition, end)] : []; });
    const review = daysFor(reviewId, start, end).filter(isResolved);
    const parts = [
      { key: "Showing up", score: pct(rows.filter(isRep).length, rows.length), weight: 25, hint: "Minimum counts. Done or minimum on scheduled days, 4 weeks." },
      { key: "Recovery", score: r.m ? pct(r.r, r.m) : live.length ? 100 : 0, weight: 25, hint: "Back the next time after a miss, 8 weeks." },
      { key: "Gates", score: evaluations.length ? Math.round(evaluations.reduce((sum, g) => sum + (g.state === "pass" ? 100 : g.state === "pending" ? 50 : 0), 0) / evaluations.length) : live.length ? 100 : 0, weight: 20, hint: "Habits being built that pass their gate." },
      { key: "Autopilot", score: pct(live.filter(h => h.status === "established").length, live.length), weight: 15, hint: "Share of carried habits that run on their own." },
      { key: "Review", score: pct(review.filter(isRep).length, review.length), weight: 15, hint: "Sunday reviews done, last 4 weeks." },
    ];
    return { parts, total: Math.round(parts.reduce((sum, p) => sum + p.score * p.weight, 0) / 100) };
  };
  const health = healthAt(shiftHabitDate(today, -1)), healthPrev = healthAt(shiftHabitDate(today, -29));
  const band = health.total >= 90 ? { word: "Healthy", color: "green.solid" } : health.total >= 75 ? { word: "Stable", color: "brand.solid" } : health.total >= 55 ? { word: "Strained", color: "orange.solid" } : { word: "At risk", color: "red.solid" };
  const weakest = [...health.parts].sort((a, b) => a.score - b.score)[0]!;
  const gates = build.filter(h => h.status !== "established").map(h => ({ h, g: gateFor(h) }));
  const notPassing = gates.filter(x => x.g.state !== "pass");
  const recentDoubles = tracked.reduce((sum, h) => sum + doublesSince(h.id, shiftHabitDate(today, -13)), 0);
  const newest = [...build].sort((a, b) => (timeline.started.get(b.id) ?? "").localeCompare(timeline.started.get(a.id) ?? ""))[0];
  const newestStart = newest && timeline.started.get(newest.id);
  const newestDays = newestStart ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(newestStart)) / 86400000)) : 0;
  const repsFor = (id: string) => lifetimeReps[id] ?? (byHabit.get(id) ?? []).filter(isRep).length;
  const anchor = [...build].sort((a, b) => Number(b.status === "established") - Number(a.status === "established") || repsFor(b.id) - repsFor(a.id))[0];
  const checks = [
    { ok: notPassing.length === 0, label: "Every habit being built passes its gate", detail: notPassing.length ? `Not yet: ${notPassing.map(x => x.h.name).join(", ")}` : `${gates.length} of ${gates.length} passing` },
    { ok: recentDoubles === 0, label: "No habit missed twice in a row, last 2 weeks", detail: recentDoubles ? `${recentDoubles} double miss${recentDoubles > 1 ? "es" : ""}` : "None" },
    { ok: Boolean(newestStart) && newestDays >= 28, label: "Newest habit has run for 4 weeks", detail: newest ? `${newest.name}: ${newestDays} days` : "No active habits" },
  ];
  const activity = Array.from({ length: 364 }, (_, i) => ({ date: shiftHabitDate(from, i), due: 0, reps: 0, misses: 0, doubles: 0, open: false }));
  const activityByDate = new Map(activity.map(d => [d.date, d]));
  for (const [id, days] of byHabit) for (const d of days) {
    const a = activityByDate.get(d.date); if (!a || d.state === "none" || d.state === "skipped") continue;
    a.due++; a.reps += Number(isRep(d)); a.misses += Number(d.state === "missed"); a.doubles += Number(doubleDates.get(id)?.has(d.date)); a.open ||= d.state === "open";
  }
  const slots = projection.stacks.flatMap(st => weekdays.map((_, d) => {
    const rows = tracked.filter(h => h.stack === st.id).flatMap(h => daysFor(h.id, from)).filter(day => new Date(`${day.date}T12:00:00Z`).getUTCDay() === d && isResolved(day));
    const m = rows.filter(day => day.state === "missed").length;
    return { st: { id: st.id, name: st.name }, d, m, due: rows.length, rate: pct(m, rows.length) };
  })).filter(s => s.due >= 8).sort((a, b) => b.rate - a.rate || a.st.id.localeCompare(b.st.id) || a.d - b.d);
  const rows = tracked.map(h => {
    const days = daysFor(h.id, shiftHabitDate(today, -28), shiftHabitDate(today, -1)), resolved = days.filter(isResolved), reps = days.filter(isRep);
    return { h, c: pct(reps.length, resolved.length), doubles: doublesSince(h.id, shiftHabitDate(today, -27)), g: gateFor(h), minShare: reps.length ? reps.filter(d => d.state === "minimum").length / reps.length : 0, auto: automaticity(repsFor(h.id)) };
  }).sort((a, b) => a.c - b.c);
  type Finding = { tone: "risk" | "warn" | "win"; what: string; why: string; change: string; habit?: string };
  const worst = slots[0];
  const findings: Finding[] = [
    ...rows.filter(r => r.g.state === "fail").map((r): Finding => ({ tone: "risk", habit: r.h.id, what: r.h.name, why: `Below gate: ${r.g.reps} of ${r.g.eligible}`, change: "Shrink the minimum or move the cue" })),
    ...rows.filter(r => r.doubles >= 1).map((r): Finding => ({ tone: "risk", habit: r.h.id, what: r.h.name, why: `Missed twice in a row ${r.doubles === 1 ? "once" : `${r.doubles}×`} in 4 weeks`, change: r.h.fallback ? "Make the fallback smaller or earlier" : "Add an 'If I miss' plan" })),
    ...(worst ? [{ tone: "warn" as const, what: `${worst.st.name}, ${weekdays[worst.d]}`, why: `${worst.rate}% missed, weakest slot`, change: `Check the cue happens on ${weekdays[worst.d]}s` }] : []),
    ...rows.filter(r => r.minShare >= 0.6 && r.auto > 0.6).map((r): Finding => ({ tone: "warn", habit: r.h.id, what: r.h.name, why: `${Math.round(r.minShare * 100)}% of reps were the minimum`, change: "Fine. Nudge the full version if it feels easy" })),
    ...rows.filter(r => r.g.state === "pass" && r.auto >= 0.9 && r.h.status !== "established").map((r): Finding => ({ tone: "win", habit: r.h.id, what: r.h.name, why: "Passed its gate, runs on its own", change: "Mark established or stack the next habit" })),
  ];
  const currentDay = activity.at(-1)!;
  return { asOf: today, logged: currentDay.reps, due: currentDay.due, nWeeks, health, healthPrev: { total: healthPrev.total }, band, weakest,
    rec: recoverySince(shiftHabitDate(today, -55)), doubles: tracked.reduce((sum, h) => sum + doublesSince(h.id, shiftHabitDate(today, -27)), 0),
    passing: gates.filter(x => x.g.state === "pass").length, gateCount: gates.length, checks, ready: checks.every(c => c.ok), wait: Math.max(0, 28 - newestDays), anchor: anchor ? { id: anchor.id, name: anchor.name } : null,
    load, autoNow: load.at(-1)!.auto, autoThen: load[0]!.auto, activity, slots, maxRate: Math.max(...slots.map(s => s.rate), 1), findings,
    autopilotDates: Object.fromEntries(timeline.autopilot),
  };
}
export type HabitSummary = ReturnType<typeof computeHabitSummary>;
