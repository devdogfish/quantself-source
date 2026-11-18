import { timingSafeEqual } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { z } from "zod";
import {
  analyticsCohorts, analyticsCtas, analyticsRetentionMs, analyticsSite, analyticsSources,
} from "@quantself/db/website-analytics-contract";

const slug = (max: number) => z.string().min(1).max(max).regex(/^[a-z0-9_-]+$/);
const duration = z.number().int().min(0).max(86_400_000);
const event = z.strictObject({
  schemaVersion: z.literal(1).optional(),
  eventId: z.uuid(),
  visitorId: z.uuid().optional(),
  ipId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  applicationCode: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  sessionId: z.uuid(),
  pageViewId: z.uuid(),
  seq: z.number().int().min(0).max(2_147_483_647),
  occurredAt: z.iso.datetime(),
  cohort: z.enum(analyticsCohorts),
  path: z.string().max(240).regex(/^\/(?:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/?)?$/),
});
const batch = z.strictObject({
  siteId: z.literal(analyticsSite).optional(),
  events: z.array(z.discriminatedUnion("type", [
    event.extend({
      type: z.literal("page_view"),
      properties: z.strictObject({
        source: z.enum(analyticsSources).optional(),
        applicationCode: slug(48).optional(),
        entryCode: slug(48).optional(),
        referrer: z.string().max(253).regex(/^[a-z0-9.-]+$/).optional(),
        device: z.enum(["mobile", "tablet", "desktop"]).optional(),
      }),
    }),
    event.extend({
      type: z.literal("engagement"),
      properties: z.strictObject({ visibleMs: duration, activeMs: duration.optional() })
        .refine(({ visibleMs, activeMs }) => (activeMs ?? 0) <= visibleMs),
    }),
    event.extend({
      type: z.literal("scroll"),
      properties: z.union([
        z.strictObject({ percent: z.literal([25, 50, 75, 90]) }),
        z.strictObject({ threshold: z.literal([25, 50, 75, 90]) }),
      ]),
    }),
    event.extend({
      type: z.literal("cta_click"),
      properties: z.strictObject({
        ctaId: z.enum(analyticsCtas).optional(),
        action: z.enum(analyticsCtas).optional(),
        target: slug(80).optional(),
        contentId: slug(64).optional(),
      }).refine(({ ctaId, action }) => Boolean(ctaId) !== Boolean(action)),
    }),
    event.extend({
      type: z.literal("resume_link_open"),
      cohort: z.enum(["software", "web-cms", "admin-excel"]),
      properties: z.strictObject({
        source: z.enum(["resume-software", "resume-web-cms", "resume-admin-excel"]),
        contentId: slug(64),
        target: z.enum(["external", "case-study", "demo", "repository", "live-site"]),
      }),
    }),
    event.extend({
      type: z.literal("contact_success"),
      properties: z.strictObject({ method: z.enum(["form", "booking"]) }),
    }),
  ])).min(1).max(50),
});

export function websiteAnalyticsIngestion({
  token = () => process.env.QUANTSELF_WEBSITE_ANALYTICS_TOKEN,
  forward = forwardToUmami,
  clock = Date.now,
}: {
  token?: () => string | undefined;
  forward?: (events: z.infer<typeof batch>["events"]) => Promise<void>;
  clock?: () => number;
} = {}) {
  const app = new Hono();
  let windowEnds = 0;
  let requests = 0;

  app.post("/events", async (context, next) => {
    const secret = token();
    const supplied = Buffer.from(context.req.header("x-api-key") ?? "");
    if (!secret || Buffer.byteLength(secret) < 32) {
      return context.json({ code: "ANALYTICS_DISABLED" }, 503);
    }
    const expected = Buffer.from(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      return context.json({ code: "UNAUTHENTICATED" }, 401);
    }

    const now = clock();
    if (now >= windowEnds) {
      windowEnds = now + 60_000;
      requests = 0;
    }
    if (++requests > 120) {
      context.header("Retry-After", String(Math.ceil((windowEnds - now) / 1000)));
      return context.json({ code: "RATE_LIMITED" }, 429);
    }
    await next();
  }, bodyLimit({
    maxSize: 64 * 1024,
    onError: (context) => context.json({ code: "PAYLOAD_TOO_LARGE" }, 413),
  }), async (context) => {
    const now = clock();
    const parsed = batch.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success || parsed.data.events.some(({ occurredAt }) => {
      const time = Date.parse(occurredAt);
      return !Number.isFinite(time) || time < now - analyticsRetentionMs || time > now + 300_000;
    }) || parsed.data.events.some(item => item.type === "resume_link_open" && (
      item.properties.source !== `resume-${item.cohort}` ||
      (item.applicationCode
        ? !validApplicationPath(item.path, item.applicationCode, item.properties.contentId, item.properties.target)
        : item.path !== `/go/${item.cohort}/${item.properties.target === "external" ? "profile" : "project"}/${item.properties.contentId}/${item.properties.target}`)
    ))) {
      return context.json({ code: "INVALID_ANALYTICS_BATCH" }, 400);
    }

    const { events } = parsed.data;
    try {
      await forward(events);
    } catch {
      return context.json({ code: "ANALYTICS_UPSTREAM_UNAVAILABLE" }, 502);
    }
    return context.json({ received: events.length, accepted: events.length });
  });
  return app;
}

