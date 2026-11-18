import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Editor } from "@tiptap/react";

mock.module("next/navigation", () => ({ usePathname: () => window.location.pathname, useRouter: () => ({ push() {}, replace() {} }) }));

test("Jobs context renders Markdown and keeps editing and Undo visible during a pending save", async () => {
  const dom = new Window({ url: "http://localhost/jobs/context" });
  const keys = ["HTMLStyleElement", "SVGElement", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLInputElement",
    "HTMLTextAreaElement", "Element", "Node", "Text", "DOMParser", "DocumentFragment", "NodeFilter", "Event",
    "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "getSelection", "requestAnimationFrame",
    "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  Object.defineProperty(dom, "matchMedia", { value: (query: string) => ({ matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, }) });
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const firstSave = Promise.withResolvers<Response>();
  const load = Promise.withResolvers<Response>();
  const applicationId = "174be71f-59c8-4c7c-8427-e63befba7225";
  const questionReads: string[] = [];
  const calls: { method: string; markdown?: string; expectedVersion?: number }[] = [];
  const fetchContext = async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    if (path === `/api/jobs/application-details/${applicationId}`) {
      expect(method).toBe("GET");
      questionReads.push(path);
      return Response.json({
        application: { id: applicationId, role: "Engineer", company: "Example Studio" },
        candidateRulesUnavailable: true,
      });
    }
    if (path === `/api/v1/jobs/private-fields?applicationId=${applicationId}`) {
      expect(method).toBe("GET");
      questionReads.push(path);
      return Response.json({ fields: [] });
    }
    expect(path).toBe("/api/v1/jobs/candidate-context");
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, ...body });
    if (method === "GET") return load.promise;
    if (body.expectedVersion === 1) return firstSave.promise;
    return Response.json({ markdown: body.markdown, version: body.expectedVersion + 1 });
  };
  for (const key of keys) {
    const value = key === "window" ? dom : key === "fetch" ? fetchContext : key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key);
    const bound = typeof value === "function" && ["getComputedStyle", "getSelection", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
      ? value.bind(dom) : value;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof bound === "function" && key === "matchMedia" ? bound.bind(dom) : bound });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JobsCandidateContext } = await import("./jobs-candidate-context");
  const host = document.createElement("div");
  document.body.append(host);
  const rawRoot = createRoot(host);
  const { CacheProvider } = await import("@emotion/react");
  const { default: createCache } = await import("@emotion/cache");
  const cache = createCache({ key: "jobs-test", container: document.head });
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const root = {
    render: (element: Parameters<typeof rawRoot.render>[0]) => rawRoot.render(<CacheProvider value={cache}><ChakraTestWrapper>{element}</ChakraTestWrapper></CacheProvider>),
    unmount: () => rawRoot.unmount(),
  };
  const button = (text: string) => [...host.querySelectorAll("button")].find(element => element.textContent === text)!;
  try {
    await act(async () => root.render(<JobsCandidateContext />));
    expect(host.textContent).toContain("Loading candidate context");
    await act(async () => { load.resolve(Response.json({ markdown: "## Initial", version: 1 })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const textbox = host.querySelector<HTMLElement>('[role="textbox"][aria-label="Candidate context"]')!;
    const { editor } = textbox as HTMLElement & { editor: Editor };
    expect(textbox.querySelector("h2")?.textContent).toBe("Initial");
    const edit = async (markdown: string) => {
      await act(async () => { textbox.focus(); editor.commands.setContent(markdown, { contentType: "markdown" }); });
      await act(async () => textbox.blur());
    };
    await edit("First");
    expect(host.textContent).toContain("Saving");
    await edit("**Later**");
    expect(textbox.querySelector("strong")?.textContent).toBe("Later");
    await act(async () => button("Undo").click());
    expect(textbox.textContent).toBe("First");
    await act(async () => button("Redo").click());
    expect(textbox.textContent).toBe("Later");
    expect(calls).toEqual([{ method: "GET" }, { method: "PATCH", markdown: "First", expectedVersion: 1 }]);

    await act(async () => { firstSave.resolve(Response.json({ markdown: "First", version: 2 })); });
    expect(textbox.querySelector("strong")?.textContent).toBe("Later");
    expect(calls[2]).toEqual({ method: "PATCH", markdown: "**Later**", expectedVersion: 2 });
    expect(calls).toHaveLength(3);

    // Per-application questions moved to Submissions; Profile never reads application data.
    expect(questionReads).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
