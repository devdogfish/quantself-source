import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import {
  habitSchema,
  stackSchema,
  type HabitProjection,
} from "./habits-definition";
import {
  buildDays,
  chain,
  computeOverview,
  momentum,
} from "./habits-insights-core";
import { detectInsights, rankInsights } from "./habits-insights-detectors";
import { gate, shiftHabitDate } from "./habits-insights-facts";
import { registerHabitOverviewRoutes } from "./habits-insights-route";
import type { DayState, OverviewHabit } from "./habits-insights-schema";

const asOf = new Date("2026-11-07T15:00:00Z");
const range = { from: "2026-10-11", to: "2026-11-07" };
const habit = (
  id: string,
  input: Partial<ReturnType<typeof habitSchema.parse>> = {},
) =>
  habitSchema.parse({
    id,
    stack: "morning",
    name: id,
    status: "building",
    tracked: true,
    ...input,
  });
function projection(habits = [habit("stretch")]): HabitProjection {
  return {
    habits,
    stacks: [
      stackSchema.parse({ id: "morning", name: "Morning" }),
      stackSchema.parse({ id: "evening", name: "Evening" }),
    ],
    gate: { window: 14, required: 10 },
    diagnostics: [],
  };
}
const rows = (...states: DayState[]) =>
  states.map((state, i) => ({ date: shiftHabitDate("2026-10-11", i), state }));

test.each([
  ["2026-03-08T03:59:59Z", "2026-03-08T04:00:00Z", "2026-03-07", "2026-03-08"],
  ["2026-11-01T02:59:59Z", "2026-11-01T03:00:00Z", "2026-10-31", "2026-11-01"],
])(
  "only persisted opens become misses at Halifax midnight (%s)",
  (before, after, day, next) => {
    const input = {
      projection: projection(),
      occurrences: [{ habitId: "stretch", date: day, status: "open" }],
      range: { from: shiftHabitDate(day, -1), to: next },
    };
    const days = (time: string) =>
      computeOverview({ ...input, asOf: new Date(time) }).habits[0]!.days;
    expect(days(before).map(({ state }) => state)).toEqual([
      "none",
      "open",
      "none",
    ]);
    expect(days(after).map(({ state }) => state)).toEqual([
      "none",
      "missed",
      "open",
    ]);
  },
);

test("weekly fabric uses Sundays; weekly gate counts one eligible bucket per week", () => {
  const result = computeOverview({
    projection: projection([
      habit("stretch", {
        schedule: ["saturday"],
        gate: { window: 2, required: 2 },
      }),
    ]),
    occurrences: [
      { habitId: "stretch", date: "2026-10-31", status: "minimum" },
      { habitId: "stretch", date: "2026-11-02", status: "open" },
      { habitId: "stretch", date: "2026-11-07", status: "done" },
    ],
    asOf,
    range: { from: "2026-10-26", to: "2026-11-07" },
  }).habits[0]!;
  expect(result.days).toEqual([
    { date: "2026-11-01", state: "minimum" },
    { date: "2026-11-08", state: "done" },
  ]);
  expect(result.gate).toEqual({
    window: 2,
    required: 2,
    eligible: 2,
    reps: 2,
    state: "pass",
  });
  expect(result.chain).toBe(2);
  expect(buildDays([], { from: "2026-11-02", to: "2026-11-07" }, true)).toEqual(
    [{ date: "2026-11-08", state: "none" }],
  );
});

test("chain bends once, ignores skips, breaks twice and retains its historical best", () => {
  const history = rows(
    "done",
    "missed",
    "skipped",
    "minimum",
    "missed",
    "skipped",
  );
  expect(chain(history)).toEqual({
    chain: 2,
    bestChain: 2,
    chainAtRisk: true,
    missedTwice: false,
  });
  const broken = rows(
    ...history.map(({ state }) => state),
    "none",
    "missed",
    "open",
  );
  expect(chain(broken)).toEqual({
    chain: 0,
    bestChain: 2,
    chainAtRisk: false,
    missedTwice: true,
  });
  expect(
    chain(rows(...broken.map(({ state }) => state), "minimum")).chain,
  ).toBe(1);
});

