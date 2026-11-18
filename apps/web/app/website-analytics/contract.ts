import type { components, paths } from "@/lib/generated/quantself-api-schema";

export const websiteReportPath = "/api/v1/website-analytics/website" satisfies keyof paths;
export const jobSearchReportPath = "/api/v1/website-analytics/job-search" satisfies keyof paths;

export type WebsiteReport = components["schemas"]["WebsiteReport"];
export type ChannelId = WebsiteReport["channels"][number]["id"];
export type InquiryStatus = WebsiteReport["inquiries"][number]["status"];
export type Device = NonNullable<Visit["device"]>;
export type TrackingStatus = Pick<WebsiteReport, "generatedAt" | "lastEventAt" | "excludedScanners">;

export type JobSearchReport = components["schemas"]["JobSearchReport"];
export type Application = JobSearchReport["applications"][number];
export type Outcome = Application["outcome"];
export type Visit = Application["visits"][number];
