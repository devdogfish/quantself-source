import {
  websiteChannels, websiteProjectPath, type WebsiteChannel, type WebsiteReport, type WebsiteReportQuery,
} from "./website-analytics-report-contract";
import {
  analyticsDayMs, analyzeWebsiteEvents, ctaKey, deviceClass, pageTitle, sessionPages, type WebsiteAnalyticsRow,
} from "./website-analytics-events";

type Counts = Partial<Record<WebsiteChannel, number>>;
type Inquiry = WebsiteReport["inquiries"][number];

export type WebsiteReportLink = {
  code: string;
  sentAt: number | null;
};
export type WebsiteReportInquiry = Omit<Inquiry, "channel" | "receivedAt"> & { receivedAt: number; linkCode: string | null };
export type WebsiteReportData = {
  events: WebsiteAnalyticsRow[];
  links: WebsiteReportLink[];
  inquiries: WebsiteReportInquiry[];
};

function sourceChannel(source: string): WebsiteChannel | undefined {
  const value = source.toLowerCase().trim();
  if (value.startsWith("resume-")) return "resume";
  return websiteChannels.find(channel => channel === value);
}

function firstViewChannel(entry: WebsiteAnalyticsRow, links: ReadonlyMap<string, WebsiteReportLink>): WebsiteChannel {
  if (entry.linkCode && links.has(entry.linkCode)) return "resume";
  if (entry.utmSource) return sourceChannel(entry.utmSource) ?? "other";
  const host = (entry.referrerHost ?? "").toLowerCase().replace(/\.$/, "");
  if (/(^|\.)(linkedin\.com|lnkd\.in)$/.test(host)) return "linkedin";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)github\.com$/.test(host)) return "github";
  if (/(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return "google";
  if (host && !/(^|\.)girke\.dev$/.test(host)) return "other";
  // The native importer preserves a legacy source when an actual UTM/referrer is absent.
  const source = typeof entry.props.source === "string" ? entry.props.source : undefined;
  if (source && source !== "unknown") return sourceChannel(source) ?? "other";
  return "direct";
}

const contactCtas = new Set(["contact", "contact_open", "email", "email_click", "booking", "booking_click"]);
function metrics() {
  return { browsers: new Set<string>(), sessions: 0, activeMs: 0, contactClicks: 0, inquiries: 0 };
}
type Metrics = ReturnType<typeof metrics>;
type Day = { metrics: Metrics; channels: Map<WebsiteChannel, Metrics> };
type Project = { views: number; activeMs: number; scrollViews: number; readViews: number; byChannel: Counts };

function channelMetrics(channels: Map<WebsiteChannel, Metrics>, id: WebsiteChannel) {
  const result = channels.get(id) ?? metrics();
  channels.set(id, result);
  return result;
}

function averageSeconds(activeMs: number, count: number) {
  return count ? Math.round(activeMs / count / 1000) : 0;
}

function summarize(current: Metrics, previous: Metrics) {
  return {
    visitors: current.browsers.size, previousVisitors: previous.browsers.size,
    avgActiveSeconds: averageSeconds(current.activeMs, current.sessions),
    previousAvgActiveSeconds: averageSeconds(previous.activeMs, previous.sessions),
    contactClicks: current.contactClicks, previousContactClicks: previous.contactClicks,
  };
}

const utcDay = (at: number) => Math.floor(at / analyticsDayMs) * analyticsDayMs;
const dateLabel = (at: number) => new Date(at).toISOString().slice(0, 10);

export function websiteReportWindows(range: WebsiteReportQuery["range"], now: number) {
  const today = utcDay(now);
  const currentStart = today - (range - 1) * analyticsDayMs;
  const previousStart = currentStart - range * analyticsDayMs;
  return { today, currentStart, previousStart };
}

export function buildWebsiteReport(data: WebsiteReportData, query: WebsiteReportQuery, now: number): WebsiteReport {
  const { today, currentStart, previousStart } = websiteReportWindows(query.range, now);
  const links = new Map(data.links.map(link => [link.code, link]));
  const activity = analyzeWebsiteEvents(data.events, new Map(data.links.map(link => [link.code, link.sentAt])));
  const days: Day[] = Array.from({ length: 2 * query.range }, () => ({ metrics: metrics(), channels: new Map() }));
  const current = metrics(), previous = metrics();
  const channels = new Map<WebsiteChannel, Metrics>();
  const projects = new Map<string, Project>();
  const sessions = new Map<string, { entry: WebsiteAnalyticsRow; events: WebsiteAnalyticsRow[] }>();
  for (const visit of activity.visits) {
    const { entry, events } = visit;
    const sessionId = entry.sessionId!;
    const previous = sessions.get(sessionId);
    if (previous) {
      if (entry.at < previous.entry.at) previous.entry = entry;
      previous.events.push(...events);
    } else sessions.set(sessionId, { entry, events: [...events] });

  }
  for (const { entry, events } of sessions.values()) {
    if (entry.at < previousStart || entry.at > now) continue;
    const channel = firstViewChannel(entry, links);
    if ((query.channel && query.channel !== channel) || (query.device && query.device !== deviceClass(entry.device))) continue;
    const inCurrent = entry.at >= currentStart;
    const pages = sessionPages(events);
    if (inCurrent) for (const page of pages) {
      if (!websiteProjectPath.test(page.path)) continue;
      const project = projects.get(page.path) ?? { views: 0, activeMs: 0, scrollViews: 0, readViews: 0, byChannel: {} };
      project.views++;
      project.activeMs += page.activeMs;
      if (page.scrollPercent !== null) project.scrollViews++;
      if ((page.scrollPercent ?? 0) >= 75) project.readViews++;
      project.byChannel[channel] = (project.byChannel[channel] ?? 0) + 1;
      projects.set(page.path, project);
    }

    const selectedPages = query.project ? pages.filter(page => page.path === query.project) : pages;
    if (query.project && !selectedPages.length) continue;
    const activeMs = selectedPages.reduce((sum, page) => sum + page.activeMs, 0);
    const contactClicks = events.filter(event => contactCtas.has(ctaKey(event) ?? "")).length;
    const day = days[Math.floor((entry.at - previousStart) / analyticsDayMs)];
    const targets = [inCurrent ? current : previous, day.metrics, channelMetrics(day.channels, channel)];
    if (inCurrent) targets.push(channelMetrics(channels, channel));
    for (const target of targets) {
      target.browsers.add(entry.visitorId ?? entry.sessionId!);
      target.sessions++;
      target.activeMs += activeMs;
      target.contactClicks += contactClicks;
    }
  }

  const inquiries: Inquiry[] = data.inquiries.flatMap(({ receivedAt, linkCode, ...row }) => {
    if (receivedAt < currentStart || receivedAt > now) return [];
    const channel: WebsiteChannel = !linkCode ? "direct" : links.has(linkCode) ? "resume" : "other";
    if (query.channel && channel !== query.channel) return [];
    channelMetrics(channels, channel).inquiries++;
    return [{ ...row, channel, receivedAt: new Date(receivedAt).toISOString() }];
  }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
  const excludedScanners = query.project || query.device ? 0 : activity.scanners.filter(event => {
    if (event.at < currentStart || event.at > now) return false;
    return !query.channel || query.channel === firstViewChannel(event, links);
  }).length;

  return {
    generatedAt: new Date(now).toISOString(),
    lastEventAt: activity.lastEventAt === null ? null : new Date(activity.lastEventAt).toISOString(),
    excludedScanners, range: { days: query.range, from: dateLabel(currentStart), to: dateLabel(today) }, previousPeriod: "complete",
    totals: summarize(current, previous),
    daily: days.slice(query.range).map((day, index) => ({
      day: dateLabel(currentStart + index * analyticsDayMs), ...summarize(day.metrics, days[index].metrics),
      byChannel: Object.fromEntries([...day.channels].map(([channel, values]) => [channel, values.browsers.size])),
    })),
    channels: [...channels].map(([id, values]) => ({
      id, visitors: values.browsers.size, avgActiveSeconds: averageSeconds(values.activeMs, values.sessions),
      contactClicks: values.contactClicks, inquiries: values.inquiries,
    })).sort((a, b) => b.visitors - a.visitors || a.id.localeCompare(b.id)),
    projects: [...projects].map(([path, values]) => ({
      path, title: pageTitle(path), views: values.views, avgActiveSeconds: averageSeconds(values.activeMs, values.views),
      readTo75Percent: values.scrollViews ? Math.round(100 * values.readViews / values.scrollViews) : null, byChannel: values.byChannel,
    })).sort((a, b) => b.views - a.views || a.path.localeCompare(b.path)),
    inquiries,
  };
}
