import { createCurrencyConverter } from "./budget-fx";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { prisma } from "@quantself/db";
import type { BudgetRoute } from "./budget-route-types";
import { budgetPlan, emptyPlan, billOccurrences, localDate, shiftDate } from "./budgeting";
import { subscription, subscriptionEntries, subscriptionSelect, priceSubscriptions, withRecurringPlanStatus } from "./budget-subscriptions";
import { affordabilityResult, previewPurchase, purchaseQuery } from "./budget-affordability";

const item = z.object({ id: z.string(), title: z.string().nullable() });
const linkedItems = z.object({ items: z.array(item) });
const sourceQuery = z.object({ type: z.enum(["receipt", "expense"]), id: z.uuid() });
const linkInput = sourceQuery.extend({ itemId: z.string().min(1).max(128), linked: z.boolean() }).strict();
const range = z.object({ from: z.iso.date(), through: z.iso.date() });
const commitments = z.object({ events: z.array(z.object({ key: z.string(), label: z.string(), date: z.iso.date(), cents: z.number().int(),
  kind: z.enum(["bill", "income", "uncertainIncome"]), paid: z.boolean() })) });

export function registerBudgetExtras(route: BudgetRoute, db = prisma) {
  const fx = createCurrencyConverter(db);
  route("get", "/affordability", "previewBudgetPurchase", "Preview a purchase without changing the budget", affordabilityResult, { today: "2026-11-08", date: "2026-11-08", amount: 0, available: null, leftoverBefore: null, leftoverAfter: null, rentMonthsBefore: null, rentMonthsAfter: null, shortfallBefore: null, shortfallAfter: null, through: "2027-11-08", reserveCents: 0 },
    async (_c, ownerId, _input, query) => {
      const today = localDate();
      if (query.date < today || query.date > shiftDate(today, 365)) throw new HTTPException(400, { message: "Choose a date within the next year." });
      const [row, subscriptions] = await Promise.all([
        db.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } }),
        db.budgetSubscription.findMany({ where: { ownerId, OR: [{ status: { in: ["active", "trial"] } }, { planEntry: true }] }, select: subscriptionSelect }),
      ]);
      const items = subscriptions.map(row => subscription.parse(row));
      const plan = withRecurringPlanStatus(row ? budgetPlan.parse(row.plan) : emptyPlan, items);
      const expenses = await db.budgetExpense.findMany({ where: { ownerId,
        AND: [{ OR: [{ bankFlow: null }, { bankFlow: { in: ["expense", "refund"] } }] },
          { OR: [{ date: { gte: plan.checkpoint?.date ?? today, lte: today } }, { billKey: { not: null } }] }] },
        select: { date: true, totalCents: true, foodCents: true, billKey: true, bankAccount: true, createdAt: true } });
      const payments = subscriptionEntries(await priceSubscriptions(items, fx, today), plan.checkpoint?.date ?? today, shiftDate(today, 365));
      return previewPurchase(plan, expenses, today, query, payments);
    }, { query: purchaseQuery, ownerOnly: true });

  route("get", "/commitments", "getBudgetCommitments", "Read scheduled bills and income for Calendar", commitments, { events: [] },
    async (_c, ownerId, _input, query) => {
      if (query.through < query.from || query.through > shiftDate(query.from, 185)) throw new HTTPException(400, { message: "Choose up to 186 days." });
      const [row, rules] = await Promise.all([
        db.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } }),
        db.budgetSubscription.findMany({ where: { ownerId, OR: [
          { planEntry: true, status: { in: ["paused", "cancelled"] } },
          { planEntry: false, kind: "income", status: { in: ["active", "trial"] } },
        ] }, select: subscriptionSelect }),
      ]);
      const items = rules.map(row => subscription.parse(row));
      const plan = withRecurringPlanStatus(row ? budgetPlan.parse(row.plan) : emptyPlan, items);
      const income = subscriptionEntries(await priceSubscriptions(items, fx, localDate()), query.from, query.through);
      const events = [...billOccurrences(plan, query.from, query.through), ...income];
      const paid = events.length ? await db.budgetExpense.findMany({ where: { ownerId, billKey: { in: events.map(event => event.key) } }, select: { billKey: true } }) : [];
      const keys = new Set(paid.map(row => row.billKey));
      return { events: events.map(event => ({ ...event, paid: keys.has(event.key) })) };
    }, { query: range, ownerOnly: true });

  async function source(ownerId: string, type: "receipt" | "expense", id: string) {
    const where = { ownerId_id: { ownerId, id } };
    const row = type === "receipt" ? await db.budgetReceipt.findUnique({ where, select: { id: true } }) : await db.budgetExpense.findUnique({ where, select: { id: true } });
    if (!row) throw new HTTPException(404, { message: "Purchase record not found." });
    return type === "receipt" ? { ownerId, receiptId: id } : { ownerId, expenseId: id };
  }
  route("get", "/item-links", "getBudgetItemLinks", "Read inventory items linked to a purchase", linkedItems, { items: [] },
    async (c, ownerId, _input, query) => {
      if (!c.get("accessContext")!.permissions.includes("inventory:read")) throw new HTTPException(403, { message: "Missing inventory:read." });
      const where = await source(ownerId, query.type, query.id);
      const rows = await db.budgetInventoryLink.findMany({ where, select: { item: { select: { id: true, title: true } } }, orderBy: { itemId: "asc" } });
      return { items: rows.map(row => row.item) };
    }, { query: sourceQuery, ownerOnly: true });
  route("get", "/item-search", "searchBudgetInventory", "Search inventory items to link to a purchase", linkedItems, { items: [] },
    async (c, _ownerId, _input, query) => {
      if (!c.get("accessContext")!.permissions.includes("inventory:read")) throw new HTTPException(403, { message: "Missing inventory:read." });
      return { items: await db.inventoryItem.findMany({ where: { archivedAt: null, OR: [
        { title: { contains: query.q, mode: "insensitive" } }, { searchText: { contains: query.q, mode: "insensitive" } },
      ] }, select: { id: true, title: true }, orderBy: [{ title: "asc" }, { id: "asc" }], take: 20 }) };
    }, { query: z.object({ q: z.string().trim().min(2).max(100) }), ownerOnly: true });
  route("put", "/item-links", "setBudgetItemLink", "Link or unlink an inventory item without changing spending", z.object({ ok: z.boolean() }), { ok: true },
    async (c, ownerId, input) => {
      if (!c.get("accessContext")!.permissions.includes("inventory:read")) throw new HTTPException(403, { message: "Missing inventory:read." });
      const where = await source(ownerId, input.type, input.id);
      if (input.linked) {
        if (!await db.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true } })) throw new HTTPException(404, { message: "Inventory item not found." });
        await db.budgetInventoryLink.createMany({ data: [{ ...where, itemId: input.itemId }], skipDuplicates: true });
      } else await db.budgetInventoryLink.deleteMany({ where: { ...where, itemId: input.itemId } });
      return { ok: true };
    }, { input: linkInput, ownerOnly: true, retry: "same desired link state is idempotent" });
}
