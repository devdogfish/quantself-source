import { expect, test } from "bun:test";
import { todoTask, todosForDate } from "./todo-projection";
import type { LiveTodo } from "./todo-live";
const todo: LiveTodo = {
  id: "I_live",
  databaseId: 12,
  repository: "example/tasks",
  number: 1,
  title: "A live task",
  body: "Prose",
  state: "open",
  closureReason: null,
  url: "https://github.com/example/tasks/issues/1",
  updatedAt: "2026-10-26T12:00:00Z",
  labels: [],
  fields: {},
  fieldValues: [],
  scheduleError: null,
  start: null, end: null, allDay: false, fixed: false,
};
test("missing commitment and estimates stay unknown; closure stays distinct", () => {
  expect(todoTask(todo)).toMatchObject({
    state: "unknown",
    unknownDuration: true,
    start: "",
  });
  expect(
    todoTask({ ...todo, state: "closed", closureReason: "not_planned" }).state,
  ).toBe("closed");
  expect(
    todoTask({ ...todo, state: "closed", closureReason: "completed" }).state,
  ).toBe("completed");
});
test("one range spans dates with the same task identity and an exclusive end", () => {
  const record = { ...todo, start: "2026-10-26T23:30:00-03:00", end: "2026-10-28T00:00:00-03:00" };
  expect(todoTask(record)).toMatchObject({ id: todo.id, minutes: 1470, start: "23:30", plannedDate: "2026-10-26" });
  expect(todosForDate([record], "2026-10-26")[0]).toMatchObject({ id: todo.id, minutes: 30, start: "23:30", continuesBefore: false, continuesAfter: true });
  expect(todosForDate([record], "2026-10-27")[0]).toMatchObject({ id: todo.id, minutes: 1440, start: "00:00", continuesBefore: true, continuesAfter: false });
  expect(todosForDate([record], "2026-10-28")).toEqual([]);
});
test("unscheduled tasks remain in lists, and all-day ranges share identity", () => {
  expect(todoTask(todo).id).toBe(todo.id);
  expect(todosForDate([todo], "2026-10-26")).toEqual([]);
  const record = { ...todo, start: "2026-10-26T00:00:00-03:00", end: "2026-10-27T00:00:00-03:00", allDay: true };
  expect(todosForDate([record], "2026-10-26")[0]).toMatchObject({ id: todo.id, allDay: true, minutes: 1440 });
});
test("DST-crossing ranges preserve exact duration and surface clock changes", () => {
  const record = { ...todo, start: "2026-11-01T01:30:00-03:00", end: "2026-11-01T02:00:00-04:00" };
  expect(todoTask(record).minutes).toBe(90);
  expect(todosForDate([record], "2026-11-01")[0]).toMatchObject({ unplaced: true, timingWarning: expect.stringContaining("Clock changes") });
});
test("calendar preserves readiness independently of prerequisite placement", () => {
  const record = { ...todo, start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T10:00:00-03:00", readiness: "blocked" as const, blockedBy: [{ id: "missing", databaseId: 99, number: 99, title: "Prerequisite", repository: "external/private", url: "https://example.com" }] };
  expect(todosForDate([record], "2026-10-26")[0]).toMatchObject({ readiness: "blocked", prerequisites: ["missing"] });
  expect(todosForDate([record], "2026-10-26")[0].timingWarning).toContain("Blocked");
});


test("prep crossing midnight remains visible on the adjoining day", () => {
  const todo = { id: "prep", number: 1, title: "Early", state: "open", fields: {}, start: "2026-10-28T00:05:00-03:00", end: "2026-10-28T23:55:00-03:00", beforeMinutes: 10, afterMinutes: 10, allDay: false, fixed: false } as any;
  expect(todosForDate([todo], "2026-10-27")[0]).toMatchObject({ prepOnly: "before", start: "23:55", minutes: 5 });
  expect(todosForDate([todo], "2026-10-28")[0]).toMatchObject({ beforeMinutes: 5, afterMinutes: 5 });
  expect(todosForDate([todo], "2026-10-29")[0]).toMatchObject({ prepOnly: "after", start: "00:00", minutes: 5 });
});

test("projects each valid URL separately, preserving optimistic links and excluding unsafe rows", () => {
  const fields = { URL: "https://example.com/one\r\nhttps://example.org/two\njavascript:alert(1)\nhttps:dsl\nhttps://user:secret@example.com\nnot a URL" };
  const record = { ...todo, optimistic: true, fields };
  expect(todoTask(record)).toMatchObject({ pending: true, eventUrls: ["https://example.com/one", "https://example.org/two"] });
  expect(todoTask({ ...todo, fields: { URL: "example.org/path" } }).eventUrls).toEqual(["https://example.org/path"]);
  expect(todoTask({ ...todo, fields: { URL: "javascript:alert(1)" } }).eventUrls).toEqual([]);
  expect(todoTask(todo).eventUrls).toEqual([]);
});


test("projects nonblank stored locations for map actions", () => {
  expect(todoTask({ ...todo, fields: { Location: "  123 Main St, Halifax  " } }).eventLocation).toBe("123 Main St, Halifax");
  expect(todoTask({ ...todo, fields: { Location: " \n " } }).eventLocation).toBeUndefined();
  expect(todoTask(todo).eventLocation).toBeUndefined();
});
