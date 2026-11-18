import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

beforeEach(() => {
  const dom = new Window({ url: "http://localhost:3000" });
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
    ResizeObserver: dom.ResizeObserver,
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

test("Chakra Button renders inside the test provider", async () => {
  const { Button } = await import("@chakra-ui/react");
  const { ChakraTestWrapper } = await import("./test-utils");
  await act(async () =>
    root.render(
      <ChakraTestWrapper>
        <Button>Save</Button>
      </ChakraTestWrapper>,
    ),
  );
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Save");
  expect(button?.className).toContain("chakra-button");
});
