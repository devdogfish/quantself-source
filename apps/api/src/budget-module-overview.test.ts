import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
import { emptyPlan, localDate } from "./budgeting";
import { buildBalance, buildStatement, statementPeriods } from "./budget-module-overview";
const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const base = { id, date: "2026-11-12", merchant: "Shop", totalCents: 1000, foodCents: 400, billKey: null, bankFlow: null, receiptId: null, originalCurrency: null, originalAmountMinor: null, bankAccount: null, createdAt: new Date("2026-11-12T14:00:00Z") };
test("same-day comparison clamps February and weekly comparison includes the same number of days", () => {
  expect(statementPeriods("2026-03-31", "month", 0)).toEqual([{start:"2026-03-01",end:"2026-03-31"},{start:"2026-02-01",end:"2026-02-28"},{start:"2026-02-01",end:"2026-02-28"}]);
  expect(statementPeriods("2026-11-13", "week", 0)[2]).toEqual({start:"2026-11-02",end:"2026-11-06"});
});
test("statement separates posted bills, deposits, savings, transfers, refunds and split allowances without double-counting", () => {
  const rows = [base, { ...base, id: "bill", billKey: "rent:2026-11", totalCents: 90000, foodCents: 0 },
    { ...base, id: "deposit", bankFlow: "deposit", totalCents: -150000 },
    { ...base, id: "transfer", bankFlow: "transfer", totalCents: 50000 },
    { ...base, id: "saving", bankFlow: "transfer", bankAccount: "rbc-savings", totalCents: -10000 },
    { ...base, id: "refund", totalCents: -200, foodCents: -200, originalCurrency: "USD", originalAmountMinor: -150 }];
  const events = [{id, key:"rent:2026-11",date:"2026-11-01",label:"Rent",cents:100000,kind:"bill"},
    {id, key:"maybe",date:"2026-11-20",label:"Maybe",cents:20000,kind:"uncertainIncome"}];
  const result = buildStatement({ ...emptyPlan, foodCents:7000, otherCents:7000 }, rows, events, "2026-11-13", {start:"2026-11-01",end:"2026-11-30"}, "month");
  expect(result.totals).toEqual({income:150000,bills:90000,savings:10000,spending:800});
  expect(result.cats).toEqual([{name:"Food",allowance:"food",cents:800,count:2}]);
  expect(result.bills).toHaveLength(1); expect(result.spending[1].original).toEqual({currency:"USD",cents:-150});
  expect(result.income.find(x => x.label === "Maybe")).toMatchObject({done:false,note:"Uncertain"});
});
test("daily movements and deposits drive history without projecting past scheduled income", () => {
  const plan = { ...emptyPlan, checkpoint: {date:"2026-11-12",cents:10000,recordedAt:"2026-11-12T12:00:00Z"}, foodCents:700, otherCents:0 };
  const rows = [{ date: "2026-11-12", totalCents: 1000 }, { date: "2026-11-13", totalCents: -3000 }];
  const events = [{id,key:"old",date:"2026-11-13",label:"Unposted salary",cents:20000,kind:"income"}, {id,key:"next",date:"2026-11-14",label:"Salary",cents:2000,kind:"income"}];
  const result = buildBalance(plan, rows, events, "2026-11-13");
  expect(result.slice(0,3)).toEqual([{date:"2026-11-12",cents:9000,past:true},{date:"2026-11-13",cents:12000,past:true},{date:"2026-11-14",cents:13900,past:false}]);
  expect(result.at(-1)?.date).toBe("2027-05-12");
  expect(buildBalance(emptyPlan, rows, events, "2026-11-13")).toEqual([]);
});
function appWith(db: unknown, permissions = ["budgeting:read"]) {
  const app = new OpenAPIHono<{Variables:{accessContext:AccessContext|null}}>();
  app.use("*", async (c,next) => { c.set("accessContext", {owner:{id:"owner"},client:{id:"web",kind:"web"},permissions} as AccessContext); await next(); });
  const scoped = { budgetWeeklyLimit: { findMany: async () => [] }, budgetTransactionCommand: { findMany: async () => [] }, ...db as object };
  Object.assign(scoped, { $transaction: async (fn: (tx: typeof scoped) => unknown, options: unknown) => {
    expect(options).toEqual({ isolationLevel: "RepeatableRead" }); return fn(scoped);
  } });
  registerBudgetingRoutes(app, scoped as unknown as typeof prisma); return app;
}
test("session-aware context uses seven bulk reads; same-day period changes use five", async () => {
  const calls: {table:string;query:any}[] = [];
  const checkpoint = { date: localDate(), cents: 10000, recordedAt: new Date().toISOString() };
  const db = {
    budgetPlan: {findUnique: async (query:any) => { calls.push({table:"plan",query}); return {plan:{...emptyPlan,checkpoint}}; }},
    budgetSubscription: {findMany: async (query:any) => {calls.push({table:"rules",query});return [];}},
    budgetWeeklyLimit: { findMany: async (query:any) => { calls.push({table:"limits",query});return []; } },
    budgetTransactionCommand: { findMany: async (query:any) => { calls.push({table:"commands",query});return [{id}]; } },
    budgetExpense: {
      findMany: async (query:any) => { calls.push({ table: "expenses", query }); return Array.from({ length: 1000 }, (_, i) => ({ ...base, id: String(i), date: localDate() })); },
      groupBy: async (query:any) => { calls.push({ table: "history", query }); return []; },
    },
  };
  const app = appWith(db), timings:number[]=[];
  for (const [query, context] of [
    ["context=yes", true],
    [`context=no&offset=-1&contextDate=${localDate()}`, false],
    ["context=no&contextDate=2025-01-01", true],
  ] as const) {
    calls.length=0; const start=performance.now(); const response=await app.request("/api/v1/budgeting/module/overview?"+query+"&session="+id); timings.push(performance.now()-start);
    expect(response.status).toBe(200); const data=await response.json() as any;
    expect(calls.map(x=>x.table)).toEqual(["plan", "rules", "limits", "commands", "expenses", ...(context ? ["history", "history"] : [])]);
    expect(calls.every(x=>x.query.where.ownerId === "owner")).toBe(true);
    expect(calls[4].query.select).not.toHaveProperty("receipt");
    expect(data.applied).toEqual([id]);
    expect(data.statements).toHaveLength(3);
    expect(!!data.context).toBe(context);
    if (context) {
      expect(calls[5].query.by).toEqual(["date"]);
      expect(calls[5].query._sum).toEqual({ totalCents: true });
      expect(calls[5].query.where.AND).toEqual([
        { OR: [{ bankFlow: null }, { bankFlow: { not: "transfer" } }] },
        { OR: [
          { date: { gt: checkpoint.date, lte: checkpoint.date } },
          { date: checkpoint.date, bankAccount: null, createdAt: { gt: new Date(checkpoint.recordedAt) } },
        ] },
      ]);
      // Earlier history: one read grouped by date and account, excluding entries recorded after the checkpoint.
      expect(calls[6].query.by).toEqual(["date", "bankAccount"]);
      expect(calls[6].query.where.AND[2]).toEqual({ NOT: { date: checkpoint.date, bankAccount: null, createdAt: { gt: new Date(checkpoint.recordedAt) } } });
      expect(data.context.forecast).toBe("scheduled");
    }
  }
  console.log(`Overview API: cold ${timings[0].toFixed(1)}ms; warm period ${timings[1].toFixed(1)}ms; 7 initial bulk DB reads, 5 per same-day period (1000 mocked rows).`);
  expect((await appWith({},[]).request("/api/v1/budgeting/module/overview")).status).toBe(403);
  expect((await app.request("/api/v1/budgeting/module/overview?offset=1")).status).toBe(400);
});

