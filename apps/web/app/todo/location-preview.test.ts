import { expect, test } from "bun:test";
import { searchLocations } from "./location-search";
import { resolveLocationPreview } from "./location-preview";
import { cachedLocationPreview, rememberLocationPreview } from "./location-preview-cache";

const signal = () => new AbortController().signal;
const feature = (name: string, coordinates: unknown = [-63.57, 44.64]) => ({ geometry: { type: "Point", coordinates }, properties: { name, city: "Halifax" } });

test("selected suggestion coordinates need zero additional requests", async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json({ features: [feature("Selected preview place")] }); };
  const [suggestion] = await searchLocations("selected preview", signal(), fetcher);
  expect(await resolveLocationPreview(suggestion.label, signal(), fetcher)).toEqual({ lat: 44.64, lon: -63.57, label: suggestion.label, locality: "Halifax" });
  expect(requests).toBe(1);
});

test("cold address makes one bounded request, skips invalid geometry, caches trimmed query", async () => {
  let requests = 0;
  const fetcher = async (url: string) => {
    requests++;
    expect(new URL(url).searchParams.get("limit")).toBe("5");
    return Response.json({ features: [feature("Invalid first", [181, 100]), feature("Resolved preview place")] });
  };
  const preview = await resolveLocationPreview(" Cold preview address ", signal(), fetcher);
  expect(preview).toMatchObject({ lat: 44.64, lon: -63.57, locality: "Halifax" });
  expect(await resolveLocationPreview("Cold preview address", signal(), fetcher)).toEqual(preview);
  expect(requests).toBe(1);
  expect(await resolveLocationPreview("  ", signal(), fetcher)).toBeNull();
  expect(requests).toBe(1);
});

test("no match caches null; errors remain explicit and retryable", async () => {
  let requests = 0;
  const empty = async () => { requests++; return Response.json({ features: [] }); };
  expect(await resolveLocationPreview("No preview match", signal(), empty)).toBeNull();
  expect(await resolveLocationPreview("No preview match", signal(), empty)).toBeNull();
  expect(requests).toBe(1);
  await expect(resolveLocationPreview("Unavailable preview", signal(), async () => new Response(null, { status: 429 }))).rejects.toThrow("Location search unavailable");
  expect(await resolveLocationPreview("Unavailable preview", signal(), empty)).toBeNull();
  expect(requests).toBe(2);
});

test("concurrent callers share one request; aborting one preserves the other", async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  let requestSignal!: AbortSignal;
  const fetcher = async (_url: string, init: RequestInit) => { requests++; requestSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); };
  const controller = new AbortController();
  const first = resolveLocationPreview("Concurrent preview", controller.signal, fetcher);
  const firstAbort = first.catch(error => error);
  const second = resolveLocationPreview("Concurrent preview", signal(), fetcher);
  controller.abort();
  expect(await firstAbort).toMatchObject({ name: "AbortError" });
  expect(requestSignal.aborted).toBe(false);
  finish(Response.json({ features: [feature("Concurrent resolved place")] }));
  expect(await second).toMatchObject({ lat: 44.64 });
  expect(requests).toBe(1);
});

test("last caller abort cancels request, rejects stale response, permits fresh retry", async () => {
  let finish!: (response: Response) => void;
  let requestSignal!: AbortSignal;
  const controller = new AbortController();
  const pending = resolveLocationPreview("Aborted preview", controller.signal, async (_url, init) => { requestSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); });
  const aborted = pending.catch(error => error);
  controller.abort(); expect(await aborted).toMatchObject({ name: "AbortError" });
  expect(requestSignal.aborted).toBe(true);
  finish(Response.json({ features: [feature("Stale aborted place")] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cachedLocationPreview("Aborted preview")).toBeUndefined();
  expect(cachedLocationPreview("Stale aborted place, Halifax")).toBeUndefined();
  expect(await resolveLocationPreview("Aborted preview", signal(), async () => Response.json({ features: [] }))).toBeNull();
  await expect(resolveLocationPreview("Already aborted", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("coordinate cache stays bounded and expires after one day", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let index = 0; index < 101; index++) rememberLocationPreview(`Bounded cache ${index}`, { lat: 10, lon: 20, label: `Place ${index}`, locality: "" });
    expect(cachedLocationPreview("Bounded cache 0")).toBeUndefined();
    expect(cachedLocationPreview("Bounded cache 100")).toMatchObject({ lat: 10 });
    now += 24 * 60 * 60 * 1000;
    expect(cachedLocationPreview("Bounded cache 100")).toBeUndefined();
  } finally { Date.now = originalNow; }
});

test("lookup times out after eight seconds, aborts shared fetch, clears timer, and allows retry", async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let timeout!: () => void;
  let cleared = 0;
  let requestSignal!: AbortSignal;
  let complete!: (response: Response) => void;
  const timerId = { previewTimer: true };
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    expect(delay).toBe(8000); timeout = callback; return timerId;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => { expect(id).toBe(timerId); cleared++; }) as typeof clearTimeout;
  try {
    const fetcher = async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { complete = resolve; });
    };
    const first = resolveLocationPreview("Timed out preview", signal(), fetcher).catch(error => error);
    const second = resolveLocationPreview("Timed out preview", signal(), fetcher).catch(error => error);
    timeout();
    expect((await first).message).toBe("Map preview lookup timed out. Try again.");
    expect((await second).message).toBe("Map preview lookup timed out. Try again.");
    expect(requestSignal.aborted).toBe(true);
    expect(cleared).toBe(1);
    complete(Response.json({ features: [feature("Expired preview result")] }));
    await Promise.resolve(); await Promise.resolve();
    expect(cachedLocationPreview("Timed out preview")).toBeUndefined();
    expect(await resolveLocationPreview("Timed out preview", signal(), async () => Response.json({ features: [] }))).toBeNull();
    expect(cleared).toBe(2);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  }
});
