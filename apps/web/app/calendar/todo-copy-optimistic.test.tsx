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

test("repeated copy/paste projects each task and leaves existing tasks draggable during creation", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=calendar&date=2026-10-26" });
  const todo: LiveTodo = {
    id: "shopping", databaseId: 1, repository: "example/tasks", number: 1,
    title: "Shopping", body: "", state: "open", closureReason: null,
    url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z",
    labels: [], fields: { Commitment: "Active" }, fieldValues: [], scheduleError: null,
    start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:05:00-03:00", fixed: false, allDay: false,
  };
  let listReads = 0;
  let patchWrites = 0;
  let creates = 0;
  let finishCreate!: (response: Response) => void;
  let createCommand: any;
  let written: any;
  let finishSave!: (response: Response) => void;
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        creates++; createCommand = JSON.parse(String(init.body));
        return new Promise<Response>(resolve => { finishCreate = resolve; });
      }
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
      await act(async () => pointer("pointerdown", 100));
      await act(async () => pointer("pointermove", 130));
      await act(async () => pointer("pointerup", 130));
    };
    const label = () => host.querySelector('button[aria-label^="Event Shopping,"]')!.getAttribute("aria-label");
    const key = async (key: string) => act(async () => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }) as unknown as Event));
    await act(async () => button.click());
    await key("c");
    await key("v");
    await key("v");
    expect(creates).toBe(1);
    expect(host.querySelectorAll('[aria-label^="Event Shopping,"]')).toHaveLength(3);
    await move();
    expect(patchWrites).toBe(1);
    await settleSave();
    const finish = async (number: number) => act(async () => finishCreate(Response.json({ todo: { ...todo, ...createCommand, id: `copy-${number}`, number }, outcomes: { issue: "saved", timing: "saved" }, retryable: false, message: "Created" })));
    await finish(3);
    expect(creates).toBe(2);
    await finish(4);
    expect(host.querySelectorAll('[aria-label^="Event Shopping,"]')).toHaveLength(3);
    expect(listReads).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
