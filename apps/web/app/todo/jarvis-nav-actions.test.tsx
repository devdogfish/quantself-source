import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { JarvisCallbacks } from "./jarvis-connection";

mock.module("next/navigation", () => ({ usePathname: () => "/todo", useRouter: () => ({ push() {} }) }));
mock.module("next/dynamic", () => ({ default: () => (props: { state?: string }) => <div data-aura-state={props.state} /> }));
afterAll(() => mock.restore());

test("shell Jarvis actions start and stop the same session as the menu items", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLStyleElement", "Element", "Node", "DocumentFragment", "NodeFilter", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "getComputedStyle" ? dom.getComputedStyle.bind(dom) : name === "matchMedia" ? matchMedia : Reflect.get(dom, name) });
  globalThis.fetch = (async (path: string) => Response.json(path.endsWith("/access") ? { signedUrl: "wss://example" } : { commands: [], status: "pending" })) as typeof fetch;
  let starts = 0, stops = 0;
  const start = async (_url: string, _id: string, callbacks: JarvisCallbacks) => {
    starts++; callbacks.connected("conversation_1");
    return { endSession: async () => { stops++; }, setMicMuted() {} };
  };
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoJarvis, JarvisNavActions, JarvisVoiceActivity } = await import("./todo-jarvis");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(<ChakraTestWrapper><TodoJarvis start={start}><JarvisNavActions /><JarvisVoiceActivity /></TodoJarvis></ChakraTestWrapper>));
    expect(button("Start Jarvis")?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Start Jarvis")!.click());
    expect(starts).toBe(1);
    expect(button("Stop Jarvis")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label="Jarvis voice activity"]')).not.toBeNull();
    await act(async () => button("Stop Jarvis")!.click());
    expect(stops).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dom.happyDOM.abort();
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});
