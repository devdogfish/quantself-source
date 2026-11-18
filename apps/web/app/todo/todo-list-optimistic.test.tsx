import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "./todo-live";

mock.module("./todo-workspace.module.css", () => ({ default: {} }));
mock.module("../calendar/calendar-top-bar", () => ({ CalendarTopBar: () => null }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

test("list priority, completion and Undo remain immediate during pending writes", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=list&date=2026-10-26" });
  const todo: LiveTodo = {
    id: "shopping", databaseId: 1, repository: "example/tasks", number: 1,
    title: "Shopping", body: "", state: "open", closureReason: null,
    url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z",
    labels: [], fields: { Commitment: "Active", Rank: 1 }, fieldValues: [], scheduleError: null,
    start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:05:00-03:00", fixed: false, allDay: false,
  };
  const second: LiveTodo = { ...todo, id: "crawler", number: 2, title: "Run crawler", fields: { Commitment: "Active", Rank: 2 } };
  const tasks: LiveTodo[] = [todo, second];
  let listReads = 0;
  let patchWrites = 0;
  let written: any;
  let writtenNumber = 0;
  let finishSave!: (response: Response) => void;
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchWrites++;
        writtenNumber = Number(path.split("/").at(-1));
        written = JSON.parse(String(init.body));
        return new Promise<Response>(resolve => { finishSave = resolve; });
      }
      if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
      if (path.endsWith("access-context")) return Response.json({ permissions: ["todos:read", "todos:write"] });
      listReads++;
      return Response.json({ todos: tasks, readAt: "now" });
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    window.localStorage.setItem("quantself.todo.layout", "classic");
    const { TodoWorkspace } = await import("./todo-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    expect(host.querySelector('[data-layout="list"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Classic");
    const click = async (label: string) => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      expect(button).not.toBeNull();
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    };
    const undo = async () => act(async () => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }) as unknown as Event));
    await click("Mark Shopping as top priority");
    await click("Remove top priority from Shopping");
    await undo();
    expect(host.querySelector('[aria-label="Remove top priority from Shopping"]')).not.toBeNull();
    await click("Complete Shopping");
    expect(host.querySelector('[aria-label="Open Shopping"]')).toBeNull();
    await undo();
    expect(host.querySelector('[aria-label="Open Shopping"]')).not.toBeNull();
    expect(patchWrites).toBe(1);
    for (let index = 0; index < 5; index++) {
      const task = tasks.find(task => task.number === writtenNumber)!;
      for (const [key, value] of Object.entries(written.fields ?? {}) as [string, {before: any; after: any}][]) {
        expect(task.fields[key] ?? null).toEqual(value.before);
        task.fields[key] = value.after;
      }
      if (written.closure) {
        expect(written.closure.before.outcome).toBe(task.state === "open" ? "open" : task.closureReason);
        task.state = written.closure.after.outcome === "open" ? "open" : "closed";
        task.closureReason = task.state === "open" ? null : written.closure.after.outcome;
      }
      task.updatedAt = crypto.randomUUID();
      const outcomes = Object.fromEntries([...Object.keys(written.fields ?? {}), ...(written.closure ? ["closure"] : [])].map(key => [key, "saved"]));
      await act(async () => finishSave(Response.json({ commandId: written.commandId, todo: task, outcomes, retryable: false, message: "Saved" })));
      expect(host.querySelector('[aria-label="Remove top priority from Shopping"]')).not.toBeNull();
      expect(host.querySelector('[aria-label="Open Shopping"]')).not.toBeNull();
    }
    expect(patchWrites).toBe(5);
    expect(listReads).toBe(1);
    expect(todo.state).toBe("open");
    expect(todo.fields["Top priority"]).toBe("Yes");
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
