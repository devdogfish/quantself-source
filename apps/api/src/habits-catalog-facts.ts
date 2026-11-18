import type { HabitProjection } from "./habits-definition";
import type { CatalogFact, DayState } from "./habits-insights-schema";
import { bucketDays, gate, gateRule, isRep, isResolved, observationDay, shiftHabitDate, type Observation } from "./habits-insights-facts";

type Day = { date: string; state: DayState };
export function recoveryFacts(days: Day[]) {
  const resolved = days.filter(isResolved);
  let misses = 0, recovered = 0;
  for (let i = 0; i < resolved.length - 1; i++) {
    if (resolved[i]!.state !== "missed") continue;
    misses++;
    if (isRep(resolved[i + 1]!)) recovered++;
  }
  return { misses, recovered };
}
/** Same projection on the API and in the optimistic Web Client; no clock or I/O. */
export function projectCatalogFact(fact: CatalogFact, state: DayState = fact.today) {
  const rep = isRep({ state }), resolved = rep || state === "missed";
  const nextAfterMiss = resolved && fact.prior.previousResolved === "missed";
  const evaluation = gate(bucketDays([...fact.gateHistory, { date: fact.date, state }], fact.weekly), fact.rule).gate;
  return {
    reps: fact.prior.reps + Number(rep),
    eligible: fact.prior.eligible + Number(resolved),
    lastDone: rep ? fact.date : fact.prior.lastDone,
    recentReps: fact.prior.recentReps,
    recentEligible: fact.prior.recentEligible,
    recovery: { misses: fact.prior.recovery.misses + Number(nextAfterMiss), recovered: fact.prior.recovery.recovered + Number(nextAfterMiss && rep) },
    gate: { ...evaluation, misses: evaluation.eligible - evaluation.reps, left: evaluation.window - evaluation.required - (evaluation.eligible - evaluation.reps) },
  };
}
export function catalogFacts(projection: HabitProjection, observations: Observation[], today: string): CatalogFact[] {
  const grouped = new Map<string, Day[]>();
  for (const row of observations) {
    if (row.date > today) continue;
    const list = grouped.get(row.habitId) ?? [];
    list.push(observationDay(row, today)); grouped.set(row.habitId, list);
  }
  const stacks = new Map(projection.stacks.map(s => [s.id, s]));
  return projection.habits.map(h => {
    const days = (grouped.get(h.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const past = days.filter(d => d.date < today), resolved = past.filter(isResolved);
    const recent = resolved.filter(d => d.date >= shiftHabitDate(today, -28));
    const schedule = h.schedule ?? stacks.get(h.stack)?.days;
    const weekly = Array.isArray(schedule) && schedule.length === 1;
    const rule = gateRule(projection, h, weekly);
    return {
      id: h.id, date: today, weekly, rule,
      today: days.find(d => d.date === today)?.state ?? "none",
      prior: { reps: resolved.filter(isRep).length, eligible: resolved.length,
        recentReps: recent.filter(isRep).length, recentEligible: recent.length,
        lastDone: past.findLast(isRep)?.date ?? null, recovery: recoveryFacts(past),
        previousResolved: resolved.at(-1)?.state ?? null },
      // Bounded sufficient context for the same gate evaluation during Undo/Redo.
      gateHistory: bucketDays(past, weekly).filter(isResolved).slice(-rule.window - 1),
    };
  });
}
