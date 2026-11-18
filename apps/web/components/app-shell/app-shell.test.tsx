import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { NavAction as NavActionComponent } from "@/components/shared/nav-action";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

let pathname = "/inventory/items/item-1";
let jarvisConnected = false;
let jarvisStarts = 0;
let jarvisStops = 0;

mock.module("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push() {} }),
}));
mock.module("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
// Jarvis itself is covered by app/todo tests; here only the shell wiring matters.
mock.module("@/app/todo/todo-jarvis", () => {
  const NavAction = NavActionComponent;
  return {
    JarvisNavActions: ({ fullWidth }: { fullWidth?: boolean }) => (
      <NavAction
        {...(fullWidth ? { w: "full" } : {})}
        aria-pressed={jarvisConnected}
        aria-label={jarvisConnected ? "Stop Jarvis" : "Start Jarvis"}
        onClick={() => { if (jarvisConnected) jarvisStops++; else jarvisStarts++; }}
      >
        <span aria-hidden="true">mic</span>Jarvis
      </NavAction>
    ),
    JarvisVoiceActivity: () => (jarvisConnected ? <div aria-label="Jarvis voice activity">listening</div> : null),
    useJarvisActive: () => jarvisConnected,
  };
});

let root: Root;
let container: HTMLElement;
let dom: Window;
let restoreGlobals: () => void;
// Menu positioning (floating-ui) needs a ResizeObserver; the shell itself no longer measures its width.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  pathname = "/inventory/items/item-1";
  jarvisConnected = false;
  jarvisStarts = 0;
  jarvisStops = 0;
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

async function renderShell(width = 1400) {
  dom.happyDOM.setViewport({ width, height: 900 });
  const { AppShell } = await import("./app-shell");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  await act(async () => root.render(<ChakraTestWrapper><AppShell><main>Page</main></AppShell></ChakraTestWrapper>));
}

// CSS (globals.css) picks the visible chrome block from <html data-layout> and the viewport width, so tests
// look inside the block each layout shows.
const chrome = (name: "compact" | "center" | "side") => container.querySelector<HTMLElement>(`[data-chrome="${name}"]`)!;
const htmlLayout = () => document.documentElement.dataset.layout;
const sections = (layout: "compact" | "center" | "side" = "compact") => [...chrome(layout).querySelectorAll<HTMLAnchorElement>('nav[aria-label="Sections"] a')];
const byName = (name: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLElement>("a, button")].find((el) => (el.getAttribute("aria-label") ?? el.textContent)?.trim() === name);

const SECTION_LINKS = [
  ["Home", "/"], ["To-Do", "/todo"], ["Calendar", "/calendar"], ["Habits", "/habits"], ["Productivity", "/productivity"],
  ["Inventory", "/inventory"], ["Budgeting", "/budgeting"], ["Jarvis", "/jarvis"], ["Jobs", "/jobs"], ["Website analytics", "/website-analytics"],
];

for (const layout of ["compact", "center", "side"] as const) {
  test(`${layout} chrome lists every area with the current one marked, plus Jarvis and Settings`, async () => {
    await renderShell();
    const block = chrome(layout);
    expect(container.querySelector("main")?.textContent).toBe("Page");
    expect(sections(layout).map((link) => [link.textContent, link.getAttribute("href")])).toEqual(SECTION_LINKS);
    expect(sections(layout).filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent)).toEqual(["Inventory"]);
    expect(block.querySelector('a[aria-label="Quantself home"]')?.getAttribute("href")).toBe("/");
    expect(byName("Settings", block)?.getAttribute("href")).toBe("/settings");
    const jarvis = byName("Start Jarvis", block)!;
    expect(jarvis).not.toBeUndefined();
    await act(async () => jarvis.click());
    expect(jarvisStarts).toBe(1);
  });
}

