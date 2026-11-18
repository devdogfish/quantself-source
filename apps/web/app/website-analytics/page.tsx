import { Suspense } from "react";
import { Website } from "./website";

export const metadata = { title: "Website · Website analytics · Quantself" };

export default function WebsiteAnalyticsPage() {
  return <Suspense><Website /></Suspense>;
}
