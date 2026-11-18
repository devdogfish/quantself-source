import { z } from "@hono/zod-openapi";
import { trackedLinkCode, trackedShareTrack } from "./tracked-links-contract";

export const websiteChannels = ["resume", "linkedin", "youtube", "github", "google", "direct", "other"] as const;
const channel = z.enum(websiteChannels);
const device = z.enum(["desktop", "mobile"]);
const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();
const channelCounts = z.partialRecord(channel, count);
export const websiteProjectPath = /^\/(?:about|(?:work|projects?)(?:\/[a-z0-9][a-z0-9._-]*)+)$/;

export const websiteReportQuery = z.object({
  range: z.enum(["7", "30", "90"]).default("30").transform(value => Number(value) as 7 | 30 | 90),
  channel: channel.optional(),
  project: z.string().max(240).regex(websiteProjectPath).optional(),
  device: device.optional(),
});

export const trackingStatus = z.object({
  generatedAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime().nullable(),
  excludedScanners: count.openapi({ description: "Suspected scanner opens excluded from activity metrics." }),
});

const metrics = {
  visitors: count,
  previousVisitors: count.nullable(),
  avgActiveSeconds: seconds,
  previousAvgActiveSeconds: seconds.nullable(),
  contactClicks: count,
  previousContactClicks: count.nullable(),
};

export const websiteReportOutput = trackingStatus.extend({
  range: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]), from: z.iso.date(), to: z.iso.date() }),
  previousPeriod: z.enum(["complete", "partial", "unavailable"]).openapi({
    description: "Comparison covers the same number of recorded UTC days immediately before the selected range.",
  }),
  totals: z.object(metrics),
  daily: z.array(z.object({ day: z.iso.date(), ...metrics, byChannel: channelCounts })).openapi({
    description: "One row per UTC day, oldest first, paired with the same day of the previous period.",
  }),
  channels: z.array(z.object({ id: channel, visitors: count, avgActiveSeconds: seconds, contactClicks: count, inquiries: count })),
  projects: z.array(z.object({
    path: z.string(), title: z.string(), views: count, avgActiveSeconds: seconds,
    readTo75Percent: z.number().min(0).max(100).nullable(), byChannel: channelCounts,
  })).openapi({ description: "Project pages ranked by views. Honors range, channel, and device filters." }),
  inquiries: z.array(z.object({
    id: z.string(), name: z.string(), topic: z.string(), email: z.email().nullable(), channel,
    receivedAt: z.iso.datetime(), status: z.enum(["new", "replied", "call_booked", "won", "lost"]),
  })),
}).openapi("WebsiteReport");

export type WebsiteReportQuery = z.output<typeof websiteReportQuery>;
export type WebsiteReport = z.output<typeof websiteReportOutput>;
export type WebsiteChannel = z.infer<typeof channel>;
export type WebsiteDevice = z.infer<typeof device>;

const visit = z.object({
  id: z.string(), at: z.iso.datetime(), link: z.string(), scanner: z.boolean(), device: device.nullable(),
  pages: z.array(z.object({ path: z.string(), title: z.string(), activeSeconds: seconds, scrollPercent: z.number().min(0).max(100).nullable() })),
  ctas: z.array(z.string()),
});

const application = z.object({
  applicationId: z.uuid(), code: trackedLinkCode, company: z.string(), role: z.string(),
  resume: z.string(), resumeLabel: z.string(),
  sentAt: z.iso.datetime().nullable().openapi({ description: "First confirmed submission time. Null when sending has no recorded date." }),
  outcome: z.enum(["none", "replied", "interview", "rejected"]).openapi({ description: "None means no recorded outcome." }),
  outcomeAt: z.iso.datetime().nullable(), portfolioUrl: z.url(), visits: z.array(visit),
});

export const websiteShare = z.object({
  code: trackedLinkCode, title: z.string(), track: trackedShareTrack.nullable(),
  archived: z.boolean(), opens: count, visits: count,
});

export const jobSearchReportOutput = trackingStatus.extend({
  shares: z.array(websiteShare),
  applications: z.array(application).openapi({ description: "Every registry entry, including applications without activity or a send date." }),
}).openapi("JobSearchReport");

export type JobSearchReport = z.output<typeof jobSearchReportOutput>;
export type JobSearchVisit = z.output<typeof visit>;
