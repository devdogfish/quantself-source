import { afterAll, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { NestedOverlayContext, useNestedOverlayGuard } from "@/components/shared/nested-overlay-guard";

mock.module("./jarvis-ui", () => ({ useJarvisDraft: () => {} }));
afterAll(() => mock.restore());

test("location suggestions debounce, discard stale results, select immediately, and autosave later intent", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "CustomEvent", "HTMLButtonElement", "NodeFilter", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: { resolve(value: Response): void; signal: AbortSignal; url: string }[] = [];
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "fetch" ? (url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ resolve, signal: init.signal as AbortSignal, url })) : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoLocationInput } = await import("./todo-location-input");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const commits: string[][] = [];
  const submitted: string[] = [];
  let rejectCommit = false;
  let replaceValue!: (value: string) => void;
  let parentGuard!: ReturnType<typeof useNestedOverlayGuard>;
  function Harness() {
    parentGuard = useNestedOverlayGuard();
    const [value, setValue] = useState(""); replaceValue = setValue;
    return <NestedOverlayContext.Provider value={parentGuard.registry}><TodoLocationInput value={value} readOnly={false} onSubmit={() => { submitted.push(commits.at(-1)![1]); }} onCommit={(before, after) => { if (rejectCommit) throw Error("Queue unavailable"); commits.push([before, after]); setValue(after); }} /></NestedOverlayContext.Provider>;
  }
  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  try {
    await act(async () => root.render(<ChakraTestWrapper><Harness /></ChakraTestWrapper>));
    jest.useFakeTimers();
    const input = host.querySelector("textarea")!;
    const change = (value: string) => act(async () => {
      input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await change("Ha"); await advance(550); expect(requests).toHaveLength(0);
    await change("Hal"); await change("Halifax"); await advance(550); expect(requests).toHaveLength(1);
    await change("Library"); expect(requests[0]!.signal.aborted).toBe(true); await advance(550); expect(requests).toHaveLength(2);
    await act(async () => requests[0]!.resolve(Response.json({ features: [{ properties: { name: "Old result" } }] })));
    expect(host.textContent).not.toContain("Old result");
    await act(async () => requests[1]!.resolve(Response.json({ features: [{ properties: { name: "Central Library", city: "Halifax" } }] })));
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    const listbox = document.querySelector('[role="listbox"]')!;
    expect(host.contains(listbox)).toBe(false);
    expect(parentGuard.protect()).toBe(true);
    expect(document.activeElement).toBe(input);
    await advance(3100);
    expect(commits).toEqual([["", "Library"]]);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(requests).toHaveLength(2);
    await act(async () => replaceValue("Library"));
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(commits).toEqual([["", "Library"], ["Library", "Central Library, Halifax"]]);
    expect(input.value).toBe("Central Library, Halifax");
    expect(submitted).toEqual(["Central Library, Halifax"]);
    await change("Home"); await advance(3100);
    expect(commits.at(-1)).toEqual(["Central Library, Halifax", "Home"]);
    expect(requests[2]!.signal.aborted).toBe(false);
    await act(async () => requests[2]!.resolve(Response.json({ features: [{ properties: { name: "Home place", city: "Halifax" } }] })));
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(requests).toHaveLength(3);
    // Undo arrives while the clean input retains focus.
    await act(async () => replaceValue("Central Library, Halifax"));
    expect(document.activeElement).toBe(input);
    // A delivery is still pending; new blur intent uses the optimistic baseline.
    await change("Home office"); await act(async () => input.blur());
    expect(commits.at(-1)).toEqual(["Central Library, Halifax", "Home office"]);
    expect(commits).toHaveLength(4);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.signal.aborted).toBe(true);
    await change("Discard");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => input.blur()); expect(input.value).toBe("Home office"); expect(commits).toHaveLength(4);
    await change("Cafe"); await advance(550);
    await act(async () => requests[3]!.resolve(Response.json({ features: [{ properties: { name: "Cafe", city: "Halifax" } }] })));
    const option = document.querySelector('[role="option"]')!;
    await act(async () => {
      option.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true }) as unknown as Event);
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(input.value).toBe("Cafe, Halifax");
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(parentGuard.protect()).toBe(true);
    expect(commits.at(-1)).toEqual(["Home office", "Cafe, Halifax"]);
    await act(async () => input.blur());
    expect(commits).toHaveLength(5);
    rejectCommit = true;
    await change("No");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(submitted).toHaveLength(1);
    expect(input.value).toBe("No");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Queue unavailable");
    rejectCommit = false;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(submitted).toEqual(["Central Library, Halifax", "No"]);
    expect(commits).toHaveLength(6);
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}, 15000);
