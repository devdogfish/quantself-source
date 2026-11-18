import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { LiveTodo } from "./todo-live";
import type { JarvisCategoryCommand } from "./jarvis-category-commands";

test("Jarvis assignments, removal and priority use the shared optimistic task queue with later intent and limit checks", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let reads = 0;
  const tasks = [1, 2, 3, 4].map(number => ({ number, id: `task-${number}`, title: `Task ${number}`, fields: { Category: null, "Top priority": number <= 2 ? "Yes" : "No" }, updatedAt: "r1", state: "open", start: null, end: null, allDay: false, fixed: false } as LiveTodo));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async () => { reads++; return Response.json({ categories: [{ id: 1, name: "Work", color: "blue" }, { id: 2, name: "Home", color: "green" }], revision: "r1" }); } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { CategoryProvider, useCategories } = await import("./todo-categories");
  const { useJarvisCategoryCommands } = await import("./jarvis-category-commands");
  const root = createRoot(host);
  let manual!: (number: number, category: string | null) => void;
  let execute!: (command: JarvisCategoryCommand) => Promise<any>;
  const queued: { command: any; number: number; resolve(): void; reject(error: Error): void }[] = [];
  function Harness() {
    const categories = useCategories();
    const [todos, setTodos] = useState(tasks);
    manual = (number, category) => setTodos(rows => rows.map(row => row.number === number ? { ...row, fields: { ...row.fields, Category: category } } as LiveTodo : row));
    execute = useJarvisCategoryCommands({ todos, writable: true }).execute;
    useEffect(() => categories.registerQueue((command, baseline) => {
      setTodos(rows => rows.map(row => row.number === baseline.number ? { ...row, fields: { ...row.fields, ...Object.fromEntries(Object.entries(command.fields ?? {}).map(([field, patch]) => [field, patch!.after])) } } as LiveTodo : row));
      return new Promise<void>((resolve, reject) => queued.push({ command, number: baseline.number, resolve, reject }));
    }), [categories.registerQueue]);
    return <output>{JSON.stringify(todos.map(row => [row.number, row.fields.Category, row.fields["Top priority"]]))}</output>;
  }
  const state = () => JSON.parse(host.querySelector("output")!.textContent!);
  try {
    await act(async () => root.render(<CategoryProvider><Harness /></CategoryProvider>));
    let first!: Promise<any>, second!: Promise<any>, clear!: Promise<any>;
    await act(async () => { first = execute({ action: "assign", taskNumbers: [1], categoryId: 1 }); });
    expect(state()[0]).toEqual([1, "Work", "Yes"]);
    await act(async () => { second = execute({ action: "assign", taskNumbers: [1], categoryId: 2 }); });
    expect(queued[1].command.fields.Category).toEqual({ before: "Work", after: "Home" });
    await act(async () => { clear = execute({ action: "assign", taskNumbers: [1], categoryId: null }); });
    expect(state()[0]).toEqual([1, null, "Yes"]);
    await act(async () => queued[0].resolve()); expect(state()[0]).toEqual([1, null, "Yes"]);
    await act(async () => queued[1].resolve()); expect(state()[0]).toEqual([1, null, "Yes"]);
    await act(async () => queued[2].resolve());
    expect((await Promise.all([first, second, clear])).map(value => value.status)).toEqual(["saved", "saved", "saved"]);
    let priority!: Promise<any>, refused!: Promise<any>;
    await act(async () => {
      priority = execute({ action: "priority", taskNumbers: [3], highPriority: true });
      refused = execute({ action: "priority", taskNumbers: [4], highPriority: true }).catch(error => error.message);
    });
    expect(await refused).toContain("Only three");
    expect(state()[2]).toEqual([3, null, "Yes"]);
    expect(queued).toHaveLength(4);
    await act(async () => queued[3].resolve()); expect((await priority).status).toBe("saved");
    let remove!: Promise<any>;
    await act(async () => { remove = execute({ action: "priority", taskNumbers: [3], highPriority: false }); });
    expect(state()[2]).toEqual([3, null, "No"]);
    await act(async () => queued[4].reject(Error("Conflict")));
    expect(await remove).toMatchObject({ status: "partial", failed: [{ number: 3, message: "Conflict" }] });
    let pendingAssign!: Promise<any>, duplicate!: Promise<any>, duplicateSettled = false;
    await act(async () => { pendingAssign = execute({ action: "assign", taskNumbers: [4], categoryId: 1 }); });
    await act(async () => { duplicate = execute({ action: "assign", taskNumbers: [4], categoryId: 1 }).then(result => { duplicateSettled = true; return result; }); });
    expect(duplicateSettled).toBe(false); expect(queued).toHaveLength(6);
    await act(async () => queued[5].reject(Error("Assignment failed")));
    expect((await pendingAssign).status).toBe("partial"); expect((await duplicate).status).toBe("partial");
    let pendingHome!: Promise<any>, laterHome!: Promise<any>;
    await act(async () => { pendingHome = execute({ action: "assign", taskNumbers: [4], categoryId: 2 }); });
    await act(async () => manual(4, null)); // Shared manual Undo supersedes Jarvis's private pending intent.
    await act(async () => { laterHome = execute({ action: "assign", taskNumbers: [4], categoryId: 2 }); });
    expect(queued).toHaveLength(8); expect(queued[7].command.fields.Category).toEqual({ before: null, after: "Home" });
    await act(async () => { queued[6].resolve(); queued[7].resolve(); });
    expect((await pendingHome).status).toBe("saved"); expect((await laterHome).status).toBe("saved");
    let omittedClear!: Promise<any>;
    await act(async () => { omittedClear = execute({ action: "assign", taskNumbers: [4] }); });
    expect(queued[8].command.fields.Category.after).toBeNull();
    await act(async () => queued[8].resolve()); await omittedClear;
    expect(reads).toBe(1); // Existing provider options; no per-task HTTP reads or writes outside the queue.
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

test.each(["saved", "failed"])("deleting a pending new category resolves its ID and waits for %s task reassignment", async mode => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let releaseCategory!: () => void, releaseTask!: () => void, failTask!: (error: Error) => void;
  let taskReads = 0;
  const commands: any[] = [], edits: any[] = [];
  let categories: any[] = [];
  const row = { number: 7, id: "task7", title: "Task", fields: { Category: "Garden" }, categoryId: 10, updatedAt: "r1", trashed: true } as LiveTodo;
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (String(path).includes("trash=include")) { taskReads++; return Response.json({ todos: [row] }); }
      if (!init?.method) return Response.json({ categories, revision: "r1" });
      const command = JSON.parse(String(init.body)); commands.push(command);
      await new Promise<void>(resolve => { releaseCategory = resolve; });
      categories = command.action === "create" ? [{ id: 10, name: command.name, color: command.color }] : [];
      return Response.json({ categories, revision: `r${commands.length + 1}` });
    } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { CategoryProvider, useCategories } = await import("./todo-categories");
  const { useJarvisCategoryCommands } = await import("./jarvis-category-commands");
  const root = createRoot(host);
  let execute!: (command: JarvisCategoryCommand) => Promise<any>;
  function Harness() {
    const categories = useCategories();
    execute = useJarvisCategoryCommands({ todos: [], writable: true }).execute;
    useEffect(() => categories.registerQueue((command, baseline) => { edits.push({ command, number: baseline.number }); return new Promise<void>((resolve, reject) => { releaseTask = resolve; failTask = reject; }); }), [categories.registerQueue]);
    return <output>{JSON.stringify(categories.categories)}</output>;
  }
  const shown = () => JSON.parse(host.querySelector("output")!.textContent!);
  try {
    await act(async () => root.render(<CategoryProvider><Harness /></CategoryProvider>));
    let creating!: Promise<any>, deleting!: Promise<any>;
    await act(async () => { creating = execute({ action: "create", name: "Garden", color: "green" }); });
    expect(shown()).toMatchObject([{ id: -1, name: "Garden" }]);
    await act(async () => { deleting = execute({ action: "delete", categoryId: -1 }); });
    expect(taskReads).toBe(0);
    await act(async () => releaseCategory());
    expect((await creating).category.id).toBe(10);
    expect(taskReads).toBe(1); expect(commands).toHaveLength(1);
    expect(edits).toMatchObject([{ number: 7, command: { fields: { Category: { before: "Garden", after: null } } } }]);
    if (mode === "failed") {
      await act(async () => failTask(Error("Task conflict")));
      expect(await deleting).toMatchObject({ status: "partial", failed: [{ number: 7, message: "Task conflict" }] });
      expect(commands).toHaveLength(1); expect(shown()).toHaveLength(1);
    } else {
      await act(async () => releaseTask());
      expect(commands).toHaveLength(2); expect(commands[1]).toMatchObject({ action: "delete", id: 10 });
      expect(shown()).toEqual([]); // Metadata deletion projects before the server response.
      await act(async () => releaseCategory());
      expect(await deleting).toMatchObject({ status: "saved", saved: [7] });
    }
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
