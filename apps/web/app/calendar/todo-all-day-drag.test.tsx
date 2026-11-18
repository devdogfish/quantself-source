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

test("drag into all-day previews immediately, never scrolls upward, and supports pending Undo", async () => {
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
    area.getBoundingClientRect = () => ({ left: -700, top: 28, right: 1464, bottom: 2160, width: 2164, height: 2160 }) as DOMRect;
    let button = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Shopping,"],button[aria-label^="Event Edited,"]')!;
    const viewport = host.querySelector<HTMLElement>("[data-scope='scroll-area'][data-part='viewport']")!;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 764, bottom: 800, width: 764, height: 800 }) as DOMRect;
    let capture = false;
    button.setPointerCapture = () => { capture = true; };
    button.hasPointerCapture = () => capture;
    button.releasePointerCapture = () => { capture = false; };
    const pointer = (type: string, y: number, modifiers = {}) => button.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 414, clientY: y, ...modifiers }) as unknown as Event);
    const scrolls: number[] = [];
    viewport.scrollBy = (x?: number | ScrollToOptions, y?: number) => { scrolls.push(typeof x === "object" ? x.top ?? 0 : y ?? 0); };
    await act(async () => pointer("pointerdown", 150));
    await act(async () => pointer("pointermove", 15));
    expect(host.querySelector('[aria-label="Move to all-day"]')?.textContent).toBe("Shopping");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    expect(scrolls.some(y => y < 0)).toBe(false);
    await act(async () => pointer("pointermove", 780));
    expect(host.querySelector('[aria-label="Move to all-day"]')).toBeNull();
    expect(scrolls.some(y => y > 0)).toBe(false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(scrolls.some(y => y > 0)).toBe(true);
    await act(async () => pointer("pointermove", 15));
    await act(async () => pointer("pointerup", 15));
    expect(written.allDay).toBe(true);
    expect(written.start).toBe("2026-10-26T03:00:00.000Z");
    expect(written.end).toBe("2026-10-27T03:00:00.000Z");
    expect(host.querySelector('button[aria-label^="Event Shopping,"]')).toBeNull();
    await act(async () => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }) as unknown as Event));
    expect(host.querySelector('button[aria-label^="Event Shopping,"]')).not.toBeNull();
    expect(patchWrites).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
