import { expect, test } from "bun:test";
import { subscriptionPayments, monthlyEquivalent, type Subscription } from "@quantself/budgeting";
import { emptyPlan, forecast } from "./budgeting";
import { subscription, subscriptionMerchantKey } from "./budget-subscriptions";
const item: Subscription = { id: "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642", revision: 1, commandId: "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642", name: "Subscription", status: "active", stopsOn: null,
  websiteUrl: null, cancelUrl: null, logoKey: null, estimated: false, evidence: "", sourceKey: null,
  terms: [{ effectiveOn: "2026-01-01", startOn: "2026-01-31", amountCents: 1200, frequency: "monthly", interval: 1 }] };
test("month-end subscriptions return to their original anchor; cancellation excludes the boundary", () => {
  expect(subscriptionPayments(item, "2026-01-01", "2026-03-31").map(p => p.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  expect(subscriptionPayments({ ...item, stopsOn: "2026-02-28" }, "2026-01-01", "2026-03-31").map(p => p.date)).toEqual(["2026-01-31"]);
});
test("30 day mobile plans do not drift into calendar months; annual charges are not monthly cash", () => {
  const phone = { ...item, terms: [{ ...item.terms[0], startOn: "2026-10-26", frequency: "daily" as const, interval: 30, amountCents: 2979 }] };
  expect(subscriptionPayments(phone, "2026-11-01", "2026-12-31").map(p => p.date)).toEqual(["2026-11-25", "2026-12-25"]);
  const annual = { ...item, terms: [{ ...item.terms[0], amountCents: 12000, frequency: "yearly" as const }] };
  expect(monthlyEquivalent(annual, "2026-01-01")).toBe(1000);
  expect(subscriptionPayments(annual, "2026-01-01", "2026-12-31")).toHaveLength(1);
});
test("dated price changes retain prior charges and stable keys", () => {
  const changed = { ...item, terms: [...item.terms, { ...item.terms[0], effectiveOn: "2026-03-01", amountCents: 1500 }] };
  const payments = subscriptionPayments(changed, "2026-01-01", "2026-03-31");
  expect(payments.map(p => p.cents)).toEqual([1200, 1200, 1500]);
  expect(payments.map(p => p.key)).toEqual(subscriptionPayments(item, "2026-01-01", "2026-03-31").map(p => p.key));
});
test("subscription is budgeted once, replaced by a real matched payment, and lowers rent leftover", () => {
  const rent = { id: "8c4e401d-74a1-4ec7-8b23-b1e97dbc0642", label: "Rent", kind: "bill" as const, frequency: "monthly" as const, date: "2026-11-30", cents: 100000 };
  const plan = { ...emptyPlan, foodCents: 0, otherCents: 0, checkpoint: { date: "2026-11-01", cents: 200000 }, entries: [rent], rentRunway: { through: "2026-11-30", reserveCents: 0, rentEntryId: rent.id } };
  const payments = subscriptionPayments(item, "2026-11-01", "2027-11-30");
  expect(forecast(plan, [], "2026-11-30", { payments }).rentRunway?.leftoverCents).toBe(98800);
  const paid = [{ date: "2026-11-30", totalCents: 1300, foodCents: 0, billKey: payments[0].key }];
  expect(forecast(plan, paid, "2026-11-30", { payments }).rentRunway?.leftoverCents).toBe(98700);
  expect(forecast(plan, paid, "2026-11-30", { payments }).bills.some(p => p.key === payments[0].key)).toBe(false);
});
test("unscheduled and dismissed candidates never affect cash; trials start billing on conversion", () => {
  expect(subscriptionPayments({ ...item, status: "candidate" }, "2026-01-01", "2026-12-31")).toEqual([]);
  expect(monthlyEquivalent({ ...item, status: "candidate" }, "2026-01-01")).toBe(0);
  expect(subscriptionPayments({ ...item, status: "trial" }, "2026-01-01", "2026-01-30")).toEqual([]);
  expect(subscription.safeParse({ ...item, terms: [] }).success).toBe(false);
  expect(subscription.safeParse({ ...item, cancelUrl: "javascript:alert(1)" }).success).toBe(false);
});
test("merchant detection distinguishes subscriptions from ordinary Amazon purchases", () => {
  expect(subscriptionMerchantKey("Amazon.ca Prime Member amazon.ca/pri")).toBe("amazon-prime");
  expect(subscriptionMerchantKey("VISA DEBIT PURCHASE - 1043 AMAZON.CA PRIME")).toBe("amazon-prime");
  expect(subscriptionMerchantKey("Amazon.ca*UG0VR76Y3")).toBeNull();
});

test("matching checks uniqueness on both sides, even when another expense has two candidates", async () => {
  const { reconcileSubscriptionPayments } = await import("./budget-subscriptions");
  const mobile = { ...item, sourceKey: "public-mobile", terms: [{ ...item.terms[0], startOn: "2026-11-01", effectiveOn: "2026-11-01", frequency: "daily", interval: 5 }] };
  let writes = 0; let reads = 0;
  const tx = { budgetSubscription: { findMany: async () => { reads++; return [mobile]; } }, budgetExpense: {
    findMany: async ({ where }: any) => { reads++; return where.billKey?.in ? [] : [
      { id: "a", merchant: "PUBLIC MOBILE", date: "2026-11-01", totalCents: 1200 },
      { id: "b", merchant: "PUBLIC MOBILE", date: "2026-11-03", totalCents: 1200 },
    ]; }, updateMany: async () => { writes++; return { count: 1 }; },
  } };
  await reconcileSubscriptionPayments(tx as any, "owner", "2026-11-01", "2026-11-03");
  expect(writes).toBe(0); expect(reads).toBe(3);
});

test("historical subscriptions can retain evidence without an invented schedule or forecast", () => {
  const history = subscription.parse({ ...item, terms: [], stopsOn: "2026-11-08", evidence: "Service ended; original interval unknown." });
  expect(subscriptionPayments(history, "2026-01-01", "2027-12-31")).toEqual([]);
  expect(monthlyEquivalent(history, "2026-11-08")).toBe(0);
  expect(subscription.safeParse({ ...history, stopsOn: null }).success).toBe(false);
  expect(history.evidence).toBe("Service ended; original interval unknown.");
});
