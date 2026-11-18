import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";


test("task detail saves keep the form editable and chain draft baselines without awaiting delivery", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = [
    "KeyboardEvent",
    "HTMLInputElement",
    "HTMLButtonElement",
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
  let todo = { id: "task", databaseId: 1, repository: "example/tasks", url: "https://example.com/1", closureReason: null, fieldValues: [], number: 1, title: "Work", updatedAt: "r1", state: "open", start: "2026-10-27T09:30:00-03:00", end: "2026-10-27T10:30:00-03:00", allDay: false, fixed: false, scheduleError: null, fields: {}, body: "", labels: [] } as LiveTodo;
  const commands: any[] = [];
  globalThis.fetch = (async () => { throw Error("The editor must hand off to the shared queue"); }) as unknown as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoFactsEditor } = await import("./todo-facts-editor");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChakraTestWrapper><TodoFactsEditor todo={todo} disabled={false} onSaved={() => {}} onQueue={command => commands.push(command)} /></ChakraTestWrapper>));
    const change = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const title = container.querySelector<HTMLInputElement>('input:not([type="datetime-local"])')!;
    const save = () => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save task")!.click());
    await change(container.querySelector<HTMLInputElement>('input[id$="-prep-before"]')!, "10");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ beforeMinutes: 10, start: todo.start, end: todo.end });
    // The save remains deferred; a second field immediately queues independently.
    await change(container.querySelector<HTMLInputElement>('input[id$="-prep-after"]')!, "5");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({ beforeMinutes: 10, afterMinutes: 5, start: todo.start, end: todo.end });
    commands.length = 0;
    await change(title, "First draft");
    await change(container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')[1], "2026-10-27T11:30");
    await save();
    expect(commands[0].beforeMinutes).toBe(10);
    expect(commands[0].start).toBe(todo.start);
    expect(commands[0].title).toEqual({ before: "Work", after: "First draft" });
    expect(commands[0].end).toBe("2026-10-27T14:30:00.000Z");
    expect([...container.querySelectorAll("fieldset")].some(fieldset => fieldset.disabled)).toBe(false);
    await change(title, "Second draft");
    await save();
    expect(commands).toHaveLength(2);
    expect(commands[1].title).toEqual({ before: "First draft", after: "Second draft" });
    expect(commands[1].start).toBeUndefined();
    expect(title.value).toBe("Second draft");
  } finally {
    await act(async () => root.unmount()); container.remove(); await window.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
