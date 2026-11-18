import { describe, expect, test } from "bun:test";
import { newTaskTiming } from "./new-task-timing";
import type { LiveTodo } from "./todo-live";
function occupied(start: string, end: string, extra: Partial<LiveTodo> = {}) {
  return { state: "open", start, end, ...extra } as LiveTodo;
}
describe("new task timing", () => {
  test("nearest future minute, thirty minutes in Halifax", () => {
    expect(newTaskTiming([], Date.parse("2026-10-28T15:00:30Z"))).toEqual({ start: "2026-10-28T12:01", end: "2026-10-28T12:31", allDay: false });
  });
  test("skips overlapping prep, nested ranges and cross-midnight work", () => {
    const todos = [occupied("2026-10-29T02:45:00Z", "2026-10-29T03:30:00Z", { afterMinutes: 15 }), occupied("2026-10-29T03:10:00Z", "2026-10-29T03:20:00Z"), occupied("2026-10-29T04:00:00Z", "2026-10-29T04:30:00Z", { beforeMinutes: 15 })];
    expect(newTaskTiming(todos, Date.parse("2026-10-29T02:50:00Z"))).toEqual({ start: "2026-10-29T01:30", end: "2026-10-29T02:00", allDay: false });
  });
  test("accepts exact thirty minute gaps and ignores closed work", () => {
    expect(newTaskTiming([occupied("2026-10-28T15:31:00Z", "2026-10-28T16:00:00Z"), occupied("2026-10-28T15:00:00Z", "2026-10-28T16:00:00Z", { state: "closed" })], Date.parse("2026-10-28T15:00:00Z"))).toEqual({ start: "2026-10-28T12:01", end: "2026-10-28T12:31", allDay: false });
  });
});
