import { expect, test } from "bun:test";
import { parseHabits } from "./habits-definition";
import { habitBlocks, planHabitAlerts } from "./habits-calendar";
const p = parseHabits(`stacks:
  - {id: routine, name: Routine, anchor: '08:00', durationMinutes: 30, alert: true}
  - {id: cue, name: Cue}
habits:
  - {id: stretch, name: Stretch, stack: routine, tracked: true, status: building}
`);
test("derived blocks and opt-in reminders honor activity, suppression and Halifax DST", () => {
  expect(habitBlocks(p, "2026-11-01", "2026-11-02")).toHaveLength(2);
  const [alert] = planHabitAlerts(p, "2026-11-01", []);
  expect(new Date(alert!.fireAt).toISOString()).toBe(
    "2026-11-01T12:00:00.000Z",
  );
  expect(alert!.url).toBe("/habits");
  expect(
    planHabitAlerts(p, "2026-11-01", [
      { habitId: "stretch", status: "minimum" },
    ]),
  ).toEqual([]);
  expect(
    planHabitAlerts(
      { ...p, stacks: p.stacks.map((s) => ({ ...s, alert: false })) },
      "2026-11-01",
      [],
    ),
  ).toEqual([]);
  expect(
    habitBlocks(
      { ...p, habits: p.habits.map((h) => ({ ...h, status: "paused" })) },
      "2026-11-01",
      "2026-11-01",
    ),
  ).toEqual([]);
});

test("cue-only, break, inactive, pre-start and off-schedule groups do not emit blocks", () => {
  const fixture = parseHabits(`stacks:
  - {id: clock, name: Clock, anchor: '08:00', durationMinutes: 30, days: weekdays}
  - {id: cue, name: Cue, durationMinutes: 30}
habits:
  - {id: break-habit, name: Pause, stack: clock, kind: break, status: building}
  - {id: later, name: Later, stack: clock, status: pending}
  - {id: paused, name: Paused, stack: clock, status: paused}
  - {id: future, name: Future, stack: clock, status: building, startDate: '2027-01-01'}
  - {id: checklist, name: Checklist, stack: cue, status: building}
`);
  expect(habitBlocks(fixture, "2026-11-04", "2026-11-04")).toEqual([]);
  const active = {
    ...fixture,
    habits: [...fixture.habits, { ...p.habits[0]!, stack: "clock" }],
  };
  expect(habitBlocks(active, "2026-11-07", "2026-11-08")).toEqual([]);
  expect(habitBlocks(active, "2026-11-04", "2026-11-04")).toHaveLength(1);
});

test("per-habit alerts require boolean opt-in and stable target/date/anchor keys", () => {
  const fixture = {
    ...p,
    stacks: p.stacks.map((s) => ({ ...s, alert: false })),
    habits: p.habits.map((h) => ({ ...h, alert: true })),
  };
  const first = planHabitAlerts(fixture, "2026-03-08", []);
  expect(new Date(first[0]!.fireAt).toISOString()).toBe(
    "2026-03-08T11:00:00.000Z",
  );
  expect(planHabitAlerts(fixture, "2026-03-08", [])[0]!.key).toBe(
    first[0]!.key,
  );
  expect(planHabitAlerts(fixture, "2026-03-09", [])[0]!.key).not.toBe(
    first[0]!.key,
  );
  expect(
    planHabitAlerts(fixture, "2026-03-08", [
      { habitId: "stretch", status: "skipped" },
    ]),
  ).toEqual([]);
  const parsed =
    parseHabits(`stacks: [{id: routine, name: Routine, anchor: '08:00'}]
habits: [{id: stretch, name: Stretch, stack: routine, alert: yes}]`);
  expect(parsed.habits).toEqual([]);
  expect(parsed.diagnostics).toHaveLength(1);
});

