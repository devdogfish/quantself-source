// Test helper: happy-dom env + React root for shared component tests (call createTestDom() at module top level).
import "./dom-env";
import { afterAll, afterEach, beforeEach, mock } from "bun:test";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";


export function createTestDom() {
  let root: Root;
  let container: HTMLElement;
  let Wrapper: typeof import("@/components/chakra/test-utils").ChakraTestWrapper;
  beforeEach(async () => {
    // Loaded dynamically so react-dom sees the happy-dom window at load time (needed for onChange on inputs).
    const { createRoot } = await import("react-dom/client");
    ({ ChakraTestWrapper: Wrapper } = await import("@/components/chakra/test-utils"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); await new Promise((r) => setTimeout(r, 0)); });
    document.body.innerHTML = "";
    localStorage.clear();
  });
  afterAll(() => mock.restore());
  return {
    get container() { return container; },
    render: (ui: ReactNode) => act(async () => root.render(<Wrapper>{ui}</Wrapper>)),
    click: (el: Element) => act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }),
    type: (el: HTMLInputElement, value: string) => act(async () => {
      el.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  };
}
