import { expect, test } from "bun:test";
import type { Subscription } from "@quantself/budgeting";
import { recurringRule } from "./subscriptions-data";

const today = "2026-11-13";
const item: Subscription = {
  id: "rule", revision: 1, commandId: "command", name: "Recurring",
  status: "active", stopsOn: null, websiteUrl: null, cancelUrl: null, logoKey: null,
  estimated: false, terms: [], evidence: "", sourceKey: null,
};

test("annualized cadence and next 30 days use actual occurrence counts", () => {
  const cases = [
    ["weekly", 1, "week", 5200, 500],
    ["weekly", 2, "2 weeks", 2600, 300],
    ["monthly", 1, "month", 1200, 100],
    ["monthly", 2, "2 months", 600, 100],
    ["yearly", 1, "year", 100, 100],
  ] as const;
  for (const [frequency, interval, every, perYearCents, next30Cents] of cases) {
    const result = recurringRule({ ...item, terms: [{ amountCents: 100, frequency, interval, startOn: today, effectiveOn: today }] }, today, new Set(), []);
    expect(result).toMatchObject({ every, perYearCents, next30Cents });
  }
});

test("preserves currency precision and actual posted charges, skipping already paid dates", () => {
  const charges = [{ id: "expense", date: today, cents: 1100 }];
  const rule = recurringRule({
    ...item, planEntry: true, terms: [{ frequency: "monthly", interval: 1, startOn: today, effectiveOn: today, amountCents: 1000, cadAmountCents: 900, currency: "JPY" }],
  }, today, new Set(["rule:2026-11"]), charges);
  expect(rule).toMatchObject({
    original: { currency: "JPY", display: "1000" }, cents: 900, next: "2026-12-13", next30Cents: 0, charges,
  });
});

test("upcoming payment can be years away with a longer existing cadence", () => {
  const rule = recurringRule({
    ...item, terms: [{ frequency: "yearly", interval: 5, startOn: "2026-10-01", effectiveOn: "2026-10-01", amountCents: 100 }],
  }, today, new Set(), []);
  expect(rule).toMatchObject({ next: "2031-10-01", perYearCents: 20, next30Cents: 0 });
});
