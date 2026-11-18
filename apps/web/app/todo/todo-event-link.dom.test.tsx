import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Task } from "./todo-projection";
mock.module("./todo-workspace.module.css", () => ({ default: {} }));
afterAll(() => mock.restore());

test("real link chooser closes with Escape, restores focus, and isolates calendar input", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node", "Element", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "window" ? window : (window as any)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value });
  }
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { EventLink } = await import("./todo-event-link");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let calendarInput = 0;
  try {
    await act(async () => root.render(<ChakraTestWrapper><div onKeyDown={() => calendarInput++} onClick={() => calendarInput++} onPointerDown={() => calendarInput++}><EventLink task={{ title: "Meeting", eventUrls: ["https://example.org/one", "https://example.net/two"] } as Task} /></div></ChakraTestWrapper>));
    const trigger = host.querySelector("button")!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
      trigger.click();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // The chooser leaves the original control hittable.
    expect(document.body.style.pointerEvents).not.toBe("none");
    const links = document.querySelectorAll('[role="menuitem"]');
    expect(Array.from(links).map(link => link.getAttribute("href"))).toEqual(["https://example.org/one", "https://example.net/two"]);
    await act(async () => {
      (links[1] as HTMLElement).focus();
      links[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.querySelector('[role="menu"]:not([hidden])')).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
    expect(calendarInput).toBe(0);
  } finally {
    await act(async () => root.unmount());
    for (const name of names) { const descriptor = previous.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
    window.happyDOM.abort();
  }
});
