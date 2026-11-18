import { catalogFacts } from "./habits-catalog-facts";
import {
  eligible,
  localHabitDate,
  type HabitProjection,
} from "./habits-definition";
import { detectInsights, rankInsights } from "./habits-insights-detectors";
import type {
  DayState,
  HabitOverview,
  OverviewHabit,
} from "./habits-insights-schema";
import {
  bucketDays,
  gate,
  gateRule,
  habitWeek,
  isRep,
  observationDay,
  shiftHabitDate,
  type Observation,
} from "./habits-insights-facts";

type Day = OverviewHabit["days"][number];
type Range = HabitOverview["range"];
export function buildDays(rows: Day[], range: Range, weekly: boolean): Day[] {
  const byDate = new Map(rows.map((day) => [day.date, day.state]));
  const days: Day[] = [];
  for (
    let date = range.from;
    date <= range.to;
    date = shiftHabitDate(date, 1)
  ) {
    days.push({ date, state: byDate.get(date) ?? "none" });
  }
  return bucketDays(days, weekly);
}

export function chain(rows: Day[]) {
  let chain = 0;
  let bestChain = 0;
  let misses = 0;
  for (const day of rows) {
    if (isRep(day)) {
      misses = 0;
      chain++;
      bestChain = Math.max(bestChain, chain);
    } else if (day.state === "missed") {
      misses++;
      if (misses >= 2) chain = 0;
    }
  }
  return {
    chain,
    bestChain,
    chainAtRisk: misses === 1,
    missedTwice: misses >= 2,
  };
}

export function momentum(rows: Day[], today: string) {
  const { start } = habitWeek(today);
  const last = shiftHabitDate(start, -7);
  const totals = { votes: 0, votesThisWeek: 0, votesLastWeek: 0 };
  for (const row of rows) {
    if (!isRep(row) || row.date > today) continue;
    totals.votes++;
    if (row.date >= start) totals.votesThisWeek++;
    else if (row.date >= last) totals.votesLastWeek++;
  }
  return totals;
}

type OverviewInput = {
  projection: HabitProjection;
  revisions?: readonly { at: Date | string }[];
  occurrences: Observation[];
  slips?: readonly { occurredAt: Date }[];
  asOf: Date;
  range: Range;
  reviewStatus?: NonNullable<HabitOverview["reviewDue"]["status"]>;
};

export function computeOverview({
  projection,
  revisions = [],
  occurrences,
  slips = [],
  asOf,
  range,
  reviewStatus = "missing",
}: OverviewInput): HabitOverview {
  const today = localHabitDate(asOf);
  const all = occurrences
    .filter((row) => row.date <= today)
    .map((row) => ({ ...observationDay(row, today), habitId: row.habitId }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byHabit = new Map<string, Day[]>();
  for (const row of all) {
    const rows = byHabit.get(row.habitId) ?? [];
    rows.push(row);
    byHabit.set(row.habitId, rows);
  }
  for (const habit of eligible(projection, today)) {
    const rows = byHabit.get(habit.id) ?? [];
    if (rows.at(-1)?.date !== today) rows.push({ date: today, state: "open" });
    byHabit.set(habit.id, rows);
  }
  const stacks = new Map(projection.stacks.map((stack) => [stack.id, stack]));
  const rollout = projection.habits
    .filter((h) => h.kind === "build" && h.tracked)
    .sort(
      (a, b) =>
        (a.startDate ?? "").localeCompare(b.startDate ?? "") ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
  const patternStart = shiftHabitDate(today, -27);
  const inputs = rollout
    .filter((habit) => habit.status !== "pending")
    .map((habit) => {
      const stack = stacks.get(habit.stack);
      const schedule = habit.schedule ?? stack?.days;
      const weekly = Array.isArray(schedule) && schedule.length === 1;
      const history = byHabit.get(habit.id) ?? [];
      const periods = bucketDays(history, weekly);
      const { missedTwice, ...chainStats } = chain(periods);
      const details = habit.details as Record<string, unknown> | undefined;
      const identity = details?.identity ?? habit.identity;
      const overview: OverviewHabit = {
        id: habit.id,
        name: habit.name,
        stackId: habit.stack,
        stackName: stack?.name ?? habit.stack,
        status: habit.status,
        identity: typeof identity === "string" ? identity : null,
        cadence: weekly ? "weekly" : "daily",
        days: buildDays(history, range, weekly),
        lifetimeReps: history.filter(isRep).length,
        ...chainStats,
        ...gate(periods, gateRule(projection, habit, weekly)),
      };
      return {
        overview,
        missedTwice,
        order: habit.order,
        recent: history.filter((day) => day.date >= patternStart),
        window: history.filter(
          (day) => day.date >= range.from && day.date <= range.to,
        ),
      };
    });
  const gateStates = new Map(
    inputs.map(({ overview }) => [overview.id, overview.gate.state]),
  );
  const byStack = new Map<string, typeof rollout>();
  for (const habit of rollout) {
    const stack = byStack.get(habit.stack) ?? [];
    stack.push(habit);
    byStack.set(habit.stack, stack);
  }
  const previousInStack = new Map<string, (typeof rollout)[number]>();
  for (const stack of byStack.values()) {
    stack.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    for (let i = 1; i < stack.length; i++)
      previousInStack.set(stack[i]!.id, stack[i - 1]!);
  }
  const upcoming = rollout.flatMap((habit, index) => {
    if (habit.status !== "pending") return [];
    const predecessor = previousInStack.get(habit.id) ?? rollout[index - 1];
    const waitingOn =
      predecessor && gateStates.get(predecessor.id) !== "pass"
        ? predecessor.name
        : null;
    return [
      {
        id: habit.id,
        name: habit.name,
        startDate: habit.startDate ?? null,
        waitingOn,
      },
    ];
  });
  const context = {
    revisionCount: revisions.filter((revision) => {
      const date = localHabitDate(new Date(revision.at));
      return date >= patternStart && date <= today;
    }).length,
    slipCount: slips.filter((slip) => {
      const date = localHabitDate(slip.occurredAt);
      return date >= patternStart && date <= today;
    }).length,
  };
  return {
    catalogFacts: catalogFacts(projection, occurrences, today),
    asOf: today,
    range,
    habits: inputs.map(({ overview }) => overview),
    totals: momentum(all, today),
    upcoming,
    insights: rankInsights(detectInsights(inputs, today, context)),
    reviewDue: { date: habitWeek(today).end, done: reviewStatus === "exists", status: reviewStatus },
  };
}
