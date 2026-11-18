import { expect, mock, test, afterEach } from "bun:test";
import { act, type ReactNode } from "react";
import { BudgetTransactionProvider } from "./transaction-store";
import type { ModuleOverview } from "./overview-client";
import { createTestDom } from "@/components/shared/test-dom";
let path = "/budgeting";
mock.module("next/navigation", () => ({ usePathname: () => path }));
const dom = createTestDom();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; path = "/budgeting"; });
const withTransactions = (children: ReactNode) => <BudgetTransactionProvider>{children}</BudgetTransactionProvider>;
test("one initial request, one per period; deferred old responses cannot replace latest period", async () => {
  const calls:{request:Request;finish:(r:Response)=>void}[]=[];
  globalThis.fetch = ((request:Request) => new Promise<Response>(finish=>calls.push({request,finish}))) as typeof fetch;
  const { BudgetingStubStore, useBudgetStore } = await import("./stub-store");
  let store!:ReturnType<typeof useBudgetStore>;
  function Probe(){ store=useBudgetStore();return <p>{store.loading?"Loading":store.error||store.s.overview?.statements[0]?.start}</p>; }
  const response = (start:string, context=false) => Response.json({today:"2026-11-13",statements:[{start}],...(context?{context:{cash:100,foodLimit:100,otherLimit:100,balance:[],upcoming:[]}}:{})});
  await dom.render(withTransactions(<BudgetingStubStore><Probe/></BudgetingStubStore>));
  expect(calls).toHaveLength(1); expect(dom.container.querySelector("p")?.textContent).toBe("Loading");
  await act(async()=>calls[0].finish(response("2026-11-01",true)));
  expect(dom.container.querySelector("p")?.textContent).toBe("2026-11-01");
  await act(async()=>store.setPeriod("month",-1));
  expect(calls).toHaveLength(2);expect(calls[1].request.url).toContain("context=no");
  await act(async()=>store.setPeriod("week",-2));
  expect(calls).toHaveLength(3);expect(calls[1].request.signal.aborted).toBe(true);
  await act(async()=>calls[2].finish(response("2026-10-26")));
  await act(async()=>calls[1].finish(response("2026-10-01")));
  expect(dom.container.querySelector("p")?.textContent).toBe("2026-10-26");expect(store.s.cash).toBe(100);
  await act(async()=>store.setPeriod("month",-3));
  await act(async()=>calls[3].finish(Response.json({message:"Unavailable"},{status:503})));
  expect(dom.container.querySelector("p")?.textContent).toBe("Unavailable");
  await act(async()=>store.retry());expect(calls).toHaveLength(5);
  await act(async()=>calls[4].finish(response("2026-08-01")));
  expect(dom.container.querySelector("p")?.textContent).toBe("2026-08-01");
  console.log("Overview browser: initial 1 request; each period 1; retry 1; cash range 0 (local series slicing).");
});

test("pending and failed periods never present zero statements, and cash range remains selected", async () => {
  const calls:{request:Request;finish:(r:Response)=>void}[]=[];
  globalThis.fetch = ((request:Request) => new Promise<Response>(finish=>calls.push({request,finish}))) as typeof fetch;
  const { BudgetingStubStore, TODAY, addDays } = await import("./stub-store");
  const { period } = await import("./ledger");
  const { BudgetOverview } = await import("./overview");
  const current=period("month",0), previous=period("month",-1);
  const partialEnd=addDays(previous.start,Math.round((Date.parse(TODAY)-Date.parse(current.start))/86400000));
  const partial={...previous,end:partialEnd < previous.end ? partialEnd : previous.end};
  const statement=(p:{start:string;end:string})=>({...p,income:[],bills:[],savings:[],spending:[],cats:[],totals:{income:12345,bills:0,savings:0,spending:0},net:12345,allowance:10000,daysLeft:4});
  await dom.render(withTransactions(<BudgetingStubStore><BudgetOverview/></BudgetingStubStore>));
  // 100 forecast days, so the 6M range has data beyond 3M and stays enabled.
  const balance=[{date:TODAY,cents:40000,past:true},...Array.from({length:100},(_,i)=>({date:addDays(TODAY,i+1),cents:39000,past:false}))];
  await act(async()=>calls[0].finish(Response.json({today:TODAY,statements:[statement(current),statement(previous),statement(partial)],context:{cash:40000,foodLimit:1000,otherLimit:1000,balance,upcoming:[]}})));
  expect(dom.container.textContent).toContain("Available to spend");
  const six=dom.container.querySelector('input[value="6"]') as HTMLInputElement;
  await dom.click(six);
  expect(six.checked).toBe(true);
  // Previous period is cached for comparison; go back twice to an unloaded one.
  await dom.click(dom.container.querySelector('[aria-label="Previous month"]')!);
  await dom.click(dom.container.querySelector('[aria-label="Previous month"]')!);
  expect(dom.container.textContent).toContain("Loading statement…");
  expect(dom.container.textContent).not.toContain("Left over");
  expect((dom.container.querySelector('input[value="6"]') as HTMLInputElement).checked).toBe(true);
  await act(async()=>calls.at(-1)!.finish(Response.json({message:"Service unavailable"},{status:503})));
  expect(dom.container.textContent).toContain("Statement unavailable.");
  expect(dom.container.textContent).not.toContain("Left over");
});

