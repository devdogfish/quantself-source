import { afterAll, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { prisma } from "@quantself/db";
import type { AccessContext } from "@quantself/auth";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { emptyPlan, localDate, shiftDate, weekStart } from "./budgeting";
import { registerBudgetingRoutes } from "./budgeting-route";

const dbUrl = process.env.BUDGET_TRANSACTIONS_TEST_DATABASE_URL;
// The optional integration run uses an isolated, migrated Docker database.
if (dbUrl && dbUrl !== process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the isolated transaction test database.");
const integration = dbUrl ? prisma : null;
const queryEvents: string[] = [];
const instrumented = integration?.$extends({ query: { $allOperations({ operation, args, query }) {
  queryEvents.push(operation);
  return query(args);
} } });
const origin = "http://localhost";
const prefix = "/api/v1/budgeting";
const today = localDate();
const ownerId = "budget-transactions-test:" + crypto.randomUUID();

function appWith(db: PrismaClient, kind: "web" | "api-key" = "web", owner = ownerId) {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: owner, email: "owner@example.com", name: "Owner" },
      client: { id: "client", kind, name: "Test" }, permissions: ["budgeting:read", "budgeting:write", "budgeting:delete"] } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db);
  return app;
}

afterAll(async () => {
  if (!integration) return;
  for (const owner of [ownerId, ownerId + ":other", ownerId + ":plan"]) {
    await integration.budgetTransactionCommand.deleteMany({ where: { ownerId: owner } });
    await integration.budgetCheckIn.deleteMany({ where: { ownerId: owner } });
    await integration.budgetSkippedSpending.deleteMany({ where: { ownerId: owner } });
    await integration.budgetWeeklyLimit.deleteMany({ where: { ownerId: owner } });
    await integration.budgetExpense.deleteMany({ where: { ownerId: owner } });
    await integration.budgetReceipt.deleteMany({ where: { ownerId: owner } });
    await integration.budgetPlan.deleteMany({ where: { ownerId: owner } });
  }
  await integration.$disconnect();
});

test("transaction endpoints require an Owner session before reading data", async () => {
  const app = appWith({} as PrismaClient, "api-key");
  for (const path of ["/transactions", "/transactions/export", "/transactions/" + crypto.randomUUID(), "/log"]) {
    expect((await app.request(prefix + path)).status).toBe(403);
  }
});

test("scoped expense writes do not distinguish a receipt link from other protected expenses", async () => {
  const linked = crypto.randomUUID();
  const imported = crypto.randomUUID();
  const manual = crypto.randomUUID();
  const receipt = crypto.randomUUID();
  const budgetExpense = {
    findUnique: async ({ where }: { where: { ownerId_id: { id: string } } }) => {
      if (where.ownerId_id.id === linked) return { receiptId: receipt, bankAccount: null };
      if (where.ownerId_id.id === imported) return { receiptId: null, bankAccount: "fixture" };
      return null;
    },
    deleteMany: async () => ({ count: 0 }),
    upsert: async ({ create }: { create: object }) => ({ ...create, conversion: null, bankAccount: null }),
  };
  const db = { budgetExpense, $transaction: (run: (tx: { budgetExpense: typeof budgetExpense }) => unknown) => run({ budgetExpense }) };
  const app = appWith(db as unknown as PrismaClient, "api-key");
  const write = (method: "PUT" | "DELETE", id: string) => app.request(prefix + "/expenses/" + id, {
    method, ...(method === "PUT" && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, merchant: "Fictional shop", date: "2026-11-13", totalCents: 900,
        foodCents: 0, receiptId: null, billKey: null }),
    }),
  });
  for (const method of ["PUT", "DELETE"] as const) {
    const replies = await Promise.all([write(method, linked), write(method, imported)]);
    expect(replies.map(reply => reply.status)).toEqual([409, 409]);
    const denied = { message: "This expense requires the Owner interface." };
    expect(await Promise.all(replies.map(reply => reply.json()))).toEqual([denied, denied]);
  }
  const saved = await write("PUT", manual);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ id: manual, totalCents: 900, receiptId: null });
});

