import type { Insight, OverviewHabit } from "./habits-insights-schema";
import {
  habitWeek,
  isRep,
  isResolved,
  shiftHabitDate,
} from "./habits-insights-facts";

const MINIMUM_RATIO = 0.6;
const MINIMUM_REPS = 5;
const RAMP_RATIO = 0.1;
const STACK_LOW = 0.5;
const STACK_HIGH = 0.8;
const KNOCK_ON_COUNT = 3;
const KNOCK_ON_RATIO = 0.6;
const WEEKDAY_COUNT = 3;
const WEEKDAY_MULTIPLE = 2;
const SKIP_COUNT = 2;
const SKIP_MULTIPLE = 2;
const BASELINE_WEEKS = 4;
const INSIGHT_LIMIT = 6;

type Subject = {
  overview: OverviewHabit;
  missedTwice: boolean;
  order: number;
  recent: OverviewHabit["days"];
  window: OverviewHabit["days"];
};

function fact(
  kind: Insight["kind"],
  severity: Insight["severity"],
  subjects: Subject[],
  title: string,
  detail: string,
  question: string,
  discriminator?: string,
): Insight {
  const habitIds = subjects.map(({ overview }) => overview.id);
  return {
    id: [kind, ...habitIds, ...(discriminator ? [discriminator] : [])].join(
      ":",
    ),
    kind,
    severity,
    title,
    detail,
    habitIds,
    prompt: `Grill me about this habit pattern. ${title} ${detail} ${question} Ask one question at a time.`,
  };
}

export function missedTwice(subject: Subject): Insight | null {
  if (!subject.missedTwice) return null;
  return fact(
    "missed-twice",
    "attention",
    [subject],
    `${subject.overview.name}: the last two eligible occurrences were missed.`,
    "",
    "Help me identify what preceded both misses and what minimum would fit the next occurrence.",
  );
}

export function chainAtRisk(subject: Subject): Insight | null {
  if (!subject.overview.chainAtRisk) return null;
  return fact(
    "chain-at-risk",
    "attention",
    [subject],
    `${subject.overview.name}: the latest eligible occurrence was missed.`,
    "",
    "Help me identify what got in the way and what is realistic for the next occurrence.",
  );
}

function gateDetail({
  reps,
  eligible,
  required,
  window,
}: OverviewHabit["gate"]) {
  return `${reps} reps in ${eligible} eligible occurrences. Gate requires ${required} in ${window}.`;
}

export function gatePassed(subject: Subject): Insight | null {
  const { name, gate } = subject.overview;
  if (gate.state !== "pass") return null;
  return fact(
    "gate-passed",
    "win",
    [subject],
    `${name}: the gate passed.`,
    gateDetail(gate),
    "Help me decide whether to continue, ramp the habit, or start the next pending habit.",
  );
}

export function gateFailing(subject: Subject): Insight | null {
  const { name, gate } = subject.overview;
  if (gate.state !== "fail") return null;
  return fact(
    "gate-failing",
    "attention",
    [subject],
    `${name}: the gate is below its threshold.`,
    gateDetail(gate),
    "Help me identify the cue, environment, or practice constraint behind the missed occurrences.",
  );
}

function minimumDetail(reps: number, ratio: number) {
  return `${Math.round(reps * ratio)} of ${reps} reps in the gate window were the minimum.`;
}

export function tooBig(subject: Subject): Insight | null {
  const { name, gate, minimumRatio } = subject.overview;
  if (gate.reps < MINIMUM_REPS || minimumRatio < MINIMUM_RATIO) return null;
  return fact(
    "too-big",
    "attention",
    [subject],
    `${name}: most reps in the gate window were the minimum.`,
    minimumDetail(gate.reps, minimumRatio),
    "Help me test whether the full version fits my days and choose one change to try.",
  );
}

export function readyToRamp(subject: Subject): Insight | null {
  const { name, gate, minimumRatio } = subject.overview;
  if (gate.state !== "pass" || minimumRatio > RAMP_RATIO) return null;
  return fact(
    "ready-to-ramp",
    "win",
    [subject],
    `${name}: the gate passed with few minimum reps.`,
    minimumDetail(gate.reps, minimumRatio),
    "Help me decide whether to change the full version while keeping the minimum easy.",
  );
}

