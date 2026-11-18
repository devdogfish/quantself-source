import { Suspense } from "react";
import { JobSearch } from "./job-search";

export const metadata = { title: "Job search · Website analytics · Quantself" };

export default function JobSearchPage() {
  return <Suspense><JobSearch /></Suspense>;
}
