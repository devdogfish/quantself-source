import type { Currency, Conversion } from "./money";
import { scheduleOccurrences, shiftDate } from "./schedule";
export type SubscriptionTerm = {
  effectiveOn: string; startOn: string; amountCents: number;
  frequency: "daily" | "weekly" | "monthly" | "yearly"; interval: number;
  currency?: Currency; cadAmountCents?: number; conversion?: Conversion;
};
export type Subscription = {
  id: string; revision: number; commandId: string; name: string;
  status: "active" | "trial" | "candidate" | "dismissed" | "paused" | "cancelled";
  kind?: "subscription" | "bill" | "income";
  category?: string;
  lastReviewed?: string | null;
  documentId?: string | null;
  planEntry?: boolean;
  stopsOn: string | null; websiteUrl: string | null; cancelUrl: string | null;
  logoKey: string | null; estimated: boolean; terms: SubscriptionTerm[];
  evidence: string; sourceKey: string | null;
};
export type SubscriptionPayment = {
  id: string; key: string; label: string; date: string; cents: number;
  kind: "bill" | "income"; frequency: "once"; subscriptionId: string;
};
export function subscriptionCadAmount(term: SubscriptionTerm) {
  if (!term.currency || term.currency === "CAD") return term.amountCents;
  if (term.cadAmountCents === undefined) throw Error("Subscription exchange rate unavailable.");
  return term.cadAmountCents;
}
export function subscriptionPayments(item: Subscription, from: string, through: string): SubscriptionPayment[] {
  if (["candidate", "dismissed", "paused", "cancelled"].includes(item.status)) return [];
  const terms = [...item.terms].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  return terms.flatMap((term, index) => {
    const next = terms[index + 1]?.effectiveOn;
    const start = from > term.effectiveOn ? from : term.effectiveOn;
    const end = next && next <= through ? shiftDate(next, -1) : through;
    return scheduleOccurrences({ id: item.id, date: term.startOn, cents: subscriptionCadAmount(term),
      frequency: term.frequency, interval: term.interval, subscription: { cancelledOn: item.stopsOn } }, start, end)
      .map(({ date, cents, key }) => ({ id: item.id, key: item.planEntry ? key : `${item.id}:${date}`, label: item.name,
        date, cents, kind: item.kind === "income" ? "income" as const : "bill" as const, frequency: "once" as const, subscriptionId: item.id }));
  });
}
export function subscriptionStatus(item: Subscription, today: string) {
  if (item.status === "candidate") return "Needs schedule";
  if (item.status === "dismissed") return "Dismissed";
  if (item.status === "paused") return "Paused";
  if (item.status === "cancelled") return "Canceled";
  if (item.stopsOn) return item.stopsOn <= today ? "Canceled" : "Canceling";
  const firstCharge = item.terms.map(term => term.startOn).sort()[0];
  return item.status === "trial" && firstCharge && today < firstCharge ? "Trial" : "Active";
}
export function currentTerm(item: Subscription, today: string) {
  const terms = [...item.terms].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  return terms.findLast(term => term.effectiveOn <= today) ?? terms[0];
}
export function monthlyEquivalent(item: Subscription, today: string) {
  if (["candidate", "dismissed", "paused", "cancelled"].includes(item.status) || (item.stopsOn && item.stopsOn <= today)) return 0;
  const term = currentTerm(item, today);
  if (!term) return 0;
  return yearlyEquivalent(term) / 12;
}

export function yearlyEquivalent(term: SubscriptionTerm) {
  const occurrences = { daily: 365.25, weekly: 52, monthly: 12, yearly: 1 };
  return subscriptionCadAmount(term) * occurrences[term.frequency] / term.interval;
}
