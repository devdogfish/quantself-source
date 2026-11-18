import { Suspense } from "react";
import type { Metadata } from "next";
import { ReviewSessionPage } from "./review-session";

export const metadata: Metadata = { title: "Review · Jobs · Quantself" };

export default function JobsReviewPage() {
  return <Suspense><ReviewSessionPage /></Suspense>;
}
