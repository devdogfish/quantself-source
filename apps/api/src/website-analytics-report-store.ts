import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import type { WebsiteAnalyticsRow } from "./website-analytics-events";
import { buildJobSearchReport, type RegisteredApplication, type RegisteredShare } from "./website-analytics-job-search";
import type { WebsiteReportQuery } from "./website-analytics-report-contract";
import {
  buildWebsiteReport, websiteReportWindows, type WebsiteReportData, type WebsiteReportInquiry, type WebsiteReportLink,
} from "./website-analytics-reports";

type Reader = Pick<PrismaClient, "$queryRaw">;
type EventRow = { source: "event"; value: WebsiteAnalyticsRow };
type WebsiteRow = EventRow | { source: "link"; value: WebsiteReportLink } | { source: "inquiry"; value: WebsiteReportInquiry };
type JobSearchRow = EventRow | { source: "application"; value: RegisteredApplication } | { source: "share"; value: RegisteredShare };

const eventProjection = Prisma.sql`jsonb_build_object(
  'id', e.id, 'at', extract(epoch FROM e.occurred_at) * 1000, 'kind', e.kind, 'path', e.path,
  'sessionId', e.session_id, 'pageViewId', e.page_view_id, 'visitorId', e.visitor_id,
  'linkCode', e.link_code, 'ipId', e.ip_id, 'utmSource', e.utm_source, 'referrerHost', e.referrer_host,
  'device', e.device, 'props', e.props
)`;

export async function loadWebsiteReport(db: Reader, _ownerId: string, query: WebsiteReportQuery, now = Date.now()) {
  const { currentStart, previousStart } = websiteReportWindows(query.range, now);
  const rows = await db.$queryRaw<WebsiteRow[]>`
    WITH report_events AS MATERIALIZED (
      SELECT id, occurred_at, kind, path, session_id, page_view_id, visitor_id, link_code, ip_id,
             utm_source, referrer_host, device, props
      FROM website_event
      WHERE occurred_at >= ${new Date(previousStart - 30_000)} AND occurred_at <= ${new Date(now)}
    ), report_inquiries AS MATERIALIZED (
      SELECT id, received_at, name, topic, email, link_code, status FROM website_inquiry
      WHERE received_at >= ${new Date(currentStart)} AND received_at <= ${new Date(now)}
    ), attributed_codes AS (
      SELECT link_code FROM report_events WHERE link_code IS NOT NULL
      UNION SELECT link_code FROM report_inquiries WHERE link_code IS NOT NULL
    )
    SELECT 'event' AS source, ${eventProjection} AS value FROM report_events e
    UNION ALL
    SELECT 'link', jsonb_build_object('code', l.code, 'sentAt', extract(epoch FROM l.sent_at) * 1000)
    FROM tracked_link l WHERE l.kind = 'application' AND l.code IN (SELECT link_code FROM attributed_codes)
    UNION ALL
    SELECT 'inquiry', jsonb_build_object('id', i.id, 'name', i.name, 'topic', i.topic, 'email', i.email,
             'linkCode', i.link_code, 'status', i.status, 'receivedAt', extract(epoch FROM i.received_at) * 1000)
    FROM report_inquiries i`;
  const data: WebsiteReportData = { events: [], links: [], inquiries: [] };
  for (const row of rows) {
    if (row.source === "event") data.events.push(row.value);
    else if (row.source === "link") data.links.push(row.value);
    else data.inquiries.push(row.value);
  }
  return buildWebsiteReport(data, query, now);
}

export async function loadJobSearchReport(db: Reader, ownerId: string, now = Date.now()) {
  // The registry belongs to this single-Owner deployment. A missing Jobs row does not hide an issued link.
  const rows = await db.$queryRaw<JobSearchRow[]>`
    SELECT 'event' AS source, ${eventProjection} AS value
    FROM website_event e JOIN tracked_link l ON l.code = e.link_code
    WHERE e.occurred_at <= ${new Date(now)}
    UNION ALL
    SELECT 'application', jsonb_build_object(
      'applicationId', l.application_id, 'code', l.code, 'cohort', l.track,
      'company', COALESCE(a.company, l.company), 'role', COALESCE(a.role, l.title),
      'sentAt', extract(epoch FROM l.sent_at) * 1000, 'status', a.status
    )
    FROM tracked_link l
    LEFT JOIN job_application a ON a.id = l.application_id::text AND a."ownerId" = ${ownerId}
    WHERE l.kind = 'application'
    UNION ALL
    SELECT 'share', jsonb_build_object('code', code, 'title', title, 'track', CASE WHEN track = 'software' THEN 'backend' ELSE track END, 'archived', archived_at IS NOT NULL)
    FROM tracked_link WHERE kind = 'share' AND created_at <= ${new Date(now)}`;
  const events: WebsiteAnalyticsRow[] = [];
  const applications: RegisteredApplication[] = [];
  const shares: RegisteredShare[] = [];
  for (const row of rows) {
    if (row.source === "event") events.push(row.value);
    else if (row.source === "application") applications.push(row.value);
    else shares.push(row.value);
  }
  applications.sort((a, b) => (b.sentAt ?? -Infinity) - (a.sentAt ?? -Infinity) || a.code.localeCompare(b.code));
  return buildJobSearchReport(events, applications, now, shares);
}
