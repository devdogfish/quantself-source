import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test, setSystemTime } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "../todo/todo-live";

mock.module("../todo/todo-workspace.module.css", () => ({ default: {} }));
mock.module("./calendar-top-bar", () => ({ CalendarTopBar: ({ onOpenTrash }: { onOpenTrash(): void }) => <button onClick={onOpenTrash}>Trash</button> }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

test.each([{ view: "calendar", allDay: true }, { view: "month", allDay: true }, { view: "month", allDay: false }])("$view unfinished and completed cards retain direct links (all-day: $allDay)", async ({ view, allDay }) => {
  setSystemTime(new Date("2026-10-27T15:00:00Z"));
  const dom = new Window({ url: `http://localhost/todo?view=${view}&date=2026-10-26` });
  const base: LiveTodo = { id: "unfinished", databaseId: 1, repository: "example/tasks", number: 1, title: "Unfinished work", body: "Evidence", state: "open", closureReason: null, url: "https://github.com/example/tasks/issues/1", updatedAt: "revision-1", labels: [], fields: { Commitment: "Active", URL: "https://example.com/event" }, fieldValues: [], scheduleError: null, start: allDay ? "2026-10-26T00:00:00-03:00" : "2026-10-26T09:00:00-03:00", end: allDay ? "2026-10-27T00:00:00-03:00" : "2026-10-26T10:00:00-03:00", fixed: false, allDay };
  const completed = { ...base, id: "completed", number: 2, title: "Completed work", state: "closed" as const, closureReason: "completed" };
  let listReads = 0, writes = 0;
  const names = ["window", "document", "DOMRect", "NodeFilter", "HTMLInputElement", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes++;
      if (path.endsWith("access-context")) return Response.json({ permissions: ["todos:read", "todos:write"] });
      if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
      listReads++; return Response.json({ todos: [base, completed], readAt: "now" });
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  Object.defineProperty(dom.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 720 });
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client"); const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("./calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const unfinished = host.querySelector<HTMLButtonElement>('button[aria-label="Unfinished work, unfinished"]')!;
    const done = host.querySelector<HTMLButtonElement>('button[aria-label="Completed work"]')!;
    expect(unfinished).not.toBeNull(); expect(done).not.toBeNull();
    expect(unfinished.closest("[data-unfinished]")?.getAttribute("data-unfinished")).toBe("true");
    expect(done.closest("[data-unfinished]")?.getAttribute("data-unfinished")).toBe("false");
    const link = host.querySelector<HTMLAnchorElement>('a[aria-label="Open link for Unfinished work"]')!;
    expect(link.href).toBe("https://example.com/event"); expect(link.target).toBe("_blank"); expect(link.closest("button")).toBeNull();
    await act(async () => link.focus()); expect(document.activeElement).toBe(link);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listReads).toBe(1); expect(writes).toBe(0);
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    setSystemTime();
  }
});
