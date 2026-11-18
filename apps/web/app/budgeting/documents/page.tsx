import { Suspense } from "react";
import { BudgetDocuments } from "../module/documents";

export const metadata = { title: "Documents · Budgeting · Quantself" };

export default function Page() {
  return <Suspense><BudgetDocuments /></Suspense>;
}
