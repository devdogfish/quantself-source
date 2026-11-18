import { afterEach, expect, mock, test } from "bun:test";
import { act, StrictMode } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { createHabitStore, habitToday, type Command, type Occurrence } from "../habit-store";
const dom = createTestDom(); let pathname = "/habits/ask";
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }), usePathname: () => pathname }));
const original = globalThis.fetch; let transport = original;
globalThis.fetch = ((...args) => transport(...args)) as typeof fetch;
const { HabitsDataProvider } = await import("./habits-data"); const { HabitsScreen } = await import("./habits-screen");
const { readHabitAsks } = await import("./habits-live-data");
afterEach(() => { transport = original; pathname = "/habits/ask"; });
const date = habitToday();
const occurrence: Occurrence = { habitId: "walk", date, status: "open", note: "", revision: 0, missed: false, definitionSha: "1" };
const model = { feeling: "Tired", lead: "Keep it small.", step: "Step outside for one minute.", support: "The minimum counts." };
const record = (id: string, text = "I'm wiped") => ({ id, text, habitId: "walk", at: new Date().toISOString(), date, feeling: "Tired", outcome: "open", outcomeRevision: 0, answer: model });
function server(count = 1, asks: any[] = []) {
  const requests: string[] = [], posted: Request[] = []; let send: (req: Request) => Promise<Response> = async r => Response.json(record(r.headers.get("idempotency-key")!, (await r.json()).text));
  const projection = { stacks: [{ id: "am", name: "Morning", days: "daily" }], habits: Array.from({ length: count }, (_, i) => ({ id: i ? `h${i}` : "walk", name: i ? `Habit ${i}` : "Walk", stack: "am", kind: i === 1 ? "break" : "build", tracked: i !== 1, status: "building", startDate: "2020-01-01", minimum: "One minute", full: "20 minutes", order: i })), gate: { window: 14, required: 10 }, diagnostics: [] };
  transport = (async (input: Request) => {
    const req = input, url = new URL(req.url); requests.push(`${req.method} ${url.pathname}`);
    if (req.method === "POST") { posted.push(req.clone()); return send(req); }
    if (url.pathname.endsWith("/asks")) return Response.json({ rows: asks.slice(url.searchParams.has("cursor") ? 100 : 0, url.searchParams.has("cursor") ? 200 : 100), next: !url.searchParams.has("cursor") && asks.length > 100 ? "page2" : null });
    if (url.pathname.endsWith("/definitions")) return Response.json({ projection, revision: 1 });
    if (url.pathname.endsWith("/day")) return Response.json({ date, today: date, projection, sha: "1", stale: false, error: null, occurrences: [occurrence] });
    if (url.pathname.endsWith("/overview")) return Response.json({ asOf: date, range: { from: date, to: date }, habits: [], catalogFacts: [], totals: {}, upcoming: [], insights: [], reviewDue: {} });
    throw Error(`Unexpected ${url}`);
  }) as typeof fetch;
  return { requests, posted, respond: (fn: typeof send) => { send = fn; } };
}
const button = (name: string) => [...dom.container.querySelectorAll("button")].find(b => b.textContent === name)!;
const text = () => dom.container.querySelector("textarea")!;
const typeDraft = (value: string) => act(async () => { const el = text(); el.focus(); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
const enter = () => act(async () => { text().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

test("Enter submits once; deferred model preserves later typing and selected context; Log minimum and Undo/Redo remain optimistic", async () => {
  const api = server(2); let resolve!: (r: Response) => void;
  api.respond(() => new Promise(r => { resolve = r; }));
  const commands: Command[] = [], saves: ((r: Occurrence) => void)[] = [];
  const store = createHabitStore(c => { commands.push(c); return new Promise(r => saves.push(r)); });
  const start = performance.now();
  await dom.render(<StrictMode><HabitsDataProvider fixture={false} store={store}><HabitsScreen view="ask" /></HabitsDataProvider></StrictMode>);
  const coldMs = performance.now() - start; expect(api.requests).toHaveLength(4);
  expect(dom.container.textContent).toContain("Jarvis uses this habit’s system and recent history.");
  await typeDraft("I'm wiped"); await enter(); await enter();
  expect(api.posted).toHaveLength(1); expect(dom.container.textContent).toContain("Asking Jarvis");
  await dom.click(dom.container.querySelector('button[aria-label="Habit"]')!);
  await dom.click([...document.querySelectorAll('[role="option"]')].find(o => o.textContent === "Habit 1")!);
  await typeDraft("A later draft");
  const id = api.posted[0]!.headers.get("idempotency-key")!;
  await act(async () => resolve(Response.json(record(id))));
  expect(dom.container.querySelector('button[aria-label="Habit"]')?.textContent).toContain("Habit 1");
  expect(dom.container.textContent).toContain("Answer · Walk");
  expect(text().value).toBe("A later draft"); expect(document.activeElement).toBe(text());
  expect(dom.container.textContent).toContain(model.step); expect(dom.container.textContent).toContain("Read as: tired");
  const t = performance.now(); await dom.click(button("Log minimum")); const interactionMs = performance.now() - t;
  expect(dom.container.textContent).toContain("did minimum"); expect(commands).toHaveLength(1);
  const key = (shiftKey = false) => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey, bubbles: true })));
  await key(); expect(dom.container.textContent).not.toContain("did minimum");
  await key(true); expect(dom.container.textContent).toContain("did minimum");
  await act(async () => saves.shift()!({ ...occurrence, status: "minimum", revision: 1 }));
  expect(dom.container.textContent).toContain("did minimum");
  for (let i = 2; i <= 3; i++) await act(async () => saves.shift()!({ ...occurrence, status: i === 2 ? "open" : "minimum", revision: i }));
  expect(api.requests).toHaveLength(5); // Four initial reads, one Ask; no analytics reread.
  pathname = "/habits"; await dom.render(<StrictMode><HabitsDataProvider fixture={false} store={store}><HabitsScreen view="today" /></HabitsDataProvider></StrictMode>);
  const beforeWarm = api.requests.length; pathname = "/habits/ask";
  await dom.render(<StrictMode><HabitsDataProvider fixture={false} store={store}><HabitsScreen view="ask" /></HabitsDataProvider></StrictMode>);
  expect(api.requests.length - beforeWarm).toBe(1);
  console.info(JSON.stringify({ warmAskPageRequests: 1, coldAskPageRequests: 4, askPostRequests: 1, analyticsRefreshAfterAsk: 0, analyticsRefreshAfterCheckIn: 0, checkInCommandsIncludingUndoRedo: commands.length, coldMs, interactionMs }));
});

