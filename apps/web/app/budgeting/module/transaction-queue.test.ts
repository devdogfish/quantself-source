import { expect, test } from "bun:test";
import type { Transaction, TransactionCommand, TransactionPage, TransactionResult } from "./transaction-client";
import { projectExpense, projectTransactionPage, reverseIntent, TransactionQueue, unappliedTransactionIntents, type Intent } from "./transaction-queue";

const row: Transaction = { id: "row", date: "2026-11-12", merchant: "Store", cents: 950, foodCents: 950, category: "Groceries",
  allowance: "food", reviewed: false, receipt: false, receiptId: null, billKey: null, subscriptionId: null };
const review = (expense = row): Intent => ({
  command: { type: "review", id: expense.id, before: false, after: true },
  changes: [{ before: expense, after: { ...expense, reviewed: true } }],
});
const move: Intent = {
  command: { type: "move", id: row.id, before: { allowance: "food", category: "Groceries", foodCents: 950 }, after: { allowance: "other", category: "Household" } },
  changes: [{ before: row, after: { ...row, allowance: "other", category: "Household", foodCents: 0 } }],
};
function harness() {
  const requests: { id: string; command: TransactionCommand; resolve: (r: TransactionResult) => void; reject: (cause: unknown) => void }[] = [];
  let n = 0;
  const queue = new TransactionQueue((id, command) => new Promise((resolve, reject) => requests.push({ id, command, resolve, reject })), () => String(++n));
  const intents = () => { const { committed, pending } = queue.getSnapshot(); return [...committed, ...pending]; };
  const project = (expense = row) => projectExpense(expense, expense.id, intents());
  return { requests, queue, intents, project };
}

test("deferred save preserves later category intent and immediate Undo and Redo", async () => {
  const { requests, queue, project } = harness();
  queue.enqueue(move);
  queue.enqueue(review());
  queue.enqueue(reverseIntent(move));
  expect(project()).toMatchObject({ category: "Groceries", reviewed: true });
  expect(requests.map(x => x.command.type)).toEqual(["move"]);
  requests[0].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  expect(project()).toMatchObject({ category: "Groceries", reviewed: true });
  expect(requests.map(x => x.command.type)).toEqual(["move", "review"]);
  queue.enqueue(move);
  expect(project()).toMatchObject({ category: "Household", reviewed: true });
  requests[1].resolve({ expense: { ...move.changes[0].after!, reviewed: true } });
  await Promise.resolve();
  expect(project()).toMatchObject({ category: "Household", reviewed: true });
  requests[2].resolve({ expense: { ...row, reviewed: true } });
  await Promise.resolve();
  requests[3].resolve({ expense: { ...move.changes[0].after!, reviewed: true } });
  await Promise.resolve();
  expect(project()).toMatchObject({ category: "Household", reviewed: true });
  expect(queue.getSnapshot().pending).toHaveLength(0);
});

test("uncertain delivery keeps its projection and retries the same ID and payload", async () => {
  const { requests, queue, project } = harness();
  queue.enqueue(move);
  queue.enqueue(reverseIntent(move));
  requests[0].reject(new TypeError("Connection dropped"));
  await Promise.resolve();
  expect(project()).toMatchObject({ category: "Groceries" });
  expect(queue.getSnapshot()).toMatchObject({ retryable: true });
  expect(requests).toHaveLength(1);
  queue.retry();
  expect(requests[1].id).toBe(requests[0].id);
  expect(requests[1].command).toBe(requests[0].command);
  requests[1].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  expect(project()).toMatchObject({ category: "Groceries" });
  requests[2].resolve({ expense: row });
  await Promise.resolve();
  expect(queue.getSnapshot().pending).toHaveLength(0);
});

