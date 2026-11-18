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

test("day/week tasks retain readable timing beside distinct read-only Habit blocks", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=calendar&date=2026-10-26" });
  const todo: LiveTodo = {
    id: "shopping", databaseId: 1, repository: "example/tasks", number: 1,
    title: "Shopping", body: "", state: "open", closureReason: null,
    url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z",
    labels: [], fields: { Commitment: "Active" }, fieldValues: [], scheduleError: null,
    start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:05:00-03:00", fixed: false, allDay: false,
  };
  let calendarReads = 0;
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string | Request, init?: RequestInit) => {
      if (path instanceof Request) {
        expect(new URL(path.url).pathname).toBe("/api/v1/habits/calendar");
        calendarReads++;
        return Response.json({blocks: [{stackId: "routine", name: "Routine", date: "2026-10-26", anchor: "09:00", durationMinutes: 30, url: "/habits"}], stale: false, error: null});
      }
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json(path.endsWith("access-context") ? { permissions: ["todos:read", "habits:read"] } : { todos: [todo, { ...todo, id: "shopping-2", number: 2, start: "2026-10-26T09:05:00-03:00", end: "2026-10-26T09:10:00-03:00" }], readAt: "2026-10-26T12:00:00Z" });
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("./calendar-workspace");
    for (const view of ["calendar", "week"]) {
      window.history.replaceState(null, "", `/todo?view=${view}&date=2026-10-26`);
      await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
      const habit = host.querySelector<HTMLButtonElement>('button[aria-label="Routine · Habit routine · 09:00"]')!;
      expect(habit.getAttribute("draggable")).toBe("false");
      expect(habit.style.borderRadius).toBe("3px");
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Event Shopping,"]')];
      expect(buttons).toHaveLength(2);
      expect(buttons[0].getAttribute("aria-label")).toContain("09:00 to 09:05");
      expect(buttons[1].getAttribute("aria-label")).toContain("09:05 to 09:10");
      const events = buttons.map(button => button.closest<HTMLElement>("[data-short]")!);
      for (const event of events) {
        expect(parseFloat(event.style.height)).toBeCloseTo(22);
        expect(event.style.width).not.toBe("");
      }
    }
    expect(calendarReads).toBe(2);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
