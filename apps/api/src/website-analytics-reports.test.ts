import { expect, test } from "bun:test";
import { analyticsDayMs as day, type WebsiteAnalyticsRow } from "./website-analytics-events";
import { buildJobSearchReport, type RegisteredApplication } from "./website-analytics-job-search";
import { jobSearchReportOutput, websiteReportOutput, websiteReportQuery } from "./website-analytics-report-contract";
import { buildWebsiteReport, type WebsiteReportData } from "./website-analytics-reports";

const now = Date.parse("2026-11-14T18:00:00Z");
const appCode = "Ab0123456789CdEf";
const zeroCode = "a".repeat(24);
const shareCode = "Rbc0k3Vz";
let index = 0;
function event(kind: string, at: number, fields: Partial<WebsiteAnalyticsRow> = {}): WebsiteAnalyticsRow {
  return { id: String(++index), at, kind, path: "/project/rbc", sessionId: null, pageViewId: null,
    visitorId: null, linkCode: null, ipId: null, utmSource: null, referrerHost: null, device: "desktop", props: {}, ...fields };
}
function browser(sessionId: string, at: number, fields: Partial<WebsiteAnalyticsRow> = {}, props = { activeMs: 5_000, maxScroll: 80 }) {
  const page = { sessionId, pageViewId: `view-${sessionId}`, ...fields };
  return [event("page:view", at, page), event("page:engagement", at + 6_000, { ...page, props })];
}
const application: RegisteredApplication = {
  applicationId: "11111111-1111-4111-8111-111111111111", code: appCode, cohort: "web-cms",
  company: "Example", role: "Editor", sentAt: now - day, status: null,
};
const links: WebsiteReportData["links"] = [
  { code: appCode, sentAt: application.sentAt },
];
const data = (events: WebsiteAnalyticsRow[] = []): WebsiteReportData => ({ events, links, inquiries: [] });

test("native channel and device filters apply identically to adjacent UTC periods", () => {
  const rows = [
    ...browser("current", now - day, { linkCode: shareCode, device: "mobile", utmSource: "linkedin", referrerHost: "github.com" }),
    ...browser("previous", now - 8 * day, { utmSource: "linkedin", device: "mobile" }, { activeMs: 9_000, maxScroll: 75 }),
    ...browser("wrong-device", now - 2 * day, { linkCode: shareCode, referrerHost: "linkedin.com" }),
    ...browser("wrong-project", now - day, { linkCode: shareCode, referrerHost: "linkedin.com", device: "mobile", path: "/project/other" }),
    ...browser("resume", now - day, { linkCode: appCode, utmSource: "linkedin", device: "mobile" }),
    ...browser("referral", now - day, { referrerHost: "github.com" }),
  ];
  const report = buildWebsiteReport(data(rows), { range: 7, channel: "linkedin", project: "/project/rbc", device: "mobile" }, now);
  expect(websiteReportOutput.parse(report).totals).toMatchObject({
    visitors: 1, previousVisitors: 1, avgActiveSeconds: 5, previousAvgActiveSeconds: 9,
  });
  expect(report.projects.map(row => row.path)).toEqual(["/project/other", "/project/rbc"]);
  expect(report.daily.map(row => row.previousVisitors)).toEqual([0, 0, 0, 0, 0, 1, 0]);
  const all = buildWebsiteReport(data(rows), { range: 7 }, now);
  expect(all.channels.map(row => [row.id, row.visitors])).toEqual([["linkedin", 3], ["github", 1], ["resume", 1]]);
});

