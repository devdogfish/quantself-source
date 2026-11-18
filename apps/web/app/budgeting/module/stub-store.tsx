"use client";

// Shared API-backed state and optimistic writes for the Budgeting module.
import { createContext, useContext, useMemo, useState, useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { fetchModuleOverview, type ModuleOverview } from "./overview-client";
import { useRecurringRules, type RecurringRule } from "./subscriptions-data";
import { projectRecurringOverview } from "./overview-recurring";
import { useTransactionLog, useTransactionState, type TransactionAction } from "./transaction-store";
import { projectOverview, type CashSnapshot, type OverviewSnapshot } from "./overview-mutations";
import type { BudgetLogData } from "./transaction-client";

import { budgetToday } from "../budget-date";
const monday = (day: string) => new Date(Date.parse(day + "T00:00:00Z") - ((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
export let TODAY = budgetToday();
export let WEEK_START = monday(TODAY);

export type Allowance = "food" | "other";
export type Expense = {
  id: string; date: string; merchant: string; cents: number; allowance: Allowance; category: string;
  reviewed: boolean; receipt: boolean; foodCents?: number; original?: { currency: string; cents: number };
};
export type Bill = { key: string; date: string; label: string; cents: number; kind: "bill" | "subscription" };
export type Income = { key: string; date: string; label: string; cents: number; uncertain?: boolean };
export type Rule = RecurringRule;
export type WeekRecord = { start: string; food: number; other: number; foodLimit: number; otherLimit: number };

export const categories: Record<Allowance, string[]> = {
  food: ["Groceries", "Eating out", "Coffee"],
  other: ["Transport", "Household", "Health", "Fun", "Clothing"],
};

export type State = { overview?: ModuleOverview; log?: BudgetLogData; foodLimit: number; otherLimit: number; cash: number; expenses: Expense[]; bills: Bill[]; income: Income[]; history: WeekRecord[]; skipped: { id: string; date: string; label: string; cents: number }[]; loggedDays: string[]; rules: Rule[] };

const initial: State = {
  foodLimit: 0, otherLimit: 0, cash: 0, expenses: [], bills: [], income: [], history: [], skipped: [], loggedDays: [],
  rules: [],
};

type RuleAction = { type: "rule"; key: string; patch: Partial<Rule> };
type Action = TransactionAction | RuleAction;

const Ctx = createContext<{
  s: State;
  dispatch: (a: Action) => void;
  undoable: (title: string, a: Action) => void;
  setPeriod: (mode: "week" | "month", offset: number) => void;
  loading: boolean;
  error: string;
  retry: () => void;
  transaction: ReturnType<typeof useTransactionState>;
  log: ReturnType<typeof useTransactionLog>;
  recurring: ReturnType<typeof useRecurringRules>;
} | null>(null);

export function BudgetingStubStore({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const enabled = path === "/budgeting";
  const recurring = useRecurringRules(path === "/budgeting/subscriptions");
  const rules = recurring.rules;
  const recurringIds = useRef("");
  recurringIds.current = recurring.schedules.map(({ item }) => item.id).join(",");
  const requestedRuleIds = useRef(new Set<string>());
  const requestedContextRuleIds = useRef(new Set<string>());
  const currentRecurringRefresh = useRef(recurring.refresh);
  const recurringRefresh = useRef(recurring.refresh);
  recurringRefresh.current = recurring.refresh;
  const transaction = useTransactionState();
  const log = useTransactionLog(transaction, path === "/budgeting/log");
  const [selection, setSelection] = useState({ mode: "month" as "week" | "month", offset: 0 });
  const setPeriod = useCallback((mode: "week" | "month", offset: number) => setSelection(old => old.mode === mode && old.offset === offset ? old : { mode, offset }), []);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>();
  const context = useRef<CashSnapshot | undefined>(undefined);
  const contextDate = useRef<string | undefined>(undefined);
  const refreshContext = useRef(false);
  const requestedDay = useRef(budgetToday());
  const latestVersion = useRef(transaction.version);
  latestVersion.current = transaction.version;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    refreshContext.current = true;
    setAttempt(n => n + 1);
  }, []);
  const overview = useMemo(() => {
    if (!snapshot) return;
    const projected = projectOverview(snapshot, context.current, transaction);
    return projectRecurringOverview(projected, snapshot.value.rules, context.current?.rules, recurring.schedules);
  }, [snapshot, transaction, recurring.schedules]);
  useEffect(() => {
    if (!enabled) { context.current = undefined; setPeriod("month", 0); return; }
    const controller = new AbortController();
    const version = latestVersion.current;
    currentRecurringRefresh.current = recurringRefresh.current;
    const ruleIds = recurringIds.current || undefined;
    requestedRuleIds.current = new Set(ruleIds?.split(",") ?? []);
    const needsContext = !context.current || refreshContext.current || recurringIds.current.split(",").some(id => id && !requestedContextRuleIds.current.has(id));
    const rulesForRequest = requestedRuleIds.current;
    setLoading(true); setError("");
    fetchModuleOverview({
      ...selection, context: needsContext ? "yes" : "no", contextDate: contextDate.current, session: transaction.session, ruleIds,
    }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      TODAY = data.today; WEEK_START = monday(data.today);
      const applied = data.applied;
      if (data.context) {
        context.current = { value: data.context, version, applied, rules: data.rules };
        requestedContextRuleIds.current = rulesForRequest;
        contextDate.current = data.today;
        refreshContext.current = false;
      }
      setSnapshot({ value: data, version, applied });
      setLoading(false);
    }, cause => { if (!controller.signal.aborted) { setError(cause.message); setLoading(false); } });
    return () => controller.abort();
  }, [enabled, selection, attempt, setPeriod, transaction.session]);
  useEffect(() => {
    if (!enabled) return;
    const checkDate = () => {
      const day = budgetToday();
      if (day === requestedDay.current) return;
      requestedDay.current = day;
      retry();
    };
    const timer = window.setInterval(checkDate, 60_000);
    window.addEventListener("focus", checkDate);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", checkDate); };
  }, [enabled, retry]);
  useEffect(() => {
    if (!enabled || transaction.refresh === 0) return;
    retry();
  }, [enabled, transaction.refresh, retry]);

  useEffect(() => {
    if (!enabled) return;
    const conflict = currentRecurringRefresh.current !== recurring.refresh;
    currentRecurringRefresh.current = recurring.refresh;
    // A retained Undo/Redo can change a rule while Overview is open. Ordinary queue
    // acknowledgements use the existing potential schedule and need no collection reread.
    if (conflict || recurring.schedules.some(({ item, created }) => !created && !requestedRuleIds.current.has(item.id))) retry();
  }, [enabled, recurring.refresh, recurring.schedules, retry]);

  const logData = log.value;
  const s: State = enabled ? {
    ...initial, foodLimit: overview?.context?.foodLimit ?? 0, otherLimit: overview?.context?.otherLimit ?? 0,
    cash: overview?.context?.cash ?? 0, expenses: overview?.statements[0]?.spending ?? [], rules, overview,
  } : {
    ...initial, foodLimit: logData?.foodLimit ?? 0, otherLimit: logData?.otherLimit ?? 0, expenses: logData?.unreviewed ?? [],
    history: logData?.history.map(week => ({ ...week, foodLimit: week.foodLimit ?? 0, otherLimit: week.otherLimit ?? 0 })) ?? [],
    skipped: logData?.skipped ?? [], loggedDays: logData?.loggedDays ?? [], rules, log: logData ?? undefined,
  };
  const dispatch = (a: Action) => {
    if (a.type === "rule") recurring.patch(null, a.key, a.patch);
    else transaction.dispatch(a);
  };
  const undoable = (title: string, a: Action) => {
    if (a.type === "rule") recurring.patch(title, a.key, a.patch);
    else transaction.undoable(title, a);
  };
  const writeError = enabled ? transaction.error || recurring.writeError : "";
  const retryCurrent = error ? retry : transaction.retryable ? transaction.retry : recurring.writeRetryable ? recurring.retry : retry;
  return <Ctx.Provider value={{ s, dispatch, undoable, setPeriod, loading,
    error: error || writeError, retry: retryCurrent, transaction, log, recurring }}>{children}</Ctx.Provider>;
}

export function useBudgetStore() {
  const c = useContext(Ctx);
  if (!c) throw Error("BudgetingStubStore missing");
  return c;
}

// Numbers derived from the Overview and Log responses.

export const DAY = 86_400_000;
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export function useBudgetNumbers() {
  const { s } = useBudgetStore();
  return useMemo(() => {
    const today = s.log?.today ?? TODAY;
    const start = s.log?.weekStart ?? WEEK_START;
    const week = s.expenses.filter(x => x.date >= start && x.date <= today);
    const foodSpent = s.log ? s.log.week.reduce((sum, day) => sum + day.food, 0) : week.reduce((sum, x) => sum + (x.foodCents ?? (x.allowance === "food" ? x.cents : 0)), 0);
    const otherSpent = s.log ? s.log.week.reduce((sum, day) => sum + day.other, 0) : week.reduce((sum, x) => sum + x.cents - (x.foodCents ?? (x.allowance === "food" ? x.cents : 0)), 0);
    const dayOfWeek = daysBetween(start, today) + 1;
    const daysLeft = 8 - dayOfWeek;
    const limit = s.foodLimit + s.otherLimit;
    const spent = foodSpent + otherSpent;
    const unreviewed = s.expenses.filter(x => !x.reviewed);
    const logLeft = s.log && s.log.foodLimit !== null && s.log.otherLimit !== null ? limit - spent : null;
    let cumulative = 0;
    const pace = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      const logDay = s.log?.week.find(day => day.date === date);
      cumulative += logDay ? logDay.food + logDay.other : week.filter(x => x.date === date).reduce((sum, x) => sum + x.cents, 0);
      return { date, label: weekday(date), spent: date > today ? null : cumulative, pace: Math.round(limit * (i + 1) / 7) };
    });
    const projection = s.overview?.context?.balance.filter(point => point.date >= today && point.date <= addDays(today, 90)) ?? [];
    const low = projection.reduce((a, b) => b.cents < a.cents ? b : a, { date: today, cents: s.cash });
    const upcoming = s.overview?.context?.upcoming ?? [];
    const nextPay = upcoming.find(event => event.kind === "income" && !event.uncertain);
    const billsBeforePay = nextPay ? upcoming.filter(event => event.kind !== "income" && event.date < nextPay.date).reduce((sum, event) => sum + event.cents, 0) : 0;
    const categoryTotals = new Map<string, { name: string; cents: number; allowance: Allowance }>();
    for (const { category: name, cents, allowance } of week) {
      const total = categoryTotals.get(name) ?? { name, cents: 0, allowance };
      total.cents += cents;
      categoryTotals.set(name, total);
    }
    const byCategory = [...categoryTotals.values()].sort((a, b) => b.cents - a.cents);
    const streak = (() => { let n = 0; for (let i = s.history.length - 1; i >= 0; i--) { const w = s.history[i]; if (w.food + w.other <= w.foodLimit + w.otherLimit) n++; else break; } return n; })();
    return { ...s, week, foodSpent, otherSpent, spent, limit, left: limit - spent, logLeft, dayOfWeek, daysLeft, unreviewed, pace, projection, low, upcoming, billsBeforePay, byCategory, streak };
  }, [s]);
}

// ---- Formatting ----
const CAD = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const CAD0 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
export const money = (cents: number) => CAD.format(cents / 100).replace("-", "−");
export const money0 = (cents: number) => CAD0.format(Math.round(cents / 100)).replace("-", "−");
export const short = (iso: string) => new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));
export const weekday = (iso: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));
