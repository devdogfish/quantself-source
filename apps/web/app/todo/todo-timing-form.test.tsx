import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";

test("task timing editor retries identical command and undoes only time", async () => {
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
  const initial = { start: todo.start, end: todo.end };
  const commands: any[] = [];
  let fail = true;
  globalThis.fetch = (async (_path: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)); commands.push(command);
    if (fail) { fail = false; throw Error("Network unavailable"); }
    todo = { ...todo, start: command.start, end: command.end, fixed: command.fixed, allDay: command.allDay, updatedAt: `r${commands.length + 1}` };
    return Response.json({ commandId: command.commandId, todo, outcomes: { timing: "saved" }, retryable: false, message: "Saved" });
  }) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoFactsEditor } = await import("./todo-facts-editor");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = () => root.render(<ChakraTestWrapper><TodoFactsEditor todo={todo} disabled={false} onSaved={render} /></ChakraTestWrapper>);
  const click = (label: string) => act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent === label)!.click(); });
  try {
    await act(async () => render());
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    expect(inputs).toHaveLength(2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[1], "2026-10-27T11:30");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save task");
    expect(container.textContent).toContain("Network unavailable");
    await click("Retry save");
    expect(commands[0]).toEqual(commands[1]);
    expect(commands[0]).toMatchObject({ revision: "r1", start: initial.start, end: "2026-10-27T14:30:00.000Z" });
    expect(commands[0]).not.toHaveProperty("sessions");
    todo.title = "External title";
    await click("Undo saved changes");
    expect(todo).toMatchObject({ ...initial, title: "External title" });
    expect(commands.at(-1).revision).toBe("r3");
  } finally {
    await act(async () => root.unmount()); container.remove(); await window.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
