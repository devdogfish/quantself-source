import { currencyCode, conversionSchema, type CurrencyConverter } from "./budget-fx";
import { z } from "@hono/zod-openapi";
import { subscriptionPayments, shiftDate, type Subscription } from "@quantself/budgeting";
import type { budgetEntry, budgetPlan } from "./budgeting";
import type { Prisma } from "@quantself/db/generated/prisma/client";
const date = z.iso.date();
const kind = z.enum(["subscription", "bill", "income"]);
const reviewFields = {
  kind: kind.optional(),
  category: z.string().trim().max(80).optional(),
  lastReviewed: date.nullable().optional(),
  documentId: z.uuid().nullable().optional(),
};
const link = z.url().max(2048).refine(value => new URL(value).protocol === "https:", "Use an HTTPS link.").nullable();
export const subscriptionTerm = z.object({
  currency: currencyCode.optional(), cadAmountCents: z.number().int().min(0).max(100_000_000).optional(), conversion: conversionSchema.optional(),
  effectiveOn: date, startOn: date, amountCents: z.number().int().min(0).max(100_000_000),
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: z.number().int().min(1).max(120),
}).strict();
export const subscriptionFields = z.object({
  name: z.string().trim().min(1).max(120), status: z.enum(["active", "trial", "candidate", "dismissed", "paused", "cancelled"]),
  ...reviewFields,
  stopsOn: date.nullable(), websiteUrl: link, cancelUrl: link,
  logoKey: z.enum(["amazon", "openai", "audible", "anthropic", "twilio", "mapbox", "namecheap", "publicmobile"]).nullable(),
  estimated: z.boolean(), terms: z.array(subscriptionTerm).max(50),
  evidence: z.string().max(3000), sourceKey: z.string().max(100).nullable(),
}).strict().superRefine((item, ctx) => {
  if (["active", "trial"].includes(item.status) && !item.terms.length && !item.stopsOn)
    ctx.addIssue({ code: "custom", message: "An active subscription needs a billing schedule." });
  if (new Set(item.terms.map(term => term.effectiveOn)).size !== item.terms.length)
    ctx.addIssue({ code: "custom", message: "Schedule changes must have distinct effective dates." });
});
export const subscription = subscriptionFields.safeExtend({
  id: z.uuid(), revision: z.number().int().nonnegative(), commandId: z.uuid(),
  kind: kind.default("subscription"), category: z.string().default(""),
  lastReviewed: date.nullable().default(null), documentId: z.uuid().nullable().default(null),
  planEntry: z.boolean().default(false),
}).strip().openapi("BudgetSubscription");
export const subscriptionWrite = z.object({ revision: z.number().int().nonnegative(), commandId: z.uuid(), changes: subscriptionFields }).strict();
export const subscriptionPayment = z.object({ id: z.uuid(), key: z.string(), label: z.string(), date, cents: z.number().int(),
  kind: z.literal("bill"), frequency: z.literal("once"), subscriptionId: z.uuid(), paid: z.boolean() });
export const subscriptionRange = z.object({ from: date, through: date }).refine(range => range.through >= range.from && range.through <= shiftDate(range.from, 185), "Choose up to 186 days.");
const charge = z.object({ id: z.uuid(), date, cents: z.number().int() });
export const subscriptionList = z.object({
  today: date, items: z.array(subscription), paidKeys: z.array(z.string()),
  charges: z.record(z.uuid(), z.array(charge)),
  oneOff: z.array(z.object({ id: z.uuid(), name: z.string(), kind, date, cents: z.number().int() })),
});
export const subscriptionCalendar = z.object({ payments: z.array(subscriptionPayment) });
export const subscriptionSelect = {
  id: true, revision: true, commandId: true, name: true, status: true, stopsOn: true,
  websiteUrl: true, cancelUrl: true, logoKey: true, estimated: true, terms: true, evidence: true, sourceKey: true,
  kind: true, category: true, lastReviewed: true, documentId: true, planEntry: true,
} as const;
export function subscriptionMerchantKey(merchant: string): string | null {
  if (/AMAZON[ .]?(?:CA|COM).*PRIME|PRIME MEMBER/i.test(merchant)) return "amazon-prime";
  if (/OPENAI.*CHATGPT/i.test(merchant)) return "chatgpt";
  if (/AUDIBLE/i.test(merchant)) return "audible";
  if (/PUBLIC MOBILE/i.test(merchant)) return "public-mobile";
  if (/ANTHROPIC.*CLAUDE SUB/i.test(merchant)) return "claude";
  if (/TWILIO/i.test(merchant)) return "twilio";
  if (/MAPBOX/i.test(merchant)) return "mapbox";
  if (/NAME.?CHEAP/i.test(merchant)) return "namecheap";
  return null;
}
/** One subscription read and one bank-row read; unique exact-amount candidates only. */
export async function reconcileSubscriptionPayments(tx: Prisma.TransactionClient, ownerId: string, from: string, through: string) {
  const [raw, expenses] = await Promise.all([
    tx.budgetSubscription.findMany({ where: { ownerId, status: { in: ["active", "trial"] }, sourceKey: { not: null }, kind: { not: "income" } }, select: subscriptionSelect }),
    tx.budgetExpense.findMany({ where: { ownerId, bankFlow: "expense", billKey: null, totalCents: { gt: 0 }, date: { gte: from, lte: through } },
      select: { id: true, merchant: true, date: true, totalCents: true } }),
  ]);
  const items = raw.map(row => subscription.parse(row)).filter(item => !item.terms.some(term => term.currency && term.currency !== "CAD"));
  const occurrences = items.flatMap(item => subscriptionPayments(item, shiftDate(from, -3), shiftDate(through, 3))
    .map(payment => ({ ...payment, sourceKey: item.sourceKey })));
  const candidates = expenses.flatMap(expense => {
    const key = subscriptionMerchantKey(expense.merchant);
    const matches = occurrences.filter(payment => key && payment.sourceKey === key && payment.cents === expense.totalCents &&
      Math.abs(Date.parse(payment.date) - Date.parse(expense.date)) <= 3 * 86_400_000);
    return matches.map(payment => ({ expense, payment }));
  });
  const counts = new Map<string, number>();
  const expenseCounts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.payment.key, (counts.get(candidate.payment.key) ?? 0) + 1);
    expenseCounts.set(candidate.expense.id, (expenseCounts.get(candidate.expense.id) ?? 0) + 1);
  }
  const keys = [...counts.keys()];
  const assigned = keys.length ? await tx.budgetExpense.findMany({ where: { ownerId, billKey: { in: keys } }, select: { billKey: true } }) : [];
  const occupied = new Set(assigned.map(row => row.billKey));
  for (const { expense, payment } of candidates) {
    if (counts.get(payment.key) !== 1 || expenseCounts.get(expense.id) !== 1 || occupied.has(payment.key)) continue;
    await tx.budgetExpense.updateMany({ where: { ownerId, id: expense.id, billKey: null }, data: { billKey: payment.key, subscriptionId: payment.subscriptionId } });
  }
}
export function subscriptionEntries(items: Subscription[], from: string, through: string) {
  return items.flatMap(item => item.planEntry ? [] : subscriptionPayments(item, from, through));
}