test("gate excludes today's open and skips, with pending, pass and fail states", () => {
  const rule = { window: 3, required: 2 };
  expect(gate(rows("done", "skipped", "open"), rule).gate.state).toBe(
    "pending",
  );
  expect(
    gate(rows("done", "skipped", "minimum", "missed", "open"), rule),
  ).toEqual({
    gate: { ...rule, reps: 2, eligible: 3, state: "pass" },
    minimumRatio: 0.5,
  });
  expect(
    gate(rows("done", "skipped", "missed", "missed"), rule).gate.state,
  ).toBe("fail");
});

test("momentum uses Monday through Sunday and retains lifetime votes outside the fabric", () => {
  const history = [
    { date: "2026-10-25", state: "done" },
    { date: "2026-10-26", state: "done" },
    { date: "2026-11-01", state: "minimum" },
    { date: "2026-11-02", state: "done" },
    { date: "2026-11-03", state: "skipped" },
    { date: "2026-11-08", state: "done" },
  ] satisfies OverviewHabit["days"];
  expect(momentum(history, "2026-11-02")).toEqual({
    votes: 4,
    votesThisWeek: 1,
    votesLastWeek: 2,
  });
  expect(momentum(history, "2026-11-08")).toEqual({
    votes: 5,
    votesThisWeek: 2,
    votesLastWeek: 2,
  });
});

test("rollout uses stack order before cross-stack start date; passed gates stop blocking", () => {
  const result = computeOverview({
    projection: projection([
      habit("start", {
        startDate: "2026-10-10",
        order: 1,
        gate: { window: 1, required: 1 },
      }),
      habit("next", { startDate: "2026-11-08", order: 2, status: "pending" }),
      habit("later", { startDate: "2026-11-09", order: 3, status: "pending" }),
      habit("other", {
        startDate: "2026-11-10",
        stack: "evening",
        status: "pending",
      }),
      habit("break", { kind: "break", startDate: "2026-11-09" }),
    ]),
    occurrences: [{ habitId: "start", date: "2026-10-25", status: "done" }],
    asOf,
    range,
    reviewStatus: "exists",
  });
  expect(result.upcoming.map(({ id, waitingOn }) => [id, waitingOn])).toEqual([
    ["next", null],
    ["later", "next"],
    ["other", "later"],
  ]);
  expect(result.reviewDue).toEqual({ date: "2026-11-08", done: true, status: "exists" });
  expect(result.habits.map(({ id }) => id)).toEqual(["start"]);
});

function subject(
  id: string,
  overrides: Partial<OverviewHabit> = {},
  days: OverviewHabit["days"] = [],
  order = 0,
) {
  const overview = computeOverview({
    projection: projection([habit(id)]),
    occurrences: [],
    asOf,
    range,
  }).habits[0]!;
  return {
    overview: { ...overview, ...overrides },
    missedTwice: false,
    order,
    recent: days,
    window: days,
  };
}
const detect = (...subjects: ReturnType<typeof subject>[]) =>
  detectInsights(subjects, "2026-11-07", { revisionCount: 0, slipCount: 0 });

test("habit facts respect gate and minimum thresholds", () => {
  const rule = {
    required: 4,
    window: 10,
    eligible: 10,
    state: "pass",
  } as const;
  const check = (
    reps: number,
    minimumRatio: number,
    state: OverviewHabit["gate"]["state"] = "pass",
  ) =>
    detect(
      subject("stretch", { gate: { ...rule, reps, state }, minimumRatio }),
    ).map(({ kind }) => kind);
  expect(check(5, 0.6)).toContain("too-big");
  expect(check(4, 0.75)).not.toContain("too-big");
  expect(check(5, 0.59)).not.toContain("too-big");
  expect(check(10, 0.1)).toEqual(["gate-passed", "ready-to-ramp"]);
  expect(check(10, 0.11)).toEqual(["gate-passed"]);
  expect(check(3, 0, "fail")).toEqual(["gate-failing"]);
  expect(check(3, 0, "pending")).toEqual([]);
  expect(
    detect({ ...subject("stretch"), missedTwice: true }).map(
      ({ kind }) => kind,
    ),
  ).toEqual(["missed-twice"]);
  expect(
    detect(subject("stretch", { chainAtRisk: true })).map(({ kind }) => kind),
  ).toEqual(["chain-at-risk"]);
});

