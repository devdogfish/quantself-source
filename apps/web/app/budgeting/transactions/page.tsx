import { Suspense } from "react";
import { BudgetTransactions } from "../module/transactions";

export const metadata = { title: "Transactions · Budgeting · Quantself" };

export default function Page() {
  return <Suspense><BudgetTransactions /></Suspense>;
}