test("API dates re-anchor period helpers and accompany cached context on the next request", async () => {
  const calls:{request:Request;finish:(r:Response)=>void}[]=[];
  globalThis.fetch = ((request:Request) => new Promise<Response>(finish=>calls.push({request,finish}))) as typeof fetch;
  const storeModule=await import("./stub-store");
  const {period}=await import("./ledger");
  let current!:ReturnType<typeof storeModule.useBudgetStore>;
  function Probe(){current=storeModule.useBudgetStore();return <p>{period("month",0).start}</p>;}
  await dom.render(withTransactions(<storeModule.BudgetingStubStore><Probe/></storeModule.BudgetingStubStore>));
  await act(async()=>calls[0].finish(Response.json({today:"2026-12-01",statements:[],context:{cash:0,foodLimit:0,otherLimit:0,balance:[],upcoming:[]}})));
  expect(dom.container.querySelector("p")?.textContent).toBe("2026-12-01");
  expect(storeModule.WEEK_START).toBe("2026-11-30");
  await act(async()=>current.setPeriod("week",-1));
  expect(calls[1].request.url).toContain("contextDate=2026-12-01");
  await act(async()=>calls[1].finish(Response.json({today:"2026-12-02",statements:[],context:{cash:100,foodLimit:0,otherLimit:0,balance:[],upcoming:[]}})));
  expect(storeModule.TODAY).toBe("2026-12-02");expect(current.s.cash).toBe(100);
});

