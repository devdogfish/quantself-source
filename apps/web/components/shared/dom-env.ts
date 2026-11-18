// Test-only: installs happy-dom globals at import time, before react-dom/emotion load (they probe `window` once on load).
import { afterAll } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000" });
Object.defineProperty(dom, "matchMedia", { value: (query: string) => ({
  matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
}) });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLStyleElement: dom.HTMLStyleElement, HTMLSelectElement: dom.HTMLSelectElement, Element: dom.Element, Node: dom.Node,
  DocumentFragment: dom.DocumentFragment, NodeFilter: dom.NodeFilter, Event: dom.Event, CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom), matchMedia: dom.matchMedia.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Release the browser frame once this file has unmounted its React roots.
afterAll(() => dom.happyDOM.close());
