import { expect, test } from "bun:test";
import { previewPurchase } from "./budget-affordability";
import { emptyPlan } from "./budgeting";
const rent = { id: "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642", kind: "bill" as const, label: "Rent", date: "2026-11-30", cents: 100_000, frequency: "monthly" as const };
const plan = { ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 400_000 }, entries: [rent], rentRunway: { through: "2026-12-31", reserveCents: 50_000, rentEntryId: rent.id } };
test("purchase preview reserves debt once, changes rent runway, and never mutates the plan", () => {
  const original = structuredClone(plan);
  const result = previewPurchase(plan, [], "2026-11-08", { amount: 60_000, date: "2026-11-09" });
  expect(result.leftoverBefore).toBe(150_000);
  expect(result.leftoverAfter).toBe(90_000);
  expect(result.rentMonthsBefore).toBe(1);
  expect(result.rentMonthsAfter).toBe(0);
  expect(plan).toEqual(original);
});
test("scheduled subscriptions and paid bills do not double count", () => {
  const paid = [{ date: "2026-11-09", totalCents: 1000, foodCents: 0, billKey: "subscription:nov" }];
  const payments = [{ ...rent, date: "2026-11-09", key: "subscription:nov", cents: 1000 }];
  const result = previewPurchase(plan, paid, "2026-11-09", { amount: 1000, date: "2026-11-09" }, payments);
  expect(result.leftoverBefore).toBe(149_000);
  expect(result.leftoverAfter).toBe(148_000);
});
test("purchase after the balance date only affects later cash timing", () => {
  const result = previewPurchase(plan, [], "2026-11-08", { amount: 200_000, date: "2027-01-01" });
  expect(result.leftoverBefore).toBe(result.leftoverAfter);
  expect(result.shortfallAfter).toBe("2027-01-01");
});
test("missing cash stays unknown, and out-of-range dates are rejected", () => {
  expect(previewPurchase(emptyPlan, [], "2026-11-08", { amount: 100, date: "2026-11-08" }).available).toBeNull();
  expect(() => previewPurchase(plan, [], "2026-11-08", { amount: 100, date: "2026-11-07" })).toThrow();
});
