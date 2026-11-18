import { catalogFacts } from "../../../../api/src/habits-catalog-facts";
import type { HabitProjection } from "../../../../api/src/habits-definition";
import { afterEach, expect, mock, test } from "bun:test";
import { act, StrictMode } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { createHabitStore, habitToday, type Command, type Occurrence } from "../habit-store";
const dom = createTestDom();
const originalFetch = globalThis.fetch;
let transport = originalFetch;
globalThis.fetch = ((...args) => transport(...args)) as typeof fetch;
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }), usePathname: () => "/habits" }));
const { HabitsDataProvider } = await import("./habits-data");
const { HabitsScreen } = await import("./habits-screen");
const { readHabits } = await import("./habits-live-data");
const { saveHabit } = await import("../habits-api");
afterEach(() => { transport = originalFetch; });
const date = habitToday();
const occurrence: Occurrence = { habitId: "walk", date, status: "open", note: "", revision: 0, missed: false, definitionSha: "1" };
function server(count = 1, history?: unknown[]) {
  const requests: string[] = [];
  let stored = { ...occurrence };
  const projection = { stacks: [{ id: "morning", name: "Morning", days: "daily", anchor: "07:30" }], habits: Array.from({ length: count }, (_, i) => ({ id: i ? `habit-${i}` : "walk", name: i ? `Habit ${i}` : "Walk", stack: "morning", kind: "build", tracked: true, status: "building", startDate: history ? undefined : "2020-01-01", minimum: "One step", full: "A walk", order: i })), gate: { window: 14, required: 10 }, diagnostics: [] };
  transport = (async (input: RequestInfo | URL) => {
    const req = input as Request, url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    let data: unknown;
    if (url.pathname.endsWith("/definitions")) data = { projection, revision: 1 };
    else if (url.pathname.endsWith("/history")) {
      const before = Number(url.searchParams.get("before") ?? Infinity);
      data = (history as { revision: number }[]).filter(r => r.revision < before).slice(0, 100);
    }
    else if (url.pathname.endsWith("/overview")) data = { asOf: date, range: { from: date, to: date }, catalogFacts: catalogFacts(projection as HabitProjection, [{ habitId: "walk", date: "2020-01-01", status: "done" }, stored], date), habits: [], totals: {}, upcoming: [], insights: [], reviewDue: {} };
    else if (url.pathname.endsWith("/day")) data = { date, today: date, projection, sha: "1", stale: false, error: null, occurrences: [stored] };
    else throw Error(`Unexpected ${url}`);
    return Response.json(data);
  }) as typeof fetch;
  return { requests, save: (command: Command) => { stored = { ...stored, ...command.after, revision: stored.revision + 1 }; return stored; }, stored: () => stored };
}
const button = (name: string) => [...dom.container.querySelectorAll("button")].find(b => b.textContent === name)!;
const pressed = (name: string) => button(name).getAttribute("aria-pressed");

test("live Today/detail share optimistic state; deferred writes, Undo/Redo, old responses, reload and request budget", async () => {
  const api = server();
  const commands: Command[] = [], resolves: ((row: Occurrence) => void)[] = [];
  const store = createHabitStore(c => { commands.push(c); return new Promise(r => resolves.push(r)); });
  const render = (view: "today" | "habit") => dom.render(<StrictMode><HabitsDataProvider fixture={false} store={store}><HabitsScreen view={view} habitId="walk" /></HabitsDataProvider></StrictMode>);
  const cold = performance.now();
  await render("today");
  const coldMs = performance.now() - cold;
  expect(api.requests).toHaveLength(3);
  expect(dom.container.textContent).not.toContain("Sample data");
  const start = performance.now();
  await dom.click(button("Done"));
  const renderMs = performance.now() - start;
  expect(pressed("Done")).toBe("true");
  await dom.click(button("Minimum"));
  expect(pressed("Minimum")).toBe("true");
  const key = async (shiftKey = false) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey, bubbles: true })); });
  await key(); expect(pressed("Done")).toBe("true");
  await key(true); expect(pressed("Minimum")).toBe("true");
  expect(commands).toHaveLength(1);
  const warm = performance.now();
  await render("habit");
  const warmMs = performance.now() - warm;
  expect(dom.container.querySelector("dd")?.textContent).toBe("2"); // Includes the old vote outside the display history.
  expect(pressed("Minimum")).toBe("true");
  expect(api.requests).toHaveLength(3);
  await act(async () => { resolves.shift()!(api.save(commands[0]!)); });
  expect(pressed("Minimum")).toBe("true");
  expect(commands[1]!.revision).toBe(1);
  for (let i = 1; i < 4; i++) await act(async () => { resolves.shift()!(api.save(commands[i]!)); });
  expect(api.stored().status).toBe("minimum");
  await dom.render(<div />);
  await render("today");
  expect(pressed("Minimum")).toBe("true");
  expect(api.requests).toHaveLength(6);
  console.info(JSON.stringify({ coldRequests: 3, warmNavigationRequests: 0, writeRequests: commands.length, reloadRequests: 3, coldMs, warmMs, interactionMs: renderMs }));
});