test("stack reminders carry the routine with minimums, and untracked routines remind too", () => {
  const fixture = parseHabits(`stacks:
  - {id: evening, name: Evening, anchor: '21:00', alert: true}
  - {id: morning, name: Morning, anchor: '06:30', alert: true}
habits:
  - {id: work-stops, name: Work stops, stack: evening, order: 1, status: building, minimum: close the laptop}
  - {id: phone-parked, name: Phone parked, stack: evening, order: 2, tracked: true, status: building, minimum: kitchen charger}
  - {id: read, name: Read, stack: evening, order: 3, status: building}
  - {id: water, name: Water, stack: morning, status: building}
  - {id: later, name: Later, stack: morning, status: pending}
`);
  const alerts = planHabitAlerts(fixture, "2026-11-05", []);
  const evening = alerts.find((a) => a.title === "Evening")!;
  expect(evening.body).toBe(
    "Work stops (close the laptop) → Phone parked (kitchen charger) → Read",
  );
  // Morning has no tracked habit, but still reminds; pending habits stay out of the chain.
  expect(alerts.find((a) => a.title === "Morning")!.body).toBe("Water");
  // Logging the only tracked habit silences the evening reminder, not the untracked morning one.
  const afterLog = planHabitAlerts(fixture, "2026-11-05", [
    { habitId: "phone-parked", status: "done" },
  ]);
  expect(afterLog.map((a) => a.title)).toEqual(["Morning"]);
  // Keys stay compatible with already-sent receipts.
  expect(evening.key).toBe(
    planHabitAlerts(fixture, "2026-11-05", [])[0]!.key,
  );
});

test("plan-B reminder fires once for an open tracked habit at its fallback time", () => {
  const fixture = parseHabits(`stacks:
  - {id: morning, name: Morning, anchor: '06:30'}
  - {id: loose, name: Loose}
habits:
  - {id: outside, name: Morning outside, stack: morning, tracked: true, status: building, fallbackAt: '12:00', fallback: 10 min outside at lunch}
  - {id: movement, name: Movement, stack: loose, tracked: true, status: building, fallbackAt: '17:30', minimum: shoes on}
  - {id: stretch, name: Stretch, stack: loose, status: building, fallbackAt: '18:00'}
  - {id: bad, name: Bad, stack: loose, tracked: true, status: building, fallbackAt: noon}
`);
  expect(fixture.diagnostics).toHaveLength(1);
  const alerts = planHabitAlerts(fixture, "2026-11-05", []);
  expect(alerts.map((a) => [a.title, a.body])).toEqual([
    ["Morning outside: plan B", "10 min outside at lunch"],
    ["Movement: plan B", "The minimum still counts: shoes on"],
  ]);
  expect(new Date(alerts[0]!.fireAt).toISOString()).toBe(
    "2026-11-05T16:00:00.000Z",
  );
  expect(alerts[0]!.url).toBe("/habits");
  expect(
    planHabitAlerts(fixture, "2026-11-05", [
      { habitId: "outside", status: "minimum" },
      { habitId: "movement", status: "skipped" },
    ]),
  ).toEqual([]);
});

test("multiple opted-in habits share one stack anchor reminder and receipt", () => {
  const fixture = parseHabits(`stacks:
  - {id: morning, name: Morning, anchor: '06:30', alert: true}
habits:
  - {id: water, name: Water, stack: morning, status: building, alert: true}
  - {id: walk, name: Walk, stack: morning, status: building, alert: true}
`);
  const date = "2026-11-05";
  const alerts = planHabitAlerts(fixture, date, []);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ title: "Morning", body: "Water → Walk" });
  fixture.stacks[0].alert = false;
  expect(planHabitAlerts(fixture, date, [])).toEqual(alerts);
  fixture.habits.forEach((habit) => { habit.alert = false; });
  expect(planHabitAlerts(fixture, date, [])).toEqual([]);
});


test("plan-B receipt stays once per habit/day when its time changes", () => {
  const fixture = parseHabits(`stacks: [{id: routine, name: Routine}]
habits: [{id: stretch, name: Stretch, stack: routine, tracked: true, status: building, fallbackAt: '12:00'}]`);
  const first = planHabitAlerts(fixture, "2026-11-07", [])[0]!;
  fixture.habits[0]!.fallbackAt = "15:00";
  const moved = planHabitAlerts(fixture, "2026-11-07", [])[0]!;
  expect(moved.key).toBe(first.key);
  expect(moved.fireAt).not.toBe(first.fireAt);
  expect(planHabitAlerts(fixture, "2026-11-08", [])[0]!.key).not.toBe(first.key);
});
