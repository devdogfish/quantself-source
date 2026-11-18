import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";



test("rendered save exposes uncertainty; Retry reuses command and shows saved outcomes", async () => {
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
    "Element",
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names.filter((name) => name !== "fetch"))
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
  (globalThis as any).fetch = async (_path: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body));
    requests.push(command);
    if (requests.length === 1) throw Error("Response lost. Retry save.");
    return Response.json({
      commandId: command.commandId,
      todo: null,
      outcomes: { issue: "saved", title: "saved" },
      message: "Task saved.",
      retryable: false,
    });
  };
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoFactsEditor } = await import("./todo-facts-editor");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const todo = {
      number: 1,
      title: "Old title",
      body: "Keep context",
      fields: {},
      start: null,
      end: null,
      allDay: false,
      fixed: false,
    } as LiveTodo;
    await act(async () =>
      root.render(
        <ChakraTestWrapper><TodoFactsEditor todo={todo} disabled={false} onSaved={() => {}} /></ChakraTestWrapper>,
      ),
    );
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "New title");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A conversational refresh must retain the draft and its original before values.
    await act(async () =>
      root.render(
        <ChakraTestWrapper><TodoFactsEditor
          todo={{ ...todo, title: "Voice title", fields: { Category: "Home" } }}
          disabled={false}
          onSaved={() => {}}
        /></ChakraTestWrapper>,
      ),
    );
    expect(container.querySelector("input")!.value).toBe("New title");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(container.textContent).toContain("Response lost");
    expect(container.textContent).toContain("Retry save");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry save")!
        .click(),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].title).toEqual({
      before: "Old title",
      after: "New title",
    });
    expect(requests[0].fields).toBeUndefined();
    expect(container.textContent).toContain("Task saved.");
    expect(container.textContent).toContain("title: saved");
    expect(container.textContent).toContain("Undo saved changes");
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});

test("rendered whole-task complete and reopen undo use narrow server-confirmed transitions", async () => {
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
    "Element",
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names)
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
  let fail = true;
  (globalThis as any).fetch = async (_path: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body));
    requests.push(command);
    if (fail)
      return Response.json(
        { message: "GitHub rejected closure" },
        { status: 503 },
      );
    return Response.json({
      commandId: command.commandId,
      todo: null,
      outcomes: { closure: "saved" },
      message: "Task saved.",
      retryable: false,
    });
  };
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoFactsEditor } = await import("./todo-facts-editor");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === label)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        <ChakraTestWrapper><TodoFactsEditor
          todo={
            {
              number: 1,
              title: "Task",
              state: "open",
              body: "Preserved",
              fields: { Commitment: "Someday" },
            } as LiveTodo
          }
          disabled={false}
          onSaved={() => {}}
        /></ChakraTestWrapper>,
      ),
    );
    await click("Mark as done");
    expect(container.textContent).toContain("GitHub rejected closure");
    expect(container.textContent).not.toContain("Undo saved changes");
    fail = false;
    await click("Retry save");
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].closure).toEqual({
      before: { outcome: "open" },
      after: { outcome: "completed" },
    });
    expect(container.textContent).toContain("closure: saved");
    await click("Undo saved changes");
    expect(requests[2].closure).toEqual({
      before: { outcome: "completed" },
      after: { outcome: "open" },
    });
    expect(requests[2].commandId).not.toBe(requests[0].commandId);
    expect(Object.keys(requests[2]).sort()).toEqual(["closure", "commandId"]);
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
