import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const anchor: { current: HTMLElement | null } = { current: null };
mock.module("./use-task-popover-position", () => ({
  isTaskScrollbarInteraction: () => false,
  useTaskPopoverPosition: () => ({ anchor, content: () => {}, x: 0, y: 0, side: "bottom", ready: true, maxWidth: 380, maxHeight: 600, showArrow: false }),
}));
afterAll(() => mock.restore());

test("Enter requests the shared exit; external replacement retains exiting panel without stale close", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? (dom as any)[key].bind(dom) : (dom as any)[key] });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AnimatePresence } = await import("motion/react");
  const { TaskPopover } = await import("./task-popover");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const host = document.createElement("div"); document.body.append(host);
  const anchorButton = document.createElement("button"); document.body.append(anchorButton); anchor.current = anchorButton;
  const root = createRoot(host);
  const render = (children: React.ReactNode) => act(async () => root.render(<ChakraTestWrapper>{children}</ChakraTestWrapper>));
  const surfaceSelector = '[data-scope="popover"][data-part="content"]';
  const closes: string[] = [];
  const panel = (id: string, callbackId = id) => <TaskPopover key={id} number={1} titleId={id} onClose={() => closes.push(callbackId)}>{requestClose => <input aria-label={id} onKeyDown={event => { if (event.key === "Enter") requestClose(); }} />}</TaskPopover>;
  const finish = async (surface: HTMLElement, animationName = "disappear") => {
    // happy-dom does not load the CSS module or emit animation events.
    surface.style.animationName = "disappear";
    const event = new dom.Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: animationName });
    await act(async () => surface.dispatchEvent(event as unknown as Event));
  };
  try {
    await render(panel("title"));
    const input = document.querySelector<HTMLInputElement>('[aria-label="title"]')!;
    await act(async () => { input.focus(); input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
    const surface = document.querySelector<HTMLElement>(surfaceSelector)!;
    expect(surface.getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).not.toBe(input);
    expect(closes).toEqual([]);
    await render(panel("title", "latest"));
    await finish(surface, "appear");
    expect(closes).toEqual([]);
    await finish(surface);
    expect(closes).toEqual(["latest"]);
    expect(document.activeElement).toBe(anchorButton);
    await render(<AnimatePresence>{panel("old")}</AnimatePresence>);
    await render(<AnimatePresence>{panel("new")}</AnimatePresence>);
    const oldSurface = document.querySelector('[aria-label="old"]')!.closest<HTMLElement>(surfaceSelector)!;
    expect(oldSurface.getAttribute("data-state")).toBe("closed");
    expect(document.querySelector('[aria-label="new"]')).not.toBeNull();
    const newInput = document.querySelector<HTMLInputElement>('[aria-label="new"]')!;
    newInput.focus();
    await finish(oldSurface);
    expect(document.activeElement).toBe(newInput);
    expect(document.querySelector('[aria-label="old"]')).toBeNull();
    expect(document.querySelector('[aria-label="new"]')).not.toBeNull();
    expect(closes).toEqual(["latest"]);
    await render(<AnimatePresence>{null}</AnimatePresence>);
    expect(document.querySelector('[data-state="closed"]')).not.toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(document.querySelector(surfaceSelector)).toBeNull();
    expect(closes).toEqual(["latest"]);
  } finally {
    await act(async () => root.unmount());
    anchor.current = null;
    dom.happyDOM.abort();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
