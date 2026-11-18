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

test.each([false, true])("drag, modifiers and undo preserve optimistic timing (initially fixed: %s)", async (fixed) => {
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
    const confirmAppointment = async (action = "Move") => {
      if (!fixed) return;
      const dialog = document.querySelector('[role="alertdialog"]')!;
      expect(dialog).not.toBeNull();
      expect(dialog.textContent).toContain(`${action} appointment?`);
      expect(dialog.textContent).not.toContain("flexible");
      expect(document.activeElement?.textContent).toBe("Cancel");
      await act(async () => [...dialog.querySelectorAll("button")].find(b => b.textContent === `${action} appointment`)!.click());
    };
    if (fixed) {
      await act(async () => pointer("pointerdown", 100));
      await act(async () => pointer("pointermove", 130));
      expect(document.querySelector('[role="alertdialog"]') === null).toBe(true);
      await act(async () => pointer("pointerup", 130));
      expect(written).toBeUndefined();
      expect(button.getAttribute("aria-label")).toContain("09:00 to 09:05");
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Move appointment?");
      await act(async () => (document.activeElement as HTMLButtonElement).click());
      expect(written).toBeUndefined();
      expect(document.querySelector('[role="alertdialog"]') === null).toBe(true);
      await act(async () => document.body.click());
    }
    const neighborGeometry = () => {
      const card = host.querySelector('button[aria-label^="Event Run crawler,"]')!.closest<HTMLElement>("[data-short]")!;
      return { top: card.style.top, height: card.style.height };
    };
    const neighborBefore = neighborGeometry();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await act(async () => pointer("pointerdown", 100));
    await act(async () => pointer("pointermove", 133, { metaKey: true }));
    expect(button.getAttribute("aria-label")).toContain("09:20 to 09:25");
    await act(async () => pointer("pointermove", 133, { metaKey: true, shiftKey: true }));
    expect(button.getAttribute("aria-label")).toContain("09:22 to 09:27");
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keyup", { key: "Shift", metaKey: true, bubbles: true }) as unknown as Event));
    expect(button.getAttribute("aria-label")).toContain("09:20 to 09:25");
    await act(async () => pointer("pointermove", 130));
    expect(neighborGeometry()).toEqual(neighborBefore);
    expect(parseFloat(button.closest<HTMLElement>("[data-short]")!.style.height)).toBeCloseTo(22);
    const writesBeforeDrop = patchWrites;
    const droppedAt = performance.now();
    await act(async () => pointer("pointerup", 130));
    await confirmAppointment();
    const optimisticMs = performance.now() - droppedAt;
    expect(written).toBeDefined();
    expect(written.fixed).toBe(fixed);
    expect(patchWrites - writesBeforeDrop).toBe(1);
    expect(neighborGeometry()).toEqual(neighborBefore);
    const moved = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Event Shopping,"]')!;
    expect(moved().getAttribute("aria-label")).toContain("09:15 to 09:20");
    expect(listReads).toBe(1);
    const firstCommand = { ...written };
    for (const expected of ["09:30 to 09:35", "09:45 to 09:50"]) {
      button = moved();
      await act(async () => pointer("pointerdown", 100));
      await act(async () => pointer("pointermove", 130));
      await act(async () => pointer("pointerup", 130));
      await confirmAppointment();
      expect(moved().getAttribute("aria-label")).toContain(expected);
      expect(patchWrites - writesBeforeDrop).toBe(1);
    }
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:45 to 09:50");
    expect(written.revision).toBe(todo.updatedAt);
    expect(written.commandId).not.toBe(firstCommand.commandId);
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:45 to 09:50");
    expect(written.revision).toBe(todo.updatedAt);
    await settleSave();
    expect(patchWrites - writesBeforeDrop).toBe(3);
    expect(listReads).toBe(1);
    await undo();
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:30 to 09:35");
    await undo();
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:15 to 09:20");
    expect(listReads).toBe(1);
    const input = document.createElement("input");
    document.body.append(input);
    const beforeInputUndo = written;
    await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }) as unknown as Event));
    expect(written).toBe(beforeInputUndo);
    input.remove();
    await undo();
    expect(moved().getAttribute("aria-label")).toContain("09:00 to 09:05");
    await settleSave();
    await undo(true);
    expect(moved().getAttribute("aria-label")).toContain("09:15 to 09:20");
    await settleSave();
    await undo();
    await settleSave();
    const resize = async (edge: "start" | "end", delta: number) => {
      const handle = host.querySelector<HTMLButtonElement>(`button[aria-label="Resize ${edge} of Shopping"]`);
      expect(handle).not.toBeNull();
      handle!.setPointerCapture = () => {};
      handle!.hasPointerCapture = () => false;
      const send = (type: string, y: number) => handle!.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 2, clientX: 414, clientY: 100 + (y - 100) * .8 }) as unknown as Event);
      await act(async () => send("pointerdown", 100));
      await act(async () => send("pointermove", 100 + delta));
      await act(async () => send("pointerup", 100 + delta));
      await confirmAppointment("Resize");
      expect(written.fixed).toBe(fixed);
      await settleSave();
    };
    await resize("end", 37.5);
    expect(moved().getAttribute("aria-label")).toContain("09:00 to 09:30");
    await resize("start", -22.5);
    expect(moved().getAttribute("aria-label")).toContain("08:45 to 09:30");
    await undo();
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:00 to 09:30");
    await undo(true);
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("08:45 to 09:30");
    await undo();
    await settleSave();
    await undo();
    await settleSave();
    expect(moved().getAttribute("aria-label")).toContain("09:00 to 09:05");
    expect(written.fixed).toBe(fixed);
    if (fixed) expect(moved().getAttribute("aria-label")).toContain("fixed appointment");
    const lastWrite = written;
    await undo();
    expect(written).toBe(lastWrite);
    // Crossing changes the moving handle's visual side, never the saved field order.
    const cross = async (edge: "start" | "end", delta: number, preview: string, expectedStart: string, expectedEnd: string) => {
      const handle = host.querySelector<HTMLButtonElement>(`button[aria-label="Resize ${edge} of Shopping"]`)!;
      handle.setPointerCapture = () => {};
      const send = (type: string, offset: number) => handle.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 3, clientX: 414, clientY: 100 + offset * .8 }) as unknown as Event);
      await act(async () => send("pointerdown", 0));
      await act(async () => send("pointermove", delta));
      expect(moved().getAttribute("aria-label")).toContain(preview);
      expect(handle.dataset.edge).toBe(edge === "start" ? "end" : "start");
      // Move back across the anchor and cross again without losing pointer capture.
      await act(async () => send("pointermove", -Math.sign(delta) * 22.5));
      expect(handle.dataset.edge).toBe(edge);
      await act(async () => send("pointermove", delta));
      expect(moved().getAttribute("aria-label")).toContain(preview);
      await act(async () => send("pointerup", delta));
      await confirmAppointment("Resize");
      expect(Date.parse(written.start)).toBe(Date.parse(expectedStart));
      expect(Date.parse(written.end)).toBe(Date.parse(expectedEnd));
      expect(Date.parse(written.start)).toBeLessThan(Date.parse(written.end));
      expect(moved().getAttribute("aria-label")).toContain(preview);
      await settleSave();
    };
    await cross("start", 67.5, "09:05 to 09:45", "2026-10-26T12:05:00.000Z", "2026-10-26T12:45:00.000Z");
    await cross("end", -90, "08:45 to 09:05", "2026-10-26T11:45:00.000Z", "2026-10-26T12:05:00.000Z");
    await undo();
    expect(moved().getAttribute("aria-label")).toContain("09:05 to 09:45");
    await settleSave();
    await undo(true);
    expect(moved().getAttribute("aria-label")).toContain("08:45 to 09:05");
    await settleSave();
    // Horizontal resizing previews every crossed day before committing, and history
    // remains usable while the first resize response is deliberately held open.
    const crossDay = async (edge: "start" | "end", x: number, delta: number, expected: string) => {
      const handle = host.querySelector<HTMLButtonElement>(`button[aria-label="Resize ${edge} of Shopping"]`)!;
      handle.setPointerCapture = () => {};
      handle.hasPointerCapture = () => false;
      const send = (type: string, clientX: number, offset: number) => handle.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 4, clientX, clientY: 100 + offset * .8 }) as unknown as Event);
      await act(async () => send("pointerdown", 414, 0));
      await act(async () => send("pointermove", x, delta));
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(2);
      const beforeCancel = patchWrites;
      await act(async () => send("pointercancel", x, delta));
      expect(patchWrites).toBe(beforeCancel);
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(1);
      await act(async () => send("pointerdown", 414, 0));
      await act(async () => send("pointermove", x, delta));
      await act(async () => send("pointerup", x, delta));
      await confirmAppointment("Resize");
      expect(Date.parse(written[edge])).toBe(Date.parse(expected));
      expect(Date.parse(written.start)).toBeLessThan(Date.parse(written.end));
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(2);
      await undo();
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(1);
      await undo(true);
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(2);
      await settleSave();
      expect(host.querySelectorAll('button[aria-label^="Event Shopping,"]').length).toBe(2);
      await settleSave();
      await settleSave();
      await undo();
      await settleSave();
    };
    await crossDay("end", 1114, 22.5, "2026-10-27T09:15:00-03:00");
    await crossDay("start", -286, -22.5, "2026-10-25T08:30:00-03:00");
    console.info(`Manual drop: ${optimisticMs.toFixed(1)} ms to optimistic render; 3 rapid moves: 3 PATCHes, 0 post-save list reads.`);

  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
