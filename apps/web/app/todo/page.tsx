import { Suspense } from "react";
import { redirect } from "next/navigation";
import { TodoWorkspace } from "./todo-workspace";

export const metadata = { title: "To-Do · Quantself" };

type Query = Record<string, string | string[] | undefined>;

function legacyCalendarHref(query: Query) {
  const view = Array.isArray(query.view) ? query.view[0] : query.view;
  if (view !== "calendar" && view !== "day" && view !== "week" && view !== "month" && view !== "year") return null;

  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const item of typeof value === "string" ? [value] : value ?? []) params.append(name, item);
  }
  return `/calendar?${params}` as const;
}

export default async function TodoPage({ searchParams }: { searchParams: Promise<Query> }) {
  const calendarHref = legacyCalendarHref(await searchParams);
  if (calendarHref) redirect(calendarHref);
  return <Suspense fallback={<p role="status">Loading tasks…</p>}><TodoWorkspace /></Suspense>;
}
