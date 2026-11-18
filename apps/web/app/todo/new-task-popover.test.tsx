import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
let card: any;
mock.module("./todo-detail", () => ({ TodoDetail: (props: any) => { card = props; return props.draft.footer(props.onClose); } }));
afterAll(() => mock.restore());

test.each(["saved", "partial", "failure", "queue failure"])("%s: local opening, autosave once, deferred later edits survive", async (outcome) => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let requests = 0, posted: any, resolve!: (response: Response) => void;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? (_path: string, init: RequestInit) => { requests++; posted = JSON.parse(String(init.body)); return new Promise<Response>(done => { resolve = done; }); } : (dom as any)[name] });
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { NewTaskPopover } = await import("./new-task-popover");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const starts: any[] = [], finishes: any[] = [], queued: any[] = []; let closed = 0;
  let blocked = outcome === "queue failure";
  const selected: string[] = [];
  const props = { onCreated: (todo: any) => selected.push(todo.id), onQueue: (command: any, before: any) => { if (blocked && command.fields?.Location) throw Error("Queue unavailable"); queued.push({ command, before }); }, initialTiming: { start: "2026-10-28T12:00", end: "2026-10-28T12:30", allDay: false }, disabled: false, onSaved: () => {}, onClose: () => { closed++; }, creation: { start: (value: any) => starts.push(value), finish: (id: string) => finishes.push(id), fail: () => {} } };
  try {
    await act(async () => root.render(<ChakraTestWrapper><NewTaskPopover {...props} /></ChakraTestWrapper>));
    expect(card.preview.title).toBe("New task"); expect(requests).toBe(0);
    card.onClose(); expect(requests).toBe(0);
    await act(async () => card.onQueue({ commandId: crypto.randomUUID(), title: { before: "New task", after: "Coffee" } }));
    expect(document.querySelector("button")).toBeNull();
    expect(card.canWrite).toBe(true);
    await act(async () => card.onQueue({ commandId: crypto.randomUUID(), title: { before: "Coffee", after: "Coffee later" } }));
    await act(async () => card.onQueue({ commandId: crypto.randomUUID(), fields: { Location: { before: null, after: "Cafe" } } }));
    if (outcome === "saved") await act(async () => { card.draft.submit(props.onClose); card.draft.submit(props.onClose); });
    expect(requests).toBe(1); expect(starts).toHaveLength(1); expect(posted.title).toBe("Coffee");
    expect(posted.start).toBe("2026-10-28T15:00:00.000Z"); expect(posted.end).toBe("2026-10-28T15:30:00.000Z");
    if (outcome === "failure") {
      const first = posted;
      await act(async () => resolve(Response.json({ message: "Try again" }, { status: 503 })));
      expect(document.querySelector("button")!.textContent).toBe("Retry save");
      await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
      expect(posted).toEqual(first); expect(requests).toBe(2);
    }
    await act(async () => resolve(Response.json({ todo: { ...card.preview, number: 42, title: "Coffee", fields: {} }, outcomes: { creation: "saved", ...(outcome === "partial" ? { Category: "conflict" } : {}) }, message: outcome === "partial" ? "Category conflict" : "Saved" })));
    if (outcome === "queue failure") {
      expect(queued).toHaveLength(1);
      expect(card.preview.fields.Location).toBe("Cafe");
      await act(async () => card.onQueue({ commandId: crypto.randomUUID(), title: { before: "Coffee later", after: "Coffee final" } }));
      expect(queued).toHaveLength(1);
      blocked = false;
      await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
      expect(queued).toHaveLength(3);
      expect(queued[1].command.fields.Location).toEqual({ before: null, after: "Cafe" });
      expect(queued[2].command.title).toEqual({ before: "Coffee later", after: "Coffee final" });
      expect(card.preview.title).toBe("Coffee final");
    }
    expect(selected).toHaveLength(1);
    expect(finishes).toEqual([posted.commandId]); expect(closed).toBe(outcome === "saved" ? 2 : 1);
    expect(queued).toHaveLength(outcome === "queue failure" ? 3 : 2); expect(queued[0].before.number).toBe(42);
    expect(queued[0].command.title).toEqual({ before: "Coffee", after: "Coffee later" });
    expect(card.preview.title).toBe(outcome === "queue failure" ? "Coffee final" : "Coffee later"); expect(card.preview.fields.Location).toBe("Cafe");
    expect(card.canWrite).toBe(true); expect(document.querySelector("button")).toBeNull();
    if (outcome === "partial") expect(document.body.textContent).toContain("Category conflict");
    await act(async () => card.draft.submit(props.onClose)); expect(requests).toBe(outcome === "failure" ? 2 : 1);
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
