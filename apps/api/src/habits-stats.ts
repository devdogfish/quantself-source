import type { HabitProjection } from "./habits-definition";
import {
  gate,
  gateRule,
  observationDay,
  type Observation,
} from "./habits-insights-facts";
export {
  habitWeek,
  shiftHabitDate,
  type Observation,
} from "./habits-insights-facts";
export function deriveHabitStats(
  projection: HabitProjection,
  rows: Observation[],
  today: string,
) {
  const grouped = new Map<string, Observation[]>();
  for (const r of rows)
    if (r.date <= today) {
      const list = grouped.get(r.habitId) ?? [];
      list.push(r);
      grouped.set(r.habitId, list);
    }
  return projection.habits
    .filter((h) => h.kind === "build" && h.tracked)
    .map((h) => {
      const all = (grouped.get(h.id) ?? []).sort((a, b) =>
        b.date.localeCompare(a.date),
      );
      const resolved = all.filter(
        (r) =>
          r.status !== "skipped" && (r.status !== "open" || r.date < today),
      );
      const rep = (r: Observation) =>
        r.status === "done" || r.status === "minimum";
      const schedule =
        h.schedule ?? projection.stacks.find((s) => s.id === h.stack)?.days;
      const weekly = Array.isArray(schedule) && schedule.length === 1;
      const { gate: evaluation } = gate(
        all
          .slice()
          .reverse()
          .map((row) => observationDay(row, today)),
        gateRule(projection, h, weekly),
      );
      let currentStreak = 0;
      for (const r of resolved) {
        if (!rep(r)) break;
        currentStreak++;
      }
      return {
        habitId: h.id,
        reps: evaluation.reps,
        totalReps: all.filter(rep).length,
        currentStreak,
        skipped: all.filter((r) => r.status === "skipped").length,
        neverMissTwice:
          resolved.length >= 2 &&
          resolved.slice(0, 2).every((r) => r.status === "open"),
        gate: {
          ...evaluation,
          state:
            evaluation.state === "pending"
              ? ("insufficient" as const)
              : evaluation.state,
        },
      };
    });
}