test("past expected income does not duplicate a posted deposit or count a future saved expense", () => {
  const rows = [
    { ...base, bankFlow: "deposit", merchant: "Payroll", totalCents: -5000 },
    { ...base, date: "2026-11-14", totalCents: 10000, billKey: "rent" },
  ];
  const events = [
    { id, key: "pay:old", date: "2026-11-12", label: "Payroll", cents: 5000, kind: "income" },
    { id, key: "pay:new", date: "2026-11-19", label: "Payroll", cents: 5000, kind: "income" },
    { id, key: "rent", date: "2026-11-14", label: "Rent", cents: 9000, kind: "bill" },
  ];
  const result = buildStatement(emptyPlan, rows, events, "2026-11-13", { start: "2026-11-01", end: "2026-11-30" }, "month");
  expect(result.income.map(({ done }) => done)).toEqual([true, false, false]);
  expect(result.totals.income).toBe(10000);
  expect(result.bills).toEqual([{ date: "2026-11-14", label: "Rent", cents: 9000, done: false }]);
  expect(result.spending).toEqual([]);
});

test("a sparse checkpoint seeds six months of history; due and overdue bills hit the first forecast point", () => {
  const plan = { ...emptyPlan, checkpoint: { date: "2024-01-01", cents: 20000 }, foodCents: 0, otherCents: 0 };
  const events = [
    { id, key: "prior", date: "2026-11-01", label: "Utility", cents: 1000, kind: "bill" },
    { id, key: "due", date: "2026-11-13", label: "Rent", cents: 8000, kind: "bill" },
  ];
  const result = buildBalance(plan, [{ date: "2024-02-01", totalCents: 1000 }], events, "2026-11-13");
  expect(result).toHaveLength(361);
  expect(result[0]).toMatchObject({ cents: 19000, past: true });
  expect(result.slice(180, 182)).toEqual([
    { date: "2026-11-13", cents: 19000, past: true },
    { date: "2026-11-14", cents: 10000, past: false },
  ]);
});

