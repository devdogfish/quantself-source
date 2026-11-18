import { expect, mock, test } from "bun:test";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { sampleTaxPlan } from "../../web/app/budgeting/tax-planning/tax-plan.fixture";
import { calc, claimIds, levels } from "@quantself/budgeting/tax-calc";
import { createTaxPlanningStore } from "./budget-tax-planning";
import { defaultTaxRules } from "./budget-tax-planning-rules";

function mockReader() {
  const query = {
    budgetTaxRules: { findMany: mock(async (): Promise<{
      year: number;
      bands: { upToCents: number | null; rate: number }[];
      creditRate: number;
      baselineCreditsCents: number;
      medicalFloorRate: number;
      medicalFloorCapCents: number;
    }[]> => []) },
    budgetTaxMoneyLine: { findMany: mock(async () => [
      { year: 2026, kind: "income", label: "Pay", note: "", cents: 5_000_000 },
      { year: 2026, kind: "withheld", label: "Paid", note: "", cents: 700_000 },
    ]) },
    budgetTaxClaim: { findMany: mock(async () => [
      { year: 2026, id: "expense", title: "Expense", certainty: "likely", treatment: "deduction", amountCents: 100_000, note: "" },
      { year: 2026, id: "maybe", title: "Maybe", certainty: "uncertain", treatment: "deduction", amountCents: 200_000, note: "" },
    ]) },
    budgetTaxItem: { findMany: mock(async () => []) },
    budgetTaxGatherDocument: { findMany: mock(async () => []) },
  };
  const $transaction = mock((read: (tx: typeof query) => unknown, _options: unknown) => read(query));
  return { store: createTaxPlanningStore({ $transaction } as unknown as PrismaClient), query, $transaction };
}

test("a plan reads five scoped projections, with prior financials in the same bulk queries", async () => {
  const { store, query, $transaction } = mockReader();
  const plan = await store.getPlan("owner", 2027);
  expect(plan.income).toEqual([]);
  expect(plan.prior).toEqual({
    incomeCents: 5_000_000,
    deductionsCents: 100_000,
    creditsCents: 335_210,
    withheldCents: 700_000,
    taxOwedCents: 892_411,
  });
  expect($transaction).toHaveBeenCalledTimes(1);
  expect($transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
  for (const [name, { findMany }] of Object.entries(query)) {
    const currentYearOnly = name === "budgetTaxItem" || name === "budgetTaxGatherDocument";
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: "owner", year: currentYearOnly ? 2027 : { in: [2026, 2027] } },
    }));
  }
});

test("empty years and rules-only prior years omit the comparison", async () => {
  const { store, query } = mockReader();
  query.budgetTaxMoneyLine.findMany.mockResolvedValue([]);
  query.budgetTaxClaim.findMany.mockResolvedValue([]);
  query.budgetTaxRules.findMany.mockResolvedValue([{
    year: 2026,
    bands: [{ upToCents: null, rate: 0.25 }],
    creditRate: 0.25,
    baselineCreditsCents: 0,
    medicalFloorRate: 0.03,
    medicalFloorCapCents: 278_000,
  }]);
  const plan = await store.getPlan("owner", 2027);
  expect(plan).not.toHaveProperty("prior");
  expect(plan.income).toEqual([]);
  expect(plan.rules.bands).toEqual([{ upToCents: null, rate: 0 }]);
});

test("a populated prior year uses the same fallback rules as its own plan", async () => {
  const { store, query } = mockReader();
  query.budgetTaxMoneyLine.findMany.mockResolvedValue([{ year: 2025, kind: "income", label: "Pay", note: "", cents: 2_000_000 }]);
  expect((await store.getPlan("owner", 2026)).prior).toEqual({
    incomeCents: 2_000_000, deductionsCents: 0, creditsCents: 0, withheldCents: 0, taxOwedCents: 0,
  });
});

test("using sourced rules with the sample produces a separate estimate from the legacy golden fixture", () => {
  const plan = { ...sampleTaxPlan, rules: defaultTaxRules(2026)! };
  expect([calc(plan, new Set()).refund, ...levels.map(level => calc(plan, claimIds(plan, level.certainties)).refund)])
    .toEqual([-214_296, -14_434, 56_687, 129_586]);
});

const commandId = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const nextId = "0b8096aa-97d1-4e3e-9dc8-8820ec02c61f";

test("retrying an unchanged command returns its original revision and stale writes conflict", async () => {
  const journal = new Map<string, { fingerprint: string; revision: number }>();
  let state: { revision: number } | null = null;
  const tx = {
    budgetTaxCommand: {
      findUnique: async ({ where }: { where: { ownerId_year_commandId: { ownerId: string; commandId: string } } }) =>
        journal.get(JSON.stringify(where.ownerId_year_commandId)) ?? null,
      findFirst: async () => null,
      create: async ({ data }: { data: { year: number; ownerId: string; commandId: string; fingerprint: string; revision: number } }) => {
        const { commandId, ownerId, year, fingerprint, revision } = data;
        journal.set(JSON.stringify({ ownerId, year, commandId }), { fingerprint, revision });
      },
    },
    budgetTaxMoneyLine: {
      findUnique: async () => state,
      upsert: mock(async ({ create }: { create: { revision: number } }) => { state = create; }),
    },
  };
  const store = createTaxPlanningStore({
    $transaction: (write: (client: typeof tx) => unknown) => write(tx),
  } as unknown as PrismaClient);
  const mutation = {
    kind: "income", operation: "put", id: "t4", revision: 0, commandId,
    changes: { label: "T4", note: "", cents: 1_000_000 },
  } as const;
  const result = await store.write("owner", 2026, mutation);
  expect(result).toEqual({ revision: 1, commandId });
  expect(await store.write("owner", 2026, { ...mutation, changes: { cents: 1_000_000, note: "", label: "T4" } })).toEqual(result);
  expect(tx.budgetTaxMoneyLine.upsert).toHaveBeenCalledTimes(1);
  await expect(store.write("owner", 2026, { ...mutation, changes: { ...mutation.changes, cents: 1_100_000 } })).rejects.toMatchObject({ status: 409 });
  await expect(store.write("owner", 2026, { ...mutation, commandId: nextId })).rejects.toMatchObject({ status: 409 });
});

