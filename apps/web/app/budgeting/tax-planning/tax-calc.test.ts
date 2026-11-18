import { expect, test } from "bun:test";
import { calc, claimIds, defaultOn, withClaim } from "./tax-calc";
import { sampleTaxPlan as plan } from "./tax-plan.fixture";

test("the sample plan reproduces the approved design's refund at each level", () => {
  expect(calc(plan, new Set()).refund).toBe(-142_512); // no claims: owes $1,425
  expect(calc(plan, claimIds(plan, ["confirmed"])).refund).toBe(57_350);
  expect(calc(plan, defaultOn(plan))).toMatchObject({ refund: 128_471, owed: 383_529, taxable: 4_024_400, deductions: 301_800 });
  expect(calc(plan, claimIds(plan, ["confirmed", "likely", "uncertain"])).refund).toBe(201_370);
});

test("switching a claim on or off moves only what that claim touches", () => {
  const on = defaultOn(plan);
  const without = calc(plan, withClaim(on, "server", false));
  expect(without.deductions).toBe(61_800); // only software left
  expect(without.claimedCredits).toBeGreaterThan(0);
  expect(calc(plan, withClaim(on, "tuition", false)).claimedCredits).toBeLessThan(calc(plan, on).claimedCredits);
});

test("medical credit counts only the part above the income floor", () => {
  const dental = withClaim(new Set(), "dental", true);
  const floor = Math.round((4_326_200) * 0.03);
  expect(calc(plan, dental).claimedCredits).toBe(Math.round((214_000 - floor) * plan.rules.creditRate));
});