test("stack break compares adjacent tracked links at the inclusive 80% and 50% thresholds", () => {
  const rate = (...states: DayState[]) => rows(...states, "open", "skipped");
  const first = subject(
    "first",
    {},
    rate("done", "done", "done", "minimum", "missed"),
    1,
  );
  const second = subject("second", {}, rate("minimum", "missed"), 2);
  const threshold = detect(second, first).find(
    ({ kind }) => kind === "stack-break",
  );
  expect(threshold?.habitIds).toEqual(["first", "second"]);
  expect(
    detect(
      { ...second, window: rate("done", "minimum", "missed") },
      first,
    ).some(({ kind }) => kind === "stack-break"),
  ).toBe(false);
  expect(
    detect(second, {
      ...first,
      window: rate("done", "done", "done", "missed", "missed"),
    }).some(({ kind }) => kind === "stack-break"),
  ).toBe(false);
});

test("knock-on needs three next-day pairs and at least 60% of the preceding habit's misses", () => {
  const dates = (days: number[]) =>
    days.map((day) => ({
      date: shiftHabitDate("2026-10-11", day),
      state: "missed" as const,
    }));
  const a = subject("alpha", {}, dates([0, 3, 6, 9, 12]));
  const b = subject("bravo", {}, dates([1, 4, 7]));
  const facts = (left: typeof a, right: typeof b) =>
    detect(left, right).filter(({ kind }) => kind === "knock-on");
  expect(facts(a, b).map(({ id }) => id)).toEqual(["knock-on:alpha:bravo"]);
  expect(facts(a, b)).toEqual(facts(a, b));
  expect(facts(a, { ...b, window: dates([1, 4]) })).toEqual([]);
  expect(facts({ ...a, window: dates([0, 3, 6, 9, 12, 15]) }, b)).toEqual([]);
});

test("weekday needs at least three misses and twice the other-weekday average", () => {
  const date = (offset: number) => ({
    date: shiftHabitDate("2026-10-11", offset),
    state: "missed" as const,
  });
  const count = (offsets: number[]) =>
    detect(subject("stretch", {}, offsets.map(date))).filter(
      ({ kind }) => kind === "weekday",
    );
  expect(count([0, 7])).toEqual([]);
  expect(count([0, 7, 14]).map(({ id }) => id)).toEqual(["weekday:stretch:0"]);
  expect(count([0, 7, 14, 1, 2, 3, 4, 5, 6, 8, 9, 10])).toHaveLength(1);
  expect(count([0, 7, 14, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11])).toEqual([]);
});

test("skip rise needs two this week and strictly above twice the four-week average", () => {
  const date = (day: number) => ({
    date: shiftHabitDate("2026-11-02", day),
    state: "skipped" as const,
  });
  const count = (offsets: number[]) =>
    detect(subject("stretch", {}, offsets.map(date))).filter(
      ({ kind }) => kind === "skips-rising",
    );
  expect(count([0])).toEqual([]);
  expect(count([0, 1, -7])).toHaveLength(1);
  expect(count([0, 1, -7, -14])).toEqual([]);
});

test("rank sorts attention, win, info and caps at six without altering the input", () => {
  const info = detect(
    subject("info", {}, [
      { date: "2026-11-02", state: "skipped" },
      { date: "2026-11-03", state: "skipped" },
    ]),
  )[0]!;
  const win = { ...info, id: "win", severity: "win" as const };
  const attention = {
    ...info,
    id: "attention",
    severity: "attention" as const,
  };
  const input = [...Array(5).fill(info), win, attention];
  expect(rankInsights(input).map(({ severity }) => severity)).toEqual([
    "attention",
    "win",
    "info",
    "info",
    "info",
    "info",
  ]);
  expect(input).toHaveLength(7);
  expect(input[0]).toBe(info);
});

