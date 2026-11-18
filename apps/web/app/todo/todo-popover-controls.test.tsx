import { expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";

test("popover controls autosave through the queue, retain newer drafts, and expose Chakra calendars", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "fetch" ? () => { throw Error("Use the shared queue"); } : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoFactsEditor } = await import("./todo-facts-editor");
  const { previewTodoEdit } = await import("./todo-live");
  let todo = { id: "task", databaseId: 1, repository: "example/tasks", url: "https://example.com/1", closureReason: null, fieldValues: [], number: 1, title: "Work", updatedAt: "r1", state: "open", start: "2026-10-27T09:30:00-03:00", end: "2026-10-27T10:30:00-03:00", allDay: false, fixed: false, scheduleError: null, fields: {}, body: "", labels: [] } as LiveTodo;
  const commands: any[] = [];
  const queue = (command: any) => { commands.push(command); };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = () => act(async () => root.render(<ChakraTestWrapper><TodoFactsEditor popover todo={todo} disabled={false} onSaved={() => {}} onQueue={queue} /></ChakraTestWrapper>));
  const change = (input: HTMLInputElement, value: string) => act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await render();
    jest.useFakeTimers();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Save task")).toBe(false);
    expect(host.querySelector('input[type="datetime-local"]')).toBeNull();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"][id$="-fixed"]')!;
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox.focus(); checkbox.click(); });
    await act(async () => checkbox.blur());
    expect(commands[0].fixed).toBe(true);
    const client = host.querySelector<HTMLInputElement>('input[id$="-Client"]')!;
    await change(client, "First client"); await act(async () => client.blur());
    expect(commands.at(-1).fields.Client).toEqual({ before: null, after: "First client" });
    await change(client, "Second client");
    // First response arrives while the next edit is still debouncing.
    todo = previewTodoEdit(todo, commands.at(-1)); await render();
    expect(client.value).toBe("Second client");
    await act(async () => { jest.advanceTimersByTime(3100); });
    expect(commands.at(-1).fields.Client).toEqual({ before: "First client", after: "Second client" });
    expect(client.disabled).toBe(false);
    const due = host.querySelector<HTMLButtonElement>('[aria-label="Due date"]')!;
    await act(async () => due.click());
    const calendar = document.querySelector('[aria-label="Due calendar"]')!;
    expect(calendar).not.toBeNull();
    const day = calendar.querySelector<HTMLElement>('[data-part="table-cell-trigger"][data-selectable]:not([data-outside-range])')!;
    await act(async () => day.click());
    await act(async () => { due.focus(); due.blur(); });
    expect(commands.at(-1).fields.Due).toMatchObject({ before: null, after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}, 10000);
