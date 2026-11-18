import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "./todo-live";

let path = "/todo", params = new URLSearchParams({ view: "list", date: "2026-10-26" });
let render = () => {};
const navigate = (url: string) => {
  const next = new URL(url, "http://localhost");
  path = next.pathname;
  params = next.searchParams;
  render();
};
mock.module("next/navigation", () => ({ usePathname: () => path, useSearchParams: () => params, useRouter: () => ({ push: navigate, replace: navigate }) }));
mock.module("next/dynamic", () => ({ default: () => () => null }));
mock.module("./todo-workspace.module.css", () => ({ default: {} }));
mock.module("./todo-date-field", () => ({ TodoDateField: ({ id, label, value, onChange, disabled }: any) => <input id={id} aria-label={`${label} date`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /> }));
let sdk: any;
const contextUpdates: string[] = [];
mock.module("@elevenlabs/client", () => ({ Conversation: { startSession: async (options: any) => {
  sdk = options;
  options.onConnect({ conversationId: "ui-test-conversation" });
  return { endSession: async () => {}, setMicMuted() {}, sendContextualUpdate: (text: string) => contextUpdates.push(text) };
} } }));
afterAll(() => mock.restore());

test("SDK tools control the real workspace, preserve drafts and send current UI context automatically", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  // Next's browser runtime synchronises native history with useSearchParams.
  const replaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = (data, unused, url) => { replaceState(data, unused, url); if (url) navigate(String(url)); };
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "localStorage", "sessionStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.filter(name => name !== "fetch")) {
    let value = name === "window" ? window : name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(window, name);
    if (["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name)) value = value.bind(window);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const task: LiveTodo = { id: "task1", number: 1, databaseId: 1, repository: "example/tasks", title: "Renew passport", body: "Bring photo", state: "open", closureReason: null, url: "https://github.com/example/tasks/issues/1", updatedAt: "2026-10-26T12:00:00Z", labels: [], fields: { Category: "Home" }, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null };
  const tasks = [task, { ...task, id: "task2", number: 2, title: "Renew license", fields: {} }];
  Object.assign(task, { start: "2026-10-26T00:00:00-03:00", end: "2026-10-27T00:00:00-03:00", allDay: true });
  const writes: string[] = [];
  let unavailable = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      if (url.endsWith("/access")) return Response.json({ signedUrl: "wss://example", captureId: "capture" });
      writes.push(url);
      return Response.json({});
    }
    if (url === "/api/v1/todo-categories") return Response.json({ categories: [{ id: 10, name: "Home", color: "green" }, { id: 20, name: "Work", color: "blue" }], revision: "categories-1" });
    if (url === "/api/v1/access-context") return Response.json({ permissions: ["todos:read", "todos:write"] });
    if (/\/todos\/\d+$/.test(url)) return Response.json({ todo: tasks.find(todo => url.endsWith(`/${todo.number}`)) });
    if (url === "/api/v1/todos" || url.startsWith("/api/v1/todos?")) return unavailable ? Response.json({}, { status: 503 }) : Response.json({ todos: tasks, readAt: task.updatedAt });
    if (url.endsWith("/commands")) return Response.json({ commands: [] });
    throw Error(`Unexpected read ${url}`);
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoJarvis, useJarvis } = await import("./todo-jarvis");
  const { TodoStoreProvider } = await import("./todo-live");
  const { TodoWorkspace } = await import("./todo-workspace");
  const { CalendarWorkspace } = await import("../calendar/calendar-workspace");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let begin!: () => Promise<void>;
  function Controls() { begin = useJarvis()!.begin; return null; }
  render = () => root.render(<ChakraTestWrapper><TodoStoreProvider><TodoJarvis><Controls />{path === "/todo" ? <TodoWorkspace /> : path === "/calendar" ? <CalendarWorkspace /> : <p>Other page</p>}</TodoJarvis></TodoStoreProvider></ChakraTestWrapper>);
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = async (name: string, input = {}) => {
    let result!: Promise<string> | string;
    await act(async () => { result = sdk.clientTools[name](input); await new Promise(resolve => setTimeout(resolve, 0)); });
    await flush();
    return await result;
  };
  const click = async (text: string) => act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === text || button.getAttribute("aria-label") === text);
    expect(button).toBeDefined();
    button!.click();
  });
  const latestContext = () => JSON.parse(contextUpdates.at(-1)!.split("): ")[1]);
  const edit = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => render());
    await flush();
    expect(container.querySelectorAll('[aria-label="Calendar view"]')).toHaveLength(0);
    expect(Array.from(container.querySelectorAll("a")).some(link => link.textContent === "Open Calendar")).toBe(false);
    await act(async () => begin());
    expect(Object.keys(sdk.clientTools).sort()).toEqual(["change_category", "close_panel", "navigate_calendar", "set_calendar_view", "set_category_filter", "show_task"]);
    expect(sdk.dynamicVariables.ui_context).toContain('"calendarView":"list"');
    expect(latestContext()).toMatchObject({ page: "/todo", calendarView: "list", date: "2026-10-26", selectedTask: null });
    expect(latestContext().categories).toEqual([{ id: 10, name: "Home", color: "green" }, { id: 20, name: "Work", color: "blue" }]);
    expect(await call("set_category_filter", { filter: "category", categoryId: 10 })).toBe("Showing Home.");
    expect(latestContext().categoryFilter).toEqual({ filter: "category", categoryId: 10 });
    expect(latestContext().visibleTasks.map((todo: any) => todo.number)).toEqual([1]);
    expect(await call("set_category_filter", { filter: "uncategorized" })).toBe("Showing uncategorized tasks.");
    expect(latestContext().visibleTasks.map((todo: any) => todo.number)).toEqual([2]);
    expect(await call("set_category_filter", { filter: "category", categoryId: 999 })).toContain("Category unavailable");
    expect(latestContext().categoryFilter).toEqual({ filter: "uncategorized" });
    expect(await call("set_category_filter", { filter: "all" })).toBe("Showing all categories.");
    expect(latestContext().visibleTasks).toHaveLength(2);
    for (const view of ["day", "week", "month", "year", "list"]) {
      expect(await call("set_calendar_view", { view })).toContain(`Showing ${view}`);
      expect(document.querySelector("[data-slot=todo-workspace]")?.getAttribute("data-view")).toBe(view === "day" ? "calendar" : view);
      expect(latestContext().calendarView).toBe(view);
      expect(path).toBe(view === "list" ? "/todo" : "/calendar");
    }
    await call("set_calendar_view", { view: "week" });
    const timeViewport = document.querySelector<HTMLElement>("[data-calendar-grid]")!;
    Object.defineProperty(timeViewport, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(timeViewport, "clientHeight", { configurable: true, value: 500 });
    await act(async () => {
      timeViewport.scrollTop = 913;
      timeViewport.dispatchEvent(new Event("scroll"));
    });
    await act(async () => document.querySelectorAll<HTMLButtonElement>("button[data-scroll-unit]")[9].click());
    expect(latestContext().calendarView).toBe("day");
    expect(timeViewport.scrollTop).toBeCloseTo(913 * 72 / 64);
    await act(async () => { timeViewport.scrollTop = 500; timeViewport.dispatchEvent(new Event("scroll")); });
    await call("set_calendar_view", { view: "week" });
    expect(document.querySelector<HTMLElement>("[data-calendar-grid]")!.scrollTop).toBe(913);
    await call("set_calendar_view", { view: "day" });
    expect(timeViewport.scrollTop).toBe(500);
    await call("set_calendar_view", { view: "week" });
    expect(timeViewport.scrollTop).toBe(913);
    await call("navigate_calendar", { target: "date", date: "2026-10-26" });
    let rapid!: Promise<string[]>;
    await act(async () => {
      rapid = Promise.all([
        sdk.clientTools.set_calendar_view({ view: "week" }),
        sdk.clientTools.navigate_calendar({ target: "next" }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await flush();
    expect((await rapid).every(result => result.startsWith("Showing week"))).toBe(true);
    expect(params.get("date")).toBe("2026-11-02");
    await call("navigate_calendar", { target: "previous" });
    expect(params.get("date")).toBe("2026-10-26");
    await call("navigate_calendar", { target: "date", date: "2028-01-31" });
    await call("set_calendar_view", { view: "month" });
    // Explicit day navigation must not inherit the month-sized toolbar step.
    await call("navigate_calendar", { target: "date", date: "2028-02-01" });
    expect(latestContext()).toMatchObject({ calendarView: "month", date: "2028-02-01" });
    await call("navigate_calendar", { target: "date", date: "2028-01-31" });
    await call("navigate_calendar", { target: "next" });
    expect(params.get("date")).toBe("2028-02-29");
    await call("set_calendar_view", { view: "year" });
    await call("navigate_calendar", { target: "next" });
    expect(params.get("date")).toBe("2029-02-28");
    await call("navigate_calendar", { target: "today" });
    expect(latestContext()).toMatchObject({ calendarView: "day", date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax" }).format(new Date()) });
    await act(async () => { Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Calendar view"] label')).find(label => label.textContent === "Month")!.click(); });
    expect(latestContext().calendarView).toBe("month");
    await call("navigate_calendar", { target: "date", date: "2026-10-26" });
    await act(async () => {
      const event = Array.from(document.querySelectorAll("button[data-calendar-event]")).find(button => button.textContent?.includes("Renew passport")) as HTMLButtonElement;
      expect(event).toBeDefined();
      event.click();
    });
    expect(latestContext()).toMatchObject({ selectedTask: { number: 1, title: "Renew passport" }, panel: null });
    expect(await call("show_task", { query: "renew" })).toContain("Multiple tasks match");
    expect(latestContext().panel).toBeNull();
    expect(await call("show_task", { query: "passport" })).toContain("Opened task #1");
    expect(latestContext()).toMatchObject({ selectedTask: { number: 1, title: "Renew passport" }, panel: "task" });
    expect(await call("close_panel")).toContain("Closed");
    expect(latestContext().panel).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    expect(await call("show_task", { number: 2 })).toContain("Opened task #2");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Edit date and task details"]')!.click());
    const titleInput = document.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!;
    await edit(titleInput, "Draft title");
    expect(await call("close_panel")).toContain("Unsaved changes");
    await edit(titleInput, "Renew license");
    const timingStart = document.querySelector<HTMLInputElement>('[aria-label="Start date"]')!;
    await edit(timingStart, "2026-11-02T09:00");
    expect(await call("close_panel")).toContain("Unsaved changes");
    await edit(timingStart, "");
    await edit(document.querySelector<HTMLInputElement>('[aria-label="End date"]')!, "");
    expect(await call("close_panel")).toContain("Closed");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    await click("Keyboard shortcuts");
    expect(await call("close_panel")).toContain("Closed");
    await click("Add task");
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!;
    await edit(input, "Unsaved draft");
    expect(await call("close_panel")).toContain("Unsaved changes");
    expect(await call("show_task", { number: 1 })).toContain("Unsaved changes");
    expect(await call("set_calendar_view", { view: "list" })).toContain("Unsaved changes");
    expect(await call("set_category_filter", { filter: "category", categoryId: 10 })).toBe("Showing Home.");
    expect(latestContext().categoryFilter).toEqual({ filter: "category", categoryId: 10 });
    expect(input.value).toBe("Unsaved draft");
    expect(latestContext().panel).toBe("new-task");
    expect(writes).toEqual([]);
    await act(async () => navigate("/"));
    expect(latestContext()).toMatchObject({ page: "/", calendarView: null, date: null, selectedTask: null, panel: null });
    expect(await call("set_calendar_view", { view: "week" })).toContain("Showing week");
    expect(path).toBe("/calendar");
    expect(latestContext().calendarView).toBe("week");
    unavailable = true;
    expect(await call("show_task", { query: "passport" })).toContain("lookup unavailable");
    expect(writes).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    // Tiptap destroys editors on a deferred tick after React unmounts.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}, 20000);
