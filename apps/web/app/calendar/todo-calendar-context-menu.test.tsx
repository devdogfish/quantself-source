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

test.each(["calendar", "compact"])("%s background and task context menus use the appropriate actions", async (view) => {
  const dom = new Window({ url: `http://localhost/todo?view=${view === "compact" ? "calendar" : view}&date=2026-10-26` });
  const todo: LiveTodo = {
    id: "shopping", databaseId: 1, repository: "example/tasks", number: 1,
    title: "Shopping", body: "", state: "open", closureReason: null,
    url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z",
    labels: [], fields: { Commitment: "Active" }, fieldValues: [], scheduleError: null,
    start: "2026-10-26T09:00:00-03:00", end: "2026-10-26T09:05:00-03:00", fixed: false, allDay: false,
  };
  const names = ["window", "document", "DOMRect", "NodeFilter", "HTMLInputElement", "HTMLTextAreaElement", "Text", "DOMParser", "KeyboardEvent", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (path: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json(path.endsWith("access-context") ? { permissions: ["todos:read", "todos:write"] } : { todos: [todo, { ...todo, id: "shopping-2", number: 2, allDay: view === "compact", fields: { Commitment: "Active", Location: "Halifax & Dartmouth", URL: "https://example.org/one\nhttps://example.net/two" }, start: "2026-10-26T09:05:00-03:00", end: "2026-10-26T09:10:00-03:00" }], readAt: "2026-10-26T12:00:00Z" });
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
    // Link navigation must preserve selection throughout focus, pointer, and portal events.
    const selectedCard = host.querySelector<HTMLElement>('[data-task-number="1"]')!;
    const linkCard = host.querySelector<HTMLElement>('[data-task-number="2"]')!;
    await act(async () => { selectedCard.focus(); selectedCard.click(); });
    const selectionHistory: string[][] = [];
    const recordSelection = () => selectionHistory.push([...host.querySelectorAll('[data-calendar-event][data-selected="true"]')].map(card => card.getAttribute("data-task-number")!));
    const observer = new MutationObserver(recordSelection);
    observer.observe(host, { subtree: true, attributes: true, attributeFilter: ["data-selected"] });
    const assertSelection = () => {
      recordSelection();
      expect(selectionHistory.every(selected => selected.length === 1 && selected[0] === "1")).toBe(true);
    };
    const chooser = host.querySelector<HTMLButtonElement>('[aria-label="Open links for Shopping"]')!;
    expect(chooser).not.toBeNull();
    await act(async () => { chooser.focus(); }); assertSelection();
    await act(async () => {
      chooser.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      chooser.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    }); assertSelection();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const linkItems = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(linkItems).toHaveLength(2);
    await act(async () => {
      linkItems[1].focus(); assertSelection();
      linkItems[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }); assertSelection();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(!!document.querySelector('[role="menu"][data-state="open"]')).toBe(false);
    expect(document.activeElement === chooser).toBe(true);
    expect(linkCard.getAttribute("data-selected")).toBe("false");
    const map = host.querySelector<HTMLAnchorElement>('[aria-label="Open map for Shopping"]')!;
    expect(map.getAttribute("href")).toBe("https://maps.apple.com/search?query=Halifax%20%26%20Dartmouth");
    map.addEventListener("click", event => event.preventDefault(), { once: true });
    await act(async () => { map.focus(); map.click(); }); assertSelection();
    observer.disconnect();
    if (view === "compact") return;
    const area = host.querySelector<HTMLElement>("[data-calendar-time-area]")!;
    expect(area).not.toBeNull();
    const eventButtons = [...host.querySelectorAll<HTMLButtonElement>('[aria-label^="Event Shopping,"]')];
    expect(eventButtons).toHaveLength(2);
    await act(async () => { eventButtons[0].focus(); eventButtons[0].click(); });
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => area.click());
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(!!host.querySelector('[data-highlighted="true"]')).toBe(false);
    await act(async () => eventButtons[0].click());
    await act(async () => eventButtons[1].click());
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(eventButtons[1].getAttribute("aria-pressed")).toBe("true");
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => outside.click());
    expect(eventButtons[1].getAttribute("aria-pressed")).toBe("false");
    outside.remove();
    // Opening directly must establish selection, independent of a preceding click.
    await act(async () => eventButtons[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("true");
    expect(eventButtons[1].getAttribute("aria-pressed")).toBe("false");
    let selectedDialog = document.querySelector('[role="dialog"]')!;
    const addNotes = [...selectedDialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Add Notes, URL, or Attachments"))!;
    await act(async () => addNotes.click());
    for (const label of ["Title", "Notes"]) {
      const control = selectedDialog.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      expect(control).not.toBeNull();
      await act(async () => { control.focus(); control.click(); });
      expect(eventButtons[0].getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    }
    const category = selectedDialog.querySelector<HTMLElement>('[aria-label="Category"]')!;
    await act(async () => { category.focus(); category.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const categoryPortal = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Category"]')!;
    expect(categoryPortal).not.toBeNull();
    expect(selectedDialog.contains(categoryPortal)).toBe(false);
    expect(categoryPortal.getAttribute("data-state")).toBe("open");
    await act(async () => categoryPortal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(!!document.querySelector('[role="listbox"][data-state="open"]')).toBe(false);
    expect(selectedDialog.getAttribute("data-state")).toBe("open");
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    await act(async () => { eventButtons[1].focus(); eventButtons[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    selectedDialog = document.querySelector('[role="dialog"]')!;
    expect(selectedDialog).not.toBeNull();
    expect(eventButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(eventButtons[1].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    const clickedDate = host.querySelector("[data-calendar-day]")!.getAttribute("data-calendar-day");
    area.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 1728, width: 800, height: 1728, toJSON() {} });
    await act(async () => { area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 720 })); });
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("Add task");
    expect(menu.textContent).toContain("Paste task");
    const paste = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes("Paste task"))!;
    expect(paste.getAttribute("aria-disabled")).toBe("true");
    const add = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes("Add task"))!;
    await act(async () => { add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!.value).toBe("New task");
    expect(!!dialog.querySelector('[aria-label="Start time"]')).toBe(false);
    await act(async () => (dialog.querySelector('[aria-label="Edit date and task details"]') as HTMLButtonElement).click());
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Start time"]')!.value).toBe("10:00");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="End time"]')!.value).toBe("10:30");
    expect(dialog.querySelector('[aria-label="Start date"]')!.textContent).toContain("26");
    await act(async () => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    const shopping = host.querySelector('[aria-label^="Event Shopping,"]')!;
    await act(async () => shopping.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    expect(document.querySelector('[role="menu"]')!.textContent).toContain("Edit event");
    expect(document.querySelector('[role="menu"]')!.textContent).not.toContain("Add task");

  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