test("scanner rules reject HEAD, bots, quick opens and bursts while engagement must match the same via", () => {
  const ipId = "a".repeat(64);
  const sent = application.sentAt!;
  const open = (id: string, at: number, props: Record<string, unknown>, ip: string | null = null) =>
    event("link:open", at, { id, linkCode: appCode, ipId: ip, path: `/r/${appCode}/${props.key ?? "github"}`, props });
  const rows = [
    open("head", sent + 30_000, { method: "HEAD" }),
    open("agent", sent + 40_000, { method: "GET", ua: "Synthetic Bot/1" }),
    open("quick", sent + 9_000, { method: "GET" }, ipId),
    ...browser("scanner-runs-js", sent + 9_500, { linkCode: appCode, ipId }),
    open("burst-1", sent + 65_000, { method: "GET", key: "github" }, ipId),
    open("burst-2", sent + 66_000, { method: "GET", key: "rbc-demo" }, ipId),
    open("real", sent + 110_000, { method: "GET", key: "github" }, ipId),
    ...browser("human", sent + 112_000, { linkCode: appCode, ipId }, { activeMs: 300, maxScroll: 40 }),
    event("cta:click", sent + 117_000, { sessionId: "human", linkCode: appCode, props: { cta: "resume_download" } }),
    event("page:view", sent + 140_000, { sessionId: "mixed", pageViewId: "before", linkCode: appCode, ipId }),
    ...browser("mixed", sent + 150_000, { linkCode: "unrelated-code", ipId }),
    ...browser("insufficient", sent + 170_000, { linkCode: appCode }, { activeMs: 4_999, maxScroll: 0 }),
    open("lonely", sent + 200_000, { method: "GET" }),
  ];
  const registry = [application, { ...application, applicationId: "22222222-2222-4222-8222-222222222222",
    code: zeroCode, sentAt: null, status: "rejected" }];
  const jobs = jobSearchReportOutput.parse(buildJobSearchReport(rows, registry, now));
  expect(jobs.excludedScanners).toBe(5);
  expect(jobs.applications[0].visits.filter(visit => visit.scanner).map(visit => visit.id).sort())
    .toEqual(["agent", "burst-1", "burst-2", "head", "quick"].map(id => `redirect:${id}`));
  expect(jobs.applications[0].visits.filter(visit => !visit.scanner)).toEqual([{
    id: "browser:human", link: "GitHub", scanner: false, device: "desktop", at: new Date(sent + 110_000).toISOString(),
    pages: [{ path: "/project/rbc", title: "Rbc", activeSeconds: 0.3, scrollPercent: 40 }], ctas: ["Download résumé"],
  }]);
  expect(jobs.applications[1]).toMatchObject({ sentAt: null, visits: [], outcome: "rejected", outcomeAt: null });
  const website = buildWebsiteReport(data(rows), { range: 7, channel: "resume" }, now);
  expect(website.excludedScanners).toBe(5);
  expect(website.totals.visitors).toBe(1);
});

test("shares count opens and engaged visits by code, including unused shares", () => {
  const records = data([
    event("link:open", now - day - 1000, { linkCode: shareCode, props: { method: "GET" } }),
    event("link:open", now - day - 2000, { linkCode: shareCode, props: { method: "HEAD" } }),
    event("link:open", now - day, { linkCode: "Unknown1" }),
    ...browser("first", now - day, { linkCode: shareCode }),
    ...browser("second", now - day, { linkCode: shareCode }),
    event("page:view", now - day, { linkCode: shareCode, sessionId: "unengaged" }),
  ]);
  records.inquiries.push(
    { id: "inquiry", name: "Example", email: "person@example.test", topic: "Private project", status: "replied", linkCode: shareCode, receivedAt: now - day },
    { id: "direct", name: "Direct", email: null, topic: "Support", status: "new", linkCode: null, receivedAt: now - day },
  );
  const report = buildWebsiteReport(records, { range: 7 }, now);
  expect(buildJobSearchReport(records.events, [application], now, [
    { code: shareCode, title: "RBC launch", track: "backend", archived: false }, { code: "Empty123", title: "Empty share", track: null, archived: false },
  ]).shares).toEqual([
    { code: "Empty123", title: "Empty share", track: null, archived: false, opens: 0, visits: 0 },
    { code: shareCode, title: "RBC launch", track: "backend", archived: false, opens: 2, visits: 2 },
  ]);
  expect(report.inquiries).toEqual([
    expect.objectContaining({ id: "direct", status: "new", channel: "direct" }),
    expect.objectContaining({ id: "inquiry", status: "replied", channel: "other" }),
  ]);
  expect(report.channels).toContainEqual(expect.objectContaining({ id: "other", visitors: 0, inquiries: 1 }));
  expect(buildWebsiteReport(records, { range: 7, channel: "github" }, now).inquiries).toEqual([]);
});

test("validates report filters and gives zero comparisons when both periods have no recorded rows", () => {
  expect(websiteReportQuery.safeParse({ project: "/projects/rbc", range: "90" }).success).toBe(true);
  expect(websiteReportQuery.safeParse({ device: "tablet" }).success).toBe(false);
  const report = buildWebsiteReport(data(), websiteReportQuery.parse({}), now);
  expect(report).toMatchObject({ previousPeriod: "complete", totals: { visitors: 0, previousVisitors: 0 } });
  expect(report.daily).toHaveLength(30);
});
