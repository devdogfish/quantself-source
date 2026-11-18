import { Suspense } from "react";
import { CalendarWorkspace } from "./calendar-workspace";

export const metadata = { title: "Calendar · Quantself" };

export default function CalendarPage() {
  return <Suspense fallback={<p role="status">Loading calendar…</p>}><CalendarWorkspace /></Suspense>;
}
