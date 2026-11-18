import type { TaxRules } from "@quantself/budgeting/tax-model";

// 2026 Nova Scotia, checked November 14, 2026 against CRA T4032NS and the 2026 budget.
// https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4032-payroll-deductions-tables/t4032ns-jan/t4032ns-january-general-information.html
// https://www.budget.canada.ca/2026/report-rapport/tm-mf-en.html
// Combine marginal rates at each federal or provincial breakpoint. Use the maximum
// federal basic personal amount and the provincial basic personal amount as fixed credits.
// Owner rules/claims can model payroll credits; the default cannot infer CPP, EI or
// employment credits from income lines. Use the federal medical floor for both credits.
const novaScotia2026: TaxRules = {
  bands: [
    { upToCents: 3_099_500, rate: 0.2279 },
    { upToCents: 5_852_300, rate: 0.2895 },
    { upToCents: 6_199_100, rate: 0.3545 },
    { upToCents: 9_741_700, rate: 0.3717 },
    { upToCents: 11_704_500, rate: 0.38 },
    { upToCents: 15_712_400, rate: 0.435 },
    { upToCents: 18_144_000, rate: 0.47 },
    { upToCents: 25_848_200, rate: 0.50 },
    { upToCents: null, rate: 0.54 },
  ],
  creditRate: 0.2279,
  baselineCreditsCents: Math.round(1_645_200 * 0.14 + 1_193_200 * 0.0879),
  medical: { floorRate: 0.03, floorCapCents: 289_000 },
};

// Lets unconfigured years render the empty planner using the same response contract.
export const unconfiguredTaxRules: TaxRules = {
  bands: [{ upToCents: null, rate: 0 }],
  creditRate: 0,
  baselineCreditsCents: 0,
  medical: { floorRate: 0, floorCapCents: 0 },
};

export function defaultTaxRules(year: number): TaxRules | undefined {
  return year === 2026 ? novaScotia2026 : undefined;
}
