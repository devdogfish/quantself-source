// Pure what-if calculation for a TaxYearPlan. `on` is the set of claim ids the Owner has switched on.
// Runs in the browser so every switch updates the page instantly; the backend only serves the plan and its rules.
import type { Certainty, Claim, TaxYearPlan } from "./tax-model";

export type Calc = {
  deductions: number;
  taxable: number;
  grossTax: number;
  claimedCredits: number;
  credits: number;
  owed: number;
  refund: number; // negative means a balance owing
};

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
export const totalIncome = (plan: TaxYearPlan) => sum(plan.income.map((line) => line.cents));
export const totalWithheld = (plan: TaxYearPlan) => sum(plan.withheld.map((line) => line.cents));

export function taxOn(plan: TaxYearPlan, taxable: number) {
  let tax = 0, from = 0;
  for (const { upToCents, rate } of plan.rules.bands) {
    const to = upToCents ?? Infinity;
    if (taxable > from) tax += (Math.min(taxable, to) - from) * rate;
    from = to;
  }
  return Math.round(tax);
}

// The part of a credit claim that counts, before applying the credit rate.
export function creditBase(plan: TaxYearPlan, claim: Claim, taxable: number) {
  if (claim.treatment === "credit") return claim.amountCents;
  if (claim.treatment !== "medicalCredit") return 0;
  const { floorRate, floorCapCents } = plan.rules.medical;
  return Math.max(0, claim.amountCents - Math.min(Math.round(taxable * floorRate), floorCapCents));
}

export function calc(plan: TaxYearPlan, on: Set<string>): Calc {
  const active = plan.claims.filter((claim) => on.has(claim.id));
  const deductions = sum(active.filter((claim) => claim.treatment === "deduction").map((claim) => claim.amountCents));
  const taxable = totalIncome(plan) - deductions;
  const grossTax = taxOn(plan, taxable);
  const claimedCredits = Math.round(sum(active.map((claim) => creditBase(plan, claim, taxable))) * plan.rules.creditRate);
  const credits = plan.rules.baselineCreditsCents + claimedCredits;
  const owed = Math.max(0, grossTax - credits);
  return { deductions, taxable, grossTax, claimedCredits, credits, owed, refund: totalWithheld(plan) - owed };
}

export const withClaim = (on: Set<string>, id: string, value: boolean) => {
  const next = new Set(on);
  if (value) next.add(id); else next.delete(id);
  return next;
};

// What-if levels: each includes the ones before it.
export const levels: { value: Certainty; label: string; certainties: Certainty[] }[] = [
  { value: "confirmed", label: "Confirmed", certainties: ["confirmed"] },
  { value: "likely", label: "Likely", certainties: ["confirmed", "likely"] },
  { value: "uncertain", label: "Uncertain", certainties: ["confirmed", "likely", "uncertain"] },
];
export const claimIds = (plan: TaxYearPlan, certainties: Certainty[]) => new Set(plan.claims.filter((claim) => certainties.includes(claim.certainty)).map((claim) => claim.id));
// The plan opens on the "Likely" level.
export const defaultOn = (plan: TaxYearPlan) => claimIds(plan, ["confirmed", "likely"]);