test("prices only unsettled foreign occurrences at their date, including stopped and superseded terms", async () => {
  const today = localDate();
  const [current, prior] = statementPeriods(today, "month", 0);
  const paidDate = prior.start;
  const foreignDate = prior.end;
  const active = {
    id, revision: 1, commandId: id, status: "active", stopsOn: null, name: "Formerly USD",
    websiteUrl: null, cancelUrl: null, logoKey: null, estimated: false, evidence: "", sourceKey: null,
  };
  const terms = (effectiveOn: string, currency: "USD" | "CAD") => ({
    effectiveOn, startOn: effectiveOn, amountCents: 1000, currency, frequency: "monthly", interval: 1,
  });
  const stopped = { ...active, id: "499c0000-4b42-4d9d-a309-59e274a574be", name: "Stopped", stopsOn: current.start, terms: [terms(foreignDate, "USD")] };
  const older = { ...active, id: "8e2c55db-b0d4-42ce-a8d6-047e1183419c", name: "Irrelevant", terms: [terms("2020-01-01", "USD"), terms(prior.start, "CAD")] };
  const reads: string[][] = [];
  const db = {
    budgetPlan: { findUnique: async () => null },
    budgetSubscription: { findMany: async () => [{ ...active, terms: [terms(paidDate, "USD"), terms(current.start, "CAD")] }, stopped, older] },
    budgetExpense: { findMany: async () => [{ ...base, date: paidDate, billKey: `${id}:${paidDate}`, totalCents: 1450, merchant: "Posted USD charge" }] },
    budgetFxRate: { findMany: async ({ where }: { where: { key: { in: string[] } } }) => {
      reads.push(where.key.in);
      return [{
        key: `ecb:USD:CAD:${foreignDate}`,
        data: { base: "USD", quote: "CAD", rate: "1.25", requestedDate: foreignDate, rateDate: foreignDate,
          fetchedAt: new Date().toISOString(), source: "frankfurter-v2" },
      }];
    } },
  };
  const response = await appWith(db).request("/api/v1/budgeting/module/overview?context=no");
  expect(response.status).toBe(200);
  expect(reads).toEqual([[`ecb:USD:CAD:${foreignDate}`]]);
  const result = await response.json() as { statements: { bills: { label: string; cents: number; done: boolean }[] }[] };
  expect(result.statements[1].bills).toContainEqual(expect.objectContaining({ label: "Posted USD charge", cents: 1450, done: true }));
  expect(result.statements[1].bills).toContainEqual(expect.objectContaining({ label: "Stopped", cents: 1250, done: false }));
});

test("a bill settled across a month boundary appears only in its posted period", async () => {
  const today = localDate();
  const [settlementPeriod, previous] = statementPeriods(today, "month", -1);
  const key = `${id}:once`;
  let expenseFilter: unknown;
  const db = {
    budgetPlan: { findUnique: async () => ({ plan: { ...emptyPlan, entries: [
      { id, label: "Rent", date: previous.end, cents: 8000, kind: "bill", frequency: "once" },
    ] } }) },
    budgetSubscription: { findMany: async () => [] },
    budgetExpense: { findMany: async ({ where }: { where: unknown }) => {
      expenseFilter = where;
      return [{ ...base, date: settlementPeriod.start, billKey: key, totalCents: 8100, merchant: "Posted rent" }];
    } },
  };
  const response = await appWith(db).request("/api/v1/budgeting/module/overview?context=no&offset=-1");
  expect(response.status).toBe(200);
  expect(expenseFilter).toEqual({
    ownerId: "owner", date: { lte: today },
    OR: [{ date: { gte: previous.start, lte: settlementPeriod.end } }, { billKey: { in: [key] } }],
  });
  const result = await response.json() as { statements: { bills: { label: string; cents: number; done: boolean }[] }[] };
  expect(result.statements[0].bills).toContainEqual(expect.objectContaining({ label: "Posted rent", cents: 8100, done: true }));
  expect(result.statements[1].bills).toEqual([]);
});