export function stackBreaks(subjects: Subject[]) {
  const stacks = new Map<string, Subject[]>();
  for (const subject of subjects) {
    const group = stacks.get(subject.overview.stackId) ?? [];
    group.push(subject);
    stacks.set(subject.overview.stackId, group);
  }
  const result: Insight[] = [];
  for (const group of stacks.values()) {
    group.sort(
      (a, b) => a.order - b.order || a.overview.id.localeCompare(b.overview.id),
    );
    const rates = group.map((subject) => {
      const eligible = subject.window.filter(isResolved);
      return eligible.length
        ? eligible.filter(isRep).length / eligible.length
        : null;
    });
    for (let index = 1; index < group.length; index++) {
      const before = rates[index - 1];
      const after = rates[index];
      if (
        before == null ||
        after == null ||
        before < STACK_HIGH ||
        after > STACK_LOW
      )
        continue;
      const previous = group[index - 1]!;
      const current = group[index]!;
      result.push(
        fact(
          "stack-break",
          "attention",
          [previous, current],
          `${current.overview.stackName}: completion drops between ${previous.overview.name} and ${current.overview.name}.`,
          `${Math.round(before * 100)}% then ${Math.round(after * 100)}% of eligible occurrences in the selected range.`,
          "Help me reconstruct the transition between these two steps and choose what to test.",
        ),
      );
    }
  }
  return result;
}

export function knockOns(subjects: Subject[]) {
  const misses = subjects.map(
    (subject) =>
      new Set(
        subject.window
          .filter((day) => day.state === "missed")
          .map((day) => day.date),
      ),
  );
  return subjects.flatMap((a, index) => {
    const dates = misses[index]!;
    if (dates.size < KNOCK_ON_COUNT) return [];
    const nextDays = [...dates].map((date) => shiftHabitDate(date, 1));
    return subjects.flatMap((b, other) => {
      if (index === other) return [];
      const nextMisses = misses[other]!;
      const count = nextDays.filter((date) => nextMisses.has(date)).length;
      if (count < KNOCK_ON_COUNT || count / dates.size < KNOCK_ON_RATIO)
        return [];
      return [
        fact(
          "knock-on",
          "info",
          [a, b],
          `${b.overview.name} was missed the day after ${a.overview.name} on ${count} occasions.`,
          `${count} of ${dates.size} misses in ${a.overview.name} in the selected range.`,
          "Help me compare those days and test whether a shared cue or constraint explains the pattern.",
        ),
      ];
    });
  });
}

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function weekdayClusters(subject: Subject) {
  const counts = weekdays.map(() => 0);
  for (const day of subject.recent) {
    if (day.state === "missed") {
      const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      counts[weekday] = counts[weekday]! + 1;
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.flatMap((count, index) => {
    const weekday = weekdays[index]!;
    if (
      count < WEEKDAY_COUNT ||
      count < (WEEKDAY_MULTIPLE * (total - count)) / 6
    )
      return [];
    return [
      fact(
        "weekday",
        "info",
        [subject],
        `${subject.overview.name}: ${count} misses on ${weekday}s in the last four weeks.`,
        `${total - count} misses across all other weekdays.`,
        `Help me compare my ${weekday} routine with the rest of the week.`,
        String(index),
      ),
    ];
  });
}

export function risingSkips(subject: Subject, today: string) {
  const start = habitWeek(today).start;
  const skips = subject.recent.filter((day) => day.state === "skipped");
  const current = skips.filter((day) => day.date >= start).length;
  const average = skips.length / BASELINE_WEEKS;
  if (current < SKIP_COUNT || current <= SKIP_MULTIPLE * average) return [];
  return [
    fact(
      "skips-rising",
      "info",
      [subject],
      `${subject.overview.name}: ${current} skips this week.`,
      `The last four weeks averaged ${average} skips per week.`,
      "Help me distinguish temporary disruptions from changes I should consider in the habit schedule.",
    ),
  ];
}

export function detectInsights(
  subjects: Subject[],
  today: string,
  { revisionCount, slipCount }: { revisionCount: number; slipCount: number },
): Insight[] {
  return [
    ...subjects.flatMap((subject) => [
      missedTwice(subject),
      chainAtRisk(subject),
      gatePassed(subject),
      gateFailing(subject),
      tooBig(subject),
      readyToRamp(subject),
      ...weekdayClusters(subject),
      ...risingSkips(subject, today),
    ]),
    ...stackBreaks(subjects),
    ...knockOns(subjects),
  ]
    .filter((insight) => insight !== null)
    .map((insight) =>
      revisionCount || slipCount
        ? {
            ...insight,
            prompt: `${insight.prompt} The last four weeks contain ${revisionCount} system revisions and ${slipCount} recorded urges across the system. Ask whether any are relevant before drawing a connection.`,
          }
        : insight,
    );
}

const severityOrder = { attention: 0, win: 1, info: 2 };
export function rankInsights(insights: Insight[]) {
  return [...insights]
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, INSIGHT_LIMIT);
}
