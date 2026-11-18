"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toaster } from "@/components/chakra/toaster";
import { budgetRequest, errorMessage } from "../budgeting-client";
import {
  readBudgetLog, readTransaction, readTransactionCsv, readTransactionPage, transactionQuery, writeTransaction,
  type Allowance, type BudgetLogData, type Transaction, type TransactionCommand, type TransactionFilters, type TransactionPage,
} from "./transaction-client";
import { projectBudgetLog, projectExpense, projectReceiptLinks, projectTransactionPage, reverseIntent, TransactionQueue, unappliedTransactionIntents, type Intent } from "./transaction-queue";

import { budgetToday } from "../budget-date";

export { budgetToday } from "../budget-date";

type AddExpense = Extract<TransactionCommand, { type: "add" }>["expense"];
export type TransactionAction =
  | { type: "add"; expense: AddExpense }
  | { type: "review"; expense: Transaction; reviewed: boolean }
  | { type: "move"; expense: Transaction; allowance: Allowance; category: string }
  | { type: "reviewAll"; log: BudgetLogData }
  | { type: "receipt"; expense: Transaction; receiptId: string }
  | { type: "skip"; date: string; label: string; cents: number }
  | { type: "limit"; log: BudgetLogData; allowance: Allowance; cents: number }
  // Weekly limits modal: set a limit from `week` on; `before` is that week's saved override (null = none).
  | { type: "weekLimit"; week: string; allowance: Allowance; before: number | null; cents: number | null };

export function transactionIntent(action: TransactionAction, today: string, identify: () => string = () => crypto.randomUUID()): Intent {
  switch (action.type) {
    case "add": {
      const expense = { ...action.expense, merchant: action.expense.merchant.trim() };
      return { command: { type: "add", expense }, changes: [{ before: null, after: {
        ...expense, foodCents: expense.allowance === "food" ? expense.cents : 0, reviewed: false, receipt: false,
        receiptId: null, manualReceiptMatch: false, billKey: null, subscriptionId: null,
      } }] };
    }
    case "move": {
      const { expense, allowance, category } = action;
      return { command: { type: "move", id: expense.id, before: { allowance: expense.allowance, category: expense.category, foodCents: expense.foodCents },
        after: { allowance, category } }, changes: [{ before: expense, after: { ...expense, allowance, category, foodCents: allowance === "food" ? expense.cents : 0 } }] };
    }
    case "review":
      return { command: { type: "review", id: action.expense.id, before: action.expense.reviewed, after: action.reviewed },
        changes: [{ before: action.expense, after: { ...action.expense, reviewed: action.reviewed } }] };
    case "receipt":
      return { command: {
        type: "receipt", id: action.expense.id, before: action.expense.receiptId, after: action.receiptId,
        beforeManualReceiptMatch: action.expense.manualReceiptMatch ?? false, afterManualReceiptMatch: true,
      }, changes: [{ before: action.expense, after: { ...action.expense, receiptId: action.receiptId, receipt: true, manualReceiptMatch: true } }] };
    case "reviewAll": {
      const { log } = action;
      return { command: { type: "reviewAll", ids: log.unreviewed.map(x => x.id), date: log.today,
        before: { reviewed: false, checkedIn: log.checkedInToday }, after: { reviewed: true, checkedIn: true } },
        changes: log.unreviewed.map(expense => ({ before: expense, after: { ...expense, reviewed: true } })) };
    }
    case "skip": {
      const id = identify();
      return { command: { type: "skip", id, before: null, after: { id, date: action.date || today, label: action.label.trim(), cents: action.cents } }, changes: [] };
    }
    case "limit":
      return { command: { type: "limit", allowance: action.allowance, week: action.log.nextLimitWeek,
        before: action.log.nextLimitOverrides[action.allowance], after: action.cents }, changes: [] };
    case "weekLimit":
      return { command: { type: "limit", allowance: action.allowance, week: action.week, before: action.before, after: action.cents }, changes: [] };
  }
}

