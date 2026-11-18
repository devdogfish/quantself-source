import { expect, test } from "bun:test";
import { moveTaskTiming, timingInstant, timingRange } from "./todo-timing";
const range = { start: "2026-10-31T23:30:00-03:00", end: "2026-11-01T01:30:00-04:00", allDay: false, fixed: true };
test("movement preserves elapsed duration and handles a clipped next-day segment", () => {
  const moved = moveTaskTiming(range, "2026-11-02", 540);
  expect(moved).toMatchObject({ start: "2026-11-02T13:00:00.000Z", end: "2026-11-02T16:00:00.000Z", fixed: true });
  expect(moveTaskTiming(range, "2026-11-02", 60, { date: "2026-11-01", start: "00:00" }).start).toBe("2026-11-02T04:30:00.000Z");
});
test("DST gaps/folds require explicit offset; existing instants remain editable", () => {
  for (const wall of ["2026-03-08T02:30", "2026-11-01T01:30"]) expect(() => timingInstant(wall)).toThrow("explicit ISO time with offset");
  expect(timingInstant("2026-11-01T01:30", range.end)).toBe(range.end);
  expect(timingInstant("2026-11-01T01:30:00-03:00")).toBe("2026-11-01T04:30:00.000Z");
});

test("resize preserves the untouched instant, supports midnight, normalizes crossed ranges and DST ambiguity", async () => {
  const { resizeTaskTiming } = await import("./todo-timing");
  const event = { start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T10:00:00-03:00", allDay: false, fixed: false };
  expect(resizeTaskTiming(event, "2026-10-26", "start", 555)).toEqual({ ...event, start: "2026-10-26T12:15:00.000Z" });
  expect(resizeTaskTiming(event, "2026-10-26", "end", 1440)).toEqual({ ...event, end: "2026-10-27T03:00:00.000Z" });
  expect(() => resizeTaskTiming(event, "2026-10-26", "start", 600)).toThrow("at least one minute");
  expect(resizeTaskTiming(event, "2026-10-26", "end", 525)).toEqual({ ...event, start: "2026-10-26T11:45:00.000Z", end: event.start });
  expect(resizeTaskTiming(event, "2026-10-26", "start", 615)).toEqual({ ...event, start: event.end, end: "2026-10-26T13:15:00.000Z" });
  expect(() => resizeTaskTiming(event, "2026-11-01", "end", 90)).toThrow("explicit ISO time with offset");
  expect(resizeTaskTiming({ ...event, end: "2026-10-27T10:00:00-03:00" }, "2026-10-27", "end", 630).start).toBe(event.start);
});

 test("one entered bound seeds a thirty-minute range through midnight and offset changes", () => {
  expect(timingRange("2026-10-31T23:45", "")).toMatchObject({ start: "2026-11-01T02:45:00.000Z", end: "2026-11-01T03:15:00.000Z" });
  expect(timingRange("", "2026-11-01T01:15:00-04:00")).toMatchObject({ start: "2026-11-01T04:45:00.000Z", end: "2026-11-01T05:15:00.000Z" });
});

test("cross-day resize preserves the anchored instant across DST and rejects ambiguous destinations", async () => {
  const { resizeTaskTiming } = await import("./todo-timing");
  const event = { start: "2026-10-31T09:00:00-03:00", end: "2026-10-31T10:00:00-03:00", allDay: false, fixed: false };
  const after = resizeTaskTiming(event, "2026-11-01", "end", 600);
  expect(after.start).toBe(event.start);
  expect(after.end).toBe("2026-11-01T14:00:00.000Z");
  expect(() => resizeTaskTiming(event, "2026-11-01", "end", 90)).toThrow("explicit ISO time with offset");
  expect(resizeTaskTiming(event, "2026-10-30", "start", 540).end).toBe(event.end);
});
