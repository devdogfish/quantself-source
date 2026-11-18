import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createJarvisUiBridge, type JarvisUiContext } from "./jarvis-ui";
import { useJarvisTaskContext } from "./use-jarvis-task-context";
import { readTodoDetail } from "./todo-detail-reader";
import type { LiveTodo } from "./todo-live";

test("context shares selected reads, races safely, and removes denied facts without per-row reads", async () => {
  const dom = new Window();
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls: { url: string; resolve(response: Response): void }[] = [];
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? (url: string) => new Promise<Response>(resolve => calls.push({ url, resolve })) : (dom as unknown as Record<string, unknown>)[name] });
  const todos: LiveTodo[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), number: i + 1, databaseId: i + 1, repository: "example/tasks", title: `Task ${i + 1}`, body: "Brief", state: "open", closureReason: null, url: "https://example.com", updatedAt: "r1", labels: [], fields: {}, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null }));
  const bridge = createJarvisUiBridge(); bridge.setPage("/todo");
  let enabled = false, number: number | null = 1, status = "ready";
  function Consumer() {
    const context: JarvisUiContext = { page: "/todo", calendarView: "list", date: "2026-10-26", panel: null, selectedTask: number ? { number, title: null } : null };
    useJarvisTaskContext(enabled ? bridge : null, context, todos, todos, "2026-10-26", status); return null;
  }
  const { createRoot } = await import("react-dom/client"); const root = createRoot(document.createElement("div"));
  const render = () => act(async () => root.render(<Consumer />));
  const settle = (index: number, response: Response) => act(async () => calls[index].resolve(response));
  try {
    await render(); expect(calls).toHaveLength(0);
    enabled = true; await render(); expect(calls).toHaveLength(1);
    const panelRead = readTodoDetail(1, "r1"); expect(calls).toHaveLength(1);
    number = 2; await render(); expect(calls).toHaveLength(2);
    await settle(1, Response.json({ todo: { ...todos[1], description: "Second detail" } }));
    await settle(0, Response.json({ todo: { ...todos[0], description: "Old selection" } })); await panelRead;
    expect(bridge.context().selectedTask).toMatchObject({ number: 2, facts: { description: "Second detail" } });
    todos[1] = { ...todos[1], updatedAt: "r2" }; await render(); expect(calls).toHaveLength(3);
    todos[1] = { ...todos[1], updatedAt: "r3" }; await render(); expect(calls).toHaveLength(4);
    await settle(3, Response.json({ todo: { ...todos[1], description: "Newest" } }));
    await settle(2, Response.json({ todo: { ...todos[1], updatedAt: "r2", description: "Stale" } }));
    expect(bridge.context().selectedTask).toMatchObject({ facts: { description: "Newest", updatedAt: "r3" } });
    number = 3; await render(); expect(calls).toHaveLength(5);
    await settle(4, Response.json({ message: "Denied" }, { status: 403 }));
    expect(bridge.context()).toMatchObject({ selectedTask: null, visibleTasks: [], nextSevenDays: [], taskFreshness: "denied" });
    number = 4; await render(); expect(bridge.context().visibleTasks).toEqual([]);
    await settle(5, Response.json({ todo: todos[3] })); expect(bridge.context().visibleTasks).toHaveLength(100);
    number = 5; await render(); await settle(6, Response.json({ message: "Missing" }, { status: 404 }));
    expect(bridge.context().selectedTask).toBeNull(); expect(bridge.context().visibleTasks).toHaveLength(99);
    number = 6; await render(); await settle(7, Response.json({ todo: todos[5] })); expect(bridge.context().visibleTasks).toHaveLength(99);
    number = 7; await render(); expect(calls).toHaveLength(9);
    status = "denied"; await render(); expect(calls).toHaveLength(9); expect(bridge.context().visibleTasks).toEqual([]);
    status = "ready"; await render(); expect(calls).toHaveLength(10);
    await settle(8, Response.json({ todo: { ...todos[6], description: "Old authorization" } }));
    expect((bridge.context().selectedTask?.facts as LiveTodo)?.description).not.toBe("Old authorization");
    await settle(9, Response.json({ todo: { ...todos[6], description: "New authorization" } }));
    expect(bridge.context().selectedTask).toMatchObject({ facts: { description: "New authorization" } });
  } finally { await act(async () => root.unmount()); await dom.happyDOM.cancelAsync(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
});
