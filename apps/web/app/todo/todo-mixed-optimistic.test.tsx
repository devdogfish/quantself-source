import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "./todo-live";

mock.module("./todo-workspace.module.css", () => ({ default: {} }));
mock.module("../calendar/calendar-top-bar", () => ({ CalendarTopBar: () => null }));
mock.module("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

let detailBefore: LiveTodo;
mock.module("./todo-detail", () => ({ TodoDetail: ({ onQueue, onClose }: any) => <button onClick={() => { onQueue({ commandId: crypto.randomUUID(), revision: detailBefore.updatedAt, title: { before: "Shopping", after: "Edited" }, start: "2026-10-26T09:30:00-03:00", end: "2026-10-26T09:35:00-03:00", fixed: false, allDay: false }, detailBefore); onClose(); }}>Queue detail edit</button> }));
test("interleaved Calendar and To-Do edits preserve the queue and latest preview across routes", async () => {
  const dom = new Window({ url: "http://localhost/calendar?view=calendar&date=2026-10-26" });
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
    detailBefore = todo;
    const { CalendarWorkspace } = await import("../calendar/calendar-workspace");
    const { TodoWorkspace } = await import("./todo-workspace");
    const { TodoStoreProvider } = await import("./todo-live");
    const { TaskWorkspaceProvider } = await import("./task-workspace-queue");
    const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
    const render = () => root.render(
      <ChakraTestWrapper><TodoStoreProvider><TaskWorkspaceProvider>
        {window.location.pathname === "/calendar" ? <CalendarWorkspace /> : <TodoWorkspace />}
      </TaskWorkspaceProvider></TodoStoreProvider></ChakraTestWrapper>,
    );
    await act(async () => render());
    let button: HTMLButtonElement;
    const pointer = (type: string, y: number, modifiers = {}) => button.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 414, clientY: 100 + (y - 100) * .8, ...modifiers }) as unknown as Event);
    const settleSave = async () => {
      Object.assign(todo, { ...(written.title ? { title: written.title.after } : {}), start: written.start, end: written.end, fixed: written.fixed, updatedAt: crypto.randomUUID() });
      await act(async () => finishSave(Response.json({ todo: { ...todo }, outcomes: { timing: "saved", ...(written.title ? { title: "saved" } : {}) }, retryable: false, message: "Saved" })));
    };
    const move = async () => {
      button = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Shopping,"],button[aria-label^="Event Edited,"]')!;
      const area = host.querySelector<HTMLElement>("[data-calendar-time-area]")!;
      area.getBoundingClientRect = () => ({ left: -700, top: 0, right: 1464, bottom: 2160, width: 2164, height: 2160 }) as DOMRect;
      const viewport = host.querySelector<HTMLElement>("[data-scope='scroll-area'][data-part='viewport']")!;
      viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 764, bottom: 800, width: 764, height: 800 }) as DOMRect;
      let capture = false;
      button.setPointerCapture = () => { capture = true; };
      button.hasPointerCapture = () => capture;
      button.releasePointerCapture = () => { capture = false; };
      await act(async () => pointer("pointerdown", 100));
      await act(async () => pointer("pointermove", 130));
      await act(async () => pointer("pointerup", 130));
    };
    const label = () => host.querySelector('button[aria-label^="Event Shopping,"],button[aria-label^="Event Edited,"]')!.getAttribute("aria-label");
    await move();
    await act(async () => {
      window.history.replaceState(null, "", "/todo?task=1&date=2026-10-26");
      render();
    });
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true);
    expect(host.querySelector('[aria-label="Open Shopping"]')).not.toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Queue detail edit")!.click());
    await act(async () => {
      window.history.replaceState(null, "", "/calendar?view=calendar&date=2026-10-26");
      render();
    });
    await move();
    expect(label()).toContain("09:45 to 09:50");
    expect(patchWrites).toBe(1);
    await settleSave();
    expect(written.title.after).toBe("Edited");
    expect(written.start).toContain("09:30");
    expect(written.revision).toBe(todo.updatedAt);
    expect(label()).toContain("09:45 to 09:50");
    await settleSave();
    expect(written.title).toBeUndefined();
    expect(written.revision).toBe(todo.updatedAt);
    expect(label()).toContain("09:45 to 09:50");
    await settleSave();
    expect(todo.title).toBe("Edited");
    expect(patchWrites).toBe(3);
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