test("recorded categories and dated weekly limits agree with Transactions and Log", () => {
  const plan={...emptyPlan,checkpoint:{date:"2026-11-13",cents:10000},foodCents:700,otherCents:700};
  const limits=[{week:"2026-11-16",allowance:"food",cents:1400}];
  const rows=[{...base,category:"Groceries",allowance:"food",reviewed:true}];
  const statement=buildStatement(plan,rows,[],"2026-11-13",{start:"2026-11-09",end:"2026-11-15"},"week",limits);
  expect(statement.cats).toEqual([{name:"Groceries",allowance:"food",cents:1000,count:1}]);
  expect(statement.allowance).toBe(1400);
  expect(statement.spending[0].reviewed).toBe(true);
  expect(buildStatement(plan,[],[],"2026-11-13",{start:"2026-11-16",end:"2026-11-22"},"week",limits).allowance).toBe(2100);
  const series=buildBalance(plan,[],[],"2026-11-13",limits);
  expect(series.find(x=>x.date==="2026-11-15")?.cents).toBe(9600);
  expect(series.find(x=>x.date==="2026-11-16")?.cents).toBe(9300);
});

test("Overview preserves posted payments and exposes resumable schedules for touched paused rules", async () => {
  const today = localDate();
  const [current, previous] = statementPeriods(today, "month", 0);
  const paidDate = previous.start;
  const foreign = "499c0000-4b42-4d9d-a309-59e274a574be";
  const active = "8e2c55db-b0d4-42ce-a8d6-047e1183419c";
  const metadata = { revision: 2, commandId: id, status: "paused", stopsOn: null, name: "Paused",
    websiteUrl: null, cancelUrl: null, logoKey: null, estimated: false, evidence: "", sourceKey: null,
  };
  const calls: string[] = [];
  const requestedRates: string[][] = [];
  const app = appWith({
    budgetPlan: { findUnique: async () => {
      calls.push("plan");
      return { plan: { ...emptyPlan, checkpoint: { date: previous.start, cents: 20_000 }, foodCents: 0, otherCents: 0,
        entries: [{ id, label: "Rent", date: previous.start, kind: "bill", cents: 3000, frequency: "monthly" }] } };
    } },
    budgetSubscription: { findMany: async () => {
      calls.push("rules");
      return [
        { ...metadata, id, planEntry: true, terms: [] },
        { ...metadata, id: foreign, terms: [{ effectiveOn: paidDate, startOn: paidDate, amountCents: 1000, currency: "USD", frequency: "monthly", interval: 1 }] },
        { ...metadata, id: active, name: "Pay", status: "active", kind: "income", terms: [{ effectiveOn: current.end, startOn: current.end, amountCents: 2000, frequency: "monthly", interval: 1 }] },
      ];
    } },
    budgetWeeklyLimit: { findMany: async () => { calls.push("limits"); return []; } },
    budgetTransactionCommand: { findMany: async () => { calls.push("commands"); return []; } },
    budgetExpense: {
      findMany: async () => { calls.push("expenses"); return [
        { ...base, date: paidDate, billKey: `${id}:${paidDate.slice(0, 7)}`, totalCents: 3000, merchant: "Rent paid" },
        { ...base, date: paidDate, billKey: `${foreign}:${paidDate}`, totalCents: 1250, merchant: "Posted foreign" },
      ]; },
      groupBy: async () => { calls.push("history"); return []; },
    },
    budgetFxRate: { findMany: async ({ where }: { where: { key: { in: string[] } } }) => {
      requestedRates.push(where.key.in);
      return where.key.in.map(key => {
        const date = key.split(":").at(-1)!;
        return { key, data: { base: "USD", quote: "CAD", rate: "1.25", requestedDate: date, rateDate: date,
          fetchedAt: new Date().toISOString(), source: "frankfurter-v2" } };
      });
    } },
  });
  const response = await app.request("/api/v1/budgeting/module/overview?session=" + id + "&ruleIds=" + [id, foreign, active].join(","));
  expect(response.status).toBe(200);
  expect(calls).toEqual(["plan", "rules", "limits", "commands", "expenses", "history", "history"]);
  expect(requestedRates).toHaveLength(1);
  expect(requestedRates[0]).not.toContain(`ecb:USD:CAD:${paidDate}`);
  type Scheduled = { key: string; date: string; cents: number; kind: string; forecastDate?: string; upcoming: boolean };
  const result = await response.json() as {
    statements: { bills: { label: string; done: boolean; ruleId?: string }[] }[];
    rules: { id: string; revision: number; status: string; events: Scheduled[] }[];
    context: { upcoming: { key: string; ruleId?: string; occurrenceKey?: string }[] };
  };
  expect(result.statements[0].bills).toEqual([]);
  expect(result.statements[1].bills).toMatchObject([{ label: "Rent paid", done: true }, { label: "Posted foreign", done: true }]);
  const rent = result.rules.find(rule => rule.id === id)!;
  expect(rent).toMatchObject({ revision: 2, commandId: id, status: "paused" });
  expect(rent.events.find(event => event.date === current.start)).toMatchObject({
    key: `${id}:${current.start.slice(0, 7)}`, cents: 3000, kind: "bill",
  });
  expect(rent.events.some(event => event.date === paidDate)).toBe(false);
  expect(result.rules.find(rule => rule.id === foreign)?.events[0]).toMatchObject({ cents: 1250, kind: "subscription" });
  expect(result.context.upcoming.some(event => event.ruleId === id || event.ruleId === foreign)).toBe(false);
  expect(result.context.upcoming).toContainEqual(expect.objectContaining({ key: active, ruleId: active, occurrenceKey: `${active}:${current.end}` }));
  const period = await app.request("/api/v1/budgeting/module/overview?context=no&ruleIds=" + id);
  expect(period.status).toBe(200);
  const statementOnly = await period.json() as typeof result;
  expect(statementOnly.context).toBeUndefined();
  expect(statementOnly.rules).toHaveLength(1);
  expect(statementOnly.rules[0].events).toHaveLength(1);
  expect(statementOnly.rules[0].events[0].forecastDate).toBeUndefined();
  expect(statementOnly.rules[0].events[0].upcoming).toBe(false);
  expect((await app.request("/api/v1/budgeting/module/overview?ruleIds=bad")).status).toBe(400);
  expect((await app.request("/api/v1/budgeting/module/overview?ruleIds=" + Array(41).fill(id).join(","))).status).toBe(400);
});

