import { Suspense } from "react";
import { BudgetLog } from "../module/log";

export const metadata = { title: "Log · Budgeting · Quantself" };

export default function Page() {
  return <Suspense><BudgetLog /></Suspense>;
}
