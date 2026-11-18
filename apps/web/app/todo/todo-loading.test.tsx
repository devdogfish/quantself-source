import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

mock.module("./todo-workspace.module.css", () => ({ default: {} }));
mock.module("../calendar/calendar-top-bar", () => ({ CalendarTopBar: () => null }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {} }),
}));
afterAll(() => mock.restore());

test("calendar stays visible while tasks load and shows persistent failure with retry", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=calendar&date=2026-10-26" });
  let finish!: (response: Response) => void;
  let response = new Promise<Response>(resolve => { finish = resolve; });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
      return path.endsWith("access-context") ? Response.json({ permissions: ["todos:read", "todos:write"] }) : response;
    } : name === "ResizeObserver" ? class { observe() {} unobserve() {} disconnect() {} } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("../calendar/calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    jest.useFakeTimers();
    expect(host.querySelector('[aria-label="Scrollable 24-hour calendar"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading");
    const loadingBar = host.querySelector('[data-slot="todo-connection-status"][data-state="loading"]');
    expect(loadingBar?.textContent).toContain("Loading tasks…");
    expect(loadingBar?.querySelector('.chakra-spinner')).not.toBeNull();
    expect(host.querySelector("main")?.nextElementSibling).toBe(loadingBar?.parentElement);
    expect(host.textContent?.match(/Loading tasks…/g)).toHaveLength(1);
    await act(async () => finish(Response.json({ message: "GitHub unavailable" }, { status: 503 })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    expect(host.querySelector('[data-slot="todo-connection-status"] .chakra-spinner')).toBeNull();
    expect(host.querySelector('[aria-label="Scrollable 24-hour calendar"]')).not.toBeNull();
    const bar = host.querySelector('[data-slot="todo-connection-status"]')!;
    expect(bar.getAttribute("data-state")).toBe("offline");
    expect(host.querySelector("main")?.nextElementSibling).toBe(bar.parentElement);
    response = new Promise<Response>(resolve => { finish = resolve; });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!.click();
    });
    expect(host.querySelector('[data-slot="todo-connection-status"] button')?.textContent).toBe("Retrying…");
    expect(host.querySelector<HTMLButtonElement>('[data-slot="todo-connection-status"] button')?.disabled).toBe(true);
    await act(async () => finish(Response.json({ todos: [], readAt: "2026-10-26T12:00:00Z" })));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-slot="todo-connection-status"][data-state="online"]')?.textContent).toBe("Back online");
    expect(host.querySelector('[aria-label="Scrollable 24-hour calendar"]')).not.toBeNull();
    response = Promise.resolve(Response.json({ message: "GitHub unavailable" }, { status: 503 }));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.querySelector('[data-state="offline"]')?.textContent).toContain("Retry");
    response = Promise.resolve(Response.json({ todos: [], readAt: "2026-10-26T12:01:00Z" }));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.querySelector('[data-state="online"]')?.textContent).toBe("Back online");
    await act(async () => { jest.advanceTimersByTime(4100); });
    expect(host.querySelector('[data-slot="todo-connection-status"]')).toBeNull();
    expect(host.querySelector("main")?.nextElementSibling?.getAttribute("data-slot")).toBe("todo-connection-slot");
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 10000);
