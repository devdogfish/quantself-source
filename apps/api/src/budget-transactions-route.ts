import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { budgetPlan, date, emptyPlan, isFinancialDocument, localDate, shiftDate, weekStart } from "./budgeting";
import type { BudgetRoute } from "./budget-route-types";

const id = z.uuid();
const allowance = z.enum(["food", "other"]);
const cents = z.number().int().min(0).max(100_000_000);
const signed = z.number().int();
const category = z.string().trim().min(1).max(80);
const original = z.object({ currency: z.string(), cents: signed });
const selection = z.object({ allowance, category, foodCents: signed });
const spend = { OR: [{ bankFlow: null }, { bankFlow: { in: ["expense", "refund"] } }] } satisfies Prisma.BudgetExpenseWhereInput;
const linkedDeposit = { bankFlow: "deposit", OR: [{ subscriptionId: { not: null } }, { billKey: { not: null } }] } satisfies Prisma.BudgetExpenseWhereInput;
const fields = {
  id: true, bankFlow: true, date: true, merchant: true, totalCents: true, foodCents: true, allowance: true, category: true, reviewed: true,
  receiptId: true, manualReceiptMatch: true, billKey: true, originalCurrency: true, originalAmountMinor: true, subscriptionId: true,
} as const;
type Raw = Prisma.BudgetExpenseGetPayload<{ select: typeof fields }>;
const row = z.object({
  id, date, merchant: z.string(), cents: signed, ...selection.shape, reviewed: z.boolean(), receipt: z.boolean(),
  receiptId: id.nullable(), manualReceiptMatch: z.boolean().optional(), billKey: z.string().nullable(), original: original.optional(), subscriptionId: id.nullable(), readOnly: z.literal(true).optional(),
}).openapi("BudgetTransaction");
type Row = z.infer<typeof row>;
export function budgetExpenseCategory(expense: { allowance?: string | null; category?: string | null; foodCents: number }) {
  const allowance = expense.allowance === "food" || expense.allowance === "other" ? expense.allowance : expense.foodCents === 0 ? "other" : "food";
  return { allowance, category: expense.category ?? (allowance === "food" ? "Food" : "Other") } as const;
}
const view = (raw: Raw): Row => ({
  id: raw.id, date: raw.date, merchant: raw.merchant, cents: raw.totalCents, foodCents: raw.foodCents,
  ...budgetExpenseCategory(raw), reviewed: raw.reviewed, receipt: raw.receiptId !== null, receiptId: raw.receiptId,
  billKey: raw.billKey, subscriptionId: raw.subscriptionId, manualReceiptMatch: raw.manualReceiptMatch,
  ...(raw.bankFlow === "deposit" ? { readOnly: true as const } : {}),
  ...(raw.originalCurrency && raw.originalAmountMinor !== null ? { original: { currency: raw.originalCurrency, cents: raw.originalAmountMinor } } : {}),
});
const filters = z.object({
  from: date.optional(), to: date.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), cat: category.optional(),
  seg: z.enum(["all", "review", "missing"]).optional(), q: z.string().trim().max(180).optional(),
  sort: z.enum(["new", "old", "big", "small"]).optional(), subscriptionId: id.optional(), spendingOnly: z.literal("yes").optional(),
});
const pageSize = 25;
const sessionQuery = z.object({ session: id.optional() });
const querySchema = filters.extend({ ...sessionQuery.shape, page: z.coerce.number().int().min(1).max(10_000_000).optional() });
const list = z.object({ applied: z.array(id).optional(), today: date, rows: z.array(row), count: signed.nonnegative(), totalCents: signed });
const skipped = z.object({ id, date, label: z.string().trim().min(1).max(180), cents: cents.min(1) }).strict();
const checkIn = z.object({ reviewed: z.boolean(), checkedIn: z.boolean() }).strict();
const creation = row.pick({ id: true, date: true, merchant: true, allowance: true, category: true }).extend({
  merchant: z.string().trim().min(1).max(180), cents: cents.min(1),
}).strict();
const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), expense: creation }).strict(),
  z.object({ type: z.literal("remove"), expense: creation }).strict(),
  z.object({ type: z.literal("move"), id, before: selection.strict(), after: selection.partial({ foodCents: true }).strict() }).strict(),
  z.object({ type: z.literal("review"), id, before: z.boolean(), after: z.boolean() }).strict(),
  z.object({ type: z.literal("reviewAll"), ids: z.array(id), date, before: checkIn, after: checkIn }).strict(),
  z.object({
    type: z.literal("receipt"), id, before: id.nullable(), after: id.nullable(),
    beforeManualReceiptMatch: z.boolean().optional(), afterManualReceiptMatch: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("skip"), id, before: skipped.nullable(), after: skipped.nullable() }).strict(),
  z.object({ type: z.literal("limit"), allowance, week: date, before: cents.nullable(), after: cents.nullable() }).strict(),
]).openapi("BudgetTransactionCommand");
type Command = z.infer<typeof command>;
const commandResult = z.object({ expense: row.optional(), removed: z.literal(true).optional() });
type Result = z.infer<typeof commandResult>;