test("every layout's chrome renders on the server and the page content once, so CSS alone picks the layout", async () => {
  await renderShell();
  expect(container.querySelectorAll("main")).toHaveLength(1);
  expect(["compact", "center", "side"].map((name) => !!container.querySelector(`[data-chrome="${name}"]`))).toEqual([true, true, true]);
});

test("Jarvis voice activity shows as one floating assistant for every layout while connected", async () => {
  await renderShell();
  expect(container.querySelector('[aria-label="Jarvis voice activity"]')).toBeNull();
  jarvisConnected = true;
  await renderShell();
  expect(container.querySelectorAll('[aria-label="Jarvis voice activity"]')).toHaveLength(1);
  await act(async () => byName("Stop Jarvis", chrome("compact"))!.click());
  expect(jarvisStops).toBe(1);
});

test("focus spaces render the page without app navigation", async () => {
  pathname = "/todo";
  await renderShell();
  expect(container.querySelector("main")?.textContent).toBe("Page");
  expect(container.querySelector("[data-chrome]")).toBeNull();
  expect(container.querySelector('nav[aria-label="Sections"]')).toBeNull();
  expect(container.querySelector("[data-focus-space]")).not.toBeNull();
  pathname = "/todos-elsewhere";
  await renderShell();
  expect(container.querySelector("[data-chrome]")).not.toBeNull();
});

test("active section follows the route: exact match for Home, prefix match elsewhere", async () => {
  const current = () => sections().filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent);
  pathname = "/";
  await renderShell();
  expect(current()).toEqual(["Home"]);
  pathname = "/website-analytics/pages";
  await renderShell();
  expect(current()).toEqual(["Website analytics"]);
  pathname = "/settings";
  await renderShell();
  expect(current()).toEqual([]);
  expect(byName("Settings", chrome("compact"))?.getAttribute("aria-current")).toBe("page");
});

test("boot script puts the saved layout on <html> before first paint; unknown or missing values mean compact", async () => {
  const { LAYOUT_BOOT_SCRIPT } = await import("./layout");
  const boot = () => { delete document.documentElement.dataset.layout; new Function("document", "localStorage", LAYOUT_BOOT_SCRIPT)(document, localStorage); return htmlLayout(); };
  expect(boot()).toBe("compact");
  for (const layout of ["center", "side", "compact"]) {
    localStorage.setItem("quantself.layout", layout);
    expect(boot()).toBe(layout);
  }
  localStorage.setItem("quantself.layout", "sideways");
  expect(boot()).toBe("compact");
});

test("narrow top bar offers the sections through a menu button", async () => {
  await renderShell(375);
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Sections menu"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    trigger.click();
  });
  const items = [...document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')];
  expect(items.map((item) => item.textContent)).toEqual(SECTION_LINKS.map(([label]) => label));
  expect(items.filter((item) => item.getAttribute("aria-current") === "page").map((item) => item.textContent)).toEqual(["Inventory"]);
});

test("layout preference switches live and is remembered after a reload", async () => {
  const { useLayoutPreference } = await import("./layout-preference");
  function Switcher() {
    const { layout, setLayout } = useLayoutPreference();
    return <><output>{layout}</output>{(["compact", "center", "side"] as const).map((value) => <button key={value} onClick={() => setLayout(value)}>{value}</button>)}</>;
  }
  const { AppShell } = await import("./app-shell");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const mount = () => act(async () => root.render(<ChakraTestWrapper><AppShell><Switcher /></AppShell></ChakraTestWrapper>));
  await mount();
  const choose = (name: string) => act(async () => byName(name, container.querySelector("main") ?? container)!.click());
  await choose("side");
  expect(htmlLayout()).toBe("side");
  expect(localStorage.getItem("quantself.layout")).toBe("side");
  await choose("center");
  expect(htmlLayout()).toBe("center");
  expect(localStorage.getItem("quantself.layout")).toBe("center");
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  expect(container.querySelector("output")?.textContent).toBe("center");
});