test("Add expense and Undo project Overview while acknowledgements are deferred and share the Log queue", async () => {
  const { BudgetingStubStore, addDays, useBudgetStore } = await import("./stub-store");
  const { budgetToday } = await import("./transaction-store");
  const { BudgetOverview } = await import("./overview");
  const { BudgetLog } = await import("./log");
  const { Toaster } = await import("@/components/chakra/toaster");
  const today = budgetToday();
  const monthStart = today.slice(0, 7) + "-01";
  const previousEnd = addDays(monthStart, -1);
  const nextStart = addDays(monthStart, 32).slice(0, 7) + "-01";
  const current = { start: monthStart, end: addDays(nextStart, -1) };
  const previous = { start: previousEnd.slice(0, 7) + "-01", end: previousEnd };
  const weekday = new Date(today + "T00:00:00Z").getUTCDay();
  const weekStart = addDays(today, -((weekday + 6) % 7));
  const partialEnd = addDays(previous.start, (Date.parse(today) - Date.parse(current.start)) / 86400000);
  const partial = { ...previous, end: partialEnd < previous.end ? partialEnd : previous.end };
  const statement = (range: { start: string; end: string }) => ({
    start: range.start, end: range.end, income: [], bills: [], savings: [], spending: [], cats: [],
    totals: { income: 12345, bills: 0, savings: 0, spending: 0 }, net: 12345, allowance: 10000, daysLeft: 4,
  });
  const context = { cash: 40000, checkpointDate: addDays(today, -1), foodLimit: 1000, otherLimit: 1000,
    balance: [{ date: today, cents: 40000, past: true }, { date: addDays(today, 1), cents: 39000, past: false }], upcoming: [] };
  const base = { today, statements: [statement(current), statement(previous), statement(partial)], context, applied: [] as string[] };
  const reads: string[] = [];
  const writes: { id: string; type: string; expense: { id: string; merchant: string; cents: number; date: string; allowance: "food"; category: string }; finish: (r: Response) => void }[] = [];
  let response: ModuleOverview = base;
  globalThis.fetch = ((request: Request | string, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request.url, window.location.origin);
    if (init?.method === "PUT") {
      const command = JSON.parse(String(init.body));
      return new Promise<Response>(finish => writes.push({ id: url.pathname.split("/").at(-1)!, ...command, finish }));
    }
    reads.push(url.pathname);
    if (url.pathname.endsWith("/overview")) {
      expect(url.searchParams.get("session")).toBeTruthy();
      return Promise.resolve(Response.json(response));
    }
    if (url.pathname.endsWith("/log")) {
      const added = writes[0];
      return Promise.resolve(Response.json({
        today, weekStart, nextLimitWeek: addDays(weekStart, 7),
        week: [{ date: today, food: added.expense.cents, other: 0 }], history: [],
        unreviewed: [{ ...added.expense, foodCents: added.expense.cents, receipt: false, reviewed: false, receiptId: null, billKey: null, subscriptionId: null }],
        skipped: [], loggedDays: [], foodLimit: 1000, otherLimit: 1000, nextFoodLimit: 1000, nextOtherLimit: 1000, checkedInToday: false,
        nextLimitOverrides: { food: null, other: null }, applied: [added.id],
      }));
    }
    throw Error("Unexpected request " + url.pathname);
  }) as typeof fetch;
  let store!: ReturnType<typeof useBudgetStore>;
  function Probe() {
    store = useBudgetStore();
    return <><Toaster />{path === "/budgeting/log" ? <BudgetLog /> : <BudgetOverview />}</>;
  }
  const render = () => dom.render(withTransactions(<BudgetingStubStore><Probe /></BudgetingStubStore>));
  const button = (label: string) => Array.from(document.body.querySelectorAll("button")).find(el => el.textContent?.trim() === label)!;
  await render();
  expect(reads).toEqual(["/api/v1/budgeting/module/overview"]);
  expect(dom.container.textContent).toContain("$400.00");
  await dom.click(button("Add expense"));
  await dom.type(document.querySelector('[aria-label="Amount"]')!, "12.50");
  await dom.type(document.querySelector('[aria-label="Merchant"]')!, "Market");
  await dom.click(button("Add"));
  expect(writes).toHaveLength(1);
  expect(store.s.overview?.statements[0]).toMatchObject({ totals: { spending: 1250 }, cats: [{ name: "Groceries", cents: 1250, count: 1 }] });
  expect(dom.container.textContent).toContain("$387.50");

  // A server snapshot can contain a write while the command response is still held.
  const expense = { ...writes[0].expense, foodCents: 1250, receipt: false, reviewed: false, receiptId: null, billKey: null, subscriptionId: null };
  response = { ...base, applied: [writes[0].id], context: { ...context, cash: 38750, balance: context.balance.map(point => ({ ...point, cents: point.cents - 1250 })) },
    statements: [{ ...base.statements[0], spending: [expense], cats: [{ name: "Groceries", allowance: "food", cents: 1250, count: 1 }],
      totals: { ...base.statements[0].totals, spending: 1250 }, net: 11095 }, ...base.statements.slice(1)] };
  await act(async () => store.retry());
  expect(store.s.overview?.statements[0]?.totals.spending).toBe(1250);
  expect(store.s.cash).toBe(38750);
  await dom.click(button("Undo"));
  expect(store.s.overview?.statements[0]?.totals.spending).toBe(0);
  expect(dom.container.textContent).toContain("$400.00");
  expect(writes).toHaveLength(1);
  await act(async () => writes[0].finish(Response.json({ expense })));
  expect(store.s.cash).toBe(40000);
  expect(writes.map(write => write.type)).toEqual(["add", "remove"]);

  path = "/budgeting/log";
  await render();
  expect(dom.container.textContent).toContain("Confirm no new transactions");
  expect(reads).toEqual(["/api/v1/budgeting/module/overview", "/api/v1/budgeting/module/overview", "/api/v1/budgeting/log"]);
  await act(async () => writes[1].finish(Response.json({ expense: null })));
  expect(dom.container.textContent).toContain("Confirm no new transactions");
  expect(reads).toHaveLength(3);

  await dom.type(document.querySelector('[aria-label="Amount"]')!, "5.00");
  await dom.type(document.querySelector('[aria-label="Merchant"]')!, "Lunch shop");
  await dom.click(button("Add"));
  expect(dom.container.textContent).toContain("Lunch shop");
  expect(store.s.log?.week[0]?.food).toBe(500);
  expect(dom.container.textContent?.includes("$15.00")).toBe(true);
  await dom.click(button("Confirm all and check in"));
  expect(dom.container.textContent).toContain("Confirm no new transactions");
  expect(writes.map(write => write.type)).toEqual(["add", "remove", "add"]);
  const logExpense = { ...expense, ...writes[2].expense, foodCents: 500 };
  await act(async () => writes[2].finish(Response.json({ expense: logExpense })));
  expect(writes.map(write => write.type)).toEqual(["add", "remove", "add", "reviewAll"]);
  expect(dom.container.textContent).toContain("Confirm no new transactions");
  await act(async () => writes[3].finish(Response.json({})));
  expect(reads).toHaveLength(3);
});