test("conflict rolls back its field and dependent Undo while preserving other writes", async () => {
  const { requests, queue, project } = harness();
  const another = { ...row, id: "other" };
  const rejectedId = queue.enqueue(move)!;
  const canceledId = queue.enqueue(reverseIntent(move))!;
  queue.enqueue(review());
  queue.enqueue(review(another));
  expect(requests.map(x => x.command.type)).toEqual(["move", "review"]);
  requests[0].reject(Object.assign(Error("Budget data changed elsewhere"), { status: 409 }));
  await Promise.resolve();
  expect(queue.getSnapshot()).toMatchObject({ refresh: 1, error: "Budget data changed elsewhere" });
  expect(queue.canReverse(rejectedId)).toBeFalse();
  expect(queue.canReverse(canceledId)).toBeFalse();
  expect(queue.getSnapshot().pending.map(x => x.command.type)).toEqual(["review", "review"]);
  expect(project()).toMatchObject({ category: "Groceries", reviewed: true });
  expect(project(another)).toMatchObject({ reviewed: true });
  requests[1].resolve({ expense: { ...another, reviewed: true } });
  requests[2].resolve({ expense: { ...row, reviewed: true } });
  await Promise.resolve();
});

test("filtered totals update immediately and Undo restores the row", () => {
  const { queue, intents } = harness();
  const base: TransactionPage = { today: "2026-11-13", rows: [row], count: 28, totalCents: 80_000 };
  queue.enqueue(review());
  expect(projectTransactionPage(base, { seg: "review" }, intents())).toMatchObject({ rows: [], count: 27, totalCents: 79_050 });
  queue.enqueue(reverseIntent(review()));
  expect(projectTransactionPage(base, { seg: "review" }, intents())).toEqual(base);
});


test("a GET that saw the pending write does not count its filtered removal again", async () => {
  const { queue, requests } = harness();
  const id = queue.enqueue(review())!;
  const server: TransactionPage = { today: "2026-11-13", rows: [], count: 27, totalCents: 79_050, applied: [id] };
  const visible = () => projectTransactionPage(server, { seg: "review" }, unappliedTransactionIntents(queue.getSnapshot(), 0, server.applied));
  expect(visible()).toEqual(server);
  requests[0].resolve({ expense: { ...row, reviewed: true } });
  await Promise.resolve();
  expect(visible()).toEqual(server);
  queue.enqueue(reverseIntent(review()));
  expect(visible()).toMatchObject({ count: 28, totalCents: 80_000, rows: [row] });
});

test("stale Undo and Redo cannot project over later category intent", async () => {
  const { queue, requests, project } = harness();
  const first = queue.enqueue(move)!;
  const undo = queue.enqueue(reverseIntent(move))!;
  const latest = queue.enqueue(move)!;
  expect(queue.canReverse(first)).toBeFalse();
  expect(queue.canReverse(undo)).toBeFalse();
  expect(queue.canReverse(latest)).toBeTrue();
  expect(project()?.category).toBe("Household");

  requests[0].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  requests[1].resolve({ expense: row });
  await Promise.resolve();
  requests[2].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  expect(queue.canReverse(undo)).toBeFalse();
  expect(queue.canReverse(latest)).toBeTrue();
  if (queue.canReverse(latest)) queue.enqueue(reverseIntent(move));
  expect(project()?.category).toBe("Groceries");
});

test("later work on an unrelated field or record leaves Undo available", async () => {
  const { queue, requests, project } = harness();
  const first = queue.enqueue(move)!;
  const otherRow = { ...row, id: "other" };
  queue.enqueue(review());
  queue.enqueue(review(otherRow));
  requests[1].resolve({ expense: { ...otherRow, reviewed: true } });
  await Promise.resolve();
  expect(queue.canReverse(first)).toBeTrue();
  queue.enqueue(reverseIntent(move));
  expect(project()).toMatchObject({ category: "Groceries", reviewed: true });
  expect(project(otherRow)?.reviewed).toBeTrue();
});

