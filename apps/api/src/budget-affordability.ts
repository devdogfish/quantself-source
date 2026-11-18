import { z } from "@hono/zod-openapi";
import { budgetPlan, forecast, shiftDate } from "./budgeting";
export const purchaseQuery = z.object({ amount: z.coerce.number().int().min(0).max(100_000_000), date: z.iso.date() });
export const affordabilityResult = z.object({
  today: z.iso.date(), date: z.iso.date(), amount: z.number().int(),
  available: z.number().int().nullable(), leftoverBefore: z.number().int().nullable(), leftoverAfter: z.number().int().nullable(),
  rentMonthsBefore: z.number().int().nullable(), rentMonthsAfter: z.number().int().nullable(),
  shortfallBefore: z.iso.date().nullable(), shortfallAfter: z.iso.date().nullable(), through: z.iso.date(),
  reserveCents: z.number().int(),
});
export function previewPurchase(plan: z.infer<typeof budgetPlan>, expenses: Parameters<typeof forecast>[1], today: string,
  purchase: z.infer<typeof purchaseQuery>, payments: NonNullable<Parameters<typeof forecast>[3]>["payments"] = []) {
  if (purchase.date < today || purchase.date > shiftDate(today, 365)) throw Error("Choose a purchase date within the next year.");
  const reserve = plan.rentRunway?.reserveCents ?? 0;
  // Reserve debt once, up front, for a conservative payment-timing check.
  const reserved = { ...plan, checkpoint: plan.checkpoint ? { ...plan.checkpoint, cents: plan.checkpoint.cents - reserve } : null,
    ...(plan.rentRunway ? { rentRunway: { ...plan.rentRunway, reserveCents: 0 } } : {}) };
  const options = { food: 0, other: 0, payments };
  const before = forecast(reserved, expenses, today, options);
  const purchasePayment = { id: "00000000-0000-4000-8000-000000000001", key: "purchase-preview", label: "Purchase preview",
    date: purchase.date, cents: purchase.amount, kind: "bill" as const, frequency: "once" as const };
  const after = forecast(reserved, expenses, today, { ...options, payments: [...payments, purchasePayment] });
  return { today, date: purchase.date, amount: purchase.amount, available: before.available,
    leftoverBefore: before.rentRunway?.leftoverCents ?? null, leftoverAfter: after.rentRunway?.leftoverCents ?? null,
    rentMonthsBefore: before.rentRunway?.fullRentMonths ?? null, rentMonthsAfter: after.rentRunway?.fullRentMonths ?? null,
    shortfallBefore: before.shortfall, shortfallAfter: after.shortfall,
    through: before.rentRunway?.through ?? shiftDate(today, 365), reserveCents: reserve };
}
