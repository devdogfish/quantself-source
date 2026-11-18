import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "../todo/todo-live";

mock.module("../todo/todo-workspace.module.css", () => ({ default: {} }));
mock.module("./calendar-top-bar", () => ({ CalendarTopBar: () => null }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

test.each(["history", "uncertain", "conflict"])("rapid moves handle %s saves without losing newer previews or overwriting conflicts", async failure => {
  const fixed = false;
  const dom = new Window({ url: "http://localhost/todo?view=calendar&date=2026-10-26" });
  const todo: LiveTodo = {
    id: "shopping", databaseId: 1, repository: "example/tasks", number: 1,
    title: "Shopping", body: "", state: "open", closureReason: null,
    url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z",
    labels: [], fields: { Commitment: "Active" }, fieldValues: [], scheduleError: null,
    start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:05:00-03:00", fixed, allDay: false,
  };
  let listReads = 0;
  let patchWrites = 0;
  let written: any;
  let finishSave!: (response: Response) => void;
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchWrites++;
        written = JSON.parse(String(init.body));
        return new Promise<Response>(resolve => { finishSave = resolve; });
      }
      if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
      if (path.endsWith("access-context")) return Response.json({ permissions: ["todos:read", "todos:write"] });
      listReads++;
      return Response.json({ todos: [todo, { ...todo, id: "crawler", number: 2, title: "Run crawler", start: "2026-10-26T09:20:00-03:00", end: "2026-10-26T10:20:00-03:00", fixed: false }], readAt: "now" });
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("./calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const area = host.querySelector<HTMLElement>("[data-calendar-time-area]")!;
    area.getBoundingClientRect = () => ({ left: -700, top: 0, right: 1464, bottom: 2160, width: 2164, height: 2160 }) as DOMRect;
    let button = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Shopping,"]')!;
    const viewport = host.querySelector<HTMLElement>("[data-scope='scroll-area'][data-part='viewport']")!;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 764, bottom: 800, width: 764, height: 800 }) as DOMRect;
    let capture = false;
    button.setPointerCapture = () => { capture = true; };
    button.hasPointerCapture = () => capture;
    button.releasePointerCapture = () => { capture = false; };
    const pointer = (type: string, y: number, modifiers = {}) => button.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 414, clientY: 100 + (y - 100) * .8, ...modifiers }) as unknown as Event);
    const settleSave = async () => {
      Object.assign(todo, { start: written.start, end: written.end, fixed: written.fixed, updatedAt: crypto.randomUUID() });
      await act(async () => finishSave(Response.json({ todo: { ...todo }, outcomes: { timing: "saved" }, retryable: false, message: "Saved" })));
    };
    const undo = async (redo = false) => { await act(async () => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: redo, bubbles: true }) as unknown as Event)); };
    const move = async () => {
      button = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Shopping,"]')!;
      await act(async () => pointer("pointerdown", 100));
      await act(async () => pointer("pointermove", 130));
      await act(async () => pointer("pointerup", 130));
    };
    const label = () => host.querySelector('button[aria-label^="Event Shopping,"]')!.getAttribute("aria-label");
    await move();
    const first = { ...written };
    await move();
    await move();
    expect(label()).toContain("09:45 to 09:50");
    expect(patchWrites).toBe(1);
    if (failure === "history") {
      await undo();
      expect(label()).toContain("09:30 to 09:35");
      await undo();
      expect(label()).toContain("09:15 to 09:20");
      await undo(true);
      expect(label()).toContain("09:30 to 09:35");
      await move();
      expect(label()).toContain("09:45 to 09:50");
      await undo(true); // A new edit invalidates redo immediately.
      expect(label()).toContain("09:45 to 09:50");
      await undo();
      expect(label()).toContain("09:30 to 09:35");
      await undo(true);
      expect(label()).toContain("09:45 to 09:50");
      expect(patchWrites).toBe(1);
      for (let index = 0; index < 9; index++) {
        await settleSave();
        expect(label()).toContain("09:45 to 09:50");
        if (index < 8) expect(written.revision).toBe(todo.updatedAt);
      }
      expect(patchWrites).toBe(9);
      expect(listReads).toBe(1);
      await undo();
      expect(label()).toContain("09:30 to 09:35");
      await settleSave();
      return;
    }
    await act(async () => finishSave(Response.json({ message: "Save interrupted" }, { status: failure === "uncertain" ? 503 : 409 })));
    if (failure === "uncertain") {
      expect(label()).toContain("09:45 to 09:50");
      await undo();
      expect(label()).toContain("09:30 to 09:35");
      await undo(true);
      expect(label()).toContain("09:45 to 09:50");
      await move();
      expect(label()).toContain("10:00 to 10:05");
      expect(patchWrites).toBe(1);
      const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry timing");
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(written).toEqual(first);
      for (let index = 0; index < 6; index++) {
        await settleSave();
        expect(label()).toContain("10:00 to 10:05");
        if (index < 5) expect(written.revision).toBe(todo.updatedAt);
      }
      expect(patchWrites).toBe(7); // Four moves, undo/redo, and one identical retry.
      expect(listReads).toBe(1);
    } else {
      expect(label()).toContain("09:00 to 09:05");
      expect(patchWrites).toBe(1); // Dependent moves never overwrite the conflict.
      expect(listReads).toBe(2);
      await move();
      expect(patchWrites).toBe(2);
      await settleSave();
      expect(label()).toContain("09:15 to 09:20");
    }
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
