import { budgetExpenseCategory, effectiveBudgetLimits, type LimitEntry } from "./budget-transactions-route";
import { z } from "@hono/zod-openapi";
import { prisma } from "@quantself/db";
import type { Currency } from "@quantself/budgeting";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import type { BudgetRoute } from "./budget-route-types";
import { budgetPlan, billOccurrences, emptyPlan, localDate, shiftDate, weekStart } from "./budgeting";
import { createCurrencyConverter, type CurrencyConverter } from "./budget-fx";
import { combineRecurringRules, subscription, subscriptionEntries, subscriptionSelect, withRecurringPlanStatus } from "./budget-subscriptions";

const line = z.object({ date: z.iso.date(), label: z.string(), cents: z.number().int(), done: z.boolean(), note: z.string().optional(), ruleId: z.uuid().optional(), key: z.string().optional() });
const spending = z.object({ id: z.string(), date: z.iso.date(), merchant: z.string(), cents: z.number().int(), foodCents: z.number().int(), allowance: z.enum(["food", "other"]), category: z.string(), reviewed: z.boolean(), receipt: z.boolean(), original: z.object({ currency: z.string(), cents: z.number().int() }).optional() });
export const moduleStatement = z.object({
  start: z.iso.date(), end: z.iso.date(), income: z.array(line), bills: z.array(line), savings: z.array(line), spending: z.array(spending),
  cats: z.array(z.object({ name: z.string(), allowance: z.string(), cents: z.number().int(), count: z.number().int() })),
  totals: z.object({ income: z.number().int(), bills: z.number().int(), savings: z.number().int(), spending: z.number().int() }),
  net: z.number().int(), allowance: z.number().int(), daysLeft: z.number().int(),
});
const scheduledKind = z.enum(["income", "bill", "subscription"]);
const ruleEvent = z.object({
  key: z.string(), date: z.iso.date(), label: z.string(), cents: z.number().int(), kind: scheduledKind,
  uncertain: z.boolean(), forecastDate: z.iso.date().optional(), upcoming: z.boolean(),
});
const ruleSnapshot = z.object({
  id: z.uuid(), revision: z.number().int().nonnegative(), commandId: z.uuid(), status: subscription.shape.status,
  stopsOn: z.iso.date().nullable(), events: z.array(ruleEvent),
});
const context = z.object({
  futureLimits: z.array(z.object({ week: z.iso.date(), allowance: z.enum(["food", "other"]), cents: z.number().int() })).optional(),
  checkpointDate: z.iso.date().nullable().optional(), checkpointRecordedAt: z.string().nullable().optional(),
  cash: z.number().int().nullable(), foodLimit: z.number().int().nullable(), otherLimit: z.number().int().nullable(),
  // "allowance": bills, income and weekly limits; "scheduled": bills and income only (no limits set yet).
  forecast: z.enum(["allowance", "scheduled"]).optional(),
  // This week's saved overrides (null = none): the "before" for editing limits from this week on.
  thisWeek: z.object({ week: z.iso.date(), food: z.number().int().nullable(), other: z.number().int().nullable() }).optional(),
  balance: z.array(z.object({ date: z.iso.date(), cents: z.number().int(), past: z.boolean() })),
  upcoming: z.array(z.object({ key: z.string(), date: z.iso.date(), label: z.string(), cents: z.number().int(), kind: scheduledKind, uncertain: z.boolean(), ruleId: z.uuid().optional(), occurrenceKey: z.string().optional() })),
});
export const moduleOverview = z.object({ applied: z.array(z.uuid()).optional(), today: z.iso.date(), statements: z.array(moduleStatement), context: context.optional(), rules: z.array(ruleSnapshot).optional() });
const querySchema = z.object({
  mode: z.enum(["week", "month"]).default("month"),
  offset: z.coerce.number().int().min(-1200).max(0).default(0),
  context: z.enum(["yes", "no"]).default("yes"),
  contextDate: z.iso.date().optional(),
  session: z.uuid().optional(),
  ruleIds: z.string().max(40 * 37 - 1)
    .refine(value => value.split(",").every(id => z.uuid().safeParse(id).success), "Choose up to 40 recurring rule IDs.")
    .optional(),
});
export function statementPeriods(today: string, mode: "week" | "month", offset: number) {
  const range = (n: number) => {
    if (mode === "week") { const start = shiftDate(weekStart(today), n * 7); return { start, end: shiftDate(start, 6) }; }
    const d = new Date(today + "T00:00:00Z");
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
    return { start, end };
  };
  const current = range(offset), previous = range(offset - 1);
  const partialEnd = shiftDate(previous.start, Math.round((Date.parse(today) - Date.parse(current.start)) / 86400000));
  return [current, previous, { ...previous, end: offset === 0 && partialEnd < previous.end ? partialEnd : previous.end }];
}
type Row = { category?: string | null; allowance?: string | null; reviewed?: boolean; id: string; date: string; merchant: string; totalCents: number; foodCents: number; billKey: string | null; bankFlow: string | null; receiptId: string | null; originalCurrency: string | null; originalAmountMinor: number | null; bankAccount: string | null };
type Event = { id: string; key: string; date: string; label: string; cents: number; kind: string; subscriptionId?: string; ruleId?: string };
type ScheduledEvent = Event & { originalCurrency?: Currency };
type CashMovement = { date: string; totalCents: number };