test("next-week limit, Undo and Redo update Overview forecast while saving", async () => {
  const { BudgetingStubStore, addDays, useBudgetStore } = await import("./stub-store");
  const { budgetToday } = await import("./transaction-store");
  const { BudgetOverview } = await import("./overview");
  const { BudgetLog } = await import("./log");
  const { Toaster } = await import("@/components/chakra/toaster");
  const today = budgetToday();
  const weekday = new Date(today + "T00:00:00Z").getUTCDay();
  const weekStart = addDays(today, -((weekday + 6) % 7));
  const nextWeek = addDays(weekStart, 7);
  const followingWeek = addDays(nextWeek, 7);
  const dates = Array.from({ length: 16 - ((weekday + 6) % 7) }, (_, index) => addDays(today, index));
  const originalBalance = dates.map(date => ({ date, past: date === today, cents: 40000 }));
  const originalLimits = [
    { week: nextWeek, allowance: "food" as const, cents: 1400 },
    { week: followingWeek, allowance: "food" as const, cents: 700 },
  ];
  const context = { cash: 40000, checkpointDate: addDays(today, -1), foodLimit: 1000, otherLimit: 1000, balance: originalBalance, upcoming: [],
    futureLimits: originalLimits };
  const reads: string[] = [];
  const writes: { id: string; changes: { type: string; before: number | null; after: number | null }; finish: (r: Response) => void }[] = [];
  let applied: string[] = [];
  let recordedContext = context;
  globalThis.fetch = ((request: Request | string, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request.url, window.location.origin);
    if (init?.method === "PUT") {
      const changes = JSON.parse(String(init.body));
      return new Promise<Response>(finish => writes.push({ id: url.pathname.split("/").at(-1)!, changes, finish }));
    }
    reads.push(url.pathname);
    if (url.pathname.endsWith("/overview")) return Promise.resolve(Response.json({ today, statements: [], context: recordedContext, applied }));
    if (url.pathname.endsWith("/log")) return Promise.resolve(Response.json({
      today, weekStart, nextLimitWeek: nextWeek, week: [], history: [], unreviewed: [], skipped: [], loggedDays: [],
      foodLimit: 1000, otherLimit: 1000, nextFoodLimit: 1400, nextOtherLimit: 1000, checkedInToday: false,
      nextLimitOverrides: { food: 1400, other: null }, applied: [],
    }));
    throw Error("Unexpected request " + url.pathname);
  }) as typeof fetch;

  let store!: ReturnType<typeof useBudgetStore>;
  function Probe() {
    store = useBudgetStore();
    return <><Toaster />{path === "/budgeting/log" ? <BudgetLog /> : <BudgetOverview />}</>;
  }
  const render = () => dom.render(withTransactions(<BudgetingStubStore><Probe /></BudgetingStubStore>));
  const button = (text: string, startsWith = false) => Array.from(document.body.querySelectorAll("button"))
    .find(node => startsWith ? node.textContent?.trim().startsWith(text) : node.textContent?.trim() === text)!;
  const balanceOn = (date: string) => store.s.overview?.context?.balance.find(point => point.date === date)?.cents;
  path = "/budgeting/log";
  await render();
  await dom.click(button("Next week", true));
  await dom.click(button("Apply"));
  expect(writes[0].changes).toMatchObject({ type: "limit", before: 1400, after: 0 });
  expect(store.s.log?.nextFoodLimit).toBe(0);

  path = "/budgeting";
  await render();
  expect(reads).toEqual(["/api/v1/budgeting/log", "/api/v1/budgeting/module/overview"]);
  expect(balanceOn(addDays(nextWeek, -1))).toBe(40000);
  expect(balanceOn(nextWeek)).toBe(40200);
  expect(balanceOn(followingWeek)).toBe(41400);
  expect(store.s.cash).toBe(40000);

  recordedContext = { ...context, futureLimits: [{ ...originalLimits[0], cents: 0 }, originalLimits[1]],
    balance: originalBalance.map(point => ({ ...point, cents: point.cents + Math.max(0, Math.min(7, (Date.parse(point.date) - Date.parse(nextWeek)) / 86400000 + 1)) * 200 })) };
  applied = [writes[0].id];
  await act(async () => store.retry());
  expect(balanceOn(followingWeek)).toBe(41400);
  await dom.click(button("Undo"));
  expect(balanceOn(nextWeek)).toBe(40000);
  await dom.click(button("Redo"));
  expect(balanceOn(nextWeek)).toBe(40200);
  expect(writes).toHaveLength(1);
  await act(async () => writes[0].finish(Response.json({})));
  expect(balanceOn(nextWeek)).toBe(40200);
  expect(writes[1].changes).toMatchObject({ before: 0, after: 1400 });
  await act(async () => writes[1].finish(Response.json({})));
  expect(writes[2].changes).toMatchObject({ before: 1400, after: 0 });
  await act(async () => writes[2].finish(Response.json({})));
  expect(balanceOn(followingWeek)).toBe(41400);
  expect(reads).toHaveLength(3);
});

