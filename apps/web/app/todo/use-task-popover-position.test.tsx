import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { isTaskScrollbarInteraction, useTaskPopoverPosition } from "./use-task-popover-position";

test("late-mounted portal observes size changes and follows replacement anchors without resetting side", async () => {
  const dom = new Window({ width: 1280, height: 720 });
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMRect", "MutationObserver", "ResizeObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const observers: { nodes: Set<Element>; notify(): void }[] = [];
  class Observer {
    nodes = new Set<Element>();
    constructor(private callback: () => void) { observers.push(this); }
    observe(node: Element) { this.nodes.add(node); }
    disconnect() { this.nodes.clear(); }
    notify() { this.callback(); }
  }
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "ResizeObserver" ? Observer : name === "getComputedStyle" ? dom.getComputedStyle.bind(dom) : (dom as any)[name] });
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
  Object.defineProperty(dom, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; } });
  Object.defineProperty(dom, "cancelAnimationFrame", { value: (id: number) => { frames.delete(id); } });
  const flush = async () => { await act(async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } }); };
  let position!: ReturnType<typeof useTaskPopoverPosition>, show!: () => void;
  let panelHeight = 217;
  function Harness() {
    position = useTaskPopoverPosition(2);
    const [mounted, setMounted] = useState(false); show = () => setMounted(true);
    return mounted ? createPortal(<div ref={node => { if (node) { node.getBoundingClientRect = () => new DOMRect(0, 0, 380 * .97, panelHeight * .97); Object.defineProperties(node, { offsetWidth: { configurable: true, get: () => 380 }, offsetHeight: { configurable: true, get: () => panelHeight } }); } position.content(node); }} />, document.body) : null;
  }
  const host = document.createElement("div"); document.body.append(host);
  const source = document.createElement("button"); source.dataset.taskNumber = "2"; source.getBoundingClientRect = () => new DOMRect(500, 600, 100, 60); document.body.append(source);
  const { createRoot } = await import("react-dom/client"); const root = createRoot(host);
  try {
    const scrollbar = document.createElement("div"); scrollbar.dataset.slot = "scroll-area-scrollbar";
    const thumb = document.createElement("div"); scrollbar.append(thumb); document.body.append(scrollbar);
    let protectedGesture = false;
    const observeGesture = (event: Event) => { protectedGesture = isTaskScrollbarInteraction(event as PointerEvent); };
    document.addEventListener("pointerdown", observeGesture);
    thumb.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
    expect(protectedGesture).toBe(true);
    source.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
    expect(protectedGesture).toBe(false);
    document.removeEventListener("pointerdown", observeGesture); scrollbar.remove();
    await act(async () => root.render(<Harness />));
    await act(async () => show());
    expect(observers.some(observer => [...observer.nodes].some(node => node !== source))).toBe(true);
    const initialSide = position.side;
    panelHeight = 576;
    await act(async () => { for (const observer of observers) observer.notify(); }); await flush();
    expect(position.y + panelHeight).toBeLessThanOrEqual(708);
    const replacement = source.cloneNode() as HTMLElement;
    replacement.getBoundingClientRect = () => new DOMRect(500, -600, 100, 60);
    await act(async () => { source.replaceWith(replacement); dom.dispatchEvent(new dom.Event("scroll")); }); await flush();
    expect(position.anchor.current).toBe(replacement);
    expect(position.side).toBe(initialSide);
    expect(position.showArrow).toBe(false);
    expect(position.y).toBe(12);
  } finally {
    await act(async () => root.unmount()); dom.happyDOM.abort();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