function paidBillKeys(rows: Pick<Row, "date" | "billKey">[], today: string) {
  return new Set(rows.flatMap(row => row.billKey && row.date <= today ? [row.billKey] : []));
}

function scheduledSubscriptions(items: z.infer<typeof subscription>[], from: string, through: string): ScheduledEvent[] {
  return items.flatMap(item => {
    const terms = [...item.terms].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
    // Generate occurrence keys and dates before pricing. A matched charge uses its posted amount.
    const schedule = { ...item, terms: terms.map(term => ({ ...term, currency: undefined })) };
    return subscriptionEntries([schedule], from, through).map(event => {
      const term = terms.findLast(term => term.effectiveOn <= event.date);
      return { ...event, ruleId: item.id, originalCurrency: term?.currency };
    });
  });
}

async function priceSchedule(events: ScheduledEvent[], fx: CurrencyConverter) {
  const foreign = events.filter(event => event.originalCurrency && event.originalCurrency !== "CAD");
  if (!foreign.length) return;
  const prices = await fx.convertMany(foreign.map(event => ({
    money: { currency: event.originalCurrency!, amountMinor: event.cents },
    target: "CAD",
    date: event.date,
  })));
  foreign.forEach((event, index) => { event.cents = prices[index].converted.amountMinor; });
}
export function buildStatement(plan: z.infer<typeof budgetPlan>, rows: Row[], events: Event[], today: string, range: { start: string; end: string }, mode: "week" | "month", limits: LimitEntry[] = []) {
  const inside = (x: { date: string }) => x.date >= range.start && x.date <= range.end;
  const paid = paidBillKeys(rows, today);
  const income: z.infer<typeof line>[] = [], bills: z.infer<typeof line>[] = [], savings: z.infer<typeof line>[] = [];
  const expenses: z.infer<typeof spending>[] = [];
  for (const row of rows.filter(row => inside(row) && row.date <= today)) {
    const posted = { date: row.date, label: row.merchant, cents: row.totalCents, done: true };
    if (row.bankFlow === "deposit") income.push({ ...posted, cents: -row.totalCents });
    // Only transfers recorded on the named savings account establish a savings movement.
    else if (row.bankFlow === "transfer" && row.bankAccount === "rbc-savings") savings.push({ ...posted, cents: -row.totalCents });
    else if (row.bankFlow === "transfer") continue;
    else if (row.billKey) bills.push(posted);
    else expenses.push({ id: row.id, date: row.date, merchant: row.merchant, cents: row.totalCents, foodCents: row.foodCents,
      ...budgetExpenseCategory(row), reviewed: row.reviewed ?? false, receipt: !!row.receiptId,
      ...(row.originalCurrency && row.originalAmountMinor !== null ? { original: { currency: row.originalCurrency, cents: row.originalAmountMinor } } : {}) });
  }
  for (const event of events.filter(inside)) {
    if (paid.has(event.key)) continue;
    // A schedule is never proof of historical income/payment. Show unposted commitments as planned.
    const target = event.kind === "bill" ? bills : income;
    target.push({ date: event.date, label: event.label, cents: event.cents, done: false,
      ...(event.ruleId ? { ruleId: event.ruleId, key: event.key } : {}),
      ...(event.kind === "uncertainIncome" ? { note: "Uncertain" } : {}) });
  }
  const sum = (xs: { cents: number }[]) => xs.reduce((n, x) => n + x.cents, 0);
  const totals = { income: sum(income.filter(x => x.done || (x.date > today && !x.note))), bills: sum(bills), savings: sum(savings), spending: sum(expenses) };
  const cats = new Map<string, { name: string; allowance: string; cents: number; count: number }>();
  for (const x of expenses) {
    const cat = cats.get(x.category) ?? { name: x.category, allowance: x.allowance, cents: 0, count: 0 };
    cat.cents += x.cents; cat.count++; cats.set(x.category, cat);
  }
  let allowance = 0;
  for (let day = range.start; day <= range.end; day = shiftDate(day, 1)) {
    const limit = effectiveBudgetLimits(plan, limits, weekStart(day));
    allowance += ((limit.food ?? 0) + (limit.other ?? 0)) / 7;
  }
  return { ...range, income: income.sort((a,b) => a.date.localeCompare(b.date)), bills: bills.sort((a,b) => a.date.localeCompare(b.date)), savings, spending: expenses,
    cats: [...cats.values()].sort((a,b) => b.cents - a.cents), totals, net: totals.income - totals.bills - totals.savings - totals.spending,
    allowance: Math.round(allowance),
    daysLeft: range.start <= today && range.end >= today ? Math.round((Date.parse(range.end) - Date.parse(today)) / 86400000) + 1 : 0 };
}
function forecastDate(event: Event, today: string) {
  if (event.kind === "uncertainIncome" || (event.kind !== "bill" && event.date <= today)) return undefined;
  return event.date <= today ? shiftDate(today, 1) : event.date;
}

