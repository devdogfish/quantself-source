import type { Habit, HabitProjection } from "./habits-definition";
import type { DayState, OverviewHabit } from "./habits-insights-schema";

type Day = OverviewHabit["days"][number];
export type Observation = { habitId: string; date: string; status: string };
export function shiftHabitDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function habitWeek(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const start = shiftHabitDate(date, -((weekday + 6) % 7));
  return { start, end: shiftHabitDate(start, 6) };
}
export const isRep = (day: { state: DayState }) =>
  day.state === "done" || day.state === "minimum";
export const isResolved = (day: Day) => isRep(day) || day.state === "missed";

export function observationDay(row: Observation, today: string): Day {
  const { date, status } = row;
  if (status === "open")
    return { date, state: date < today ? "missed" : "open" };
  if (status === "done" || status === "minimum" || status === "skipped")
    return { date, state: status };
  return { date, state: "none" };
}

export function gateRule(
  projection: HabitProjection,
  habit: Habit,
  weekly: boolean,
) {
  const defaults = projection.gate;
  return (
    habit.gate ??
    (weekly ? defaults.weekly : defaults.daily) ??
    (weekly && defaults.window === 14 && defaults.required === 10
      ? { window: 4, required: 3 }
      : { window: defaults.window, required: defaults.required })
  );
}

export function gate(rows: Day[], rule: { window: number; required: number }) {
  const recent = rows.filter(isResolved).slice(-rule.window);
  const reps = recent.filter(isRep).length;
  const state =
    recent.length < rule.window
      ? "pending"
      : reps >= rule.required
        ? "pass"
        : "fail";
  return {
    gate: {
      ...rule,
      reps,
      eligible: recent.length,
      state,
    } satisfies OverviewHabit["gate"],
    minimumRatio: reps
      ? recent.filter((day) => day.state === "minimum").length / reps
      : 0,
  };
}

const weekPriority: Record<DayState, number> = {
  none: 0,
  skipped: 1,
  missed: 2,
  open: 3,
  minimum: 4,
  done: 5,
};

export function bucketDays(rows: Day[], weekly: boolean): Day[] {
  if (!weekly) return rows;
  const buckets = new Map<string, DayState>();
  for (const { date, state } of rows) {
    const key = habitWeek(date).end;
    const previous = buckets.get(key) ?? "none";
    buckets.set(
      key,
      weekPriority[state] > weekPriority[previous] ? state : previous,
    );
  }
  return [...buckets].map(([date, state]) => ({ date, state }));
}
