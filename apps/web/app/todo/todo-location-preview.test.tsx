import { afterAll, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";

const requests: { query: string; signal: AbortSignal; resolve: (value: null) => void }[] = [];
mock.module("./location-preview", () => ({ resolveLocationPreview: (query: string, signal: AbortSignal) => new Promise<null>(resolve => requests.push({ query, signal, resolve })) }));
afterAll(() => mock.restore());

test("preview debounces, cancels stale locations, and keeps a useful map link on no match", async () => {
  const dom = new Window({ url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as any)[key] });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoLocationPreview } = await import("./todo-location-preview");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    jest.useFakeTimers();
    await act(async () => root.render(<TodoLocationPreview location=" " />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<TodoLocationPreview location="Old & address" />));
    expect(host.textContent).toContain("Loading map"); expect(requests).toHaveLength(0);
    await act(async () => { jest.advanceTimersByTime(520); });
    expect(requests).toHaveLength(1);
    await act(async () => root.render(<TodoLocationPreview location="New place" />));
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => requests[0].resolve(null));
    expect(host.textContent).toContain("Loading map");
    expect(host.textContent).not.toContain("Old & address");
    await act(async () => { jest.advanceTimersByTime(520); });
    expect(requests).toHaveLength(2);
    await act(async () => requests[1].resolve(null));
    expect(host.textContent).toContain("No map preview");
    const link = host.querySelector<HTMLAnchorElement>('a[aria-label]')!;
    expect(new URL(link.href).searchParams.get("query")).toBe("New place");
    expect(link.target).toBe("_blank");
    await act(async () => root.render(<TodoLocationPreview location="" />));
    expect(host.textContent).toBe(""); expect(requests[1].signal.aborted).toBe(true);
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount());
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.happyDOM.abort();
  }
});
