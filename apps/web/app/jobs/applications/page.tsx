import { Suspense } from "react";
import type { Metadata } from "next";
import { JobsApplications } from "./jobs-applications";

export const metadata: Metadata = { title: "Applications · Jobs · Quantself" };

export default function JobsApplicationsPage() {
  return <Suspense><JobsApplications /></Suspense>;
}