test("without weekly limits the forecast still follows scheduled bills and income", () => {
  const plan = { ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 11838 } };
  const events = [
    { id, key: "pay", date: "2026-11-26", label: "Paycheque", cents: 164814, kind: "income" },
    { id, key: "rent", date: "2026-11-30", label: "Rent", cents: 100000, kind: "bill" },
  ];
  const result = buildBalance(plan, [], events, "2026-11-14");
  expect(result.at(-1)?.date).toBe("2027-05-13");
  expect(result.find(x => x.date === "2026-11-25")?.cents).toBe(11838);
  expect(result.find(x => x.date === "2026-11-26")?.cents).toBe(176652);
  expect(result.find(x => x.date === "2026-11-30")?.cents).toBe(76652);
});

test("history before the checkpoint walks back through imported days and stops at the first one", () => {
  const plan = { ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 10000, recordedAt: "2026-11-08T12:00:00Z" } };
  // Imported from Nov 5: on Nov 6, 2000 left; on Nov 7 a 5000 deposit arrived; on Nov 8 (before recording) 1000 left.
  const earlier = { from: "2026-11-05", movements: [
    { date: "2026-11-06", totalCents: 2000 }, { date: "2026-11-07", totalCents: -5000 }, { date: "2026-11-08", totalCents: 1000 },
  ] };
  const result = buildBalance(plan, [], [], "2026-11-09", [], earlier);
  expect(result.slice(0, 5)).toEqual([
    { date: "2026-11-05", cents: 8000, past: true },
    { date: "2026-11-06", cents: 6000, past: true },
    { date: "2026-11-07", cents: 11000, past: true },
    { date: "2026-11-08", cents: 10000, past: true },
    { date: "2026-11-09", cents: 10000, past: true },
  ]);
  // Without imported history nothing is invented before the checkpoint.
  expect(buildBalance(plan, [], [], "2026-11-09")[0].date).toBe("2026-11-08");
});
