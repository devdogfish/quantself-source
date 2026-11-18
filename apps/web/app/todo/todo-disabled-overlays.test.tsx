import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

test("open date and category overlays close on disable and stay closed on recovery", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "fetch" ? async () => Response.json({ categories: [{ id: 1, name: "Work", color: "blue" }], revision: "r1" }) : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoDateField } = await import("./todo-date-field");
  const { CategoryPicker, CategoryProvider } = await import("./todo-categories");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const render = (disabled: boolean) => act(async () => root.render(<ChakraTestWrapper><CategoryProvider><TodoDateField id="start" label="Start" value="2026-10-28" disabled={disabled} onChange={value => changes.push(value)} /><CategoryPicker value="" disabled={disabled} onChange={value => changes.push(value)} /></CategoryProvider></ChakraTestWrapper>));
  try {
    await render(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Start date"]')!.click());
    expect(!!document.querySelector('[aria-label="Start calendar"]')).toBe(true);
    expect(!!host.querySelector('[data-scope="date-picker"][data-part="control"]')).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.activeElement?.closest('[aria-label="Start calendar"]') !== null).toBe(true);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.activeElement === host.querySelector('[aria-label="Start date"]')).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Start date"]')!.click());
    const clear = [...document.querySelectorAll("button")].find(button => button.textContent === "Clear date")!;
    await render(true);
    expect(document.querySelector('[aria-label="Start calendar"]')).toBeNull();
    await act(async () => clear.click());
    expect(changes).toEqual([]);
    await render(false);
    expect(document.querySelector('[aria-label="Start calendar"]')).toBeNull();
    await act(async () => host.querySelector('[aria-label="Category"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    const option = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent === "Work")!;
    await render(true);
    expect(!!document.querySelector('[role="listbox"][data-state="open"]')).toBe(false);
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(changes).toEqual([]);
    await render(false);
    expect(!!document.querySelector('[role="listbox"][data-state="open"]')).toBe(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