test.skipIf(!integration)("Docker Postgres: filter, paginate, export and mutate owner-scoped transaction and Log records", async () => {
  const db = integration!;
  const app = appWith(instrumented as unknown as PrismaClient);
  const read = (path: string) => app.request(origin + prefix + path);
  const session = crypto.randomUUID();
  const write = (command: unknown, id = crypto.randomUUID()) => app.request(origin + prefix + "/transaction-commands/" + id + "?session=" + session, {
    method: "PUT", headers: { origin: new URL(process.env.BETTER_AUTH_URL ?? origin).origin, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const first = crypto.randomUUID(), receiptId = crypto.randomUUID(), skippedId = crypto.randomUUID();
  const foreignReceiptId = crypto.randomUUID(), linkedExpense = crypto.randomUUID(), billId = crypto.randomUUID();
  await db.budgetPlan.create({ data: { ownerId, plan: { ...emptyPlan, foodCents: 11_000, otherCents: 9000 } } });
  const incomeRule = crypto.randomUUID(), linkedDeposit = crypto.randomUUID(), unlinkedDeposit = crypto.randomUUID();
  const start = weekStart(today);
  const lastWeek = shiftDate(start, -7);
  await db.budgetWeeklyLimit.create({ data: { ownerId, allowance: "food", week: lastWeek, cents: 13_000 } });
  await db.budgetReceipt.createMany({ data: [
    { ownerId, id: receiptId, merchant: "Corner Store", lines: [], scanStatus: "manual" },
    { ownerId: ownerId + ":other", id: foreignReceiptId, merchant: "Different Owner", lines: [], scanStatus: "manual" },
  ] });
  await db.budgetExpense.createMany({ data: [
    ...Array.from({ length: 30 }, (_, i) => ({
      ownerId, id: crypto.randomUUID(), merchant: i === 1 ? 'Corner "Store"' : "Corner Store", date: today,
      totalCents: 100 + i, foodCents: i === 0 ? 40 : 100 + i, category: i === 0 ? null : "Groceries",
    })),
    { ownerId, id: linkedExpense, merchant: "Utility", date: today, totalCents: 1000, foodCents: 0, billKey: billId + ":once" },
    { ownerId, id: crypto.randomUUID(), merchant: "Last week purchase", date: lastWeek, totalCents: 500, foodCents: 300 },
    { ownerId, id: unlinkedDeposit, merchant: "Corner Store deposit", date: today, totalCents: -700, foodCents: 0, bankFlow: "deposit" },
    { ownerId, id: linkedDeposit, merchant: "Paycheque", date: today, totalCents: -12500, foodCents: 0, bankFlow: "deposit", billKey: incomeRule + ":once" },
    { ownerId: ownerId + ":other", id: first, merchant: "Corner Store", date: today, totalCents: 100, foodCents: 100, category: "Groceries" },
  ] });
  const filters = "?from=" + today + "&to=" + today + "&month=" + today.slice(0, 7) + "&seg=review&q=corner&sort=big";
  const requestTimings: { path: string; phase: string; ms: number; dataQueries: number }[] = [];
  for (const phase of ["first", "warm"]) for (const path of ["/transactions" + filters, "/log"]) {
    const mark = queryEvents.length;
    const began = performance.now();
    expect((await read(path)).status).toBe(200);
    const dataQueries = queryEvents.length - mark;
    requestTimings.push({ path: path.split("?")[0], phase, ms: Math.round(performance.now() - began), dataQueries });
  }
  console.log("Budget route request samples:", JSON.stringify(requestTimings));
  expect(requestTimings.map(x => x.dataQueries)).toEqual([2, 6, 2, 6]);
  const page1 = await (await read("/transactions" + filters)).json() as { rows: { id: string; cents: number }[] };
  const page2 = await (await read("/transactions" + filters + "&page=2")).json() as typeof page1;
  expect(page1).toMatchObject({ count: 30, totalCents: 3435 });
  expect(page1.rows).toHaveLength(25);
  expect(page2.rows).toHaveLength(5);
  expect(page1.rows[0].cents).toBe(129);
  expect(page2.rows[4].cents).toBe(100);
  expect(await (await read("/transactions?cat=Groceries&q=1.01")).json()).toMatchObject({ count: 1, totalCents: 101 });
  expect(await (await read("/transactions?from=" + today + "&cat=Food&q=corner")).json()).toMatchObject({ count: 1, totalCents: 100 });
  expect(await (await read("/transactions?subscriptionId=" + billId)).json()).toMatchObject({ count: 1, rows: [{ id: linkedExpense }] });
  const spending = "&spendingOnly=yes";
  const utility = "?q=utility";
  expect(await (await read("/transactions" + utility)).json()).toMatchObject({ count: 1, totalCents: 1000 });
  expect(await (await read("/transactions" + utility + spending)).json()).toMatchObject({ count: 0, totalCents: 0, rows: [] });
  expect(await (await read("/transactions/export" + utility + spending)).json()).toMatchObject({ csv: "Date,Merchant,Category,Allowance,Status,Receipt,Amount CAD" });
  const { csv } = await (await read("/transactions/export" + filters)).json() as { csv: string };
  expect(csv.split("\r\n")).toHaveLength(31);
  expect(csv).toContain('"Corner ""Store"""');
  expect(await (await read("/transactions?subscriptionId=" + incomeRule)).json()).toMatchObject({ count: 1, totalCents: -12500, rows: [{ id: linkedDeposit, readOnly: true }] });
  expect(await (await read("/transactions?seg=review&subscriptionId=" + incomeRule)).json()).toMatchObject({ count: 0 });
  expect(await (await read("/transactions/" + linkedDeposit)).json()).toMatchObject({ readOnly: true });
  expect((await read("/transactions/" + unlinkedDeposit)).status).toBe(404);
  expect((await write({ type: "review", id: linkedDeposit, before: false, after: true })).status).toBe(404);
  expect((await read("/transactions/" + first)).status).toBe(404);
  expect((await read("/transactions/" + page2.rows[4].id)).status).toBe(200);
  expect((await read("/transactions?from=2026-12-01&to=2026-11-01")).status).toBe(400);

  const expense = { id: first, merchant: "Café", date: today, allowance: "food", category: "Coffee", cents: 400 };
  const add = { type: "add", expense };
  const addCommandId = crypto.randomUUID();
  expect(await (await write(add, addCommandId)).json()).toMatchObject({ expense: { reviewed: false, cents: 400, receipt: false } });
  expect((await write({ ...add, expense: { ...expense, merchant: "Other" } }, addCommandId)).status).toBe(409);
  const move = { type: "move", id: first, before: { allowance: "food", category: "Coffee", foodCents: 400 }, after: { allowance: "other", category: "Fun" } };
  expect(await (await write(move)).json()).toMatchObject({ expense: { category: "Fun", foodCents: 0, cents: 400 } });
  expect((await write(move)).status).toBe(409);
  expect((await write({ ...move, before: { ...move.after, foodCents: 0 }, after: move.before })).status).toBe(200);

  expect((await write({ type: "receipt", id: first, before: null, after: foreignReceiptId })).status).toBe(404);
  expect(await (await write({
    type: "receipt", id: first, before: null, after: receiptId, beforeManualReceiptMatch: false, afterManualReceiptMatch: true,
  })).json()).toMatchObject({ expense: { receipt: true, receiptId, manualReceiptMatch: true } });
  expect(await (await read("/transactions?q=Café&seg=missing")).json()).toMatchObject({ count: 0 });
  const undoReceipt = { type: "receipt", id: first, before: receiptId, after: null, beforeManualReceiptMatch: true, afterManualReceiptMatch: false };
  expect((await write({ ...undoReceipt, beforeManualReceiptMatch: false })).status).toBe(409);
  expect(await (await write(undoReceipt)).json()).toMatchObject({ expense: { receipt: false, receiptId: null, manualReceiptMatch: false } });

  const checkIn = { type: "reviewAll", ids: [first, linkedExpense], date: today,
    before: { reviewed: false, checkedIn: false }, after: { reviewed: true, checkedIn: true } };
  expect((await write(checkIn)).status).toBe(200);
  expect(await (await read("/log")).json()).toMatchObject({ foodLimit: 13000, otherLimit: 9000, loggedDays: [today], checkedInToday: true });
  expect(await (await read("/transactions/" + first)).json()).toMatchObject({ reviewed: true });
  const conflict = { type: "reviewAll", ids: [first, page1.rows[0].id], date: today,
    before: { reviewed: false, checkedIn: true }, after: { reviewed: true, checkedIn: true } };
  expect((await write(conflict)).status).toBe(409);
  expect(await (await read("/transactions/" + page1.rows[0].id)).json()).toMatchObject({ reviewed: false });
  expect((await write({ ...checkIn, before: checkIn.after, after: checkIn.before })).status).toBe(200);

  const skip = { type: "skip", id: skippedId, before: null, after: { id: skippedId, date: today, label: "Lunch out", cents: 1100 } };
  const limit = { type: "limit", allowance: "food", week: shiftDate(start, 7), before: null, after: 12_000 };
  expect((await write(skip)).status).toBe(200);
  expect((await write(limit)).status).toBe(200);
  const logged = await (await read("/log?session=" + session)).json() as { history: { start: string }[]; applied: string[] };
  expect(logged.applied).toContain(addCommandId);
  expect(await (await read("/transactions?session=" + session)).json()).toMatchObject({ applied: expect.arrayContaining([addCommandId]) });
  expect(await (await read("/transactions?session=" + crypto.randomUUID())).json()).toMatchObject({ applied: [] });
  expect(logged).toMatchObject({ foodLimit: 13000, nextFoodLimit: 12000, skipped: [skip.after], loggedDays: [], checkedInToday: false });
  expect(logged.history.at(-1)).toMatchObject({ start: lastWeek, food: 300, other: 200, foodLimit: 13000, otherLimit: 9000 });
  expect((await write({ ...skip, before: skip.after, after: null })).status).toBe(200);
  expect((await write({ ...limit, before: limit.after, after: null })).status).toBe(200);

  expect((await write({ type: "remove", expense })).status).toBe(200);
  // Delayed replay of a previous add returns its original acknowledgement and cannot recreate the row.
  expect((await write(add, addCommandId)).status).toBe(200);
  expect((await read("/transactions/" + first)).status).toBe(404);
});

test.skipIf(!integration)("Docker Postgres: applying explicit Plan limits updates the current week and preserves history and scheduled limits", async () => {
  const db = integration!;
  const owner = ownerId + ":plan";
  const app = appWith(db, "web", owner);
  const currentWeek = weekStart(today), lastWeek = shiftDate(currentWeek, -7), nextWeek = shiftDate(currentWeek, 7);
  await db.budgetPlan.create({ data: { ownerId: owner, plan: { ...emptyPlan, foodCents: 11_000, checkpoint: { date: today, cents: 100000 } } } });
  await db.budgetWeeklyLimit.createMany({ data: [
    { ownerId: owner, allowance: "food", week: lastWeek, cents: 13000 },
    { ownerId: owner, allowance: "food", week: nextWeek, cents: 14000 },
    { ownerId: owner, allowance: "other", week: currentWeek, cents: 6000 },
  ] });
  const write = (path: string, method: string, body: unknown) => app.request(origin + prefix + path, {
    method, headers: { origin: new URL(process.env.BETTER_AUTH_URL ?? origin).origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const log = async () => (await app.request(origin + prefix + "/log")).json() as Promise<{
    history: { start: string; foodLimit: number | null; otherLimit: number | null }[];
  }>;
  // Explicitly resubmitting the original Plan number still replaces the current override.
  expect((await write("/proposal", "PUT", { revision: 0, changes: { foodCents: 11000 } })).status).toBe(200);
  expect((await write("/proposal/decision", "POST", { revision: 0, action: "apply" })).status).toBe(409);
  expect(await log()).toMatchObject({ foodLimit: 13000, otherLimit: 6000, nextFoodLimit: 14000 });
  expect(await (await write("/proposal/decision", "POST", { revision: 1, action: "apply" })).json())
    .toMatchObject({ revision: 2, plan: { foodCents: 11000, otherCents: null }, proposal: null });
  expect(await log()).toMatchObject({ foodLimit: 11000, otherLimit: 6000, nextFoodLimit: 14000 });

  expect((await write("/proposal", "PUT", { revision: 2, changes: { foodCents: 12000, otherCents: 8000 } })).status).toBe(200);
  expect((await write("/proposal/decision", "POST", { revision: 3, action: "apply" })).status).toBe(200);
  const applied = await log();
  expect(applied).toMatchObject({ foodLimit: 12000, otherLimit: 8000, nextFoodLimit: 14000, nextOtherLimit: 8000 });
  expect(applied.history.find(week => week.start === lastWeek)).toMatchObject({ foodLimit: 13000, otherLimit: null });
  expect(applied.history[0]).toMatchObject({ foodLimit: 11000, otherLimit: null });

  type Projection = { date: string; cents: number; baseline?: number };
  const overview = async (query = "") => {
    const response = await app.request(origin + prefix + query);
    expect(response.status).toBe(200);
    return await response.json() as { foodLimit: number; otherLimit: number; projection: Projection[] };
  };
  const current = await overview();
  expect(current).toMatchObject({ foodLimit: 12000, otherLimit: 8000 });
  expect(current.projection[0]).toMatchObject({ date: today, cents: 80000 });
  expect(current.projection.find(point => point.date === nextWeek)).toMatchObject({ cents: 58000 });
  expect(current.projection.find(point => point.date === shiftDate(nextWeek, 7))).toMatchObject({ cents: 36000 });
  const scenario = await overview("?food=1000");
  expect(scenario).toMatchObject({ foodLimit: 1000, otherLimit: 8000 });
  expect(scenario.projection.find(point => point.date === nextWeek)).toMatchObject({ cents: 82000, baseline: 58000 });

  const purchase = await app.request(origin + prefix + "/affordability?amount=90000&date=" + nextWeek);
  expect(await purchase.json()).toMatchObject({ available: 100000, shortfallBefore: null, shortfallAfter: null });

});

test("receipt Undo compares and restores automatic matching eligibility", async () => {
  const id = crypto.randomUUID();
  const receipt = crypto.randomUUID();
  const expense = {
    id, date: today, merchant: "Shop", totalCents: 1000, foodCents: 0, category: "Other", allowance: "other",
    reviewed: false, receiptId: null as string | null, manualReceiptMatch: false,
    billKey: null, subscriptionId: null, originalCurrency: null, originalAmountMinor: null, bankFlow: "expense",
  };
  const tx = {
    budgetTransactionCommand: { findUnique: async () => null, create: async () => {} },
    budgetReceipt: { findUnique: async () => ({ kind: "receipt", expense: null }) },
    budgetExpense: {
      findFirst: async () => expense,
      update: async ({ data }: { data: Partial<typeof expense> }) => Object.assign(expense, data),
    },
  };
  const app = appWith({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as unknown as PrismaClient);
  const write = (body: object) => app.request(origin + prefix + "/transaction-commands/" + crypto.randomUUID(), {
    method: "PUT", headers: { origin: new URL(process.env.BETTER_AUTH_URL ?? origin).origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const attach = { type: "receipt", id, before: null, after: receipt, beforeManualReceiptMatch: false, afterManualReceiptMatch: true };
  const undo = { ...attach, before: receipt, after: null, beforeManualReceiptMatch: true, afterManualReceiptMatch: false };
  expect((await write(attach)).status).toBe(200);
  expect(expense).toMatchObject({ receiptId: receipt, manualReceiptMatch: true });
  expect((await write({ ...undo, beforeManualReceiptMatch: false })).status).toBe(409);
  const response = await write(undo);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ expense: { receiptId: null, manualReceiptMatch: false } });
  expect(expense.manualReceiptMatch).toBeFalse();
});
