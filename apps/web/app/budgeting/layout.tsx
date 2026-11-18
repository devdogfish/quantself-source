import type { ReactNode } from "react";
import { BudgetingShell } from "./budgeting-shell";

export default function BudgetingLayout({ children }: { children: ReactNode }) {
  return <BudgetingShell>{children}</BudgetingShell>;
}