type AnalyticsEvent = z.infer<typeof batch>["events"][number];
export function validApplicationPath(path: string, code: string, contentId: string, target: string) {
  const root = `/r/${code}/`;
  if (!path.startsWith(root)) return false;
  const suffix = path.slice(root.length);
  // Destination existence is owned by the portfolio catalog; this relay validates only the wire shape.
  if (target === "external") return /^profile\/[a-z0-9-]+$/.test(suffix);
  if (target === "case-study") return /^project\/[a-z0-9-]+$/.test(suffix);
  if (target === "repository") return /^project\/[a-z0-9-]+\/source(?:\/[a-z0-9-]+)?$/.test(suffix);
  return /^project\/[a-z0-9-]+\/(?:demo|live-site)$/.test(suffix);
}
const publicHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const localSuffix = /\.(?:internal|local|localhost|test|invalid|example)$/;

function browserContext(event: AnalyticsEvent) {
  if (event.type !== "page_view") return {};
  const { referrer, device } = event.properties;
  return {
    ...(referrer && publicHostname.test(referrer) && !localSuffix.test(referrer) && { referrerHost: referrer }),
    ...(device && { deviceClass: device }),
  };
}

export function toUmamiEvent(event: AnalyticsEvent, website: string) {
  const { type, properties, visitorId, sessionId, eventId, seq, occurredAt, pageViewId, cohort, path } = event;
  const metadata = { e: eventId, q: seq, t: Date.parse(occurredAt), p: pageViewId, s: sessionId, v: visitorId, k: type };
  let details;
  let name: string | undefined;
  switch (event.type) {
    case "page_view":
      details = { source: event.properties.source, applicationCode: event.properties.entryCode ?? event.properties.applicationCode };
      break;
    case "scroll":
      name = type;
      details = { scrollPercent: "threshold" in event.properties ? event.properties.threshold : event.properties.percent };
      break;
    case "cta_click": {
      const { action, ctaId, contentId, target } = event.properties;
      name = action ?? ctaId;
      details = { ctaId: name, contentId, target };
      break;
    }
    default:
      name = type;
      details = properties;
  }
  const data = JSON.stringify({ ...metadata, ...details, ...(event.applicationCode && { applicationCode: event.applicationCode }) });
  if (data.length > 500) throw Error("Analytics event metadata exceeds the Umami field limit.");
  return {
    type: "event",
    payload: {
      website, hostname: analyticsSite, url: path === "/" ? path : path.replace(/\/$/, ""),
      name, tag: cohort, id: visitorId ?? sessionId,
      timestamp: Math.floor(Date.parse(occurredAt) / 1000),
      // Supply a fixed proxy IP and user agent. Never forward visitor headers to Umami.
      ip: "127.0.0.1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      data: { quantself: data, ...browserContext(event), ...(event.ipId && { ipId: event.ipId }) },
    },
  };
}

async function forwardToUmami(events: AnalyticsEvent[]) {
  const { QUANTSELF_UMAMI_URL: origin, QUANTSELF_UMAMI_WEBSITE_ID: website } = process.env;
  if (!origin || !website || !z.uuid().safeParse(website).success) throw Error("Umami is not configured.");
  const response = await fetch(new URL("/api/batch", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events.map((item) => toUmamiEvent(item, website))),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw Error("Umami batch request failed.");
  const result = await response.json() as { processed?: number; errors?: number };
  if (result.errors !== 0 || result.processed !== events.length) throw Error("Umami rejected analytics events.");
}
