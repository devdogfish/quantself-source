import type { Metadata } from "next";
import { JobsOverview } from "./jobs-overview";

export const metadata: Metadata = { title: "Jobs · Quantself" };

export default function JobsOverviewPage() {
  return <JobsOverview />;
}