function eventKind(event: Event): z.infer<typeof scheduledKind> {
  return event.kind !== "bill" ? "income" : event.subscriptionId ? "subscription" : "bill";
}

// Earlier movements reconstruct history before the checkpoint, walking backwards from it. They are only
// trustworthy where imported bank transactions exist, so `from` is the first imported day (or 180 days ago).
export type EarlierMovements = { from: string; movements: CashMovement[] };

export function buildBalance(plan: z.infer<typeof budgetPlan>, movements: CashMovement[], events: Event[], today: string, limits: LimitEntry[] = [], earlier?: EarlierMovements) {
  const checkpoint = plan.checkpoint;
  if (!checkpoint || checkpoint.date > today) return [];
  const historyStart = shiftDate(today, -180);
  const start = checkpoint.date > historyStart ? checkpoint.date : historyStart;
  // Scheduled bills and income are known even before weekly limits are set, so always forecast.
  const end = shiftDate(today, 180);
  const daily = new Map<string, number>();
  let cash = checkpoint.cents;
  for (const movement of movements) {
    if (movement.date < start) cash -= movement.totalCents;
    else daily.set(movement.date, (daily.get(movement.date) ?? 0) - movement.totalCents);
  }
  const future = new Map<string, number>();
  for (const event of events) {
    const due = forecastDate(event, today);
    if (!due) continue;
    future.set(due, (future.get(due) ?? 0) + (event.kind === "bill" ? -event.cents : event.cents));
  }
  const result: z.infer<typeof context>["balance"] = [];
  if (earlier && start === checkpoint.date && earlier.from < start) {
    // End-of-day balance before day d = balance at the end of d plus what left the account on d.
    const out = new Map<string, number>();
    for (const movement of earlier.movements) out.set(movement.date, (out.get(movement.date) ?? 0) + movement.totalCents);
    const from = earlier.from > historyStart ? earlier.from : historyStart;
    let back = checkpoint.cents;
    for (let date = checkpoint.date; date > from; date = shiftDate(date, -1)) {
      back += out.get(date) ?? 0;
      result.unshift({ date: shiftDate(date, -1), cents: Math.round(back), past: true });
    }
  }
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    const limit = effectiveBudgetLimits(plan, limits, weekStart(date));
    const dailyAllowance = ((limit.food ?? 0) + (limit.other ?? 0)) / 7;
    cash += date <= today ? daily.get(date) ?? 0 : (future.get(date) ?? 0) - dailyAllowance;
    result.push({ date, cents: Math.round(cash), past: date <= today });
  }
  return result;
}

