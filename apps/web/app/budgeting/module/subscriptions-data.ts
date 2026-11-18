"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { currentTerm, decimalMoney, recurrenceLabel, shiftDate, subscriptionPayments, yearlyEquivalent, type Subscription } from "@quantself/budgeting";
import { toaster } from "@/components/chakra/toaster";
import { budgetRequest } from "../budgeting-client";
import { SubscriptionStore } from "../subscription-store";

export type RecurringRule = {
  key: string;
  name: string;
  kind: "subscription" | "bill" | "income";
  every: string;
  cents: number;
  original?: { currency: string; cents: number; display?: string };
  category: string;
  next: string;
  status: "active" | "paused" | "cancelled";
  reviewed: string | null;
  since: string;
  doc?: string;
  perYearCents?: number;
  next30Cents?: number;
  charges?: { id: string; date: string; cents: number }[];
  oneOff?: boolean;
};

const store = new SubscriptionStore({
  read: () => budgetRequest<"listBudgetSubscriptions">("/subscriptions"),
  write: (id, input) => budgetRequest<"saveBudgetSubscription">(`/subscriptions/${id}`, "PUT", input),
  changed: () => window.dispatchEvent(new Event("budget-subscriptions-changed")),
});

function nextScheduledPayment(item: Subscription, from: string, paid: Set<string>) {
  const terms = [...item.terms].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  for (const [index, term] of terms.entries()) {
    const start = [from, term.effectiveOn, term.startOn].sort().at(-1)!;
    const gap = { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[term.frequency] * term.interval;
    const deadline = terms[index + 1]?.effectiveOn;
    let through = shiftDate(start, gap);
    if (deadline && deadline <= through) through = shiftDate(deadline, -1);
    const payment = subscriptionPayments({ ...item, terms: [term] }, start, through)
      .find(payment => !paid.has(payment.key));
    if (payment) return payment;
  }
}

export function recurringRule(
  item: Subscription, today: string, paid: Set<string>, charges: RecurringRule["charges"],
): RecurringRule | null {
  if (item.status === "candidate" || item.status === "dismissed") return null;
  const status = item.status === "cancelled" || (item.stopsOn && item.stopsOn <= today) ? "cancelled"
    : item.status === "paused" ? "paused" : "active";
  const term = currentTerm(item, today);
  const original = term?.currency && term.currency !== "CAD"
    ? { currency: term.currency, cents: term.amountCents, display: decimalMoney({ currency: term.currency, amountMinor: term.amountCents }) }
    : undefined;
  const cents = original ? term?.cadAmountCents ?? 0 : term?.amountCents ?? 0;
  const priced = { ...item, status: "active" as const };
  const hasPrices = item.terms.every(term => !term.currency || term.currency === "CAD" || term.cadAmountCents !== undefined);
  const next30 = hasPrices ? subscriptionPayments(priced, today, shiftDate(today, 29)).filter(payment => !paid.has(payment.key)) : [];
  const next = next30[0] ?? (hasPrices ? nextScheduledPayment(priced, shiftDate(today, 30), paid) : undefined);
  const every = term ? recurrenceLabel({ ...term, id: item.id, date: term.startOn, cents }).slice("Every ".length) : "";
  return {
    key: item.id, name: item.name, kind: item.kind ?? "subscription", category: item.category ?? "",
    every, cents, original, next: next?.date ?? "", status, reviewed: item.lastReviewed ?? null,
    since: item.terms.map(term => term.startOn).sort()[0] ?? "", doc: item.documentId ?? undefined,
    perYearCents: term ? yearlyEquivalent({ ...term, cadAmountCents: cents }) : 0,
    next30Cents: next30.reduce((sum, charge) => sum + charge.cents, 0),
    charges: charges ?? [],
  };
}

function offerUndo(title: string, change: ReturnType<SubscriptionStore["change"]>) {
  if (!change) return;
  toaster.create({
    title, type: "info", duration: 5000,
    action: { label: "Undo", onClick: () => {
      const redo = store.undo(change);
      if (!redo) return;
      toaster.create({ title: "Change undone", type: "info", duration: 5000, action: { label: "Redo", onClick: () => store.redo(redo) } });
    } },
  });
}

function patch(title: string | null, key: string, change: Partial<RecurringRule>) {
  const item = store.getSnapshot().items.find(item => item.id === key);
  if (!item) return;
  const status = change.status;
  const intent = store.patch(key, {
    ...(status !== undefined ? { status } : {}),
    ...(status === "active" && item.stopsOn ? { stopsOn: null } : {}),
    ...(change.reviewed !== undefined ? { lastReviewed: change.reviewed } : {}),
    ...("doc" in change ? { documentId: change.doc ?? null } : {}),
  }, title !== null);
  if (title !== null) offerUndo(title, intent);
}

function save(item: Subscription) {
  offerUndo(`${item.name} added`, store.change(item));
}

export function useRecurringRules(enabled = true) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (enabled) void store.load();
  }, [enabled, snapshot.settlementRefresh]);
  const rules = useMemo(() => {
    const paid = new Set(snapshot.paidKeys);
    return snapshot.today ? snapshot.items.flatMap(item => recurringRule(item, snapshot.today, paid, snapshot.charges[item.id]) ?? []) : [];
  }, [snapshot.today, snapshot.items, snapshot.paidKeys, snapshot.charges]);
  const oneOff = useMemo(() => snapshot.oneOff.map((item): RecurringRule => ({
    key: item.id, name: item.name, kind: item.kind, every: "once", cents: item.cents,
    category: "", next: item.date, status: "active", reviewed: null, since: item.date,
    charges: snapshot.charges[item.id], oneOff: true,
  })), [snapshot.oneOff, snapshot.charges]);
  return { rules, oneOff, schedules: snapshot.schedules, refresh: snapshot.refresh, today: snapshot.today, loading: snapshot.loading, error: snapshot.error, writeError: snapshot.writeError, writeRetryable: !!snapshot.retryable.length, save, patch,
    retry: snapshot.retryable.length ? store.retry : store.load, reload: store.load };
}