/** Reporting estimates refresh independently of the immutable subscription terms and actual expenses. */
export async function priceSubscriptions(items: Subscription[], fx: CurrencyConverter, today: string): Promise<Subscription[]> {
  const requests: { item: number; term: number; date: string }[] = [];
  items.forEach((item, index) => item.terms.forEach((term, termIndex) => {
    if (term.currency && term.currency !== "CAD" && !["candidate", "dismissed"].includes(item.status) && (!item.stopsOn || item.stopsOn > today)) {
      const later = item.terms.some(other => other.effectiveOn > term.effectiveOn && other.effectiveOn <= today);
      if (!later) requests.push({ item: index, term: termIndex, date: today });
    }
  }));
  const converted = await fx.convertMany(requests.map(request => { const term = items[request.item].terms[request.term]; return { money: { amountMinor: term.amountCents, currency: term.currency! }, target: "CAD", date: request.date }; }));
  const result = items.map(item => ({ ...item, terms: item.terms.map(term => ({ ...term })) }));
  requests.forEach((request, index) => Object.assign(result[request.item].terms[request.term], { cadAmountCents: converted[index].converted.amountMinor, conversion: converted[index] }));
  return result;
}
/** Derived rates are not user intent and never affect command identity or history checks. */
export function subscriptionIntent<T extends { terms: Subscription["terms"] }>(item: T) {
  return { ...item, terms: item.terms.map(({ cadAmountCents: _cad, conversion: _conversion, ...term }) => term) };
}

type Plan = z.infer<typeof budgetPlan>;
type Entry = z.infer<typeof budgetEntry>;
const unsavedCommandId = "00000000-0000-4000-8000-000000000000";

export function planRecurringRule(entry: Entry, metadata?: z.infer<typeof subscription>) {
  if (entry.frequency === "once") return null;
  return subscription.parse({
    id: entry.id, revision: 0, commandId: unsavedCommandId, status: "active",
    websiteUrl: null, cancelUrl: null, logoKey: null, stopsOn: null, sourceKey: null,
    estimated: entry.kind === "uncertainIncome", evidence: "",
    ...metadata,
    name: entry.label, kind: entry.kind === "bill" ? "bill" : "income", planEntry: true,
    terms: [{ startOn: entry.date, effectiveOn: entry.date, amountCents: entry.cents, frequency: entry.frequency, interval: entry.interval ?? 1 }],
  });
}

export function combineRecurringRules(plan: Plan, items: z.infer<typeof subscription>[]) {
  const overrides = new Map(items.filter(item => item.planEntry).map(item => [item.id, item]));
  const recurring = plan.entries.flatMap(entry => planRecurringRule(entry, overrides.get(entry.id)) ?? []);
  return [...items.filter(item => !item.planEntry), ...recurring];
}

export function withRecurringPlanStatus(plan: Plan, items: Subscription[]): Plan {
  const inactive = new Set(items.filter(item => item.planEntry && ["paused", "cancelled"].includes(item.status)).map(item => item.id));
  return { ...plan, entries: plan.entries.filter(entry => entry.frequency === "once" || !inactive.has(entry.id)) };
}

export function recurringChanges<T extends Subscription>(item: T) {
  const { id: _id, revision: _revision, commandId: _commandId, planEntry: _planEntry, ...changes } = item;
  return changes;
}