const week = z.object({ start: date, food: signed, other: signed, foodLimit: cents.nullable(), otherLimit: cents.nullable() });
const log = z.object({
  applied: z.array(id).optional(), today: date, weekStart: date, foodLimit: cents.nullable(), otherLimit: cents.nullable(), nextFoodLimit: cents.nullable(), nextOtherLimit: cents.nullable(),
  week: z.array(z.object({ date, food: signed, other: signed })), history: z.array(week), unreviewed: z.array(row), skipped: z.array(skipped),
  loggedDays: z.array(date), checkedInToday: z.boolean(), nextLimitWeek: date,
  nextLimitOverrides: z.object({ food: cents.nullable(), other: cents.nullable() }),
}).openapi("BudgetLog");

function fail(status: 400 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}
const conflict = () => fail(409, "Budget data changed elsewhere. Refresh and try again.");
const rawFields = Prisma.sql`id, "bankFlow", date, merchant, "totalCents", "foodCents", allowance, category, reviewed, "receiptId", "manualReceiptMatch", "billKey", "originalCurrency", "originalAmountMinor", "subscriptionId"`;
const categorySql = Prisma.sql`COALESCE(category, CASE WHEN COALESCE(allowance, CASE WHEN "foodCents" = 0 THEN 'other' ELSE 'food' END) = 'food' THEN 'Food' ELSE 'Other' END)`;

function transactionQuery(ownerId: string, filter: z.infer<typeof filters>) {
  const { from, to, month, cat, seg, q, sort, subscriptionId, spendingOnly } = filter;
  if (from && to && from > to) fail(400, "Date range is reversed.");
  const order = sort === "old" ? Prisma.sql`date ASC, id ASC`
    : sort === "big" ? Prisma.sql`"totalCents" DESC, date DESC, id DESC`
    : sort === "small" ? Prisma.sql`"totalCents" ASC, date DESC, id DESC`
    : Prisma.sql`date DESC, id DESC`;
  const eligibleFlow = subscriptionId && seg !== "review" ? Prisma.sql`('expense', 'refund', 'deposit')` : Prisma.sql`('expense', 'refund')`;
  const where = [Prisma.sql`"ownerId" = ${ownerId}`, Prisma.sql`("bankFlow" IS NULL OR "bankFlow" IN ${eligibleFlow})`];
  if (from) where.push(Prisma.sql`date >= ${from}`);
  if (to) where.push(Prisma.sql`date <= ${to}`);
  if (month) {
    const start = month + "-01";
    where.push(Prisma.sql`date >= ${start} AND date < ${shiftDate(start, 32).slice(0, 7) + "-01"}`);
  }
  if (cat) where.push(Prisma.sql`${categorySql} = ${cat}`);
  if (spendingOnly) where.push(Prisma.sql`"billKey" IS NULL AND "bankFlow" IS DISTINCT FROM 'deposit'`);
  if (seg === "review") where.push(Prisma.sql`NOT reviewed`);
  if (seg === "missing") where.push(Prisma.sql`"receiptId" IS NULL`);
  if (subscriptionId) where.push(Prisma.sql`("subscriptionId" = ${subscriptionId} OR "billKey" LIKE ${subscriptionId + ":%"})`);
  if (q) where.push(Prisma.sql`STRPOS(LOWER(merchant || ' ' || ${categorySql} || ' ' || ROUND("totalCents"::numeric / 100, 2)::text), LOWER(${q})) > 0`);
  return { where: Prisma.join(where, " AND "), order };
}