test("overview requires habits:read before invoking the loader", async () => {
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  let access: AccessContext | null = null;
  let calls = 0;
  app.use("*", async (c, next) => {
    c.set("accessContext", access);
    await next();
  });
  registerHabitOverviewRoutes(app, {
    overview: async (ownerId, options) => {
      calls++;
      expect(ownerId).toBe("owner");
      expect(options.weeks).toBe(4);
      return computeOverview({
        projection: projection(),
        occurrences: [],
        asOf,
        range,
      });
    },
  });
  expect((await app.request("/api/v1/habits/overview")).status).toBe(401);
  access = {
    owner: { id: "owner", name: "Owner", email: "owner@example.test" },
    client: { id: "client", name: "Client", kind: "api-key" },
    permissions: ["habits:write"],
  };
  expect((await app.request("/api/v1/habits/overview")).status).toBe(403);
  access.permissions = ["habits:read"];
  expect((await app.request("/api/v1/habits/overview?weeks=0")).status).toBe(
    400,
  );
  expect(calls).toBe(0);
  expect((await app.request("/api/v1/habits/overview")).status).toBe(200);
  expect(calls).toBe(1);
});

test("overview bulk reads owner-scoped history, with extra queries only for full pages", async () => {
  const { createHabitInsights } = await import("./habits-insights");
  const calls: string[] = [];
  let archiveUnavailable = false;
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    habitId: `archived-${String(index).padStart(4, "0")}`,
    date: "2026-10-11",
    status: "minimum",
  }));
  let resolvePage!: (page: typeof firstPage) => void;
  const pendingPage = new Promise<typeof firstPage>((resolve) => {
    resolvePage = resolve;
  });
  const db = {
    habitOccurrence: {
      async findMany(query: { where: { ownerId: string }; cursor?: unknown }) {
        expect(query.where.ownerId).toBe("owner");
        if (query.cursor) {
          calls.push("next observations");
          return [{ habitId: "stretch", date: "2026-10-12", status: "done" }];
        }
        calls.push("observations");
        return pendingPage;
      },
    },
    habitDefinitionRevision: {
      async findMany(query: { where: { ownerId: string }; select: unknown }) {
        calls.push("revisions");
        expect(query.where.ownerId).toBe("owner");
        expect(query.select).toEqual({ createdAt: true });
        return [];
      },
    },
    habitSlip: {
      async findMany(query: { where: { ownerId: string }; select: unknown }) {
        calls.push("slips");
        expect(query.where.ownerId).toBe("owner");
        expect(query.select).toEqual({ occurredAt: true });
        return [];
      },
    },
  } as unknown as Parameters<typeof createHabitInsights>[0];
  const insights = createHabitInsights(
    db,
    {
      current: async (ownerId) => {
        calls.push("catalog");
        expect(ownerId).toBe("owner");
        return { projection: projection(), revision: 1 };
      },
    },
    {
      hasReview: async (path) => {
        calls.push("review tree");
        expect(path).toBe("reviews/2026-11-08.md");
        if (archiveUnavailable) throw Error("Review index unavailable.");
        return true;
      },
    },
  );
  const overview = insights.overview("owner", { asOf });
  expect(calls).toEqual([
    "catalog",
    "revisions",
    "observations",
    "slips",
    "review tree",
  ]);
  resolvePage(firstPage);
  const result = await overview;
  expect(calls.at(-1)).toBe("next observations");
  expect(calls).toHaveLength(6);
  expect(result.totals.votes).toBe(1001);
  expect(result.reviewDue).toEqual({ date: "2026-11-08", done: true, status: "exists" });

  calls.length = 0;
  archiveUnavailable = true;
  const degraded = await insights.overview("owner", { asOf });
  expect(degraded.totals).toEqual(result.totals);
  expect(degraded.habits).toEqual(result.habits);
  expect(degraded.insights).toEqual(result.insights);
  expect(degraded.reviewDue).toEqual({ date: "2026-11-08", done: false, status: "unavailable" });
  expect(calls.filter((call) => call === "review tree")).toHaveLength(1);
});