test("rejected later category intent releases the earlier Undo", async () => {
  const { queue, requests, project } = harness();
  const first = queue.enqueue(move)!;
  const later = queue.enqueue(reverseIntent(move))!;
  expect(queue.canReverse(first)).toBeFalse();

  requests[0].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  expect(queue.canReverse(first)).toBeFalse();
  requests[1].reject(Object.assign(Error("Rejected"), { status: 409 }));
  await Promise.resolve();

  expect(queue.canReverse(later)).toBeFalse();
  expect(queue.canReverse(first)).toBeTrue();
  expect(project()?.category).toBe("Household");
  queue.enqueue(reverseIntent(move));
  expect(project()?.category).toBe("Groceries");
});

test("add and remove overlap every field on their transaction", async () => {
  const { queue, requests } = harness();
  const add = queue.enqueue({ command: { type: "add", expense: row }, changes: [{ before: null, after: row }] })!;
  const later = queue.enqueue(review())!;
  expect(queue.canReverse(add)).toBeFalse();
  expect(queue.canReverse(later)).toBeTrue();
  requests[0].resolve({ expense: row });
  await Promise.resolve();
  expect(queue.canReverse(add)).toBeFalse();
});

test("a pending receipt claim blocks a second transaction and Undo restores the match flag", async () => {
  const { queue, requests, project } = harness();
  const receiptId = "receipt";
  const attach = (expense: Transaction): Intent => ({
    command: {
      type: "receipt", id: expense.id, before: null, after: receiptId,
      beforeManualReceiptMatch: false, afterManualReceiptMatch: true,
    },
    changes: [{ before: expense, after: { ...expense, receiptId, receipt: true, manualReceiptMatch: true } }],
  });
  const first = { ...row, manualReceiptMatch: false };
  const second = { ...first, id: "second" };
  const firstAttach = attach(first);
  const id = queue.enqueue(firstAttach)!;
  expect(project(first)?.receiptId).toBe(receiptId);
  expect(queue.enqueue(attach(second))).toBeUndefined();
  expect(project(second)?.receiptId).toBeNull();
  expect(queue.canReverse(id)).toBeTrue();
  const undo = reverseIntent(firstAttach);
  expect(undo.command).toMatchObject({ beforeManualReceiptMatch: true, afterManualReceiptMatch: false });
  queue.enqueue(undo);
  expect(project(first)).toMatchObject({ receiptId: null, manualReceiptMatch: false });

  expect(queue.enqueue(attach(second))).toBeDefined();
  expect(project(second)?.receiptId).toBe(receiptId);
  expect(requests).toHaveLength(1);
  requests[0].resolve({ expense: firstAttach.changes[0].after! });
  await Promise.resolve();
  expect(requests).toHaveLength(2);
  requests[1].resolve({ expense: first });
  await Promise.resolve();
  expect(requests).toHaveLength(3);
  expect(requests[2].command).toMatchObject({ id: second.id, after: receiptId });
});

test("spending-only totals exclude matched bills during optimistic changes", () => {
  const bill = { ...row, billKey: "rent", cents: 90000 };
  const base: TransactionPage = { today: "2026-11-13", rows: [], count: 0, totalCents: 0 };
  expect(projectTransactionPage(base, { spendingOnly: "yes" }, [review(bill)])).toEqual(base);
});

test("export waits for accepted commands without blocking later independent work", async () => {
  const { queue, requests } = harness();
  queue.enqueue(move);
  let ready = false;
  const wait = queue.waitForIdle().then(() => { ready = true; });
  queue.enqueue(review({ ...row, id: "other" }));
  requests[0].resolve({ expense: move.changes[0].after! });
  await Promise.resolve();
  expect(ready).toBeFalse();
  requests[1].resolve({});
  await wait;
  expect(ready).toBeTrue();
});

test("export wait stops when a pending write needs a retry", async () => {
  const { queue, requests } = harness();
  queue.enqueue(move);
  const wait = queue.waitForIdle();
  requests[0].reject(new TypeError("Connection dropped"));
  await expect(wait).rejects.toThrow("Retry the pending save before exporting.");
});
