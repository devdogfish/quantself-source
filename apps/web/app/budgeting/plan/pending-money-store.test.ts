import { expect, test } from "bun:test";
import type { BudgetPlan } from "../budgeting-client";
import { PendingMoneyStore, type PendingMoney } from "./pending-money-store";

const item = { id: crypto.randomUUID(), label: "Deposit return", cents: 20_000, date: null };
const other = { ...item, id: crypto.randomUUID(), label: "Reimbursement" };
function plan(revision: number, items: PendingMoney[] = []): BudgetPlan {
  return {
    revision, note: "", proposal: null,
    plan: { checkpoint: null, foodCents: null, otherCents: null, entries: [], pendingMoney: items },
  };
}

test("pending money accepts edits, undo and redo before a write returns", async () => {
  const first = Promise.withResolvers<BudgetPlan>();
  const second = Promise.withResolvers<BudgetPlan>();
  const requests: (PendingMoney | null)[] = [];
  const store = new PendingMoneyStore(plan(0), ({ after }) => {
    requests.push(after);
    switch (requests.length) {
      case 1: return first.promise;
      case 2: return second.promise;
      case 3: return Promise.resolve(plan(3, [item]));
      default: return Promise.resolve(plan(4, [item, other]));
    }
  }, () => {});
  store.change(item.id, item);
  store.change(other.id, other);
  store.undo();
  expect(store.getSnapshot().items).toEqual([item]);
  store.redo();
  expect(store.getSnapshot().items).toEqual([item, other]);
  expect(requests).toEqual([item]);

  first.resolve(plan(1, [item]));
  await Promise.resolve();
  expect(requests).toEqual([item, other]);
  expect(store.getSnapshot().items).toEqual([item, other]);
  second.resolve(plan(2, [item, other]));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).toEqual([item, other, null, other]);
  expect(store.getSnapshot()).toMatchObject({ items: [item, other], saving: false });
});

test("uncertain saves retry the same change and allow unrelated saves", async () => {
  const requests: unknown[] = [];
  const store = new PendingMoneyStore(plan(0), async change => {
    requests.push(change);
    if (requests.length === 1) throw Error("Network disconnected");
    return requests.length === 2 ? plan(1, [other]) : plan(2, [other, item]);
  }, () => {});
  store.change(item.id, item);
  await Promise.resolve();
  expect(store.getSnapshot().retryable).toBe(true);
  store.change(other.id, other);
  await Promise.resolve();
  store.retry();
  await Promise.resolve();
  expect(requests[2]).toBe(requests[0]);
  expect(store.getSnapshot()).toMatchObject({ items: [other, item], saving: false, retryable: false });
});

test("a conflict rolls back only the affected item and refreshes the plan", async () => {
  let refreshed = false;
  const store = new PendingMoneyStore(plan(0), async ({ id }) => {
    if (id === item.id) throw Object.assign(Error("Changed elsewhere"), { status: 409 });
    return plan(1, [other]);
  }, () => { refreshed = true; });
  store.change(item.id, item);
  store.change(other.id, other);
  await Promise.resolve();
  await Promise.resolve();
  expect(refreshed).toBe(true);
  expect(store.getSnapshot().items).toEqual([other]);
  expect(store.getSnapshot().error).toContain("Changed elsewhere");
});