test("link validation looks up distinct IDs in bulk under the correct ownership", async () => {
  const recurringId = "0b8096aa-97d1-4e3e-9dc8-8820ec02c61f";
  const oneOffId = "2f799d4e-cd63-416f-8018-b26c6dafba68";
  const visibleSubscription = { id: "hosting", status: "active", planEntry: false };
  const tx = {
    budgetTaxCommand: { findUnique: async () => null, findFirst: async () => null, create: mock(async () => {}) },
    budgetTaxItem: { findUnique: async () => null, upsert: mock(async () => {}) },
    budgetReceipt: { findMany: mock(async () => [{ id: "invoice" }]) },
    budgetSubscription: { findMany: mock(async () => [visibleSubscription]) },
    budgetPlan: { findUnique: mock(async () => ({
      plan: { checkpoint: null, foodCents: null, otherCents: null, entries: [
        { id: recurringId, label: "Recurring plan entry", date: "2026-01-01", cents: 1_000, frequency: "monthly", kind: "bill" },
        { id: oneOffId, label: "One-off plan entry", date: "2026-01-01", cents: 1_000, frequency: "once", kind: "bill" },
      ] },
    })) },
    authOwner: { findUnique: mock(async (): Promise<{ id: string } | null> => ({ id: "singleton" })) },
    inventoryItem: { findMany: mock(async () => [{ id: "server" }]) },
  };
  const store = createTaxPlanningStore({
    $transaction: (write: (client: typeof tx) => unknown) => write(tx),
  } as unknown as PrismaClient);
  const mutation = {
    kind: "items", operation: "put", id: "hosting", revision: 0, commandId,
    changes: { title: "Hosting", type: "Deduction", amountCents: 1_000, links: [
      { kind: "document", label: "Invoice", id: "invoice" },
      { kind: "document", label: "Same invoice", id: "invoice" },
      { kind: "subscription", label: "Subscription", id: "hosting" },
      { kind: "inventoryItem", label: "Inventory", id: "server" },
      { kind: "transactions", label: "Payment", search: "hosting" },
    ] },
  } satisfies Parameters<typeof store.write>[2];
  await store.write("owner", 2026, mutation);
  expect(tx.budgetReceipt.findMany).toHaveBeenCalledTimes(1);
  expect(tx.budgetReceipt.findMany).toHaveBeenCalledWith({ where: { ownerId: "owner", id: { in: ["invoice"] } }, select: { id: true } });
  expect(tx.budgetSubscription.findMany).toHaveBeenCalledWith({
    where: { ownerId: "owner", id: { in: ["hosting"] } }, select: { id: true, status: true, planEntry: true },
  });
  expect(tx.budgetPlan.findUnique).not.toHaveBeenCalled();
  expect(tx.authOwner.findUnique).toHaveBeenCalledWith({ where: { userId: "owner" }, select: { id: true } });
  expect(tx.inventoryItem.findMany).toHaveBeenCalledWith({ where: { id: { in: ["server"] } }, select: { id: true } });

  tx.budgetReceipt.findMany.mockResolvedValueOnce([]);
  await expect(store.write("other-owner", 2026, mutation)).rejects.toMatchObject({ status: 400, message: "A linked document was not found." });
  tx.budgetSubscription.findMany.mockResolvedValueOnce([]);
  await expect(store.write("owner", 2026, mutation)).rejects.toMatchObject({ status: 400, message: "A linked subscription was not found." });
  tx.authOwner.findUnique.mockResolvedValueOnce(null);
  await expect(store.write("other-owner", 2026, mutation)).rejects.toMatchObject({ status: 400, message: "A linked inventory item was not found." });
  expect(tx.budgetTaxItem.upsert).toHaveBeenCalledTimes(1);

  const withSubscriptions = (...ids: string[]) => ({
    ...mutation, changes: { ...mutation.changes, links: ids.map(id => ({ kind: "subscription" as const, label: "Subscription", id })) },
  });
  tx.budgetSubscription.findMany.mockResolvedValueOnce([]);
  await expect(store.write("owner", 2026, withSubscriptions(recurringId, oneOffId))).resolves.toMatchObject({ revision: 1 });
  expect(tx.budgetPlan.findUnique).toHaveBeenLastCalledWith({ where: { ownerId: "owner" }, select: { plan: true } });
  tx.budgetSubscription.findMany.mockResolvedValueOnce([{ ...visibleSubscription, status: "candidate" }]);
  await expect(store.write("owner", 2026, withSubscriptions("hosting"))).rejects.toMatchObject({ status: 400 });
  tx.budgetSubscription.findMany.mockResolvedValueOnce([{ id: recurringId, status: "dismissed", planEntry: true }]);
  await expect(store.write("owner", 2026, withSubscriptions(recurringId))).rejects.toMatchObject({ status: 400 });
});

test("a PostgreSQL restrict violation is a conflict", async () => {
  const store = createTaxPlanningStore({
    $transaction: async () => { throw new Error("referenced", { cause: { code: "23001" } }); },
  } as unknown as PrismaClient);
  await expect(store.write("owner", 2026, {
    kind: "claims", operation: "delete", id: "expense", revision: 1, commandId,
  })).rejects.toMatchObject({ status: 409 });
});
