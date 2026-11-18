import { expect, test } from "bun:test";
import { jarvisTaskContext } from "./jarvis-task-context";
import type { LiveTodo } from "./todo-live";
import type { JarvisUiContext } from "./jarvis-ui";
const context: JarvisUiContext = { page: "/todo", calendarView: "day", date: "2026-10-26", selectedTask: null, panel: null };
function task(number: number, extra: Partial<LiveTodo> = {}): LiveTodo {
  return { id: String(number), number, databaseId: number, repository: "example/tasks", title: `Task ${number}`, body: "Visible notes\n<!-- metadata hidden -->", state: "open", closureReason: null, url: "https://github.com/example/tasks/issues/1", updatedAt: "r1", labels: [], fields: {}, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null, ...extra };
}
test("visible descriptions obey view/category filters; next week is compact, open and independent", () => {
  const todos = [task(1, { start: "2026-10-25T23:30:00-03:00", end: "2026-10-26T01:00:00-03:00" }), task(2, { fields: { Due: "2026-10-26" }, description: "a".repeat(300) }), task(3, { fields: { Due: "2026-11-01" } }), task(4, { fields: { Due: "2026-11-02" } }), task(5, { fields: { Due: "2026-10-26" }, trashed: true }), task(6, { fields: { Due: "2026-10-26" }, state: "closed" }), task(7, { start: "2026-10-25T23:00:00-03:00", end: "2026-10-26T00:00:00-03:00" })];
  const input = { context, todos, visibleTodos: todos.filter(t => t.number !== 6), today: "2026-10-26", status: "ready" };
  const result = jarvisTaskContext(input);
  expect(result.visibleTasks?.map(t => t.number)).toEqual([1, 2]);
  expect(result.visibleTasks?.[0].description).toBe("Visible notes");
  expect(result.visibleTasks?.[1].description).toHaveLength(240);
  expect(result.nextSevenDays?.map(t => t.number)).toEqual([1, 2, 3]);
  expect(Object.keys(result.nextSevenDays![0])).toEqual(["number", "title", "when"]);
  expect(jarvisTaskContext({ ...input, context: { ...context, calendarView: "list" } }).visibleTasks).toHaveLength(5);
  expect(jarvisTaskContext({ ...input, context: { ...context, calendarView: "week" } }).visibleTasks?.map(t => t.number)).toEqual([1, 2, 7]);
});
test("selected full detail preserves missing properties, overlays new intent, and never reuses stale facts", () => {
  const detail = task(1, { description: "Full detail", body: "Full body" });
  const selected = task(1, { title: "Optimistic title", description: undefined });
  Object.assign(selected, { body: undefined });
  const input = { context: { ...context, selectedTask: { number: 1, title: "Old", facts: { stale: true } } }, todos: [selected], visibleTodos: [selected], today: "2026-10-26", status: "ready", detail };
  expect(jarvisTaskContext(input).selectedTask).toMatchObject({ title: "Optimistic title", facts: { description: "Full detail", body: "Full body" } });
  expect(jarvisTaskContext({ ...input, detail: { ...detail, updatedAt: "old" } }).selectedTask?.facts).toEqual(selected);
  expect(jarvisTaskContext({ ...input, todos: [], detail: null }).selectedTask).toEqual({ number: 1, title: "Old" });
  expect(jarvisTaskContext({ ...input, todos: [{ ...selected, trashed: true }] }).selectedTask).toBeNull();
  expect(jarvisTaskContext({ ...input, status: "denied" })).toMatchObject({ selectedTask: null, visibleTasks: [], nextSevenDays: [] });
  expect(jarvisTaskContext({ ...input, unavailableNumbers: [1] })).toMatchObject({ selectedTask: null, visibleTasks: [], nextSevenDays: [] });
});

test("pending creations are not published as saved tasks or selected facts", () => {
  const pending = task(-1, { optimistic: true, fields: { Due: "2026-10-26" } });
  const result = jarvisTaskContext({ context: { ...context, selectedTask: { number: -1, title: pending.title } }, todos: [pending], visibleTodos: [pending], today: "2026-10-26", status: "ready" });
  expect(result).toMatchObject({ selectedTask: null, visibleTasks: [], nextSevenDays: [] });
});


test("denied task context clears category names and filter selection", () => {
  const result = jarvisTaskContext({ context: { ...context, categories: [{ id: 1, name: "Private", color: "blue" }], categoryFilter: { filter: "category", categoryId: 1 } }, todos: [], visibleTodos: [], today: "2026-10-26", status: "denied" });
  expect(result.categories).toEqual([]);
  expect(result.categoryFilter).toEqual({ filter: "all" });
});
