import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { LiveTodo } from "./todo-live";

const notifications = mock(() => {});
mock.module("@/components/chakra/toaster", () => ({
  Toaster: () => null,
  toaster: { create: notifications },
}));
mock.module("./todo-workspace.module.css", () => ({ default: {} }));
let workspaceView = "list";
mock.module("next/navigation", () => ({
  usePathname: () => "/todo",
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams({ view: workspaceView }),
}));
mock.module("../calendar/calendar-top-bar", () => ({
  CalendarTopBar: ({
    readOnly,
    onAddTask,
  }: {
    readOnly: boolean;
    onAddTask: () => void;
  }) => (
    <button disabled={readOnly} onClick={onAddTask}>
      Add task
    </button>
  ),
}));
afterAll(() => mock.restore());

test("renders live tasks, loads details on demand, retains stale records, and shows empty/denied states", async () => {
  const window = new Window({ url: "http://localhost/todo?view=list" });
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLButtonElement",
    "Node", "DocumentFragment", "CustomEvent", "ResizeObserver",
    "Element",
    "Event",
    "MouseEvent", "KeyboardEvent",
    "MutationObserver",
    "ResizeObserver",
    "DocumentFragment",
    "CustomEvent",
    "HTMLSelectElement",
    "HTMLInputElement",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names.filter((name) => name !== "fetch")) {
    const value =
      name === "IS_REACT_ACT_ENVIRONMENT"
        ? true
        : name === "window"
          ? window
          : (window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        typeof value === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ].includes(name)
          ? value.bind(window)
          : value,
    });
  }
  const task: LiveTodo = {
    id: "I_real",
    databaseId: 1,
    repository: "example/tasks",
    number: 1,
    title: "Live GitHub task",
    body: "Original task description",
    state: "open",
    closureReason: null,
    url: "https://github.com/example/tasks/issues/1",
    updatedAt: "2026-10-26T12:00:00Z",
    labels: ["ready-for-human"],
    fields: { Commitment: "Active" },
    fieldValues: [],
    start: null, end: null, allDay: false, fixed: false,
    scheduleError: null,
  };
  let mode = "live",
    details = 0,
    reads = 0;
  let resolveDetail!: (response: Response) => void;
  const detailResponse = new Promise<Response>((resolve) => { resolveDetail = resolve; });
  let rejectCreate!: (error: Error) => void;
  const createResponse = new Promise<Response>((_resolve, reject) => {
    rejectCreate = reject;
  });
  globalRecord.fetch = async (path: string, init?: RequestInit) => {
      if (path.includes("/notifications/")) return Response.json({ minutes: 10, morning: null });
    if (path === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "categories-1" });
    if (path.endsWith("/access-context"))
      return Response.json({ permissions: ["todos:read", "todos:write"] });
    if (init?.method === "POST" && path === "/api/v1/todos")
      return createResponse;
    if (path.endsWith("/1")) {
      details++;
      return detailResponse;
    }
    reads++;
    if (mode === "outage")
      return Response.json({ message: "GitHub unavailable." }, { status: 503 });
    if (mode === "denied") return Response.json({}, { status: 403 });
    return Response.json({
      todos: mode === "empty" ? [] : [task],
      readAt: "2026-10-26T12:00:00Z",
    });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const root = createRoot(container);
  try {
    window.localStorage.setItem("quantself.todo.layout", "classic");
    const { CalendarWorkspace: TodoWorkspace } = await import("../calendar/calendar-workspace");
    await act(async () => {
      root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>);
    });
    expect(container.querySelector('[data-slot="todo-workspace"]')?.getAttribute("data-layout")).toBe("list");
    expect([...container.querySelectorAll('[role="radio"]')].map(item => item.textContent)).toEqual(["List", "Today", "Plan", "Board", "Triage"]);
    expect(container.querySelector('[aria-label="Task list"]')).toBeNull();
    expect(container.textContent).toContain("Live GitHub task");
    expect(container.textContent).not.toContain("Finish the client proposal");
    expect(container.textContent).not.toContain("Estimate unknown");
    expect(details).toBe(0);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Mark Live GitHub task as top priority"]',
      )?.disabled,
    ).toBe(false);
    const title = container.querySelector<HTMLElement>('[aria-label="Open Live GitHub task"]')!;
    await act(async () => {
      title.click();
    });
    expect(details).toBe(1);
    expect(document.body.textContent).toContain("Loading details");
    expect(container.textContent).toContain(task.title);
    await act(async () => resolveDetail(Response.json({ todo: task })));
    expect(container.querySelector('[aria-label="Loading task"]')).toBeNull();
    expect(document.body.textContent).toContain("Original task description");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Edit date and task details"]')!.click());
    expect(document.body.textContent).toContain("Original task description");
    const refresh = () => document.dispatchEvent(new Event("visibilitychange"));
    mode = "outage";
    await act(async () => {
      refresh();
    });
    expect(container.querySelector('[data-slot="todo-connection-status"]')?.textContent).toContain("Offline");
    expect(container.textContent).toContain(task.title);
    mode = "empty";
    await act(async () => {
      refresh();
    });
    expect(container.textContent).toContain(
      "Nothing here.",
    );
    workspaceView = "calendar";
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    expect(
      container.querySelector('[aria-label="Unscheduled tasks"]'),
    ).toBeNull();
    task.fields.Commitment = "Inbox";
    mode = "live";
    await act(async () => refresh());
    const unscheduled = container.querySelector(
      '[aria-label="Unscheduled tasks"]',
    );
    expect(unscheduled).toBeNull();
    expect(container.querySelector('[aria-label="Timing to review"]')).toBeNull();

    expect(
      container.querySelector('[aria-label="To-Do calendar"]')?.textContent,
    ).not.toContain(task.title);
    workspaceView = "list";
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add task"]')!.click());
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
      (element) => element.querySelector("h2")?.textContent === "New task",
    )!;
    const titleInput = dialog.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(titleInput, "Optimistic form task");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Inbox"))!.click());
    expect(
      [...container.querySelectorAll('[role="button"]')].some(
        (button) => button.getAttribute("aria-label") === "Open Optimistic form task",
      ),
    ).toBe(true);
    workspaceView = "calendar";
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    expect(
      container.querySelector('[aria-label="Unscheduled tasks"]')?.textContent,
    ).toBeUndefined();
    workspaceView = "list";
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Inbox"))!.click());
    expect(container.textContent).toContain("Optimistic form task");
    await act(async () => rejectCreate(new Error("Task creation rejected")));
    expect(container.querySelector('[aria-label="Open Optimistic form task"]')).toBeNull();
    expect(titleInput.value).toBe("Optimistic form task");
    expect(dialog.textContent).toContain("Retry save");
    expect(container.querySelector('[data-slot="todo-mutation-status"]')?.textContent).toContain("Task creation rejected");
    expect(notifications).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    workspaceView = "list";
    await act(async () => root.render(<ChakraTestWrapper><TodoWorkspace /></ChakraTestWrapper>));
    mode = "denied";
    await act(async () => {
      refresh();
    });
    expect(container.querySelector('[data-slot="todo-connection-status"]')?.textContent).toContain("access denied");
    expect(container.textContent).not.toContain(task.title);
    const before = reads;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reads).toBe(before);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reads).toBe(before + 1);
  } finally {
    workspaceView = "list";
    await act(async () => {
      root.unmount();
    });
    container.remove();
    await window.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalRecord[name];
    }
  }
});
