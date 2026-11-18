import { expect, test } from "bun:test";
import { billOccurrences, emptyPlan, forecast, summarizeBudgetActivity } from "./budgeting";
import { parseReceiptText } from "./budget-receipt-scan";

const zeroLimits = { ...emptyPlan, foodCents: 0, otherCents: 0 };
const internet = { id: "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642", kind: "bill", label: "Internet", date: "2026-11-30", cents: 8000, frequency: "monthly" } as const;

test("a matched bill replaces its scheduled estimate exactly once", () => {
  const plan = { ...zeroLimits, checkpoint: { date: "2026-11-01", cents: 50_000 }, entries: [internet] };
  const unpaid = forecast(plan, [], "2026-11-30");
  const paid = forecast(plan, [{ date: "2026-11-30", totalCents: 8200, foodCents: 0, billKey: internet.id + ":2026-11" }], "2026-11-30");
  expect(unpaid.months[0].cents).toBe(42_000);
  expect(paid.months[0].cents).toBe(41_800);
  expect(paid.otherSpent).toBe(0);
  expect(billOccurrences(plan, "2027-02-01", "2027-02-28").map(e => e.date)).toEqual(["2027-02-28"]);
});

test("a same-day cash reset keeps spending history and counts later expenses once", () => {
  const plan = { ...zeroLimits, foodCents: 10_000,
    checkpoint: { date: "2026-11-08", cents: 25_000, recordedAt: "2026-11-08T12:00:00Z" } };
  const paid = forecast(plan, [
    { date: "2026-11-08", totalCents: 500, foodCents: 500, billKey: null, createdAt: new Date("2026-11-08T11:00:00Z") },
    { date: "2026-11-08", totalCents: 1000, foodCents: 800, billKey: null, createdAt: new Date("2026-11-08T13:00:00Z") },
  ], "2026-11-08");
  expect(paid.available).toBe(24_000);
  expect(paid.foodSpent).toBe(1300);
  expect(paid.otherSpent).toBe(200);
  expect(paid.shortfall).toBe("2026-11-16");
});

test("uncertain income only affects the preview", () => {
  const plan = { ...zeroLimits, checkpoint: { date: "2026-11-01", cents: 5000 }, entries: [
    internet, { ...internet, id: "8c4e401d-74a1-4ec7-8b23-b1e97dbc0642", date: "2026-11-29", kind: "uncertainIncome" as const, cents: 5000, frequency: "once" as const },
  ] };
  expect(forecast(plan, [], "2026-11-08").shortfall).toBe("2026-11-30");
  expect(forecast(plan, [], "2026-11-08", { uncertain: true }).shortfall).toBe("2026-12-30");
});

test("receipt OCR preserves ordered columns and ignores subtotal when finding the total", () => {
  const parsed = parseReceiptText("Market\n2026/11/08\nBread 4.99\nSubtotal 4.99\nTax 0.75\nTOTAL $5.74");
  expect(parsed).toMatchObject({ merchant: "Market", date: "2026-11-08", totalCents: 574 });
  expect(parsed.lines[2]).toEqual({ text: "Bread", amount: "4.99" });
});

test("a checkpoint alone does not imply twelve months of runway", () => {
  const result = forecast({ ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 50_000 } }, [], "2026-11-08");
  expect(result.available).toBe(50_000);
  expect(result.months).toEqual([]);
  expect(result.foodLimit).toBeNull();
});

test("cash flow separates deposits, refunds, and bill spending without counting transfers", () => {
  const row = { date: "2026-11-01", bankFlow: null, billKey: null, totalCents: 2500, foodCents: 2000 };
  const activity = summarizeBudgetActivity("2026-11-02", [
    row,
    { ...row, date: "2026-10-31" },
    { ...row, date: "2026-11-02", totalCents: -500, foodCents: -500, bankFlow: "refund" },
    { ...row, date: "2026-11-02", totalCents: -150_000, foodCents: 0, bankFlow: "deposit" },
    { ...row, date: "2026-11-02", totalCents: 100_000, foodCents: 0, bankFlow: "transfer" },
    { ...row, date: "2026-11-02", totalCents: 33_300, foodCents: 0, billKey: "bill:once" },
    { ...row, date: "2026-11-03" },
  ]);
  expect(activity.cashFlow).toEqual([
    { month: "2026-11", deposits: 150_000, refunds: 500, food: 2000, other: 500, bills: 33_300 },
    { month: "2026-10", deposits: 0, refunds: 0, food: 2000, other: 500, bills: 0 },
  ]);
  expect(activity.week.slice(0, 2)).toEqual([
    { date: "2026-11-02", food: -500, other: 0 },
    { date: "2026-11-03", food: 0, other: 0 },
  ]);
});

