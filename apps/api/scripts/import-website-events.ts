import { prisma } from "@quantself/db";
import { getUmamiReader } from "@quantself/db/umami-reader";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { z } from "zod";

const pageSize = 500;
const kinds = {
  page_view: "page:view",
  engagement: "page:engagement",
  scroll: "page:engagement",
  cta_click: "cta:click",
  resume_link_open: "link:open",
  contact_success: "contact_form:submit",
} as const;
const label = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
const legacyMetadata = z.object({
  e: z.uuid(), s: z.uuid(), p: z.uuid(), v: z.uuid().optional(),
  q: z.number().int().nonnegative(), t: z.number().int().min(0).max(253_402_300_799_999),
  k: z.enum(Object.keys(kinds) as (keyof typeof kinds)[]),
  applicationCode: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/).optional().catch(undefined),
  source: label.optional().catch(undefined),
  ctaId: label.optional().catch(undefined),
  target: label.optional().catch(undefined),
  contentId: label.optional().catch(undefined),
  activeMs: z.number().int().min(0).max(86_400_000).optional(),
  visibleMs: z.number().int().min(0).max(86_400_000).optional(),
  scrollPercent: z.number().min(0).max(100).optional(),
  method: z.enum(["form", "booking"]).optional(),
});

type LegacyRow = {
  row_id: string;
  path: string | null;
  metadata: string | null;
  referrer: string | null;
  device: string | null;
  ip_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
};

function validLabel(value: string | null) {
  const parsed = label.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function convertUmamiWebsiteEvent(row: LegacyRow): Prisma.WebsiteEventCreateManyInput | null {
  if (!row.metadata || !row.path || row.path.length > 240 ||
      !/^\/(?:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/?)?$/.test(row.path)) return null;
  let json: unknown;
  try { json = JSON.parse(row.metadata); } catch { return null; }
  const parsed = legacyMetadata.safeParse(json);
  if (!parsed.success) return null;
  const {
    e: id, t, k, v: visitorId, s: sessionId, p: pageViewId,
    q: seq, applicationCode, scrollPercent, ctaId, ...details
  } = parsed.data;
  const referrerHost = row.referrer && row.referrer.length <= 253 &&
    /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(row.referrer) ? row.referrer : null;
  const booking = k === "contact_success" && details.method === "booking";
  return {
    id,
    occurredAt: new Date(t),
    kind: booking ? "cta:click" : kinds[k],
    visitorId,
    sessionId,
    pageViewId,
    ipId: row.ip_id && /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(row.ip_id) ? row.ip_id : null,
    path: row.path,
    linkCode: applicationCode,
    utmSource: validLabel(row.utm_source),
    utmMedium: validLabel(row.utm_medium),
    utmCampaign: validLabel(row.utm_campaign),
    referrerHost,
    device: row.device === "tablet" ? "mobile" :
      row.device === "desktop" || row.device === "mobile" ? row.device : null,
    props: { ...details, seq, maxScroll: scrollPercent, cta: booking ? "booking" : ctaId },
  };
}

export async function importUmamiWebsiteEvents({
  source, destination, websiteId, apply,
}: {
  source: PrismaClient;
  destination: PrismaClient;
  websiteId: string;
  apply: boolean;
}) {
  let cursor: string | null = null;
  const result = { read: 0, rejected: 0, inserted: 0 };
  await source.$transaction(async readOnly => {
    await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
    while (true) {
      const rows: LegacyRow[] = await readOnly.$queryRaw`
        SELECT e.event_id AS row_id, e.url_path AS path, e.utm_source, e.utm_medium, e.utm_campaign,
               MAX(d.string_value) FILTER (WHERE d.data_key = 'quantself') AS metadata,
               MAX(d.string_value) FILTER (WHERE d.data_key = 'referrerHost') AS referrer,
               MAX(d.string_value) FILTER (WHERE d.data_key = 'deviceClass') AS device,
               MAX(d.string_value) FILTER (WHERE d.data_key = 'ipId') AS ip_id
        FROM website_event e
        JOIN event_data d ON d.website_event_id = e.event_id AND d.website_id = e.website_id
          AND d.data_key IN ('quantself', 'referrerHost', 'deviceClass', 'ipId')
        WHERE e.website_id = ${websiteId}::uuid AND e.hostname = 'girke.dev'
          AND (${cursor}::uuid IS NULL OR e.event_id > ${cursor}::uuid)
        GROUP BY e.event_id
        HAVING COUNT(*) FILTER (WHERE d.data_key = 'quantself') > 0
        ORDER BY e.event_id
        LIMIT ${pageSize}
      `;
      const events = rows.map(convertUmamiWebsiteEvent).filter(event => event !== null);
      result.read += rows.length;
      result.rejected += rows.length - events.length;
      if (apply && events.length) {
        const { count } = await destination.websiteEvent.createMany({ data: events, skipDuplicates: true });
        result.inserted += count;
      }
      if (rows.length < pageSize) break;
      cursor = rows[rows.length - 1]!.row_id;
    }
  }, { isolationLevel: "RepeatableRead", timeout: 15 * 60_000 });

  const [{ bytes }] = await destination.$queryRaw<{ bytes: number }[]>`
    SELECT pg_total_relation_size('website_event'::regclass)::float8 AS bytes
  `;
  return { ...result, tableBytes: bytes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--dry-run", "--apply"].includes(args[0]!)) {
    console.error("Usage: bun apps/api/scripts/import-website-events.ts --dry-run|--apply");
    process.exit(2);
  }
  let source: PrismaClient | undefined;
  try {
    const websiteId = z.uuid().parse(process.env.QUANTSELF_UMAMI_WEBSITE_ID);
    source = getUmamiReader();
    const result = await importUmamiWebsiteEvents({ source, destination: prisma, websiteId, apply: args[0] === "--apply" });
    console.log(JSON.stringify({ mode: args[0], ...result }));
    if (result.rejected) process.exitCode = 1;
  } catch {
    console.error("Website event import failed. A retry with the same event UUIDs preserves committed rows.");
    process.exitCode = 1;
  } finally {
    await Promise.all([source?.$disconnect(), prisma.$disconnect()]);
  }
}
