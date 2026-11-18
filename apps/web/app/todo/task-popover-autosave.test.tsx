import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";

const anchor = { current: null };
const content = () => {};
mock.module("./use-task-popover-position", () => ({ isTaskScrollbarInteraction: () => false, useTaskPopoverPosition: () => ({ anchor, content, x: 100, y: 100, side: "bottom", ready: true, maxWidth: 380, maxHeight: 600, showArrow: false, arrowStyle: {} }) }));
mock.module("./jarvis-ui", () => ({ useJarvisDraft: () => {} }));
afterAll(() => mock.restore());

test("opening selects title; Escape discards inline draft before dismissing; close blurs form", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "DOMRect", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TaskPopover } = await import("./task-popover");
  const { TodoInlineText } = await import("./todo-inline-text");
  const commits: string[] = [];
  let closed = false, formBlur = false;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState("Shopping");
    return <TaskPopover number={42} titleId="task-title" selectTitle onClose={() => { closed = true; }}>
      <h2 id="task-title">Task</h2>
      <TodoInlineText title label="Title" placeholder="Title" value={value} readOnly={false} onCommit={(_, next) => { commits.push(next); setValue(next); }} />
      <form onBlurCapture={() => { formBlur = true; }}><input aria-label="Client" defaultValue="Acme" /></form>
    </TaskPopover>;
  }
  try {
    await act(async () => root.render(<ChakraTestWrapper><Harness /></ChakraTestWrapper>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!;
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(0); expect(title.selectionEnd).toBe(8);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "Draft"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(title.getAttribute("data-inline-dirty")).toBe("true");
    await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(title.value).toBe("Shopping"); expect(commits).toEqual([]); expect(closed).toBe(false);
    const client = document.querySelector<HTMLInputElement>('[aria-label="Client"]')!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      client.focus();
    });
    expect(client.selectionStart).toBe(0); expect(client.selectionEnd).toBe(4);
    await act(async () => {
      client.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
      client.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
      title.focus();
    });
    expect(title.selectionStart).toBe(0); expect(title.selectionEnd).toBe(title.value.length);
    await act(async () => {
      title.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      client.focus();
      title.setSelectionRange(2, 2); title.focus();
    });
    expect(title.selectionStart).toBe(2); expect(title.selectionEnd).toBe(2);
    await act(async () => client.focus());
    await act(async () => client.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(formBlur).toBe(true); expect(closed).toBe(true);
  } finally {
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