const Context = createContext<{ queue: TransactionQueue; session: string } | null>(null);

export function BudgetTransactionProvider({ children }: { children: ReactNode }) {
  const [value] = useState(() => {
    const session = crypto.randomUUID();
    return { session, queue: new TransactionQueue((id, command) => writeTransaction(id, command, session)) };
  });
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTransactionState() {
  const context = useContext(Context);
  if (!context) throw new Error("BudgetTransactionProvider missing");
  const { queue, session } = context;
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return {
    ...snapshot, session,
    retry: queue.retry, waitForIdle: queue.waitForIdle,
    dispatch: (action: TransactionAction) => queue.enqueue(transactionIntent(action, budgetToday())),
    undoable: (title: string, action: TransactionAction) => {
      const intent = transactionIntent(action, budgetToday());
      let active = true;
      let commandId: string | undefined;
      const undo = () => {
        if (!active || !commandId || !queue.canReverse(commandId)) return;
        const next = queue.enqueue(reverseIntent(intent));
        if (!next) return;
        active = false;
        commandId = next;
        toaster.create({ title: "Undone", type: "info", duration: 5000, action: { label: "Redo", onClick: redo } });
      };
      const redo = () => {
        if (active || commandId && !queue.canReverse(commandId)) return;
        const next = queue.enqueue(intent);
        if (!next) return;
        active = true;
        commandId = next;
        toaster.create({ title, type: "info", duration: 5000, action: { label: "Undo", onClick: undo } });
      };
      active = false;
      redo();
    },
  };
}

type Read<T> = (key: string, signal: AbortSignal) => Promise<T>;

function useTransactionRead<T>(key: string | null, read: Read<T>, snapshot: ReturnType<typeof useTransactionState>, invalidate = 0, delay = 0, reconcile = false) {
  const [state, setState] = useState<{ key: string; value: T; version: number; refresh: number } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const start = () => {
      const { version: requestedVersion, session, refresh } = snapshotRef.current;
      // The server snapshot may include a write whose acknowledgement is still held
      // in flight. Reconcile against command IDs from that same snapshot.
      const path = reconcile ? key + (key.includes("?") ? "&" : "?") + "session=" + session : key;
      setFailure(null);
      void read(path, controller.signal).then(
        value => { if (!controller.signal.aborted) setState({ key, value, version: requestedVersion, refresh }); },
        cause => { if (!controller.signal.aborted) setFailure({ key, error: errorMessage(cause) }); },
      );
    };
    const timer = delay ? setTimeout(start, delay) : undefined;
    if (!delay) start();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, read, snapshot.refresh, invalidate, attempt, delay, reconcile]);
  const current = state?.key === key ? state : null;
  const error = failure?.key === key ? failure.error : "";
  const intents = unappliedTransactionIntents(snapshot, current?.version ?? -1,
    (current?.value as { applied?: string[] } | undefined)?.applied);
  return { value: current?.value ?? null, readVersion: current?.version, readRefresh: current?.refresh, applied: (current?.value as { applied?: string[] } | undefined)?.applied, intents, error, loading: key !== null && !current && !error, reload: () => setAttempt(x => x + 1) };
}

const loadPage: Read<TransactionPage> = readTransactionPage;
const loadDetail: Read<Transaction> = readTransaction;
const loadLog: Read<BudgetLogData> = readBudgetLog;
const blankPage: TransactionPage = { today: "", rows: [], count: 0, totalCents: 0 };

