import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
let query = "";
mock.module("../todo/todo-workspace.module.css", () => ({ default: {} }));
mock.module("./calendar-top-bar", () => ({ CalendarTopBar: ({ onToday }: { onToday(): void }) => <button onClick={onToday}>Today</button> }));
mock.module("next/navigation", () => ({ usePathname: () => "/todo", useSearchParams: () => new URLSearchParams(query), useRouter: () => ({ replace() {} }) }));
afterAll(() => mock.restore());
test.each(["calendar", "week"].flatMap(mode => [10, 900, 1435].map(minutes => [mode, minutes] as const)))("Today in %s at minute %s waits for navigation and scrolls to the current time", async (mode, minutes) => {
  const dom = new Window({ url: "http://localhost/todo" });
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-10-27T00:00:00-03:00") + minutes * 60000;
  query = `view=${mode}&date=2026-10-28`;
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
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    const { CalendarWorkspace: TodoWorkspace } = await import("./calendar-workspace");
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    const viewport = host.querySelector<HTMLElement>('[aria-label^="Scrollable"]')!;
    const area = host.querySelector<HTMLElement>("[data-calendar-time-area]")!;
    const header = mode === "week" ? 68 : 28;
    area.getBoundingClientRect = () => new dom.DOMRect(0, header - viewport.scrollTop, 1000, 1800);
    // Record real scroll commands while controlling the browser's geometry.
    const targets: ScrollToOptions[] = [];
    viewport.scrollTo = (options?: ScrollToOptions | number, _y?: number) => {
      if (!options || typeof options === "number") return;
      targets.push(options);
      if (options.top !== undefined) viewport.scrollTop = options.top;
    };
    viewport.scrollTop = 50;
    await act(async () => host.querySelector("button")!.click());
    expect(targets).toEqual([]); // Today's column can already exist in tomorrow's buffered range.
    query = `view=${mode}&date=2026-10-27`;
    await act(async () => { root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>); });
    await act(async () => { await new Promise(resolve => dom.requestAnimationFrame(resolve)); });
    const expected = Math.max(0, minutes * (mode === "week" ? 64 : 72) / 60 - (750 - header) * .35);
    expect(targets.at(-1)?.top).toBeCloseTo(expected);
    expect(targets.at(-1)?.behavior).toBe("instant");
    viewport.scrollTop = 0;
    await act(async () => host.querySelector("button")!.click());
    await act(async () => { await new Promise(resolve => dom.requestAnimationFrame(resolve)); });
    expect(targets).toHaveLength(2);
    expect(targets.at(-1)?.top).toBeCloseTo(expected);
    expect(targets.at(-1)?.behavior).toBe("instant");
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    Date.now = originalNow;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
