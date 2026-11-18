import { expect, test } from "bun:test";
import { createTodoReadStore, type LiveTodo } from "./todo-live";
import { jarvisTaskContext } from "./jarvis-task-context";

test("SSE updates retain Rank and stable identity order in workspace and Jarvis context", async () => {
  const task = (number: number, rank?: number) => ({ id: `I${number}`, number, title: `Task ${number}`, state: "open", fields: { Due: "2026-10-28", ...(rank === undefined ? {} : { Rank: rank }) }, updatedAt: "2026-10-28T01:00:00Z" }) as LiveTodo;
  const rows = [task(1, 1), task(2, 1), task(3), task(4)];
  const store = createTodoReadStore(async () => ({ todos: rows, readAt: "2026-10-28T01:00:00Z" }));
  await store.refresh();
  store.applyRemote({ generation: 1, upserts: [{ ...rows[0], title: "Edited first" }, { ...rows[2], title: "Edited unranked" }], readAt: "2026-10-28T01:01:00Z" });
  const snapshot = store.getSnapshot();
  expect(snapshot.todos.map(todo => todo.number)).toEqual([1, 2, 3, 4]);
  const context = jarvisTaskContext({ context: { page: "/todo", calendarView: "list", date: "2026-10-28", selectedTask: null, panel: null }, todos: snapshot.todos, visibleTodos: snapshot.todos, today: "2026-10-28", status: "ready" });
  expect(context.visibleTasks?.map(todo => todo.number)).toEqual([1, 2, 3, 4]);
  expect(context.nextSevenDays?.map(todo => todo.number)).toEqual([1, 2, 3, 4]);
  store.applyRemote({ generation: 2, upserts: [{ ...rows[3], fields: { Rank: 0 } }], readAt: "2026-10-28T01:02:00Z" });
  expect(store.getSnapshot().todos.map(todo => todo.number)).toEqual([4, 1, 2, 3]);
});
