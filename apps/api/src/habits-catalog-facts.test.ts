import { expect, test } from "bun:test";
import { catalogFacts, projectCatalogFact } from "./habits-catalog-facts";
import { computeOverview } from "./habits-insights-core";
import type { HabitProjection } from "./habits-definition";
const today = "2026-11-13";
const projection: HabitProjection = {
  stacks: [{ id: "morning", name: "Morning", days: "daily" }],
  habits: [
    { id: "walk", name: "Walk", stack: "morning", order: 0, kind: "build", tracked: true, status: "building" },
    { id: "water", name: "Water", stack: "morning", order: 1, kind: "build", tracked: false, status: "established" },
    { id: "break", name: "Break", stack: "morning", order: 2, kind: "break", tracked: false, status: "building" },
  ], gate: { window: 3, required: 2 }, diagnostics: [],
};
const rows = [
  { habitId: "walk", date: "2020-01-01", status: "done" },
  { habitId: "walk", date: "2026-11-09", status: "minimum" },
  { habitId: "walk", date: "2026-11-10", status: "skipped" },
  { habitId: "walk", date: "2026-11-11", status: "done" },
  { habitId: "walk", date: "2026-11-12", status: "open" },
  { habitId: "walk", date: today, status: "open" },
  { habitId: "water", date: "2021-02-03", status: "done" },
];
test("all Catalog habits retain lifetime facts beyond the display window, including untracked habits", () => {
  const facts = catalogFacts(projection, rows, today);
  expect(facts.map(f => f.id)).toEqual(["walk", "water", "break"]);
  const walk = projectCatalogFact(facts[0]!);
  expect(walk).toMatchObject({ reps: 3, eligible: 4, lastDone: "2026-11-11", recentReps: 2, recentEligible: 3 });
  expect(projectCatalogFact(facts[1]!).lastDone).toBe("2021-02-03");
  expect(projectCatalogFact(facts[2]!)).toMatchObject({ reps: 0, eligible: 0, lastDone: null });
  expect(facts[0]!.gateHistory.length).toBeLessThanOrEqual(4);
});
test("optimistic completion, minimum, Skip and Undo use the API gate and recovery semantics", () => {
  const fact = catalogFacts(projection, rows, today)[0]!;
  const minimum = projectCatalogFact(fact, "minimum");
  expect(minimum).toMatchObject({ reps: 4, eligible: 5, lastDone: today, recovery: { misses: 1, recovered: 1 }, gate: { reps: 2, eligible: 3, state: "pass", left: 0 } });
  expect(projectCatalogFact(fact, "open")).toEqual(projectCatalogFact(fact));
  expect(projectCatalogFact(fact, "skipped").recovery).toEqual({ misses: 0, recovered: 0 });
  const overview = computeOverview({ projection, occurrences: rows.map(r => r.date === today ? { ...r, status: "minimum" } : r), asOf: new Date(`${today}T16:00:00Z`), range: { from: "2026-05-16", to: today } });
  expect(minimum.gate).toMatchObject(overview.habits[0]!.gate);
  expect(overview.catalogFacts).toHaveLength(3);
});
test("weekly gates exclude skips, bucket weeks, and retain sufficient context outside 52 weeks", () => {
  const weekly = structuredClone(projection); weekly.habits[0]!.schedule = ["friday"]; weekly.habits[0]!.gate = { window: 3, required: 2 };
  const history = [
    { habitId: "walk", date: "2020-01-03", status: "done" },
    { habitId: "walk", date: "2020-01-10", status: "minimum" },
    { habitId: "walk", date: "2026-11-06", status: "skipped" },
    { habitId: "walk", date: today, status: "done" },
  ];
  const fact = catalogFacts(weekly, history, today)[0]!;
  expect(projectCatalogFact(fact).gate).toMatchObject({ reps: 3, eligible: 3, state: "pass" });
  const overview = computeOverview({ projection: weekly, occurrences: history, asOf: new Date(`${today}T16:00:00Z`), range: { from: "2026-05-16", to: today } });
  expect(projectCatalogFact(fact).gate).toMatchObject(overview.habits[0]!.gate);
});
