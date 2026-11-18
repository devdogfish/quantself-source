import { expect, test } from "bun:test";
import { habitRows, filterHabitRows, exportHabitRows } from "./habits-table-data";
import { habitDates } from "./habits-live-data";
import type { Habit, Stack, State } from "./habit-metrics";
const dates = habitDates("2026-11-13");
const stacks: Stack[] = ["morning", "evening"].map(id => ({ id, name: id, cue: "", anchor: "", minutes: 0, place: "" }));
const habits: Habit[] = Array.from({ length: 55 }, (_, i) => ({ id: `habit-${i}`, name: `Habit ${String(i).padStart(2, "0")}`, stack: i % 2 ? "evening" : "morning", kind: i === 54 ? "break" : "build", status: i % 3 ? "building" : "established", identity: "", minimum: "One", full: "Two", started: "Jan 1", gate: { window: 14, required: 10 }, untracked: i % 3 === 0 }));
const hist: Record<string, State[]> = Object.fromEntries(habits.filter(h => !h.untracked).map(h => [h.id, dates.map((_, i) => i % 3 ? "done" : "missed")]));
const all = habitRows(habits, stacks, hist, dates, {});
const filters = { query: "", scope: "all" as const, stack: "all", status: "all", sort: "stack" };
test("55-row full Catalog filters combine, reset to empty, and paginate without fetching", () => {
  expect(all).toHaveLength(55);
  expect(filterHabitRows(all, stacks, { ...filters, scope: "tracked" })).toHaveLength(36);
  expect(filterHabitRows(all, stacks, { ...filters, scope: "untracked" })).toHaveLength(19);
  expect(filterHabitRows(all, stacks, { ...filters, scope: "tracked", stack: "evening", status: "Building", query: "Habit 0" }).every(r => r.tracked && r.h.stack === "evening" && r.status === "Building")).toBe(true);
  expect(filterHabitRows(all, stacks, { ...filters, query: "no such habit" })).toEqual([]);
  expect(Array.from({ length: 5 }, (_, page) => all.slice(page * 12, (page + 1) * 12)).flat()).toEqual(all);
  expect(all.find(r => r.h.kind === "break")!.status).toBe("Breaking");
});
test("sorts all rows by name, stack, consistency and actual completion date", () => {
  expect(filterHabitRows([...all].reverse(), stacks, { ...filters, sort: "name" }).map(r => r.h.name)).toEqual(habits.map(h => h.name));
  expect(filterHabitRows(all, stacks, filters).slice(0, 28).every(r => r.h.stack === "morning")).toBe(true);
  const examples = all.slice(0, 3).map((r, i) => ({ ...r, rate: [null, 20, 80][i]!, lastDate: [null, "2020-01-01", "2026-11-13"][i]! }));
  expect(filterHabitRows(examples, stacks, { ...filters, sort: "rate" }).map(r => r.rate)).toEqual([20, 80, null]);
  expect(filterHabitRows(examples, stacks, { ...filters, sort: "recent" }).map(r => r.lastDate)).toEqual(["2026-11-13", "2020-01-01", null]);
});
test("exports every filtered row, preserving commas, quotes and newlines in CSV", () => {
  const rows = [{ ...all[0]!, h: { ...all[0]!.h, name: 'Read, "one"\npage' } }];
  expect(exportHabitRows(rows, ",")).toContain('"Read, ""one""\npage"');
  expect(exportHabitRows(all, "\t").split("\n")).toHaveLength(56);
  expect(exportHabitRows([], ",")).toBe("Habit,Stack,Status,Started,Consistency 4 wks,Last done");
});
