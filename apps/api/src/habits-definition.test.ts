import { expect, test } from "bun:test";
import { parseHabits, eligible, localHabitDate } from "./habits-definition";
const source = `gate: { window: 14, required: 10 }
stacks:
  - { id: morning, name: Morning, days: weekdays, cue: After waking }
habits:
  - { id: stretch, name: Stretch, stack: morning, order: 1, kind: build, tracked: true, status: testing, startDate: '2026-11-02', minimum: One stretch, reward: Tea }
  - { id: pause, name: Pause, stack: morning, order: 2, kind: build, tracked: true, status: paused }
  - { id: stop, name: Stop, stack: morning, order: 3, kind: break, tracked: true, status: building }
  - { id: invalid, name: Invalid, stack: missing }
`;
test("loads valid cue-only entries, preserves unknown fields and excludes invalid entries", () => {
  const p = parseHabits(source);
  expect(p.habits.map((h) => h.id)).toEqual(["stretch", "pause", "stop"]);
  expect(p.stacks[0].anchor).toBeUndefined();
  expect(p.habits[0].reward).toBe("Tea");
  expect(p.diagnostics).toHaveLength(1);
  expect(eligible(p, "2026-11-02").map((h) => h.id)).toEqual(["stretch"]);
  expect(eligible(p, "2026-11-01")).toEqual([]);
  expect(eligible(p, "2026-11-07")).toEqual([]);
});
test("Halifax boundaries follow DST rather than fixed UTC offsets", () => {
  expect(localHabitDate(new Date("2026-03-08T03:30:00Z"))).toBe("2026-03-07");
  expect(localHabitDate(new Date("2026-03-09T03:30:00Z"))).toBe("2026-03-09");
  expect(localHabitDate(new Date("2026-11-02T03:30:00Z"))).toBe("2026-11-01");
});

test("pending, paused, untracked and break habits never materialize; explicit schedules override stack defaults", () => {
  const p =
    parseHabits(`stacks: [{ id: routine, name: Routine, days: weekdays }]
habits:
  - { id: pending, name: Pending, stack: routine, tracked: true, status: pending }
  - { id: paused, name: Paused, stack: routine, tracked: true, status: paused }
  - { id: checklist, name: Checklist, stack: routine, tracked: false, status: established }
  - { id: break, name: Break, stack: routine, tracked: true, kind: break, status: building }
  - { id: later, name: Later, stack: routine, tracked: true, status: testing, startDate: '2026-12-01' }
  - { id: sunday, name: Sunday, stack: routine, tracked: true, status: established, schedule: [sunday] }
  - { id: daily, name: Daily, stack: routine, tracked: true, status: testing, schedule: daily }
`);
  expect(eligible(p, "2026-11-08").map((h) => h.id)).toEqual([
    "sunday",
    "daily",
  ]);
  expect(eligible(p, "2026-11-09").map((h) => h.id)).toEqual(["daily"]);
  expect(p.gate).toEqual({ window: 14, required: 10 });
});
test("duplicate IDs exclude all ambiguous entries; malformed whole document fails", () => {
  const p = parseHabits(`stacks: [{ id: routine, name: Routine }]
habits: [{ id: same, name: First, stack: routine }, { id: same, name: Second, stack: routine }]
`);
  expect(p.habits).toEqual([]);
  expect(p.diagnostics).toHaveLength(2);
  expect(() => parseHabits("stacks: []")).toThrow();
  expect(() =>
    parseHabits("gate: {window: 4, required: 10}\nstacks: []\nhabits: []"),
  ).toThrow();
});
