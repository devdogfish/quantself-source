"use client";

// Budgeting page frame: PageHeader (title, actions, optional facts; no subtitle) with the area tabs in its
// `nav` slot, like Website analytics and Inventory, then PageBody. Design settled in #175.
import { AreaNav } from "@/components/shared/area-nav";
import { PageBody, PageHeader, type PageFact } from "@/components/shared/page-layout";

const paths = {
  overview: "/budgeting",
  log: "/budgeting/log",
  transactions: "/budgeting/transactions",
  subscriptions: "/budgeting/subscriptions",
  documents: "/budgeting/documents",
  tax: "/budgeting/tax-planning",
} as const;
export type BudgetPage = keyof typeof paths;

// Link to a Budgeting page with optional query state (filters, drawer ?id=).
export const to = (page: BudgetPage, params: Record<string, string | undefined> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.size ? `${paths[page]}?${q}` : paths[page];
};

// Every Budgeting destination stays reachable from the tabs. The redesigned module pages render their own frame;
// the rest are the existing pages (see #175 follow-ups for consolidating them).
export const budgetingNav = [
  { href: paths.overview, label: "Overview", exact: true },
  { href: paths.log, label: "Log" },
  { href: paths.transactions, label: "Transactions" },
  { href: paths.subscriptions, label: "Subscriptions" },
  { href: paths.documents, label: "Documents", also: ["/budgeting/receipts"] },
  { href: "/budgeting/plan", label: "Plan" },
  { href: "/budgeting/affordability", label: "Can I afford this?" },
  { href: paths.tax, label: "Tax planning" },
  { href: "/budgeting/import", label: "Import bank CSV" },
];
export const modulePaths: string[] = Object.values(paths);

export function Frame({ title, actions, facts, children }: {
  title: string; actions?: React.ReactNode; facts?: PageFact[]; children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} actions={actions} facts={facts} nav={<AreaNav label="Budgeting" items={budgetingNav} />} />
      <PageBody pb="16">{children}</PageBody>
    </>
  );
}
