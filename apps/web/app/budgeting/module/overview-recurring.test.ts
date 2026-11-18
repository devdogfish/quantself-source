import { expect, test } from "bun:test";
import type { Subscription } from "@quantself/budgeting";
import { projectRecurringOverview } from "./overview-recurring";
import type { ModuleOverview } from "./overview-client";

const id = "6a282c67-0202-4116-a5a9-3226f8692968";
const localCommand = "cca62731-94c8-471a-97ae-9ec044a18abe";
const otherCommand = "92c05379-ea95-4641-b6d5-3a8032564776";
const today = "2026-11-13";
const tomorrow = "2026-11-14";
const term = { effectiveOn: today, startOn: tomorrow, amountCents: 900, frequency: "monthly" as const, interval: 1 };
const row: Subscription = {
  id, name: "Internet", revision: 1, commandId: otherCommand, status: "active", kind: "bill", stopsOn: null,
  terms: [term], sourceKey: null, evidence: "", logoKey: null, websiteUrl: null, cancelUrl: null, estimated: false,
};
const base: ModuleOverview = {
  today, statements: [{ start: today, end: tomorrow, bills: [], income: [], savings: [], spending: [], cats: [],
    totals: { income: 0, bills: 0, savings: 0, spending: 0 }, net: 0, allowance: 0, daysLeft: 2 }],
  context: { cash: 2000, foodLimit: 0, otherLimit: 0, upcoming: [], balance: [
    { date: today, cents: 2000, past: true }, { date: tomorrow, cents: 2000, past: false },
  ] },
};

test("a newer external revision stays authoritative while an older write is pending", () => {
  const rules = [{ id, revision: 2, commandId: otherCommand, status: "paused" as const, stopsOn: null, events: [{
    key: id + ":" + tomorrow, date: tomorrow, label: row.name, cents: 900, kind: "bill" as const,
    upcoming: true, uncertain: false, forecastDate: tomorrow,
  }] }];
  expect(projectRecurringOverview(base, rules, rules, [{ item: row, commandId: localCommand, pending: true, created: false }])).toEqual(base);
});

test("a new rule projects its priced schedule before persistence and rolls back without mutating the base", () => {
  const projected = projectRecurringOverview(base, [], [], [{ item: { ...row, revision: 0 }, pending: true, created: true }]);
  expect(projected.statements[0]).toMatchObject({ bills: [{ label: row.name, date: tomorrow, cents: 900, done: false }], net: -900 });
  expect(projected.context).toMatchObject({ cash: 2000, upcoming: [{ key: id }], balance: [{ cents: 2000 }, { cents: 1100 }] });
  expect(projectRecurringOverview(base, [], [], [{ item: { ...row, status: "dismissed" }, pending: true, created: true }])).toEqual(base);
});
