import { currencyCode, conversionSchema } from "./budget-fx";
import { z } from "@hono/zod-openapi";
import { scheduleOccurrences, shiftDate } from "@quantself/budgeting";
export { shiftDate } from "@quantself/budgeting";

export const date = z.iso.date();
const cents = z.number().int().min(0).max(100_000_000);
const signedCents = z.number().int().min(-100_000_000).max(100_000_000);
const id = z.uuid();
export const checkpoint = z.object({ date, cents }).strict();
export const budgetEntry = z.object({
  id, label: z.string().trim().min(1).max(120), date, cents: cents.min(1),
  kind: z.enum(["bill", "income", "uncertainIncome"]),
  frequency: z.enum(["once", "monthly", "weekly", "yearly", "daily"]),
  interval: z.number().int().min(1).max(120).optional(),
}).strict();
const rentRunwayInput = z.object({ through: date, reserveCents: cents, rentEntryId: id }).strict();
const pendingMoneyItem = z.object({
  id, label: budgetEntry.shape.label, cents: budgetEntry.shape.cents, date: date.nullable(),
}).strict();
export const pendingMoneyInput = z.object({
  id, before: pendingMoneyItem.nullable(), after: pendingMoneyItem.nullable(),
}).strict().refine(({ id, before, after }) =>
  (!before || before.id === id) && (!after || after.id === id));