export function useTransactionPage(filters: TransactionFilters, drawerId: string | null, snapshot: ReturnType<typeof useTransactionState>) {
  const query = transactionQuery(filters);
  // Refill gaps (for example, confirming from To review) after a completed burst.
  // Known rows still update immediately from the command projection.
  const [filledVersion, setFilledVersion] = useState(snapshot.version);
  const refill = snapshot.committed.some(item => item.version > filledVersion &&
    (item.command.type === "remove" || item.command.type === "add" && (filters.page ?? 1) > 1 || (item.command.type === "review" || item.command.type === "reviewAll") && filters.seg === "review" ||
      item.command.type === "receipt" && filters.seg === "missing" || item.command.type === "move" && !!(filters.cat || filters.q)));
  useEffect(() => {
    if (!refill || snapshot.pending.length) return;
    const timer = setTimeout(() => setFilledVersion(snapshot.version), 100);
    return () => clearTimeout(timer);
  }, [refill, snapshot.pending.length, snapshot.version]);
  const page = useTransactionRead(query, loadPage, snapshot, filledVersion, filters.q ? 170 : 0, true);
  const data = useMemo(() => projectTransactionPage(page.value ?? blankPage, filters, page.intents), [page.value, filters, page.intents]);
  // A drawer click on a row that is already loaded costs no additional request. A deep link
  // starts its detail request alongside the table, even if the row is off the selected page.
  const known = drawerId ? data.rows.find(row => row.id === drawerId) : undefined;
  const baseline = drawerId ? page.value?.rows.find(row => row.id === drawerId) : undefined;
  const lastDetail = useRef<{ row: Transaction; intentsVersion: number; refresh: number; applied?: string[] } | null>(null);
  if (baseline && page.readVersion !== undefined && page.readRefresh !== undefined) {
    lastDetail.current = { row: baseline, intentsVersion: page.readVersion, refresh: page.readRefresh, applied: page.applied };
  }
  const remembered = lastDetail.current?.row.id === drawerId && lastDetail.current.refresh === snapshot.refresh ? lastDetail.current : null;
  const detail = useTransactionRead(!known && !remembered ? drawerId : null, loadDetail, snapshot);
  const open = drawerId ? known ?? (remembered
    ? projectExpense(remembered.row, drawerId, unappliedTransactionIntents(snapshot, remembered.intentsVersion, remembered.applied))
    : projectExpense(detail.value, drawerId, detail.intents)) : undefined;
  return {
    ...data, open, detailError: open ? "" : detail.error, detailLoading: !open && detail.loading,
    loading: page.loading, error: page.error, reload: page.reload, reloadDetail: detail.reload,
    csv: async (signal: AbortSignal) => { await snapshot.waitForIdle(signal); return readTransactionCsv(filters, signal); }, today: page.value?.today || budgetToday(),
  };
}

export function useTransactionLog(snapshot: ReturnType<typeof useTransactionState>, enabled: boolean) {
  const response = useTransactionRead(enabled ? "" : null, loadLog, snapshot, 0, 0, true);
  const value = response.value ? projectBudgetLog(response.value, response.intents) : null;
  return { ...response, value };
}

const loadReceipts: Read<Awaited<ReturnType<typeof budgetRequest<"listBudgetReceipts">>>> = (path, signal) =>
  budgetRequest<"listBudgetReceipts">(path, "GET", undefined, signal);

export function useAvailableReceipts() {
  const queue = useTransactionState();
  const [cursor, setCursor] = useState<string | null>(null);
  const path = "/receipts?reveal=yes" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const result = useTransactionRead(path, loadReceipts, queue);
  const [pages, setPages] = useState<{ receipts: NonNullable<typeof result.value>["receipts"]; version: number; refresh: number }[]>([]);
  const current = result.value;
  const activePages = pages.filter(page => page.refresh === queue.refresh);
  const reads = current ? [...activePages, { receipts: current.receipts, version: result.readVersion!, refresh: result.readRefresh! }] : activePages;
  const available = reads.flatMap(({ receipts, version }) => {
    const projected = projectReceiptLinks(unappliedTransactionIntents(queue, version));
    return receipts.filter(receipt => {
      const link = projected.get(receipt.id);
      return (link === undefined ? !receipt.expense : link === null) &&
        (receipt.kind === "receipt" || receipt.kind === "invoice");
    });
  });
  return {
    available,
    loading: result.loading,
    error: result.error,
    retry: result.reload,
    next: current?.next,
    more: () => {
      if (!current?.next) return;
      setPages(reads);
      setCursor(current.next);
    },
  };
}
