import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

mock.module("../todo/todo-workspace.module.css", () => ({ default: {} }));
mock.module("./calendar-top-bar", () => ({ CalendarTopBar: () => null }));
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => { throw new Error("Calendar scrolling must not request a server navigation"); } }),
}));
afterAll(() => mock.restore());

test("calendar scrolling stays bounded across years and days without server navigation", async () => {
  const dom = new Window({ url: "http://localhost/todo?view=year&date=2026-01-01" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string) => Response.json(path.endsWith("access-context") ? { permissions: ["todos:read"] } : { todos: [], readAt: "2026-01-01T12:00:00Z" }) : name === "ResizeObserver" ? class {
      observe() {} unobserve() {} disconnect() {}
    } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  Object.defineProperties(dom.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 750 },
  });
  dom.HTMLElement.prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 1000, 750);
  const original = Intl.DateTimeFormat;
  let constructed = 0;
  let formatted = 0;
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args) {
      constructed++;
      const formatter = Reflect.construct(target, args);
      return new Proxy(formatter, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          return typeof value !== "function" ? value : (...args: unknown[]) => {
            if (key === "format") formatted++;
            return value.apply(target, args);
          };
        },
      });
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("./calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    expect(constructed).toBeLessThan(20);
    for (let year = 2027; year <= 2066; year++) {
      const before = formatted;
      await act(async () => {
        const viewport = host.querySelector<HTMLElement>('[aria-label="Year dates"]')!;
        viewport.scrollTop = 1500;
        viewport.dispatchEvent(new Event("scrollend"));
      });
      // Next's history integration acknowledges the URL change through search params.
      await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
      expect(window.location.search).toContain(`date=${year}-01-01`);
      expect(host.querySelectorAll("[data-active-year]")).toHaveLength(3);
      expect(host.querySelectorAll('[data-calendar-date-kind="year"]')).toHaveLength(1512);
      expect(formatted - before).toBeLessThan(600);
    }
    expect(constructed).toBeLessThan(20);

    window.history.replaceState(null, "", "/todo?view=week&date=2026-01-01");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const weekViewport = () => host.querySelector<HTMLElement>('[aria-label="Scrollable week calendar"]')!;
    expect(host.querySelectorAll("[data-calendar-day]")).toHaveLength(21);
    await act(async () => {
      weekViewport().scrollLeft = 8000;
      weekViewport().dispatchEvent(new Event("scrollend"));
    });
    // Weekly snaps land on a day boundary and remain aligned after recycling.
    expect(weekViewport().scrollLeft).toBe(7000);
    expect(window.location.search).toContain("date=2025-12-29");
    await act(async () => {
      weekViewport().scrollLeft = 6000;
      weekViewport().dispatchEvent(new Event("scrollend"));
    });
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    expect(weekViewport().scrollLeft).toBe(7000);
    expect(window.location.search).toContain("date=2025-12-28");
    expect(host.querySelectorAll("[data-calendar-day]")).toHaveLength(21);

    window.history.replaceState(null, "", "/todo?view=calendar&date=2026-01-01");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const dayViewport = () => host.querySelector<HTMLElement>('[aria-label="Scrollable 24-hour calendar"]')!;
    expect(host.querySelectorAll("[data-calendar-day]")).toHaveLength(3);
    expect(dayViewport().scrollLeft).toBe(1000);
    dayViewport().scrollTop = 480;
    for (let offset = 1; offset <= 40; offset++) {
      await act(async () => {
        dayViewport().scrollLeft = 2000;
        dayViewport().dispatchEvent(new Event("scrollend"));
      });
      await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
      const expected = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
      expect(window.location.search).toContain(`date=${expected}`);
      expect(window.location.search).toContain("view=calendar");
      expect(host.querySelectorAll("[data-calendar-day]")).toHaveLength(3);
      expect(dayViewport().scrollTop).toBe(480);
      expect(dayViewport().scrollLeft).toBe(1000);
    }
  } finally {
    await act(async () => root.unmount());
    Intl.DateTimeFormat = original;
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 20000);