function csvCell(value: string) {
  const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function transactionCsv(rows: Row[]) {
  return ["Date,Merchant,Category,Allowance,Status,Receipt,Amount CAD",
    ...rows.map(x => [x.date, csvCell(x.merchant), csvCell(x.category), x.allowance === "food" ? "Food" : "Other",
      x.reviewed ? "Reviewed" : "To review", x.receipt ? "Yes" : "No", (-x.cents / 100).toFixed(2)].join(","))].join("\r\n");
}

export type LimitEntry = { week: string; allowance: string; cents: number | null };
// The undated entry preserves the previous Plan fallback for completed weeks.
const planLimitBaseline = "";
export async function recordPlanLimits(
  tx: Prisma.TransactionClient,
  ownerId: string,
  week: string,
  prior: { foodCents: number | null; otherCents: number | null },
  change: { foodCents?: number; otherCents?: number },
) {
  const entries = (["food", "other"] as const).flatMap(allowance => {
    const field = allowance === "food" ? "foodCents" : "otherCents";
    const cents = change[field];
    return cents === undefined ? [] : [{ allowance, cents, previous: prior[field] }];
  });
  await tx.budgetWeeklyLimit.createMany({
    data: entries.map(({ allowance, previous }) => ({ ownerId, allowance, week: planLimitBaseline, cents: previous })),
    skipDuplicates: true,
  });
  for (const { allowance, cents } of entries) {
    const key = { ownerId, allowance, week };
    await tx.budgetWeeklyLimit.upsert({
      where: { ownerId_allowance_week: key },
      create: { ...key, cents },
      update: { cents },
    });
  }
}
export function readBudgetLimitSchedule(db: Pick<typeof prisma, "$queryRaw">, ownerId: string, from: string, through: string) {
  return db.$queryRaw<LimitEntry[]>`
    (SELECT DISTINCT ON (allowance) week, allowance, cents
      FROM "budget_weekly_limit"
      WHERE "ownerId" = ${ownerId} AND week <= ${from}
      ORDER BY allowance, week DESC)
    UNION ALL
    (SELECT week, allowance, cents
      FROM "budget_weekly_limit"
      WHERE "ownerId" = ${ownerId} AND week > ${from} AND week <= ${through})
  `;
}

export function effectiveBudgetLimits(plan: { foodCents: number | null; otherCents: number | null }, entries: LimitEntry[], at: string) {
  let food = plan.foodCents, other = plan.otherCents, foodWeek: string | null = null, otherWeek: string | null = null;
  for (const entry of entries) {
    if (entry.week > at) continue;
    if (entry.allowance === "food" && (foodWeek === null || entry.week > foodWeek)) { food = entry.cents; foodWeek = entry.week; }
    if (entry.allowance === "other" && (otherWeek === null || entry.week > otherWeek)) { other = entry.cents; otherWeek = entry.week; }
  }
  return { food, other };
}

const appliedCommands = (ownerId: string, session?: string) => session
  ? Prisma.sql`ARRAY(SELECT id FROM "budget_transaction_command" WHERE "ownerId" = ${ownerId} AND "sessionId" = ${session})`
  : Prisma.sql`NULL::text[]`;

async function readLog(db: typeof prisma, ownerId: string, today: string, session?: string): Promise<z.infer<typeof log>> {
  const start = weekStart(today), nextLimitWeek = shiftDate(start, 7), historyStart = shiftDate(start, -84);
  const monthStart = today.slice(0, 7) + "-01";
  const [planRow, limits, byDate, unreviewed, skippedRows, [checkIns]] = await db.$transaction([
    db.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } }),
    db.budgetWeeklyLimit.findMany({ where: { ownerId, week: { lte: nextLimitWeek } }, select: { week: true, allowance: true, cents: true } }),
    db.budgetExpense.groupBy({
      by: ["date"], orderBy: { date: "asc" }, where: { ownerId, ...spend, billKey: null, date: { gte: historyStart, lte: today } }, _sum: { totalCents: true, foodCents: true },
    }),
    db.budgetExpense.findMany({ where: { ownerId, ...spend, reviewed: false }, select: fields, orderBy: [{ date: "desc" }, { id: "desc" }] }),
    db.budgetSkippedSpending.findMany({ where: { ownerId, date: { gte: monthStart, lte: today } }, select: { id: true, date: true, label: true, cents: true }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
    db.$queryRaw<{ days: string[]; applied: string[] | null }[]>`
      SELECT ARRAY(SELECT date FROM "budget_check_in" WHERE "ownerId" = ${ownerId}
        AND date BETWEEN ${shiftDate(monthStart, -1)} AND ${today} ORDER BY date) AS days,
        ${appliedCommands(ownerId, session)} AS applied
    `,
  ], { isolationLevel: "RepeatableRead" });
  const plan = planRow ? budgetPlan.parse(planRow.plan) : emptyPlan;
  const current = effectiveBudgetLimits(plan, limits, start);
  const next = effectiveBudgetLimits(plan, limits, nextLimitWeek);
  const history = Array.from({ length: 12 }, (_, i) => {
    const week = shiftDate(historyStart, 7 * i);
    const limit = effectiveBudgetLimits(plan, limits, week);
    return { start: week, food: 0, other: 0, foodLimit: limit.food, otherLimit: limit.other };
  });
  const historyByStart = new Map(history.map(w => [w.start, w]));
  const days = Array.from({ length: 7 }, (_, i) => ({ date: shiftDate(start, i), food: 0, other: 0 }));
  const daysByDate = new Map(days.map(day => [day.date, day]));
  for (const { date, _sum } of byDate) {
    const bucket = date >= start ? daysByDate.get(date) : historyByStart.get(weekStart(date));
    if (bucket) {
      const food = _sum?.foodCents ?? 0;
      bucket.food += food;
      bucket.other += (_sum?.totalCents ?? 0) - food;
    }
  }
  return {
    ...(checkIns.applied ? { applied: checkIns.applied } : {}), today, weekStart: start, foodLimit: current.food, otherLimit: current.other, nextFoodLimit: next.food, nextOtherLimit: next.other, week: days,
    history, unreviewed: unreviewed.map(view), skipped: skippedRows, loggedDays: checkIns.days,
    checkedInToday: checkIns.days.includes(today), nextLimitWeek,
    nextLimitOverrides: { food: limits.find(l => l.week === nextLimitWeek && l.allowance === "food")?.cents ?? null,
      other: limits.find(l => l.week === nextLimitWeek && l.allowance === "other")?.cents ?? null },
  };
}