async function cashMovements(db: Pick<typeof prisma, "budgetExpense">, ownerId: string, checkpoint: NonNullable<z.infer<typeof budgetPlan>["checkpoint"]>, today: string) {
  const rows = await db.budgetExpense.groupBy({
    by: ["date"],
    where: {
      ownerId,
      AND: [
        { OR: [{ bankFlow: null }, { bankFlow: { not: "transfer" } }] },
        { OR: [
          { date: { gt: checkpoint.date, lte: today } },
          ...(checkpoint.recordedAt ? [{ date: checkpoint.date, bankAccount: null, createdAt: { gt: new Date(checkpoint.recordedAt) } }] : []),
        ] },
      ],
    },
    _sum: { totalCents: true },
  });
  return rows.map(row => ({ date: row.date, totalCents: row._sum.totalCents ?? 0 }));
}

// Movements on and before the checkpoint day (excluding entries recorded after it), grouped by date and
// account in one read: the sums rebuild earlier history, and the first imported-bank day bounds it.
async function earlierMovements(db: Pick<typeof prisma, "budgetExpense">, ownerId: string, checkpoint: NonNullable<z.infer<typeof budgetPlan>["checkpoint"]>, today: string): Promise<EarlierMovements | undefined> {
  const from = shiftDate(today, -180);
  if (checkpoint.date <= from) return undefined;
  const rows = await db.budgetExpense.groupBy({
    by: ["date", "bankAccount"],
    where: {
      ownerId,
      AND: [
        { OR: [{ bankFlow: null }, { bankFlow: { not: "transfer" } }] },
        { date: { gte: from, lte: checkpoint.date } },
        ...(checkpoint.recordedAt ? [{ NOT: { date: checkpoint.date, bankAccount: null, createdAt: { gt: new Date(checkpoint.recordedAt) } } }] : []),
      ],
    },
    _sum: { totalCents: true },
  });
  const imported = rows.filter(row => row.bankAccount !== null).map(row => row.date).sort()[0];
  if (!imported) return undefined;
  return { from: imported, movements: rows.filter(row => row.date >= imported).map(row => ({ date: row.date, totalCents: row._sum.totalCents ?? 0 })) };
}

