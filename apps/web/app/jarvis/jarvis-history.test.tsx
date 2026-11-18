import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
let jarvisValue: any = null;
mock.module("@/app/todo/todo-jarvis", () => ({ useJarvis: () => jarvisValue }));
mock.module("next/dynamic", () => ({ default: () => (p: any) => <div data-aura-state={p.state} /> }));
afterAll(() => mock.restore());

const item = (id: string, over = {}) => ({ id, channel: "app", capturedAt: "2026-01-01T15:00:00Z", summary: `Sum ${id}`, preview: "p", turnCount: 2, hasAudio: false, ...over });

async function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response> | Response, initialId: string | null = null) {
  const window = new Window({ url: "http://localhost/jarvis" });
  for (const n of ["window", "document", "navigator", "HTMLElement", "Event", "Node", "localStorage", "fetch", "Request", "Response", "Headers"] as const) {
    if (n === "fetch") continue;
    Object.defineProperty(globalThis, n, { configurable: true, writable: true, value: n === "Request" || n === "Response" || n === "Headers" ? (globalThis as any)[n] : (window as any)[n] });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
    return fetcher(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`, init);
  }) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JarvisHistory } = await import("./jarvis-history");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChakraTestWrapper><JarvisHistory initialId={initialId} /></ChakraTestWrapper>));
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  await flush();
  const btn = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLElement | undefined;
  return { act, container, calls, flush, btn, root };
}

test("list renders, load older follows nextCursor, select fetches detail once", async () => {
  jarvisValue = null;
  const t = await setup((url) => {
    if (url.startsWith("GET /api/v1/jarvis/conversations?")) {
      return Response.json(url.includes("cursor=c1") ? { conversations: [item("b")], nextCursor: null } : { conversations: [item("a", { channel: "phone" })], nextCursor: "c1" });
    }
    return Response.json({ id: "a", channel: "phone", capturedAt: "2026-01-01T15:00:00Z", summary: "Sum a", hasAudio: false, turns: [{ role: "user", text: "hello there" }, { role: "assistant", text: "hi" }] });
  });
  expect(document.body.textContent).toContain("Sum a");
  expect(document.body.textContent).toContain("Phone");
  await t.act(async () => t.btn("Load older")!.click());
  await t.flush();
  expect(document.body.textContent).toContain("Sum b");
  expect(t.btn("Load older")).toBeUndefined();
  expect(t.calls.some((c) => c.includes("cursor=c1"))).toBe(true);
  await t.act(async () => t.btn("Sum a")!.click());
  await t.flush();
  await t.act(async () => t.btn("Sum b")!.click());
  await t.act(async () => t.btn("Sum a")!.click());
  await t.flush();
  expect(document.body.textContent).toContain("hello there");
  expect(t.calls.filter((c) => c === "GET /api/v1/jarvis/conversations/a").length).toBe(1);
  expect(t.calls.filter((c) => c.startsWith("GET /api/v1/jarvis/conversations?")).length).toBe(2);
});

test("live section shows transcript when connected", async () => {
  jarvisValue = { state: "listening", volume: 0, connected: true, busy: false, notice: null, begin() {}, end() {}, openDebug() {},
    transcript: [{ id: "1", role: "user", text: "turn on lights" }, { id: "2", role: "agent", text: "done" }] };
  const t = await setup(() => Response.json({ conversations: [], nextCursor: null }));
  expect(document.body.textContent).toContain("Current conversation");
  expect(document.body.textContent).toContain("turn on lights");
  expect(document.body.textContent).toContain("done");
  expect(t.btn("Stop")).toBeDefined();
});

test("delete is optimistic and rolls back on deferred failure", async () => {
  jarvisValue = null;
  let release!: (r: Response) => void;
  const t = await setup((url) => {
    if (url.startsWith("DELETE")) return new Promise<Response>((r) => { release = r; });
    if (url.startsWith("GET /api/v1/jarvis/conversations?")) return Response.json({ conversations: [item("a")], nextCursor: null });
    return Response.json({ id: "a", channel: "app", capturedAt: "2026-01-01T15:00:00Z", summary: "Sum a", hasAudio: false, turns: [] });
  }, "a");
  await t.act(async () => t.btn("Delete")!.click());
  const confirm = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Delete").pop()!;
  await t.act(async () => confirm.click());
  await t.flush();
  expect(t.calls).toContain("DELETE /api/v1/todo-captures/a");
  expect(document.querySelector('[aria-current]')).toBeNull();
  expect(document.body.textContent).not.toContain("Sum a");
  await t.act(async () => release(Response.json({ message: "nope" }, { status: 500 })));
  await t.flush();
  expect(document.body.textContent).toContain("Sum a");
});