const same = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
const validAllocation = (food: number, total: number) => food >= Math.min(0, total) && food <= Math.max(0, total);

async function applyCommand(tx: Prisma.TransactionClient, ownerId: string, command: Command, today: string): Promise<Result> {
  const key = (id: string) => ({ ownerId_id: { ownerId, id } });
  switch (command.type) {
    case "add": {
      const expense = command.expense;
      if (expense.date > today) fail(400, "Use a date through today.");
      const { cents, ...rest } = expense;
      return { expense: view(await tx.budgetExpense.create({
        data: { ownerId, ...rest, totalCents: cents, foodCents: expense.allowance === "food" ? cents : 0 }, select: fields,
      })) };
    }
    case "remove": {
      const { id, merchant, date, cents, allowance, category } = command.expense;
      const removed = await tx.budgetExpense.deleteMany({
        where: { ownerId, id, merchant, date, totalCents: cents, allowance, category, foodCents: allowance === "food" ? cents : 0,
          reviewed: false, bankAccount: null, originalCurrency: null, receiptId: null, billKey: null, subscriptionId: null, inventoryLinks: { none: {} } },
      });
      if (!removed.count) conflict();
      return { removed: true };
    }
    case "move":
    case "review":
    case "receipt": {
      const current = await tx.budgetExpense.findFirst({ where: { ownerId, id: command.id, ...spend }, select: fields });
      if (!current) return fail(404, "Transaction not found.");
      let data: Prisma.BudgetExpenseUncheckedUpdateInput;
      if (command.type === "move") {
        const expected = budgetExpenseCategory(current);
        if (command.before.allowance !== expected.allowance || command.before.category !== expected.category || command.before.foodCents !== current.foodCents) conflict();
        const foodCents = command.after.foodCents ?? (command.after.allowance === "food" ? current.totalCents : 0);
        if (!validAllocation(foodCents, current.totalCents)) fail(400, "Food allocation must fit the transaction amount.");
        data = { ...command.after, foodCents };
      } else if (command.type === "review") {
        if (current.reviewed !== command.before) conflict();
        data = { reviewed: command.after };
      } else {
        if (current.receiptId !== command.before ||
          (command.beforeManualReceiptMatch !== undefined && current.manualReceiptMatch !== command.beforeManualReceiptMatch)) conflict();
        if (command.after) {
          const document = await tx.budgetReceipt.findUnique({ where: key(command.after), select: { kind: true, expense: { select: { id: true } } } });
          if (!document) return fail(404, "Receipt not found.");
          if (!isFinancialDocument(document.kind)) fail(400, "Select a receipt or invoice.");
          if (document.expense && document.expense.id !== current.id) fail(409, "This receipt is already linked to a transaction.");
        }
        data = { receiptId: command.after, manualReceiptMatch: command.afterManualReceiptMatch ?? true };
      }
      return { expense: view(await tx.budgetExpense.update({ where: key(current.id), data, select: fields })) };
    }
    case "reviewAll": {
      if (command.date > today) fail(400, "Use a check-in date through today.");
      const checkInWhere = { ownerId_date: { ownerId, date: command.date } };
      const existing = await tx.budgetCheckIn.findUnique({ where: checkInWhere, select: { date: true } });
      if (Boolean(existing) !== command.before.checkedIn) conflict();
      const ids = [...new Set(command.ids)];
      // Match explicit observed IDs so a later import cannot be swept into the check-in or its Undo.
      if (ids.length) {
        const count = await tx.$executeRaw`
          UPDATE "budget_expense" SET reviewed = ${command.after.reviewed}
          WHERE "ownerId" = ${ownerId} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
            AND reviewed = ${command.before.reviewed} AND ("bankFlow" IS NULL OR "bankFlow" IN ('expense', 'refund'))
        `;
        if (count !== ids.length) conflict();
      }
      if (!existing && command.after.checkedIn) await tx.budgetCheckIn.create({ data: { ownerId, date: command.date } });
      if (existing && !command.after.checkedIn) await tx.budgetCheckIn.delete({ where: checkInWhere });
      return {};
    }
    case "skip": {
      if ([command.before, command.after].some(x => x && (x.id !== command.id || x.date > today))) fail(400, "Check skipped purchase ID and date.");
      const where = key(command.id);
      const current = await tx.budgetSkippedSpending.findUnique({ where, select: { id: true, date: true, label: true, cents: true } });
      if (!same(current && skipped.parse(current), command.before)) conflict();
      if (command.after) await tx.budgetSkippedSpending.upsert({ where, create: { ownerId, ...command.after }, update: command.after });
      else if (current) await tx.budgetSkippedSpending.delete({ where });
      return {};
    }
    case "limit": {
      if (weekStart(command.week) !== command.week || command.week > shiftDate(weekStart(today), 7)) fail(400, "Choose a valid budget week.");
      const where = { ownerId_allowance_week: { ownerId, week: command.week, allowance: command.allowance } };
      const current = await tx.budgetWeeklyLimit.findUnique({ where, select: { cents: true } });
      if ((current?.cents ?? null) !== command.before) conflict();
      if (command.after !== null) await tx.budgetWeeklyLimit.upsert({ where, create: { ...where.ownerId_allowance_week, cents: command.after }, update: { cents: command.after } });
      else if (current) await tx.budgetWeeklyLimit.delete({ where });
      return {};
    }
  }
}

