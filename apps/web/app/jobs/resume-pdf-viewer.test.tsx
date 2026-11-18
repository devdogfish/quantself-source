import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

mock.module("react-pdf", () => ({
  pdfjs: { version: "test", GlobalWorkerOptions: {} },
  Document: ({ children, file, error, suspense }: {
    children?: React.ReactNode; file: string; error?: React.ReactNode; suspense?: boolean;
  }) => {
    if (file === "blob:invalid") {
      // React-PDF 11 throws failures to an Error Boundary unless Suspense is disabled.
      if (suspense !== false) throw new Error("Synthetic InvalidPDFException");
      return <div>{error}</div>;
    }
    return <div>{children}</div>;
  },
  Page: () => <div />,
}));

test("PDF scrolling synchronizes both directions without echoing programmatic scroll", async () => {
  const dom = new Window({ url: "http://localhost" });
  let resize: (() => void) | undefined;
  let disconnected = false;
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Event: dom.Event, Node: dom.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  };
  Object.defineProperty(dom, "matchMedia", { value: (query: string) => ({ matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, }) });
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const Viewer = (await import("./resume-pdf-document")).default;
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
  const changes: number[] = [];
  const onRatio = (ratio: number) => changes.push(ratio);
  try {
    await act(async () => root.render(<Viewer pdfUrl="blob:synthetic" scrollRatio={0} onScrollRatioChange={onRatio} />));
    const viewport = host.querySelector('[role="region"]') as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1800 },
      clientHeight: { value: 600 },
      clientWidth: { value: 700 },
    });
    await act(async () => root.render(<Viewer pdfUrl="blob:synthetic" scrollRatio={0.5} onScrollRatioChange={onRatio} />));
    expect(viewport.scrollTop).toBe(600);
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(changes).toEqual([]);

    viewport.scrollTop = 300;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(changes).toEqual([0.25]);

    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2600 });
    await act(async () => resize?.());
    expect(viewport.scrollTop).toBe(500);
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(changes).toEqual([0.25]);

    await act(async () => root.render(<Viewer pdfUrl="blob:synthetic" scrollRatio={1} onScrollRatioChange={onRatio} />));
    expect(viewport.scrollTop).toBe(2000);
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(changes).toEqual([0.25]);
    await act(async () => root.render(<Viewer pdfUrl="blob:invalid" />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not display this PDF");
    expect(host.querySelector('[role="region"]')).not.toBeNull();
    await act(async () => root.render(<Viewer pdfUrl="blob:synthetic" />));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(disconnected).toBe(true);
    await dom.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
