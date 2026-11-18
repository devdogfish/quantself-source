import type { Metadata } from "next";
import { JobsSubmissions } from "./jobs-submissions";

export const metadata: Metadata = { title: "Submissions · Jobs · Quantself" };

export default function JobsSubmissionsPage() {
  return <JobsSubmissions />;
}