export function registerBudgetModuleOverview(route: BudgetRoute, db = prisma) {
  const fx = createCurrencyConverter(db);
  route("get", "/module/overview", "getBudgetModuleOverview", "Read period statements, recorded balance history and forecast", moduleOverview, { today: "2026-11-13", statements: [] }, async (_c, ownerId, _input, query) => {
    const today = localDate(), ranges = statementPeriods(today, query.mode, query.offset);
    const snapshot = await db.$transaction(async tx => {
    const [record, rawSubscriptions, limits, applied] = await Promise.all([
      tx.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } }),
      tx.budgetSubscription.findMany({ where: { ownerId }, select: subscriptionSelect }),
      tx.budgetWeeklyLimit.findMany({ where: { ownerId, week: { lte: shiftDate(today, 180) } }, select: { week: true, allowance: true, cents: true } }),
      query.session ? tx.budgetTransactionCommand.findMany({ where: { ownerId, sessionId: query.session }, select: { id: true } }) : [],
    ]);
    const plan = budgetPlan.parse(record?.plan ?? emptyPlan);
    const subscriptions = rawSubscriptions.map(row => subscription.parse(row));
    const recurring = combineRecurringRules(plan, subscriptions);
    const recurringIds = new Set(recurring.map(rule => rule.id));
    const touched = new Set(query.ruleIds?.split(","));
    const observed = recurring.filter(rule => touched.has(rule.id));
    const activePlan = withRecurringPlanStatus(plan, subscriptions);
    const planEvents = (selectedPlan: typeof plan, from: string, through: string) =>
      billOccurrences(selectedPlan, from, through).map(event => ({
        ...event, ...(recurringIds.has(event.id) ? { ruleId: event.id } : {}),
      }));
    const scheduled = (from: string, through: string): ScheduledEvent[] => [
      ...planEvents(activePlan, from, through),
      ...scheduledSubscriptions(subscriptions, from, through),
    ];
    const potentialPlan = { ...plan, entries: plan.entries.filter(entry => entry.frequency !== "once" && touched.has(entry.id)) };
    const potentialSubscriptions = observed.filter(rule => !rule.planEntry).map(rule => ({ ...rule, status: "active" as const, stopsOn: null }));
    const potential = (from: string, through: string): ScheduledEvent[] => [
      ...planEvents(potentialPlan, from, through),
      ...scheduledSubscriptions(potentialSubscriptions, from, through),
    ];
    const withContext = query.context === "yes" || (!!query.contextDate && query.contextDate !== today);
    const checkpoint = withContext && plan.checkpoint && plan.checkpoint.date <= today ? plan.checkpoint : null;
    const statementEvents = scheduled(ranges[1].start, ranges[0].end);
    const potentialStatement = observed.length ? potential(ranges[1].start, ranges[0].end) : [];
    const upcomingThrough = shiftDate(today, 30);
    const currentLimits = effectiveBudgetLimits(plan, limits, weekStart(today));
    const forecastThrough = checkpoint ? shiftDate(today, 180) : null;
    const contextFrom = forecastThrough && checkpoint ? checkpoint.date : today;
    const contextThrough = forecastThrough ?? upcomingThrough;
    const contextEvents = withContext ? scheduled(contextFrom, contextThrough)
      .filter(event => event.date >= today || event.kind === "bill") : [];
    const potentialContext = withContext && observed.length ? potential(contextFrom, contextThrough)
      .filter(event => event.date >= today || event.kind === "bill") : [];
    const events = [...new Map([...statementEvents, ...contextEvents].map(event => [event.key, event])).values()];
    const potentialEvents = [...new Map([...potentialStatement, ...potentialContext].map(event => [event.key, event])).values()];
    const statementDates: Prisma.BudgetExpenseWhereInput = {
      date: { gte: ranges[1].start, lte: ranges[0].end },
    };
    // Include exact matches settled outside the statement periods. Cash history needs only daily sums.
    const keys = [...new Set([...events, ...potentialEvents].filter(event => event.kind === "bill" || event.ruleId).map(event => event.key))];
    const [rows, movements, earlier] = await Promise.all([
      tx.budgetExpense.findMany({
        where: { ownerId, date: { lte: today }, OR: [
          statementDates,
          ...(keys.length ? [{ billKey: { in: keys } }] : []),
        ] },
        select: {
          id: true, date: true, merchant: true, totalCents: true, foodCents: true, billKey: true, bankFlow: true, category: true, allowance: true, reviewed: true,
          receiptId: true, originalCurrency: true, originalAmountMinor: true, bankAccount: true,
        },
      }),
      checkpoint ? cashMovements(tx, ownerId, checkpoint, today) : [],
      checkpoint ? earlierMovements(tx, ownerId, checkpoint, today) : undefined,
    ]);
    const paid = paidBillKeys(rows, today);
    const outstanding = events.filter(event => !paid.has(event.key));
    return { plan, limits, applied, currentLimits, checkpoint, rows, movements, earlier, outstanding, contextEvents, withContext, upcomingThrough,
      forecastThrough, observed, candidates: potentialEvents.filter(event => !paid.has(event.key)), potentialContext };
    }, { isolationLevel: "RepeatableRead" });
    const { plan, limits, applied, currentLimits, checkpoint, rows, movements, earlier, outstanding, contextEvents, withContext, upcomingThrough,
      forecastThrough, observed, candidates, potentialContext } = snapshot;
    // Each unpaid occurrence needs one conversion, even when used by both the server forecast and a pending rule.
    const priced = new Map([...candidates, ...outstanding].map(event => [event.key, event]));
    await priceSchedule([...priced.values()], fx);
    const contextCandidateKeys = new Set(potentialContext.map(event => event.key));
    const ruleEvents = new Map<string, z.infer<typeof ruleEvent>[]>();
    for (const candidate of candidates) {
      if (!candidate.ruleId) continue;
      const event = priced.get(candidate.key)!;
      const inContext = contextCandidateKeys.has(event.key);
      const events = ruleEvents.get(candidate.ruleId) ?? [];
      events.push({ key: event.key, date: event.date, label: event.label, cents: event.cents, kind: eventKind(event),
        uncertain: event.kind === "uncertainIncome", forecastDate: inContext && forecastThrough ? forecastDate(event, today) : undefined,
        upcoming: inContext && event.date >= today && event.date <= upcomingThrough });
      ruleEvents.set(candidate.ruleId, events);
    }
    const rules = observed.map(({ id, revision, commandId, status, stopsOn }) => ({ id, revision, commandId, status, stopsOn, events: ruleEvents.get(id) ?? [] }));
    const forecastKeys = new Set(contextEvents.map(event => event.key));
    const contextOutstanding = outstanding.filter(event => forecastKeys.has(event.key));
    const balance = checkpoint ? buildBalance(plan, movements, contextOutstanding, today, limits, earlier) : [];
    return { ...(query.session ? { applied: applied.map(row => row.id) } : {}), ...(query.ruleIds ? { rules } : {}), today, statements: ranges.map(range => buildStatement(plan, rows, outstanding, today, range, query.mode, limits)),
      ...(withContext ? { context: { futureLimits: limits.filter(row => row.cents !== null && row.week > weekStart(today) && (row.allowance === "food" || row.allowance === "other")).map(row => ({ ...row, cents: row.cents!, allowance: row.allowance === "food" ? "food" as const : "other" as const })), checkpointDate: checkpoint?.date ?? null, checkpointRecordedAt: checkpoint?.recordedAt ?? null, cash: balance.find(x => x.date === today)?.cents ?? null, foodLimit: currentLimits.food, otherLimit: currentLimits.other, balance,
        ...(checkpoint ? { forecast: currentLimits.food === null && currentLimits.other === null ? "scheduled" as const : "allowance" as const } : {}),
        thisWeek: { week: weekStart(today),
          food: limits.find(row => row.week === weekStart(today) && row.allowance === "food")?.cents ?? null,
          other: limits.find(row => row.week === weekStart(today) && row.allowance === "other")?.cents ?? null },
        upcoming: contextOutstanding.filter(e => e.date >= today && e.date <= upcomingThrough).map(e => ({ key: e.subscriptionId ?? e.id, date: e.date, label: e.label, cents: e.cents, kind: eventKind(e), uncertain: e.kind === "uncertainIncome",
          ...(e.ruleId ? { ruleId: e.ruleId, occurrenceKey: e.key } : {}) })).sort((a,b) => a.date.localeCompare(b.date)) } } : {}) };
  }, { query: querySchema, ownerOnly: true });
}