export function registerBudgetTransactions(route: BudgetRoute, db: typeof prisma) {
  route("get", "/transactions", "listBudgetTransactions", "List 25 budget transactions and filtered totals", list,
    { today: "2026-11-13", rows: [], count: 0, totalCents: 0 }, async (_c, ownerId, _input, query) => {
      const { where, order } = transactionQuery(ownerId, query);
      const offset = ((query.page ?? 1) - 1) * pageSize;
      const [rows, [totals]] = await db.$transaction([
        db.$queryRaw<Raw[]>`SELECT ${rawFields} FROM "budget_expense" WHERE ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`,
        db.$queryRaw<{ count: bigint; cents: bigint; applied: string[] | null }[]>`
          SELECT COUNT(*) AS count, COALESCE(SUM("totalCents"), 0) AS cents,
            ${appliedCommands(ownerId, query.session)} AS applied FROM "budget_expense" WHERE ${where}
        `,
      ], { isolationLevel: "RepeatableRead" });
      return { ...(totals.applied ? { applied: totals.applied } : {}), today: localDate(), rows: rows.map(view), count: Number(totals.count), totalCents: Number(totals.cents) };
    }, { query: querySchema, ownerOnly: true });
  route("get", "/transactions/export", "exportBudgetTransactions", "Export all filtered budget transactions as CSV", z.object({ csv: z.string() }), { csv: "" },
    async (_c, ownerId, _input, query) => {
      const { where, order } = transactionQuery(ownerId, query);
      const rows = await db.$queryRaw<Raw[]>`SELECT ${rawFields} FROM "budget_expense" WHERE ${where} ORDER BY ${order}`;
      return { csv: transactionCsv(rows.map(view)) };
    }, { query: filters, ownerOnly: true });
  route("get", "/transactions/{id}", "getBudgetTransaction", "Read a budget transaction by ID", row, null,
    async (c, ownerId) => {
      const item = await db.budgetExpense.findFirst({ where: { ownerId, id: c.req.param("id")!, OR: [...spend.OR, linkedDeposit] }, select: fields });
      return item ? view(item) : fail(404, "Transaction not found.");
    }, { ownerOnly: true });
  route("get", "/log", "getBudgetLog", "Read the check-in, review queue, skipped purchases and spending history", log, null,
    (_c, ownerId, _input, query) => readLog(db, ownerId, localDate(), query.session), { query: sessionQuery, ownerOnly: true });
  route("put", "/transaction-commands/{id}", "applyBudgetTransactionCommand", "Apply an undoable budget transaction or Log change", commandResult, {},
    async (c, ownerId, input, query) => {
      const where = { ownerId_id: { ownerId, id: c.req.param("id")! } };
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const replay = (prior: { fingerprint: string; result: Prisma.JsonValue }) => {
        if (prior.fingerprint !== fingerprint) fail(409, "Retry with the original command payload.");
        return commandResult.parse(prior.result);
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction(async tx => {
            const prior = await tx.budgetTransactionCommand.findUnique({ where });
            if (prior) return replay(prior);
            const result = await applyCommand(tx, ownerId, input, localDate());
            await tx.budgetTransactionCommand.create({ data: { ...where.ownerId_id, sessionId: query.session, fingerprint, result: result as Prisma.InputJsonObject } });
            return result;
          }, { isolationLevel: "Serializable" });
        } catch (cause) {
          if (cause instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(cause.code)) {
            const prior = await db.budgetTransactionCommand.findUnique({ where });
            if (prior) return replay(prior);
            // Independent concurrent writes can cause a serialization retry. Re-run all
            // before-value checks against current state before making any changes.
            if (cause.code === "P2034" && attempt < 2) continue;
          }
          throw cause;
        }
      }
    }, { input: command, query: sessionQuery, ownerOnly: true, retry: "retry with the same command ID and identical payload" });
}
