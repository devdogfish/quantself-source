import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "./todo-live";

mock.module("./todo-workspace.module.css", () => ({ default: {} }));
mock.module("../calendar/calendar-top-bar", () => ({ CalendarTopBar: ({ onOpenTrash }: { onOpenTrash(): void }) => <button onClick={onOpenTrash}>Trash</button> }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

test("deadline flags stay separate from work; Trash and Restore remain optimistic with Undo during delayed saves", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=calendar&date=2026-10-26" });
  const todo: LiveTodo = { id: "task", databaseId: 1, repository: "example/tasks", number: 1, title: "Application", body: "Evidence", state: "open", closureReason: null, url: "https://github.com/example/tasks/issues/1", updatedAt: "revision-1", labels: [], fields: { Commitment: "Active", Due: "2026-10-26", URL: "https://example.com/meeting" }, fieldValues: [], scheduleError: null, start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:30:00-03:00", deadlineAt: "2026-10-26T17:00:00-03:00", fixed: false, allDay: false };
  let reads = 0;
  const writes: any[] = [];
  let finish!: (response: Response) => void;
  const names = ["Text", "DOMParser", "HTMLTextAreaElement", "KeyboardEvent", "window", "document", "DOMRect", "NodeFilter", "HTMLInputElement", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (path.includes("/notifications/")) return Response.json({ minutes: 10, morning: null });
      if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return new Promise<Response>(resolve => { finish = resolve; }); }
      if (path.endsWith("access-context")) return Response.json({ permissions: ["todos:read", "todos:write"] });
      if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
      if (/\/todos\/1$/.test(path)) return Response.json({ todo });
      reads++; return Response.json({ todos: [todo, { ...todo, id: "other-task", number: 2, title: "Other work", fields: { Commitment: "Active" }, deadlineAt: null, start: "2026-10-26T10:00:00-03:00", end: "2026-10-26T10:30:00-03:00" }], readAt: "now" });
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client"); const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("../calendar/calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const flag = host.querySelector<HTMLButtonElement>('[data-deadline="1"]')!;
    expect(flag.textContent).toContain("17:00"); expect(flag.getAttribute("draggable")).toBe("false");
    expect(host.querySelector('a[href="https://example.com/meeting"]')).not.toBeNull();
    const event = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Application,"]')!;
    expect(event.getAttribute("aria-label")).toContain("09:00 to 09:30");
    const otherEvent = host.querySelector<HTMLButtonElement>('button[aria-label^="Event Other work,"]')!;
    const expectTaskSelected = (selected: boolean) => {
      expect(flag.getAttribute("data-selected")).toBe(String(selected));
      expect(flag.getAttribute("aria-pressed")).toBe(String(selected));
      expect(event.getAttribute("aria-pressed")).toBe(String(selected));
    };
    await act(async () => flag.focus());
    expectTaskSelected(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => otherEvent.click());
    expectTaskSelected(false);
    expect(otherEvent.getAttribute("aria-pressed")).toBe("true");
    await act(async () => flag.click());
    expectTaskSelected(true);
    expect(otherEvent.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => otherEvent.click());
    await act(async () => event.click());
    expectTaskSelected(true);
    expect(otherEvent.getAttribute("aria-pressed")).toBe("false");
    // Detail opens only with the explicit double-click or keyboard action.
    for (const type of ["dblclick", "keydown"]) {
      await act(async () => flag.dispatchEvent(type === "dblclick"
        ? new MouseEvent("dblclick", { bubbles: true, cancelable: true })
        : new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expectTaskSelected(true);
      await act(async () => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }

    await act(async () => event.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    const trash = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes("Move to Trash"))!;
    await act(async () => trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[data-deadline="1"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Event Application,"]')).toBeNull();
    expect(writes).toHaveLength(1);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Trash")!.click());
    const restore = [...document.querySelectorAll("button")].find(button => button.textContent === "Restore")!;
    expect(restore).toBeDefined();
    await act(async () => restore.click());
    expect(host.querySelector('[data-deadline="1"]')).not.toBeNull();
    expect(writes).toHaveLength(1);
    await act(async () => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }) as unknown as Event));
    expect(host.querySelector('[data-deadline="1"]')).toBeNull();
    expect(writes).toHaveLength(1);
    await act(async () => finish(Response.json({ todo: { ...todo, trashed: true, updatedAt: "revision-2" }, outcomes: { trash: "saved" }, retryable: false, message: "Saved" })));
    expect(writes).toHaveLength(2); expect(writes[1].revision).toBe("revision-2");
    expect(host.querySelector('[data-deadline="1"]')).toBeNull();
    await act(async () => finish(Response.json({ todo: { ...todo, trashed: false, updatedAt: "revision-3" }, outcomes: { trash: "saved" }, retryable: false, message: "Saved" })));
    expect(host.querySelector('[data-deadline="1"]')).toBeNull();
    expect(writes).toHaveLength(3); expect(writes[2].trash.after).toBe(true); expect(writes[2].revision).toBe("revision-3");
    await act(async () => finish(Response.json({ todo: { ...todo, trashed: true, updatedAt: "revision-4" }, outcomes: { trash: "saved" }, retryable: false, message: "Saved" })));
    expect(reads).toBe(1);
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
