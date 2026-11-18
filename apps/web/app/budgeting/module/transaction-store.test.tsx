import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import type { BudgetLogData, Transaction, TransactionPage } from "./transaction-client";

const dom = createTestDom();
const id = crypto.randomUUID();
const row: Transaction = { id, date: "2026-11-13", merchant: "Corner store", cents: 400, allowance: "food", foodCents: 400,
  category: "Coffee", receipt: false, receiptId: null, reviewed: false, billKey: null, subscriptionId: null };
const transactionPage: TransactionPage = { today: row.date, rows: [row], count: 26, totalCents: 20000, applied: [] };
const log: BudgetLogData = { today: row.date, weekStart: "2026-11-09", foodLimit: 10000, otherLimit: 8000, week: [], history: [],
  unreviewed: [row], skipped: [], loggedDays: [], checkedInToday: false, nextLimitWeek: "2026-11-16", nextFoodLimit: 10000, nextOtherLimit: 8000,
  nextLimitOverrides: { food: null, other: null }, applied: [] };

test("each page makes one HTTP read; a cold deep link reads detail in parallel", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((input: string) => new Promise<Response>(resolve => calls.push({ url: input, resolve }))) as typeof fetch;
  try {
    const { BudgetTransactionProvider, useTransactionPage, useTransactionLog, useTransactionState } = await import("./transaction-store");
    function Table({ drawerId }: { drawerId: string | null }) {
      const data = useTransactionPage({ seg: "review", page: 1 }, drawerId, useTransactionState());
      return <output>{data.loading ? "loading" : data.count} {data.open?.merchant}</output>;
    }
    function Log() {
      const { value } = useTransactionLog(useTransactionState(), true);
      return <output>{value?.unreviewed.length ?? "loading"}</output>;
    }
    await dom.render(<BudgetTransactionProvider><Table drawerId={null} /></BudgetTransactionProvider>);
    expect(calls.map(x => new URL(x.url, "https://test.invalid").pathname)).toEqual(["/api/v1/budgeting/transactions"]);
    expect(dom.container.textContent).toContain("loading");
    await act(async () => calls[0].resolve(Response.json(transactionPage)));
    await dom.render(<BudgetTransactionProvider><Table drawerId={id} /></BudgetTransactionProvider>);
    expect(calls).toHaveLength(1);
    expect(dom.container.textContent).toContain("26 Corner store");

    await dom.render(<BudgetTransactionProvider key="deep"><Table drawerId={id} /></BudgetTransactionProvider>);
    expect(calls.slice(1).map(x => new URL(x.url, "https://test.invalid").pathname)).toEqual([
      "/api/v1/budgeting/transactions", "/api/v1/budgeting/transactions/" + id,
    ]);
    await act(async () => calls[2].resolve(Response.json(row)));
    expect(dom.container.textContent).toContain("loading Corner store");
    await act(async () => calls[1].resolve(Response.json(transactionPage)));

    await dom.render(<BudgetTransactionProvider key="log"><Log /></BudgetTransactionProvider>);
    expect(calls.slice(3).map(x => new URL(x.url, "https://test.invalid").pathname)).toEqual(["/api/v1/budgeting/log"]);
    await act(async () => calls[3].resolve(Response.json(log)));
    expect(dom.container.querySelector("output")?.textContent).toBe("1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a second receipt picker excludes the pending claim and Undo makes the receipt available", async () => {
  const originalFetch = globalThis.fetch;
  const receiptId = crypto.randomUUID();
  const another = { ...row, id: crypto.randomUUID() };
  const writes: { command: unknown; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((input: string, options?: RequestInit) => {
    if (options?.method === "PUT") {
      return new Promise<Response>(resolve => writes.push({ command: JSON.parse(String(options.body)), resolve }));
    }
    if (input.startsWith("/api/v1/budgeting/receipts?")) {
      return Promise.resolve(Response.json({ receipts: [{ id: receiptId, kind: "receipt", merchant: "Corner receipt", expense: null }], next: null }));
    }
    throw Error("Unexpected request " + input);
  }) as typeof fetch;
  try {
    const { BudgetTransactionProvider, useAvailableReceipts, useTransactionState } = await import("./transaction-store");
    const { Toaster } = await import("@/components/chakra/toaster");
    function Picker({ expense }: { expense: Transaction }) {
      const state = useTransactionState();
      const receipts = useAvailableReceipts();
      return <>{receipts.available.map(receipt => <button key={receipt.id} onClick={() =>
        state.undoable("Receipt attached", { type: "receipt", expense, receiptId: receipt.id })
      }>{receipt.merchant}</button>)}</>;
    }
    const show = (expense: Transaction) => dom.render(<BudgetTransactionProvider><Toaster /><Picker key={expense.id} expense={expense} /></BudgetTransactionProvider>);
    await show(row);
    await dom.click(dom.container.querySelector("button")!);
    expect(writes).toHaveLength(1);
    await show(another);
    expect(dom.container.querySelector("button")).toBeNull();
    const undo = [...document.querySelectorAll("button")].find(button => button.textContent === "Undo");
    expect(undo).toBeDefined();
    await dom.click(undo!);
    expect(dom.container.querySelector("button")?.textContent).toBe("Corner receipt");
    expect(writes).toHaveLength(1);
    await act(async () => writes[0].resolve(Response.json({ expense: { ...row, receiptId, receipt: true, manualReceiptMatch: true } })));
    expect(writes[1].command).toMatchObject({ before: receiptId, after: null, afterManualReceiptMatch: false });
    await act(async () => writes[1].resolve(Response.json({ expense: row })));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
