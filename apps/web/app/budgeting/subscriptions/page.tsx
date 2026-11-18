import { Suspense } from "react";
import { BudgetSubscriptions } from "../module/subscriptions";

export const metadata = { title: "Subscriptions · Budgeting · Quantself" };

export default function Page() {
  return <Suspense><BudgetSubscriptions /></Suspense>;
}
