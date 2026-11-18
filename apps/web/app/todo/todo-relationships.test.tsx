import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";

test("Owner sees a blocker and resolves its relationship through the API", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = [
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
    "MutationObserver",
    "DocumentFragment",
    "CustomEvent",
    "HTMLSelectElement",
    "HTMLInputElement",
    "KeyboardEvent",
    "Element",
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const previous = new Map(
    names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]),
  );
  for (const name of names.filter((n) => n !== "fetch"))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === "window"
          ? window
          : name === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : (window as any)[name],
    });
  const requests: any[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (path: string, init: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({
        todo: null,
        outcomes: { "blockedBy:2": "saved" },
        message: "Task saved.",
        retryable: false,
      });
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoRelationships } = await import("./todo-relationships");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    let todo = {
      id: "one",
      databaseId: 1,
      url: "https://github.com/tasks/personal/issues/1",
      title: "Task",
      body: null,
      state: "open",
      closureReason: null,
      updatedAt: "now",
      labels: [],
      fields: {},
      fieldValues: [],
      start: null, end: null, allDay: false, fixed: false,
      scheduleError: null,
      number: 1,
      repository: "tasks/personal",
      readiness: "blocked",
      blockedBy: [
        {
          id: "two",
          databaseId: 2,
          number: 2,
          title: "Prepare",
          repository: "tasks/personal",
          url: "https://github.com/tasks/personal/issues/2",
        },
      ],
      children: [],
    } as LiveTodo;
    const render = () =>
      root.render(
        <ChakraTestWrapper>
          <TodoRelationships
            todo={todo}
            disabled={false}
            onSaved={() => {
              todo = { ...todo, blockedBy: [], readiness: "ready" };
              render();
            }}
          />
        </ChakraTestWrapper>,
      );
    await act(async () => render());
    expect(container.textContent).toContain("Prepare");
    expect(container.textContent).toContain("Blocked");
    await act(async () => {
      (
        Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.startsWith("Remove prerequisite"),
        ) as HTMLButtonElement
      ).click();
    });
    expect(requests[0].path).toBe("/api/v1/todos/1");
    expect(requests[0].body.relationships).toEqual([
      { kind: "blockedBy", number: 2, before: true, after: false },
    ]);
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).not.toContain("Prepare");

    const relationship = container.querySelector<HTMLButtonElement>('[aria-label="Relationship"]')!;
    await act(async () => relationship.click());
    expect(relationship.getAttribute("aria-expanded")).toBe("true");
    const subIssue = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find(option => option.textContent === "Sub-issue")!;
    await act(async () => subIssue.click());
    expect(relationship.getAttribute("aria-expanded")).toBe("false");
    expect(relationship.textContent).toBe("Sub-issue");

    const taskNumber = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(taskNumber, "3");
      taskNumber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Add relationship")!;
    await act(async () => add.click());
    expect(requests[1].body.relationships).toEqual([
      { kind: "children", number: 3, before: false, after: true },
    ]);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [name, value] of previous) {
      if (value) Object.defineProperty(globalThis, name, value);
      else delete (globalThis as any)[name];
    }
  }
});
