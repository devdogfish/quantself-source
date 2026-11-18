import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push() {} }),
}));
mock.module("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
mock.module("@/app/todo/todo-jarvis", () => ({
  JarvisNavActions: () => null, JarvisVoiceActivity: () => null, useJarvisActive: () => false,
}));

let root: Root;
let container: HTMLElement;
let dom: Window;
let restoreGlobals: () => void;
const observers: Array<(entries: unknown[]) => void> = [];

class FakeResizeObserver {
  constructor(callback: (entries: unknown[]) => void) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  observers.length = 0;
  dom = new Window({ url: "http://localhost:3000", width: 1400, height: 900 });
  Object.defineProperty(dom, "matchMedia", {
    value: (query: string) => ({
      matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
    }),
  });
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLStyleElement: dom.HTMLStyleElement,
    Element: dom.Element,
    Node: dom.Node,
    DocumentFragment: dom.DocumentFragment,
    NodeFilter: dom.NodeFilter,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: FakeResizeObserver,
    PointerEvent: dom.PointerEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    matchMedia: dom.matchMedia.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, globals);
  restoreGlobals = () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.happyDOM.abort();
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  container.remove();
  restoreGlobals();
});

afterAll(() => mock.restore());


async function renderSettings() {
  const { AppShell } = await import("@/components/app-shell/app-shell");
  const { AppearanceSettings } = await import("./appearance-settings");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  await act(async () => root.render(<ChakraTestWrapper><AppShell><AppearanceSettings /></AppShell></ChakraTestWrapper>));
}

const radio = (group: string, label: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`[aria-label="${group}"] input[type="radio"]`)].find(
    (input) => input.closest("label")?.textContent?.startsWith(label),
  )!;
const checked = (group: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`[aria-label="${group}"] input[type="radio"]`)]
    .filter((input) => input.checked).map((input) => input.closest("label")?.textContent?.split(/(?<=[a-z])(?=[A-Z])/)[0]);
const shellLayout = () => document.documentElement.dataset.layout;

test("theme choice applies immediately and is saved in this browser", async () => {
  await renderSettings();
  expect(checked("Theme")).toEqual(["Light"]);
  await act(async () => radio("Theme", "Dark").click());
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(checked("Theme")).toEqual(["Dark"]);
  await act(async () => radio("Theme", "Light").click());
  expect(localStorage.getItem("theme")).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

test("primary colour presets and reset apply and persist", async () => {
  localStorage.setItem("quantself.brand", "#0f766e");
  await renderSettings();
  expect(container.querySelector('[data-testid="brand-hex"]')?.textContent).toBe("#0F766E");
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Teal"]')?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Violet"]')!.click());
  expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#6d28d9");
  expect(localStorage.getItem("quantself.brand")).toBe("#6d28d9");
  expect(container.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#6d28d9");
  const reset = [...container.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
  await act(async () => reset.click());
  expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#005daa");
  expect(localStorage.getItem("quantself.brand")).toBeNull();
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Reset")).toBe(false);
});

test("navigation layout switches the shell live and is remembered after a reload", async () => {
  await renderSettings();
  expect(checked("Navigation layout")).toEqual(["Compact"]);
  await act(async () => radio("Navigation layout", "Sidebar").click());
  expect(shellLayout()).toBe("side");
  expect(localStorage.getItem("quantself.layout")).toBe("side");
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderSettings();
  expect(shellLayout()).toBe("side");
  expect(checked("Navigation layout")).toEqual(["Sidebar"]);
});