test("cash chart: small balances get plain-dollar axis labels and ranges grey out where data runs short", async () => {
  const { axisMoney, rangeItems } = await import("./overview");
  // A ~$118 balance used to render every tick as "$0.1k".
  expect([0, 30, 60, 90, 120].map(axisMoney(118))).toEqual(["$0", "$30", "$60", "$90", "$120"]);
  expect([2500, 5000].map(axisMoney(9000))).toEqual(["$2.5k", "$5.0k"]);
  expect([20000].map(axisMoney(25000))).toEqual(["$20k"]);
  const points = (past: number, ahead: number) => [...Array(past).fill({ past: true }), ...Array(ahead).fill({ past: false })];
  const disabled = (all: { past: boolean }[]) => rangeItems(all).filter((x) => x.disabled).map((x) => x.value);
  expect(disabled(points(7, 0))).toEqual(["3", "6"]);   // a week of history, no forecast: only 1M is meaningful
  expect(disabled(points(7, 180))).toEqual([]);         // the forecast reaches 6 months, so every range differs
  expect(disabled(points(7, 60))).toEqual(["6"]);       // reaches past 1M but not past 3M
});

test("the weekly limits modal writes a week-scoped limit command with the saved override as before", async () => {
  const { transactionIntent } = await import("./transaction-store");
  const intent = transactionIntent({ type: "weekLimit", week: "2026-11-09", allowance: "food", before: null, cents: 12000 }, "2026-11-14");
  expect(intent).toEqual({ command: { type: "limit", allowance: "food", week: "2026-11-09", before: null, after: 12000 }, changes: [] });
  const { reverseIntent } = await import("./transaction-queue");
  expect(reverseIntent(intent).command).toEqual({ type: "limit", allowance: "food", week: "2026-11-09", before: 12000, after: null });
});
