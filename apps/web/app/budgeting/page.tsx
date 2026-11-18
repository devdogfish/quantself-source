import { Suspense } from "react";
import { BudgetOverview } from "./module/overview";

export const metadata = { title: "Overview · Budgeting · Quantself" };

export default function Page() {
  return <Suspense><BudgetOverview /></Suspense>;
}