test("dated income appears in the schedule and forecast while matched bills disappear", () => {
  const payment = { ...internet, date: "2026-11-09", frequency: "once" as const, cents: 33_300 };
  const income = { ...payment, id: "8c4e401d-74a1-4ec7-8b23-b1e97dbc0642",
    kind: "income" as const, label: "Pay", date: "2026-11-10", cents: 75_000 };
  const plan = { ...zeroLimits, checkpoint: { date: "2026-11-08", cents: 100_000 }, entries: [payment, income] };
  const result = forecast(plan, [], "2026-11-08");
  expect(result.bills.map(entry => entry.date)).toEqual(["2026-11-09"]);
  expect(result.income.map(entry => entry.date)).toEqual(["2026-11-10"]);
  expect(result.projection.slice(0, 3).map(day => day.cents)).toEqual([100_000, 66_700, 141_700]);
  const paid = forecast(plan, [{ date: "2026-11-09", totalCents: 33_300, foodCents: 0, billKey: payment.id + ":once" }], "2026-11-09");
  expect(paid.bills).toEqual([]);
  expect(paid.projection[0].cents).toBe(66_700);
});

test("rent runway reserves debt and uses only scheduled mandatory cash flows", () => {
  const rent = { ...internet, label: "Rent", cents: 100_000 };
  const income = { ...rent, id: "8c4e401d-74a1-4ec7-8b23-b1e97dbc0642",
    date: "2026-11-15", label: "Final pay", kind: "income" as const, frequency: "once" as const, cents: 160_000 };
  const plan = {
    ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 100_000 }, entries: [rent, income],
    rentRunway: { through: "2026-11-30", reserveCents: 25_000, rentEntryId: rent.id },
  };
  const expected = { through: "2026-11-30", leftoverCents: 135_000, fullRentMonths: 1, reserveCents: 25_000 };
  expect(forecast(plan, [], "2026-11-08").rentRunway).toEqual(expected);
  expect(forecast(plan, [], "2026-11-08", { food: 30_000, other: 10_000 }).rentRunway).toEqual(expected);
});

test("weekly allowance accounts for subscription timing, debt reserve, and the saved split", () => {
  const rent = { ...internet, label: "Rent", date: "2026-11-30", cents: 25_000 };
  const income = { ...rent, id: "8c4e401d-74a1-4ec7-8b23-b1e97dbc0642",
    date: "2026-11-15", label: "Pay", kind: "income" as const, frequency: "once" as const, cents: 100_000 };
  const subscription = { ...rent, date: "2026-11-14", label: "Subscription", key: "subscription:2026-11-14", cents: 20_000 };
  const plan = {
    ...emptyPlan, checkpoint: { date: "2026-11-08", cents: 50_000 }, entries: [rent, income],
    foodCents: 30_000, otherCents: 10_000,
    rentRunway: { through: "2026-11-30", reserveCents: 10_000, rentEntryId: rent.id },
  };
  const options = { payments: [subscription], food: 1, other: 1 };
  expect(forecast(plan, [], "2026-11-08", options).weeklyAllowance).toEqual({
    through: "2026-11-30", foodCents: 15_000, otherCents: 5_000, firstMandatoryShortfall: null,
  });
  expect(forecast({ ...plan, checkpoint: { ...plan.checkpoint, cents: 25_000 } }, [], "2026-11-08", options)
    .weeklyAllowance).toMatchObject({ foodCents: 0, otherCents: 0, firstMandatoryShortfall: "2026-11-14" });
});

test("pending money stays out of all projections, with or without a date", () => {
  const plan = {
    ...zeroLimits, checkpoint: { date: "2026-11-01", cents: 5000 }, entries: [internet],
    rentRunway: { through: "2026-11-30", reserveCents: 0, rentEntryId: internet.id },
  };
  const pendingMoney = [
    { id: crypto.randomUUID(), label: "Government payment", date: null, cents: 35_000 },
    { id: crypto.randomUUID(), label: "Deposit return", date: "2026-11-20", cents: 20_000 },
  ];
  for (const uncertain of [false, true]) {
    const options = { uncertain };
    expect(forecast({ ...plan, pendingMoney }, [], "2026-11-08", options))
      .toEqual(forecast(plan, [], "2026-11-08", options));
  }
});

test("forecast uses current and scheduled weekly limits with independent scenario overrides", () => {
  const today = "2026-11-13";
  const nextWeek = "2026-11-16";
  const plan = { ...emptyPlan, checkpoint: { date: today, cents: 100000 }, foodCents: 10000, otherCents: 7000 };
  const limitsForWeek = (week: string) => ({ food: week >= nextWeek ? 14000 : 12000, other: 8000 });
  const forecasted = forecast(plan, [], today, { limitsForWeek });
  expect(forecasted).toMatchObject({ foodLimit: 12000, otherLimit: 8000 });
  expect(forecasted.projection[0]).toEqual({ date: today, cents: 80000 });
  expect(forecasted.projection.find(point => point.date === nextWeek)).toEqual({ date: nextWeek, cents: 58000 });
  expect(forecasted.projection.find(point => point.date === "2026-11-23")).toEqual({ date: "2026-11-23", cents: 36000 });

  const scenario = forecast(plan, [], today, { food: 1000, limitsForWeek });
  expect(scenario).toMatchObject({ foodLimit: 1000, otherLimit: 8000 });
  expect(scenario.projection.find(point => point.date === nextWeek)).toEqual({ date: nextWeek, cents: 82000 });
});
