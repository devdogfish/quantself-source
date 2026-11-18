import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const receiptId = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0643";
const quote = { base: "USD", quote: "CAD", rate: "1.4", requestedDate: "2026-10-26", rateDate: "2026-10-26", fetchedAt: "2026-10-27T00:00:00Z", source: "frankfurter-v2" };
function fixture() {
  let expense: any = null; let candidates: any[] = []; const candidateQueries: any[] = []; let rateReads = 0; let writes = 0; let documentUpdates = 0;
  const document: any = { id: receiptId, kind: "invoice", title: null, currency: "USD", invoiceNumber: "INV-1", dueDate: null, amazonAsin: null, merchant: "Example", date: "2026-10-26", totalCents: 1254, lines: [], mime: "application/pdf", createdAt: new Date(), scanStatus: "archived", expense: null };
  const db: any = {
    budgetFxRate: { findMany: async () => { rateReads++; return [{ key: "ecb:USD:CAD:2026-10-26", data: quote }]; } },
    budgetExpense: {
      findMany: async (query: any) => { candidateQueries.push(query); const start = query.cursor ? candidates.findIndex(row => row.id === query.cursor.ownerId_id.id) + 1 : 0; return candidates.slice(start, start + query.take); },
      findUnique: async () => expense,
      upsert: async ({ create, update }: any) => { writes++; expense = { ...(expense ? { ...expense, ...update } : create), bankAccount: null }; return expense; },
      updateMany: async ({ data, where }: any) => { if (where.ownerId !== "owner") throw Error("owner missing"); expense = { ...expense, ...data }; document.expense = expense; return { count: 1 }; },
    },
    budgetReceipt: {
      findUnique: async () => ({ ...document, expense: document.expense }),
      findUniqueOrThrow: async () => ({ ...document, expense: document.expense }),
      update: async ({ data }: any) => { documentUpdates++; Object.assign(document, data); return document; },
    },
    $transaction: async (fn: any) => fn(db),
  };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => { c.set("accessContext", { owner: { id: "owner" }, client: { kind: "web" }, permissions: ["budgeting:read", "budgeting:write"] } as AccessContext); await next(); });
  registerBudgetingRoutes(app, db as typeof prisma);
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
  const put = (path: string, body: unknown) => app.request(`/api/v1/budgeting${path}`, { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, put, document, candidateQueries, set candidates(value: any[]) { candidates = value; }, get expense() { return expense; }, set expense(value) { expense = value; }, get rateReads() { return rateReads; }, get writes() { return writes; }, get documentUpdates() { return documentUpdates; } };
}
test("foreign cash expenses keep source money and saved rate on retry without revaluing", async () => {
  const f = fixture(); const input = { id, merchant: "Example", date: "2026-10-26", totalCents: 1254, foodCents: 500, currency: "USD", receiptId: null, billKey: null };
  expect((await f.put(`/expenses/${id}`, input)).status).toBe(200);
  expect(f.expense).toMatchObject({ totalCents: 1756, foodCents: 700, originalAmountMinor: 1254, originalFoodMinor: 500, originalCurrency: "USD", conversion: { estimated: true, quote } });
  expect(f.rateReads).toBe(1);
  expect((await f.put(`/expenses/${id}`, input)).status).toBe(200);
  expect(f.rateReads).toBe(1); expect(f.expense.totalCents).toBe(1756);
});
test("a foreign invoice links to actual CAD bank settlement without overwriting either amount", async () => {
  const f = fixture();
  f.expense = { id, merchant: "Example", date: "2026-10-26", totalCents: 1828, foodCents: 0, bankAccount: "rbc-ion-visa", bankFlow: "expense", receiptId: null, billKey: null };
  const response = await f.put(`/receipts/${receiptId}/match`, { expenseId: id });
  expect(response.status).toBe(200);
  const result: any = await response.json();
  expect(result.totalCents).toBe(1254); expect(result.currency).toBe("USD"); expect(result.mime).toBe("application/pdf");
  expect(result.expense.totalCents).toBe(1828); expect(f.rateReads).toBe(0); expect(f.writes).toBe(0); expect(f.documentUpdates).toBe(0);
});
test("cash currency must match source document; unknown invoice currency cannot silently become CAD", async () => {
  const f = fixture(); const input = { id, merchant: "Example", date: "2026-10-26", totalCents: 1254, foodCents: 0, currency: "CAD", receiptId, billKey: null };
  expect((await f.put(`/expenses/${id}`, input)).status).toBe(400); expect(f.writes).toBe(0);
  f.document.currency = null;
  expect((await f.put(`/expenses/${id}`, input)).status).toBe(400); expect(f.writes).toBe(0);
});


test("foreign invoice suggestions paginate all nearby transactions without pretending approximate amount equality", async () => {
  const f = fixture();
  const rows = Array.from({ length: 31 }, (_, i) => ({ id: crypto.randomUUID(), merchant: `Merchant ${i}`, date: "2026-10-26", totalCents: 1800 + i, foodCents: 0, receiptId: null, billKey: null, bankAccount: "rbc-ion-visa" }));
  f.candidates = rows;
  const first: any = await (await f.app.request(`/api/v1/budgeting/receipts/${receiptId}/candidates`)).json();
  expect(first.candidates).toHaveLength(30); expect(first.next).toBe(rows[29].id);
  expect(f.candidateQueries[0].where.ownerId).toBe("owner"); expect(f.candidateQueries[0].where.totalCents).toBeUndefined();
  const second: any = await (await f.app.request(`/api/v1/budgeting/receipts/${receiptId}/candidates?cursor=${first.next}`)).json();
  expect(second.candidates).toHaveLength(1); expect(second.next).toBeNull(); expect(f.candidateQueries).toHaveLength(2); expect(f.rateReads).toBe(0);
});
