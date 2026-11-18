import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import type { LiveTodo } from "./todo-live";

mock.module("./task-popover", () => ({ TaskPopover: ({ children, onClose }: any) => <div role="dialog">{typeof children === "function" ? children(onClose) : children}</div> }));
afterAll(() => mock.restore());

test("the Owner can Undo Tyler’s capture with immediate feedback and the same audit on retry", async () => {
  const dom = new Window({ url: "http://localhost/todo?task=43" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Text", "DOMParser", "NodeFilter", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch", "EventSource"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const auditId = "5d72f10e-99cc-4d46-8bf8-d09f420ba453";
  const task = { id: "capture-task", number: 43, databaseId: 43, title: "Book vaccine appointment", repository: "example/tasks", url: "https://example.com/43", updatedAt: "r1", state: "open", closureReason: null, body: "", description: "", fields: {}, fieldValues: [], labels: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null, personalCaptureUndoId: auditId } as LiveTodo;
  let resolveUndo!: (response: Response) => void;
  const writePaths: string[] = [];
  const respond = async (url: string, options?: RequestInit) => {
    if (options?.method === "POST" && url.includes("/agent-audit/")) {
      writePaths.push(url);
      return new Promise<Response>(resolve => { resolveUndo = resolve; });
    }
    if (url.startsWith("/api/v1/todos?")) return Response.json({ todos: [task], readAt: "r1" });
    if (url.startsWith("/api/v1/todos/43")) return Response.json({ todo: task });
    if (url.includes("/notifications/")) return Response.json({ minutes: 10, morning: null });
    return Response.json({ features: [] });
  };
  for (const key of keys) {
    const value = key === "window" ? dom : key === "fetch" ? respond : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "EventSource" ? undefined : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoDetail } = await import("./todo-detail");
  const { TodoStoreProvider, useTodoStore } = await import("./todo-live");
  let store!: ReturnType<typeof useTodoStore>;
  function Harness() {
    store = useTodoStore();
    return <TodoDetail number={43} preview={task} revision="r1" canWrite stale={false} onClose={() => {}} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(value => value.textContent === label)!;
  try {
    await act(async () => root.render(<ChakraTestWrapper><TodoStoreProvider><Harness /></TodoStoreProvider></ChakraTestWrapper>));
    await act(async () => store.refresh());
    await act(async () => button("Undo Tyler’s capture").click());
    expect(button("Undoing Tyler’s capture…").disabled).toBe(true);
    expect(store.getSnapshot().todos).toHaveLength(0);
    expect(store.getSnapshot().trashTodos?.[0]?.number).toBe(43);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit date and task details"]')?.disabled).toBe(false);
    await act(async () => resolveUndo(Response.json({ message: "Undo unconfirmed. Retry this same audit entry." }, { status: 503 })));
    expect(store.getSnapshot().todos[0]?.number).toBe(43);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Undo unconfirmed");
    await act(async () => button("Retry undo").click());
    expect(writePaths).toEqual(Array(2).fill(`/api/v1/agent-audit/${auditId}/undo`));
    await act(async () => resolveUndo(Response.json({
      audit: { id: auditId, undoneAt: "2026-11-17T12:00:00Z" },
      todo: { ...task, updatedAt: "r2", trashed: true }, cacheGeneration: 2,
    })));
    expect(store.getSnapshot().trashTodos?.[0]).toMatchObject({ number: 43, updatedAt: "r2" });
    expect(host.textContent).toContain("Capture undone.");
    expect(button("Retry undo")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    dom.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("popover edits location and notes through the queue, and date expands without losing drafts", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Text", "DOMParser", "NodeFilter", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const original = { id: "task", number: 42, databaseId: 42, title: "Shopping", repository: "example/tasks", url: "https://example.com/42", updatedAt: "r1", state: "open", closureReason: null, body: "", description: "", fields: {}, fieldValues: [], labels: [], start: "2026-10-27T19:00:00Z", end: "2026-10-27T20:15:00Z", allDay: false, fixed: false, scheduleError: null } as LiveTodo;
  let reads = 0;
  let responseStatus = 200;
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "fetch" ? async (_url: string, init?: RequestInit) => { if (_url.includes("/notifications/")) return Response.json({ minutes: 10, morning: null }); expect(init?.method).toBeUndefined(); if (!_url.startsWith("/api/v1/todos/")) return Response.json({ features: [] }); reads++; return Response.json(responseStatus === 200 ? { todo: original } : {}, { status: responseStatus }); } : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoDetail } = await import("./todo-detail");
  const { previewTodoEdit } = await import("./todo-live");
  const commands: any[] = [];
  const closes: number[] = [];
  let replaceNotes!: (value: string) => void;
  let setWritable!: (value: boolean) => void;
  let setAvailability!: (value: { stale: boolean; revision: string }) => void;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const [todo, setTodo] = useState(original);
    replaceNotes = value => setTodo(current => ({ ...current, description: value }));
    const [writable, write] = useState(true); setWritable = write;
    const [availability, available] = useState({ stale: false, revision: "r1" }); setAvailability = available;
    return <TodoDetail number={42} preview={todo} canWrite={writable} {...availability} onClose={() => { closes.push(commands.length); }} onQueue={command => { commands.push(command); setTodo(current => previewTodoEdit(current, command)); }} />;
  }
  const change = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(<ChakraTestWrapper><Harness /></ChakraTestWrapper>));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Add Notes, URL, or Attachments")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const location = host.querySelector<HTMLTextAreaElement>('[aria-label="Location"]')!;
    let notes = host.querySelector<HTMLElement>('[aria-label="Notes"]')!;
    const date = host.querySelector<HTMLButtonElement>('[aria-label="Edit date and task details"]')!;
    let notesEditor = (notes as HTMLElement & { editor: Editor }).editor;
    const changeNotes = async (value: string) => {
      if (!host.querySelector('[aria-label="Notes"]')) {
        await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Add Notes, URL, or Attachments")!.click());
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      }
      notes = host.querySelector<HTMLElement>('[aria-label="Notes"]')!;
      notesEditor = (notes as HTMLElement & { editor: Editor }).editor;
      await act(async () => { notes.focus(); notesEditor.commands.setContent(value, { contentType: "markdown" }); });
    };
    expect(location.placeholder).toBe("No location"); expect(notes.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")).toBe("Add Notes");
    expect([...host.querySelectorAll("button")].some(button => ["More", "Edit task"].includes(button.textContent ?? ""))).toBe(false);
    expect(host.querySelector('[aria-label="Task fields"]')).toBeNull();
    await change(location, "Market");
    await act(async () => location.blur());
    expect(commands[0].fields.Location).toEqual({ before: null, after: "Market" });
    expect(location.value).toBe("Market");
    // Delivery remains deferred: a second inline edit still queues against the projected baseline.
    await change(location, "Supermarket"); await act(async () => location.blur());
    expect(commands[1].fields.Location).toEqual({ before: "Market", after: "Supermarket" });
    await changeNotes("Milk and coffee"); await act(async () => notes.blur());
    expect(commands[2].description).toEqual({ before: "", after: "Milk and coffee" });
    await changeNotes("Discard this"); await act(async () => notes.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await act(async () => notes.blur());
    expect(notesEditor.getMarkdown()).toBe("Milk and coffee"); expect(commands).toHaveLength(3);
    await act(async () => date.click());
    const body = host.querySelector<HTMLElement>('[aria-label="Task fields"]')!;
    expect(body.hidden).toBe(false); expect(date.getAttribute("aria-expanded")).toBe("true");
    expect(body.querySelector('[id="alert-42"]')?.textContent).toContain("10 minutes before");
    expect(host.querySelector('footer [id="alert-42"]')).toBeNull();
    expect(host.querySelector('[id="alert-minutes-42"]')).toBeNull();
    await act(async () => (body.querySelector('[id="alert-42"]') as HTMLButtonElement).click());
    const alertMenu = document.querySelector('[aria-label="Task alert"]')!;
    expect(alertMenu.textContent).toContain("15 minutes before");
    const taskWritesBeforeAlert = commands.length;
    await act(async () => (alertMenu.querySelector<HTMLInputElement>('input[type="radio"][value="15"]')!).click());
    expect(body.querySelector('[id="alert-42"]')?.textContent).toContain("15 minutes before");
    expect(commands.length).toBe(taskWritesBeforeAlert);
    await act(async () => Array.from(body.querySelectorAll('button')).find(button => button.textContent === "Undo")!.click());
    expect(body.querySelector('[id="alert-42"]')?.textContent).toContain("10 minutes before");
    await act(async () => (body.querySelector('[id="alert-42"]') as HTMLButtonElement).click());
    await act(async () => (Array.from(document.querySelector('[aria-label="Task alert"]')!.querySelectorAll('button')).find(button => button.textContent === "Custom…")!).click());
    expect(document.querySelector('[id="alert-minutes-42"]')).not.toBeNull();
    expect(host.querySelector('footer input[type="number"]')).toBeNull();
    await act(async () => document.querySelector('[id="alert-minutes-42"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[aria-label="Task alert"]')).toBeNull();
    expect(body.hidden).toBe(false);
    const title = host.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!;
    await change(title, "Shopping draft"); await act(async () => title.blur()); await act(async () => date.click()); expect(body.hidden).toBe(true);
    await act(async () => date.click()); expect(title.value).toBe("Shopping draft");
    // Only one editable location/notes control; the center never submits stale duplicates.
    expect(host.querySelectorAll('[aria-label="Location"]')).toHaveLength(1);
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Save task")).toBe(false);
    expect(commands.at(-1).title).toEqual({ before: "Shopping", after: "Shopping draft" });
    expect(commands.at(-1).description).toBeUndefined(); expect(commands.at(-1).fields?.Location).toBeUndefined();
    await changeNotes("Visit [Library](https://example.com)"); await act(async () => notes.blur());
    expect(commands.at(-1).description).toEqual({ before: "Milk and coffee", after: "Visit [Library](https://example.com)" });
    expect(host.querySelector('a[href="https://example.com"]')).not.toBeNull();
    await act(async () => notes.focus());
    await act(async () => replaceNotes("Undone note"));
    await changeNotes("After Undo"); await act(async () => notes.blur());
    expect(commands.at(-1).description).toEqual({ before: "Undone note", after: "After Undo" });
    expect(reads).toBe(1);
    // Keep the selected event visible without repeating the bottom bar's outage notice.
    await change(title, "Draft during outage");
    const beforeOutage = commands.length;
    responseStatus = 503;
    await act(async () => setAvailability({ stale: true, revision: "offline" }));
    expect(host.textContent).not.toContain("To-Dos are temporarily unavailable.");
    expect(host.querySelector('fieldset[aria-label="Task details"]')?.hasAttribute("disabled")).toBe(true);
    // Happy DOM does not resolve inherited :disabled from a fieldset.
    for (const control of host.querySelectorAll("input, textarea, button")) expect(control.hasAttribute("disabled") || !!control.closest("fieldset[disabled]")).toBe(true);
    expect(notes.getAttribute("contenteditable")).toBe("false");
    await act(async () => { title.blur(); date.click(); });
    expect(commands).toHaveLength(beforeOutage);
    expect(title.value).toBe("Draft during outage");
    expect(body.hidden).toBe(false);
    responseStatus = 200;
    await act(async () => setAvailability({ stale: false, revision: "recovered" }));
    expect(title.closest("fieldset[disabled]")).toBeNull();
    expect(notes.getAttribute("contenteditable")).toBe("true");
    await act(async () => { title.focus(); title.blur(); });
    expect(commands.at(-1).title).toEqual({ before: "Shopping draft", after: "Draft during outage" });
    await change(location, "Location draft");
    await act(async () => setAvailability({ stale: true, revision: "recovered" }));
    await act(async () => location.blur());
    expect(location.value).toBe("Location draft");
    await act(async () => setAvailability({ stale: false, revision: "recovered" }));
    await act(async () => { location.focus(); location.blur(); });
    expect(commands.at(-1).fields.Location).toEqual({ before: "Supermarket", after: "Location draft" });
    await change(title, "");
    await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(closes).toHaveLength(0);
    expect(host.textContent).toContain("A title is required.");
    await change(title, "Submitted title");
    await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    expect(closes).toHaveLength(0);
    const beforeEnter = commands.length;
    await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(commands.at(-1).title).toEqual({ before: "Draft during outage", after: "Submitted title" });
    expect(commands).toHaveLength(beforeEnter + 1);
    expect(closes).toEqual([commands.length]);
    await change(location, "Submitted location");
    await act(async () => location.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(commands.at(-1).fields.Location).toEqual({ before: "Location draft", after: "Submitted location" });
    expect(commands).toHaveLength(beforeEnter + 2);
    expect(closes).toEqual([beforeEnter + 1, beforeEnter + 2]);
    await act(async () => setWritable(false));
    expect(location.readOnly).toBe(true); expect(notes.getAttribute("contenteditable")).toBe("false");
    // An authorization failure still clears cached task details.
    responseStatus = 403;
    await act(async () => setAvailability({ stale: true, revision: "denied" }));
    expect(host.querySelector('[aria-label="Title"]')).toBeNull();
    expect(host.querySelector('[aria-label="Notes"]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