export function samePendingMoney(
  left: z.infer<typeof pendingMoneyItem> | null, right: z.infer<typeof pendingMoneyItem> | null,
) {
  return left === right || (!!left && !!right &&
    left.id === right.id && left.label === right.label && left.cents === right.cents && left.date === right.date);
}
export const budgetPlan = z.object({
  checkpoint: checkpoint.extend({ recordedAt: z.iso.datetime().optional() }).nullable(), foodCents: cents.nullable(), otherCents: cents.nullable(),
  entries: z.array(budgetEntry).max(100),
  pendingMoney: z.array(pendingMoneyItem).max(100).optional(),
  rentRunway: rentRunwayInput.optional(),
}).openapi("BudgetPlan");
export const emptyPlan = { checkpoint: null, foodCents: null, otherCents: null, entries: [] };
export const planPatch = z.object({
  checkpoint: checkpoint.optional(), foodCents: cents.optional(), otherCents: cents.optional(),
  rentRunway: rentRunwayInput.optional(),
  upsert: z.array(budgetEntry).max(100).optional(), remove: z.array(id).max(100).optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, "Supply explicit changes.");
export const budgetState = z.object({
  note: z.string(), revision: z.number().int(), plan: budgetPlan, proposal: planPatch.nullable(),
}).openapi("BudgetState");
export const noteInput = z.object({ revision: z.number().int().nonnegative(), note: z.string().max(50_000) }).strict();
export const proposalInput = z.object({ revision: z.number().int().nonnegative(), changes: planPatch }).strict();
export const applyInput = z.object({ revision: z.number().int().nonnegative(), action: z.enum(["apply", "dismiss"]) }).strict();
export const checkpointInput = z.object({ revision: z.number().int().nonnegative(), checkpoint }).strict();
const expenseFields = {
  id, merchant: z.string().trim().min(1).max(180), date,
  totalCents: signedCents, foodCents: signedCents, receiptId: id.nullable(),
  billKey: z.string().max(50).nullable(),
};
export const expense = z.object({ ...expenseFields, bankAccount: z.string().nullable().optional(),
  currency: currencyCode.optional(), originalAmountMinor: signedCents.nullable().optional(), originalFoodMinor: signedCents.nullable().optional(),
  originalCurrency: currencyCode.nullable().optional(), conversion: conversionSchema.nullable().optional(),
});
export const expenseInput = z.object({ ...expenseFields, currency: currencyCode.optional() }).strict().refine(value =>
  value.totalCents >= 0
    ? value.foodCents >= 0 && value.foodCents <= value.totalCents
    : value.foodCents <= 0 && value.foodCents >= value.totalCents, "Food allocation must fit the total.");
export const receiptLines = z.array(z.object({
  text: z.string().max(300), amount: z.string().max(30).nullable(),
})).max(250);
export const budgetDocumentKind = z.enum(["receipt", "invoice", "contract", "msa", "sow", "other"]);
export type BudgetDocumentKind = z.infer<typeof budgetDocumentKind>;
export const financialDocumentKinds: BudgetDocumentKind[] = ["receipt", "invoice"];
export function isFinancialDocument(kind: string): kind is "receipt" | "invoice" {
  return kind === "receipt" || kind === "invoice";
}
export function isCadBudgetDocument(kind: string, currency: string | null) {
  return isFinancialDocument(kind) && (currency === "CAD" || (kind === "receipt" && currency === null));
}
export function printedBudgetCurrency(text: string) {
  const markers: [string, RegExp][] = [
    ["CAD", /\bCAD\b|\bCA\$|\bC\$/i],
    ["USD", /\bUSD\b|\bUS\$/i],
    ["EUR", /\bEUR\b|€/i],
    ["GBP", /\bGBP\b|£/i],
    ["CHF", /\bCHF\b|Swiss francs?/i],
    ["AUD", /\bAUD\b|\bAU\$/i],
    ["NZD", /\bNZD\b|\bNZ\$/i],
    ["JPY", /\bJPY\b/i],
  ];
  const printed = markers.filter(([, marker]) => marker.test(text));
  return printed.length === 1 ? printed[0][0] : null;
}
const budgetDocumentMetadata = z.object({
  kind: budgetDocumentKind,
  title: z.string().trim().min(1).max(180).nullable(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable(),
  invoiceNumber: z.string().trim().min(1).max(80).nullable(),
  dueDate: date.nullable(),
  amazonAsin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/).nullable(),
});
export const budgetDocumentScanProvenance = z.enum(["upload_only", "ocr_completed"]).nullable().optional();
export const receipt = z.object({
  ...budgetDocumentMetadata.shape,
  id, merchant: z.string(), date: date.nullable(), totalCents: signedCents.nullable(),
  lines: receiptLines, mime: z.string().nullable(), createdAt: z.string(),
  scanStatus: z.string(), scanProvenance: budgetDocumentScanProvenance, expense: expense.nullable(),
}).openapi("BudgetReceipt");
export const receiptInput = z.object({
  ...budgetDocumentMetadata.partial().shape,
  merchant: z.string().trim().max(180), date: date.nullable(), totalCents: signedCents.nullable(), lines: receiptLines,
}).strict();
export const billMatchInput = z.object({ billKey: z.string().max(50).nullable() }).strict();
export const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax" }).format(new Date());

export function weekStart(value: string) {
  const weekday = new Date(value + "T00:00:00Z").getUTCDay();
  return shiftDate(value, -((weekday + 6) % 7));
}

export function billOccurrences(plan: z.infer<typeof budgetPlan>, from: string, through: string) {
  return plan.entries.flatMap(entry => scheduleOccurrences(entry, from, through))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const occurrence = budgetEntry.extend({ cents, key: z.string(), subscriptionId: z.uuid().optional() });
const month = z.object({ month: z.string(), cents: z.number().int() });
const flowMonth = z.object({
  month: z.string(), deposits: z.number().int(), refunds: z.number().int(),
  food: z.number().int(), other: z.number().int(), bills: z.number().int(),
});
const dailySpend = z.object({ date, food: z.number().int(), other: z.number().int() });

export function summarizeBudgetActivity(today: string, rows: {
  date: string; bankFlow: string | null; billKey: string | null; totalCents: number; foodCents: number;
}[]) {
  const start = weekStart(today);
  const week = Array.from({ length: 7 }, (_, i) => ({ date: shiftDate(start, i), food: 0, other: 0 }));
  const monthStart = today.slice(0, 7) + "-01";
  const cashFlow = [today.slice(0, 7), shiftDate(monthStart, -1).slice(0, 7)]
    .map(month => ({ month, deposits: 0, refunds: 0, food: 0, other: 0, bills: 0 }));
  const days = new Map(week.map(day => [day.date, day]));
  const months = new Map(cashFlow.map(month => [month.month, month]));
  for (const row of rows) {
    if (row.date > today || row.bankFlow === "transfer") continue;
    const month = months.get(row.date.slice(0, 7));
    if (month) {
      if (row.bankFlow === "deposit") month.deposits -= row.totalCents;
      else if (row.totalCents < 0) month.refunds -= row.totalCents;
      else if (row.billKey) month.bills += row.totalCents;
      else {
        month.food += row.foodCents;
        month.other += row.totalCents - row.foodCents;
      }
    }
    const day = days.get(row.date);
    if (day && !row.billKey && row.bankFlow !== "deposit") {
      day.food += row.foodCents;
      day.other += row.totalCents - row.foodCents;
    }
  }
  return { cashFlow, week };
}

export const overview = z.object({
  today: date, checkpoint: checkpoint.extend({ recordedAt: z.iso.datetime().optional() }).nullable(), foodLimit: cents.nullable(), otherLimit: cents.nullable(),
  foodSpent: z.number().int(), otherSpent: z.number().int(),
  available: z.number().int().nullable(), shortfall: date.nullable(), months: z.array(month),
  rentRunway: z.object({
    through: date, leftoverCents: z.number().int(), fullRentMonths: z.number().int().nonnegative(), reserveCents: cents,
  }).nullable(),
  weeklyAllowance: z.object({
    through: date, foodCents: z.number().int().nonnegative(),
    otherCents: z.number().int().nonnegative(),
    firstMandatoryShortfall: date.nullable(),
  }).nullable(),
  bills: z.array(occurrence), income: z.array(occurrence),
  projection: z.array(z.object({ date, cents: z.number().int(), baseline: z.number().int().optional() })),
  cashFlow: z.array(flowMonth), week: z.array(dailySpend), recent: z.array(expense),
});
type Plan = z.infer<typeof budgetPlan>;
type Expense = Pick<z.infer<typeof expense>, "date" | "foodCents" | "totalCents" | "billKey"> & { createdAt?: Date; bankAccount?: string | null };

export function forecast(plan: Plan, expenses: Expense[], today: string, options: {
  food?: number; other?: number; uncertain?: boolean; payments?: z.infer<typeof occurrence>[];
  limitsForWeek?: (week: string) => { food: number | null; other: number | null };
} = {}): Omit<z.infer<typeof overview>, "recent" | "cashFlow" | "week"> {
  const start = weekStart(today);
  const limitsForWeek = options.limitsForWeek ?? (() => ({ food: plan.foodCents, other: plan.otherCents }));
  const currentLimits = limitsForWeek(start);
  const foodLimit = options.food ?? currentLimits.food;
  const otherLimit = options.other ?? currentLimits.other;
  const spent = expenses.filter(e => !e.billKey && e.date >= start && e.date <= today)
    .reduce((sum, e) => ({ food: sum.food + e.foodCents, other: sum.other + e.totalCents - e.foodCents }), { food: 0, other: 0 });
  const baseline = plan.checkpoint?.date;
  const paid = new Set(expenses.flatMap(e => e.billKey ? [e.billKey] : []));
  const horizon = shiftDate(today, 365);
  const events = [...billOccurrences(plan, baseline ?? today, horizon), ...(options.payments ?? [])]
    .filter(e => e.date >= (baseline ?? today) && e.date <= horizon && !paid.has(e.key))
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcomingThrough = shiftDate(today, 45);
  const bills = events.filter(e => e.kind === "bill" && e.date <= upcomingThrough);
  const income = events.filter(e => e.kind !== "bill" && e.date >= today && e.date <= upcomingThrough);
  const projection: { date: string; cents: number }[] = [];
  let available = plan.checkpoint?.cents ?? null;
  if (available !== null && baseline) {
    for (const e of expenses) {
      const sameDayAfterReset = !e.bankAccount && e.date === baseline && plan.checkpoint?.recordedAt && e.createdAt &&
        e.createdAt.getTime() > Date.parse(plan.checkpoint.recordedAt);
      if ((e.date > baseline || sameDayAfterReset) && e.date <= today) available -= e.totalCents;
    }
    for (const e of events) if (e.kind === "income" && e.date > baseline && e.date <= today) available += e.cents;
  }
  let rentRunway: z.infer<typeof overview>["rentRunway"] = null;
  let weeklyAllowance: z.infer<typeof overview>["weeklyAllowance"] = null;
  const runway = plan.rentRunway;
  if (available !== null && runway && runway.through >= today && runway.through <= horizon) {
    const rent = plan.entries.find(entry => entry.id === runway.rentEntryId && entry.kind === "bill" && entry.frequency === "monthly");
    if (rent) {
      const mandatory = new Map<string, number>();
      for (const event of events) {
        if (event.date > runway.through) break;
        if (event.kind !== "bill" && (event.kind !== "income" || event.date <= today)) continue;
        const due = event.date < today ? today : event.date;
        mandatory.set(due, (mandatory.get(due) ?? 0) + (event.kind === "bill" ? -event.cents : event.cents));
      }
      let leftoverCents = available - runway.reserveCents;
      let weeklyCents = Infinity;
      let firstMandatoryShortfall: string | null = null;
      for (let day = today, days = 1; day <= runway.through; day = shiftDate(day, 1), days++) {
        leftoverCents += mandatory.get(day) ?? 0;
        // Each day caps the spending pace, even if later income restores the balance.
        weeklyCents = Math.min(weeklyCents, Math.floor(leftoverCents * 7 / days));
        if (leftoverCents < 0) firstMandatoryShortfall ??= day;
      }
      weeklyCents = Math.max(0, weeklyCents);
      const plannedFood = currentLimits.food ?? 0;
      const plannedTotal = plannedFood + (currentLimits.other ?? 0);
      const foodShare = currentLimits.food === null || currentLimits.other === null || plannedTotal === 0 ? 0.5 : plannedFood / plannedTotal;
      const foodCents = Math.round(weeklyCents * foodShare);
      weeklyAllowance = { through: runway.through, foodCents, otherCents: weeklyCents - foodCents, firstMandatoryShortfall };
      rentRunway = {
        through: runway.through, leftoverCents, reserveCents: runway.reserveCents,
        fullRentMonths: Math.floor(Math.max(0, leftoverCents) / rent.cents),
      };
    }
  }
  const months: { month: string; cents: number }[] = [];
  let shortfall: string | null = null;
  if (available !== null && foodLimit !== null && otherLimit !== null) {
    let projected = available;
    const scheduled = new Map<string, number>();
    for (const e of events) {
      if (e.kind === "income" && e.date <= today) continue;
      if (e.kind === "uncertainIncome" && (!options.uncertain || e.date <= today)) continue;
      const due = e.date < today ? today : e.date;
      scheduled.set(due, (scheduled.get(due) ?? 0) + (e.kind === "bill" ? -e.cents : e.cents));
    }
    const chartEnd = shiftDate(today, 90);
    for (let day = today; day <= horizon; day = shiftDate(day, 1)) {
      projected += scheduled.get(day) ?? 0;
      if (day === today) projected -= Math.max(0, foodLimit - spent.food) + Math.max(0, otherLimit - spent.other);
      else if (weekStart(day) === day) {
        const limits = limitsForWeek(day);
        projected -= (options.food ?? limits.food ?? foodLimit) + (options.other ?? limits.other ?? otherLimit);
      }
      if (day <= chartEnd) projection.push({ date: day, cents: projected });
      if (shortfall === null && projected < 0) shortfall = day;
      if (shiftDate(day, 1).slice(0, 7) !== day.slice(0, 7)) months.push({ month: day.slice(0, 7), cents: projected });
    }
  }
  return { today, checkpoint: plan.checkpoint, foodLimit, otherLimit, foodSpent: spent.food,
    otherSpent: spent.other, available, shortfall, months, bills, income, projection, rentRunway, weeklyAllowance };
}
