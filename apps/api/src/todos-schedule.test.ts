import { expect, test } from "bun:test";
import { emptyTiming, readTodoSchedule, editScheduleBody, todoTimingSchema, timingOverlapsDates } from "./todos-schedule";
import { withTimingWarnings } from "./todos-timing";
import type { Todo } from "./todos-github";
const range = { start: "2026-10-27T18:00:00-03:00", end: "2026-10-27T22:00:00-03:00", allDay: false, fixed: false };
const block = (value: unknown) => `<!-- quantself:todo-schedule -->\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- /quantself:todo-schedule -->`;
test("one task owns one optional range, preserves prose and version-2 extensions", () => {
  expect(readTodoSchedule("Only prose")).toEqual({ ...emptyTiming(), scheduleError: null });
  const body = `Before\n${block({ version: 2, ...range, future: { keep: true } })}\nAfter`;
  expect(readTodoSchedule(body)).toEqual({ ...range, scheduleError: null });
  const changed = editScheduleBody(body, { ...range, end: "2026-10-28T01:00:00-03:00" });
  expect(changed).toStartWith("Before\n"); expect(changed).toEndWith("\nAfter"); expect(changed).toContain('"future"');
  expect(editScheduleBody(changed, emptyTiming())).toContain('"start": null');
});
test("bounds must be paired, ordered and valid; malformed blocks are never overwritten", () => {
  for (const value of [{ ...range, end: range.start }, { ...range, end: null }, { ...range, start: "invalid" }, { ...emptyTiming(), fixed: true }]) expect(todoTimingSchema.safeParse(value).success).toBe(false);
  for (const body of [block({ version: 3, ...range }), block({ version: 2, ...range }) + block({ version: 2, ...range }), "<!-- quantself:todo-schedule -->bad"]) {
    expect(readTodoSchedule(body).scheduleError).toContain("Review task timing");
    expect(() => editScheduleBody(body, range)).toThrow("Review task timing");
  }
  expect(() => editScheduleBody("a".repeat(65536), range)).toThrow("65,536");
});
const legacy = { id: "old-id", placement: { kind: "timed", start: range.start, timeZone: "America/Halifax" }, duration: { minutes: 240, certainty: "confirmed" }, fixed: false };
test("legacy single ranges read without mutation and archive original metadata on explicit edit", () => {
  const body = block({ version: 1, sessions: [legacy], extension: "retain" });
  expect(readTodoSchedule(body)).toEqual({ ...range, end: "2026-10-28T01:00:00.000Z", scheduleError: null });
  const changed = editScheduleBody(body, range);
  expect(changed).toContain('"legacySchedule"'); expect(changed).toContain('"extension": "retain"');
  expect(readTodoSchedule(changed)).toEqual({ ...range, scheduleError: null });
});
test("ambiguous, multiple, incomplete or travel-bearing legacy ranges remain intact for review", () => {
  for (const sessions of [[legacy, legacy], [{ ...legacy, duration: { minutes: null } }], [{ ...legacy, placement: { kind: "untimed", date: "2026-10-27" } }], [{ ...legacy, allowances: { preparation: { minutes: 10 } } }]]) {
    const body = block({ version: 1, sessions });
    expect(readTodoSchedule(body).scheduleError).toContain("review");
    expect(() => editScheduleBody(body, range)).toThrow();
  }
});
test("legacy all-day ranges use actual midnight boundaries across DST", () => {
  const body = block({ version: 1, sessions: [{ ...legacy, placement: { kind: "all-day", date: "2026-11-01", timeZone: "America/Halifax" } }] });
  const parsed = readTodoSchedule(body);
  expect(parsed).toMatchObject({ start: "2026-11-01T03:00:00.000Z", end: "2026-11-02T04:00:00.000Z", allDay: true, scheduleError: null });
});
test("date filtering uses viewing zone and exclusive end, including DST", () => {
  const timing = { ...range, start: "2026-10-31T23:30:00-03:00", end: "2026-11-02T00:00:00-04:00" };
  expect(timingOverlapsDates(timing, "2026-11-01", "2026-11-01", "America/Halifax")).toBe(true);
  expect(timingOverlapsDates(timing, "2026-11-02", "2026-11-02", "America/Halifax")).toBe(false);
});
test("flat warnings retain overlapping ranges and respect 25-hour day capacity", () => {
  const base = { state: "open", allDay: false, fixed: false, start: "2026-11-01T00:00:00-03:00", end: "2026-11-02T00:00:00-04:00" };
  const single = withTimingWarnings([{ ...base, number: 1 } as Todo], "America/Halifax");
  expect(single[0].timingWarnings).toEqual([]);
  const overlaps = withTimingWarnings([{ ...base, number: 1 } as Todo, { ...base, number: 2, start: "2026-11-01T01:00:00-03:00" } as Todo], "America/Halifax");
  expect(overlaps[0].timingWarnings).toEqual([expect.stringContaining("Overlap"), expect.stringContaining("Overfull")]);
  expect(overlaps).toHaveLength(2);
});

test("voice summary converts mixed offsets and shifts preserve duration across DST", async () => {
  const { taskTimingSummary, shiftTaskTiming } = await import("./todos-schedule");
  const mixed = { ...range, start: "2026-10-27T17:30:00-03:00", end: "2026-10-27T20:40:00.000Z" };
  const summary = taskTimingSummary(mixed);
  expect(summary).toContain("17:30"); expect(summary).toContain("17:40");
  expect(summary).toContain("GMT-03:00"); expect(summary).toContain("10 minutes");
  const shifted = shiftTaskTiming({ ...mixed, start: "2026-11-01T01:50:00-03:00", end: "2026-11-01T01:00:00-04:00" }, 30);
  expect(shifted.start).toBe("2026-11-01T05:20:00.000Z");
  expect(shifted.end).toBe("2026-11-01T05:30:00.000Z");
  expect(taskTimingSummary(shifted)).toContain("GMT-04:00");
  expect(taskTimingSummary(shifted)).toContain("10 minutes");
  expect(shiftTaskTiming(shifted, -30).start).toBe("2026-11-01T04:50:00.000Z");
  expect(() => shiftTaskTiming(emptyTiming(), 30)).toThrow("unscheduled");
});


test("prep extends date filtering without changing the event interval", () => {
  const timing = { ...range, start: "2026-10-28T00:05:00-03:00", end: "2026-10-28T23:55:00-03:00", beforeMinutes: 10, afterMinutes: 10 };
  expect(timingOverlapsDates(timing, "2026-10-27", "2026-10-27", "America/Halifax")).toBe(true);
  expect(timingOverlapsDates(timing, "2026-10-29", "2026-10-29", "America/Halifax")).toBe(true);
  for (const minutes of [-1, 0.5, 1441]) expect(todoTimingSchema.safeParse({ ...range, beforeMinutes: minutes }).success).toBe(false);
});