test("50 habits still need three bulk reads; untracked and unknown detail routes do not fall back", async () => {
  const api = server(55);
  const value = await readHabits();
  expect(value.catalog.projection.habits).toHaveLength(55);
  expect(api.requests).toHaveLength(3);
  value.catalog.projection.habits[0]!.tracked = false;
  const read = async () => value;
  for (const habitId of ["walk", "unknown"]) {
    await dom.render(<HabitsDataProvider fixture={false} read={read}><HabitsScreen view="habit" habitId={habitId} /></HabitsDataProvider>);
    expect(dom.container.querySelector("h1")?.textContent).toBe("Habit not found");
  }
});

test("409 refreshes the conflicted day once, preserves unrelated pending writes, then permits a revised edit", async () => {
  const api = server();
  const baseFetch = transport;
  let writes = 0;
  const commands: Command[] = [];
  transport = (async (input: RequestInfo | URL) => {
    const req = input as Request;
    if (!req.url.endsWith("/commands")) return baseFetch(input);
    const command = await req.json() as Command; commands.push(command); writes++;
    if (writes === 1) { api.save({ ...command, after: { status: "skipped", note: "external" } }); return Response.json({ message: "Conflict" }, { status: 409 }); }
    return Response.json(api.save(command));
  }) as typeof fetch;
  const store = createHabitStore(saveHabit);
  const snapshot = await readHabits(); store.merge(snapshot.day.occurrences);
  store.edit(occurrence, { status: "done", note: "" });
  // Flush the response and conflict day refresh.
  await new Promise(r => setTimeout(r, 20));
  expect(store.row(occurrence).status).toBe("skipped");
  expect(store.row(occurrence).note).toBe("external");
  expect(api.requests.filter(p => p.endsWith("/day"))).toHaveLength(2);
  store.retry();
  store.edit(occurrence, { status: "minimum", note: "external" });
  await new Promise(r => setTimeout(r, 20));
  expect(commands[1]!.revision).toBe(1);
  expect(store.row(occurrence).status).toBe("minimum");
});


test("missing start dates use complete bulk history pages; 55-row filtering and navigation do not refetch", async () => {
  const history = Array.from({ length: 150 }, (_, i) => ({ revision: 150 - i, at: i === 149 ? "2020-01-02T02:00:00Z" : "2026-01-02T12:00:00Z", reason: "change", actor: "owner", changes: [{ type: "setStatus", habitId: "walk", status: "building" }] }));
  const api = server(55, history);
  const t = performance.now();
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="all" /></HabitsDataProvider>);
  const coldMs = performance.now() - t;
  expect(api.requests).toHaveLength(5);
  expect(dom.container.textContent).toContain("Jan 1"); // Halifax date, earliest revision, second page.
  expect(dom.container.querySelectorAll('[role="row"]')).toHaveLength(13);
  await dom.type(dom.container.querySelector('input[placeholder="Search habits"]')!, "no such habit");
  expect(dom.container.textContent).toContain("No habits match these filters.");
  await dom.type(dom.container.querySelector('input[placeholder="Search habits"]')!, "Walk");
  expect(dom.container.textContent).toContain("1 habits");
  const warm = performance.now();
  await dom.render(<HabitsDataProvider fixture={false}><HabitsScreen view="habit" habitId="walk" /></HabitsDataProvider>);
  expect(api.requests).toHaveLength(5);
  console.info(JSON.stringify({ habits: 55, historyRevisions: 150, coldRequests: api.requests.length, warmNavigationRequests: 0, filterRequests: 0, coldMs, warmMs: performance.now() - warm }));
});