test("uncertain model delivery retains input and retries identical idempotency key; errors are visible", async () => {
  const api = server(); let fail = true;
  api.respond(async r => { if (fail) throw Error("Connection lost"); return Response.json(record(r.headers.get("idempotency-key")!)); });
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="ask" /></HabitsDataProvider>);
  await typeDraft("I'm wiped"); await enter();
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost"); expect(text().value).toBe("I'm wiped");
  fail = false; await enter(); expect(api.posted).toHaveLength(2);
  expect(api.posted[0]!.headers.get("idempotency-key")).toBe(api.posted[1]!.headers.get("idempotency-key"));
  expect(dom.container.textContent).toContain(model.step);
});

test("analytics pagination is complete: 110 asks use two reads, regardless of Catalog size", async () => {
  const rows = Array.from({ length: 110 }, () => record(crypto.randomUUID())); const api = server(55, rows);
  const values = await readHabitAsks(); expect(values).toHaveLength(110); expect(api.requests).toHaveLength(2);
  const before = api.requests.length;
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="ask" /></HabitsDataProvider>);
  expect(api.requests.length - before).toBe(5); // 3 catalog/day/history + 2 ask pages.
  expect(dom.container.textContent).toContain("110");
  pathname = "/habits"; await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="today" /></HabitsDataProvider>);
  const warm = api.requests.length, t = performance.now(); pathname = "/habits/ask";
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="ask" /></HabitsDataProvider>);
  expect(api.requests.length - warm).toBe(2);
  console.info(JSON.stringify({ habits: 55, asks: 110, coldRequests: 5, warmRequests: 2, warmMs: performance.now() - t }));
});

test("a delayed analytics read cannot erase a returned Ask; analytics retry does not reread Catalog", async () => {
  const api = server(); api.respond(async r => Response.json({ ...record(r.headers.get("idempotency-key")!), outcome: "did full", outcomeRevision: 2 }));
  const base = transport; let finish!: (response: Response) => void;
  transport = (async (input: Request) => input.url.endsWith("/asks") ? new Promise(r => { finish = r; }) : base(input)) as typeof fetch;
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="ask" /></HabitsDataProvider>);
  expect(dom.container.textContent).toContain("Loading asks");
  await typeDraft("I'm wiped"); await enter(); expect(dom.container.textContent).toContain(model.step);
  await act(async () => finish(Response.json({ rows: [{ ...record(api.posted[0]!.headers.get("idempotency-key")!), outcome: "open", outcomeRevision: 1 }], next: null })));
  expect(dom.container.textContent).toContain("did full");
  expect(dom.container.textContent).toContain("Tired · Walk");
  pathname = "/habits"; await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="today" /></HabitsDataProvider>);
  pathname = "/habits/ask"; await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="ask" /></HabitsDataProvider>);
  await act(async () => finish(Response.json({ message: "Analytics unavailable" }, { status: 503 })));
  const before = api.requests.length;
  await dom.click(dom.container.querySelector('[role="alert"]')!);
  await act(async () => finish(Response.json({ rows: [], next: null })));
  expect(api.requests).toHaveLength(before); // This test holds analytics requests separately; no catalog requests.
  expect(dom.container.textContent).toContain("Tired · Walk");
});


test("an analytics read completed after leaving Ask is revalidated on return", async () => {
  server(); const base = transport; let finish!: (response: Response) => void, reads = 0;
  transport = (async (input: Request) => { if (!input.url.endsWith("/asks")) return base(input); reads++; return new Promise(r => { finish = r; }); }) as typeof fetch;
  const render = (view: "ask" | "today") => dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view={view} /></HabitsDataProvider>);
  await render("ask"); expect(reads).toBe(1);
  pathname = "/habits"; await render("today");
  await act(async () => finish(Response.json({ rows: [], next: null })));
  pathname = "/habits/ask"; await render("ask"); expect(reads).toBe(2);
  await act(async () => finish(Response.json({ rows: [], next: null })));
  expect(dom.container.textContent).toContain("Jarvis uses this habit’s system and recent history.");
});
