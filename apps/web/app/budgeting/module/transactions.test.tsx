import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import type { Transaction } from "./transaction-client";

let params = new URLSearchParams();
const path = "/budgeting/transactions";
mock.module("next/navigation", () => ({
  usePathname: () => path,
  useSearchParams: () => params,
  useRouter: () => ({ replace: (url: string) => { params = new URL(url, "https://fixture.test").searchParams; } }),
}));

const dom = createTestDom();
const first: Transaction = {
  id: crypto.randomUUID(), date: "2026-11-13", merchant: "First merchant", cents: 400, allowance: "food", foodCents: 400,
  category: "Coffee", receipt: false, receiptId: null, reviewed: false, billKey: null, subscriptionId: null,
};
const second = { ...first, id: crypto.randomUUID(), merchant: "Second merchant" };
const receiptId = crypto.randomUUID();
const receiptList = (title: string) => Response.json({ receipts: [{ id: receiptId, title, kind: "receipt", expense: null }], next: null });

function button(label: string) {
  const node = [...document.querySelectorAll("button")].find(button => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(node).toBeDefined();
  return node!;
}

test("the picker reveals on one explicit request, cancels hide/close/switch, and keeps link Undo available", async () => {
  const originalFetch = globalThis.fetch;
  const reads: { path: string; signal?: AbortSignal | null; resolve: (response: Response) => void }[] = [];
  const writes: { command: unknown; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((path: string, options?: RequestInit) => {
    if (path.startsWith("/api/v1/budgeting/receipts?")) {
      return new Promise<Response>(resolve => reads.push({ path, signal: options?.signal, resolve }));
    }
    if (path.startsWith("/api/v1/budgeting/transaction-commands/") && options?.method === "PUT") {
      return new Promise<Response>(resolve => writes.push({ command: JSON.parse(String(options.body)), resolve }));
    }
    if (path.startsWith("/api/v1/budgeting/transactions?")) {
      return Promise.resolve(Response.json({ rows: [first, second], count: 2, today: first.date, totalCents: 800, applied: [] }));
    }
    const detail = [first, second].find(transaction => path === "/api/v1/budgeting/transactions/" + transaction.id);
    if (detail) return Promise.resolve(Response.json(detail));
    throw new Error("Unexpected synthetic transaction request");
  }) as typeof fetch;
  try {
    const { BudgetTransactions } = await import("./transactions");
    const { BudgetTransactionProvider } = await import("./transaction-store");
    const { BudgetingStubStore } = await import("./stub-store");
    const { Toaster } = await import("@/components/chakra/toaster");
    const render = () => dom.render(<BudgetTransactionProvider><BudgetingStubStore><BudgetTransactions /><Toaster /></BudgetingStubStore></BudgetTransactionProvider>);
    const open = (id: string) => { params = new URLSearchParams({ id }); return render(); };
    const reveal = async () => {
      const count = reads.length;
      expect(button("Reveal receipts to attach").getAttribute("aria-expanded")).toBe("false");
      await dom.click(button("Reveal receipts to attach"));
      expect(reads).toHaveLength(count + 1);
      expect(reads[count].path).toBe("/api/v1/budgeting/receipts?reveal=yes");
      expect(document.body.textContent).toContain("Loading receipts");
    };

    await open(first.id);
    expect(reads).toHaveLength(0);
    await reveal();
    await dom.click(button("Hide receipts"));
    expect(reads[0].signal?.aborted).toBe(true);
    await act(async () => reads[0].resolve(receiptList("Hidden receipt")));
    expect(document.body.textContent).not.toContain("Hidden receipt");
    await reveal();
    await dom.click(button("Close"));
    await render();
    expect(params.has("id")).toBe(false);
    expect(reads[1].signal?.aborted).toBe(true);
    await act(async () => reads[1].resolve(receiptList("Closed drawer receipt")));
    expect(document.body.textContent).not.toContain("Closed drawer receipt");

    await open(first.id);
    await reveal();
    await open(second.id);
    expect(reads[2].signal?.aborted).toBe(true);
    expect(reads).toHaveLength(3);
    await reveal();
    await act(async () => reads[2].resolve(receiptList("Previous transaction receipt")));
    expect(document.body.textContent).not.toContain("Previous transaction receipt");
    await act(async () => reads[3].resolve(receiptList("Current receipt")));

    await dom.click(button("Current receipt"));
    expect(writes).toHaveLength(1);
    expect(writes[0].command).toMatchObject({ type: "receipt", id: second.id, before: null, after: receiptId });
    expect(document.querySelector('a[href="/budgeting/documents?id=' + receiptId + '"]')).not.toBeNull();
    await dom.click(button("Undo"));
    expect(writes).toHaveLength(1);
    expect(button("Reveal receipts to attach")).toBeDefined();
    expect(reads).toHaveLength(4);
    await act(async () => writes[0].resolve(Response.json({ expense: { ...second, receiptId, receipt: true, manualReceiptMatch: true } })));
    expect(writes[1].command).toMatchObject({ type: "receipt", before: receiptId, after: null, afterManualReceiptMatch: false });
    await act(async () => writes[1].resolve(Response.json({ expense: second })));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
