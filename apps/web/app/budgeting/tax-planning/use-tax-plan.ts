"use client";

import { useBudget } from "../budgeting-client";

export function useTaxPlan(year: number) {
  const { currentValue, currentError, reload } = useBudget<"getBudgetTaxPlan">(`/tax-planning?year=${year}`);
  return { plan: currentValue, error: currentError, retry: reload };
}
