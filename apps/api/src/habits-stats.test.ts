import { expect, test } from "bun:test";
import { deriveHabitStats, habitWeek } from "./habits-stats";
import { parseHabits, localHabitDate } from "./habits-definition";
const p = parseHabits(`stacks: [{id: routine, name: Routine}]
habits: [{id: stretch, name: Stretch, stack: routine, tracked: true, status: testing}]`);
test("seeded daily and weekly Gate defaults survive parsing and respect habit overrides", () => {
  const projection = parseHabits(`gate:
  daily: {window: 12, required: 8}
  weekly: {window: 5, required: 3}
stacks: [{id: routine, name: Routine, days: [sunday]}]
habits:
  - {id: weekly, name: Weekly, stack: routine, tracked: true}
  - {id: daily, name: Daily, stack: routine, tracked: true, schedule: daily}
  - {id: custom, name: Custom, stack: routine, tracked: true, gate: {window: 2, required: 1}}
`);
  expect(projection.diagnostics).toEqual([]);
  expect(deriveHabitStats(projection, [], "2026-11-04").map(({ gate }) => ({
    window: gate.window, required: gate.required,
  }))).toEqual([
    { window: 5, required: 3 },
    { window: 12, required: 8 },
    { window: 2, required: 1 },
  ]);
  expect(() => parseHabits(`gate: {daily: {window: 14, required: 10}, weekly: {window: 2, required: 3}}
stacks: []
habits: []`)).toThrow();
});
test("resolved windows exclude skips and today's open; minimum counts; Halifax boundary", () => {
  const rows = [
    { habitId: "stretch", date: "2026-11-01", status: "done" },
    { habitId: "stretch", date: "2026-11-02", status: "skipped" },
    { habitId: "stretch", date: "2026-11-03", status: "open" },
    { habitId: "stretch", date: "2026-11-04", status: "open" },
  ];
  expect(deriveHabitStats(p, rows, "2026-11-04")[0]).toMatchObject({
    totalReps: 1,
    currentStreak: 0,
    neverMissTwice: false,
    gate: { state: "insufficient", eligible: 2 },
  });
  expect(deriveHabitStats(p, rows, "2026-11-05")[0]?.neverMissTwice).toBe(true);
  rows[3]!.status = "minimum";
  expect(deriveHabitStats(p, rows, "2026-11-04")[0]).toMatchObject({
    totalReps: 2,
    currentStreak: 1,
    neverMissTwice: false,
  });
  expect(localHabitDate(new Date("2026-11-02T03:59:00Z"))).toBe("2026-11-01");
  expect(habitWeek("2026-11-01")).toEqual({
    start: "2026-10-26",
    end: "2026-11-01",
  });
});
test("daily/weekday and weekly defaults; complete failing window differs from insufficient; configured Gate wins", () => {
  const weekly =
    parseHabits(`stacks: [{id: routine, name: Routine, days: [sunday]}]
habits: [{id: stretch, name: Stretch, stack: routine, tracked: true, status: pending}]`);
  const rows = Array.from({ length: 14 }, (_, i) => ({
    habitId: "stretch",
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    status: i < 9 ? "minimum" : "open",
  }));
  expect(deriveHabitStats(p, rows, "2026-11-04")[0]?.gate).toMatchObject({
    window: 14,
    required: 10,
    state: "fail",
  });
  expect(
    deriveHabitStats(weekly, rows.slice(0, 4), "2026-11-04")[0]?.gate,
  ).toMatchObject({ window: 4, required: 3, state: "pass" });
  weekly.habits[0]!.gate = { window: 2, required: 1 };
  expect(deriveHabitStats(weekly, rows, "2026-11-04")[0]?.gate).toMatchObject({
    window: 2,
    required: 1,
    state: "fail",
  });
  expect(weekly.habits[0]!.status).toBe("pending");
  expect(
    deriveHabitStats(
      p,
      [{ habitId: "stretch", date: "2026-11-04", status: "open" }],
      "2026-11-04",
    )[0]?.gate.eligible,
  ).toBe(0);
});

test("weekly never-miss-twice uses occurrences rather than adjacent calendar days; skips preserve streak", () => {
  const weekly =
    parseHabits(`stacks: [{id: routine, name: Routine, days: [sunday]}]
habits: [{id: stretch, name: Stretch, stack: routine, tracked: true, status: testing}]`);
  const rows = [
    { habitId: "stretch", date: "2026-10-11", status: "done" },
    { habitId: "stretch", date: "2026-10-18", status: "open" },
    { habitId: "stretch", date: "2026-10-25", status: "skipped" },
    { habitId: "stretch", date: "2026-11-01", status: "open" },
  ];
  expect(deriveHabitStats(weekly, rows, "2026-11-01")[0]?.neverMissTwice).toBe(
    false,
  );
  expect(deriveHabitStats(weekly, rows, "2026-11-02")[0]?.neverMissTwice).toBe(
    true,
  );
  rows[1]!.status = "minimum";
  rows[3]!.status = "done";
  expect(deriveHabitStats(weekly, rows, "2026-11-01")[0]).toMatchObject({
    currentStreak: 3,
    totalReps: 3,
    gate: { state: "insufficient", eligible: 3 },
  });
  expect(localHabitDate(new Date("2026-03-08T03:59:59Z"))).toBe("2026-03-07");
  expect(localHabitDate(new Date("2026-03-08T04:00:00Z"))).toBe("2026-03-08");
});
