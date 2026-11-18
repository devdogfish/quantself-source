import { z } from "@hono/zod-openapi";

export const websiteAnalyticsMaxBytes = 32 * 1024;
const linkCode = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const trackingLabel = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
const target = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const eventBase = z.strictObject({
  id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }),
  visitor_id: z.uuid().nullish(),
  ip_id: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
  path: z.string().max(240).regex(/^\/(?:[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*\/?)?$/),
  link_code: linkCode.nullish(),
  utm_source: trackingLabel.nullish(),
  utm_medium: trackingLabel.nullish(),
  utm_campaign: trackingLabel.nullish(),
  referrer_host: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/).nullish(),
  device: z.enum(["desktop", "mobile"]).nullish(),
});

const browserEvent = eventBase.extend({
  session_id: z.uuid(),
  page_view_id: z.uuid(),
});

const serverEvent = eventBase.extend({
  session_id: z.uuid().nullish(),
  page_view_id: z.uuid().nullish(),
});

export const websiteEventSchema = z.discriminatedUnion("kind", [
  browserEvent.extend({
    kind: z.literal("page:view"),
    props: z.strictObject({ isRestore: z.boolean().optional() }),
  }),
  browserEvent.extend({
    kind: z.literal("page:engagement"),
    props: z.strictObject({
      activeMs: z.number().int().min(0).max(86_400_000),
      maxScroll: z.number().min(0).max(100),
    }),
  }),
  browserEvent.extend({
    kind: z.literal("cta:click"),
    props: z.strictObject({ cta: target, target: target.optional() }),
  }),
  browserEvent.extend({
    kind: z.literal("outbound:click"),
    props: z.strictObject({ target }),
  }),
  serverEvent.extend({
    kind: z.literal("link:open"),
    props: z.strictObject({
      method: z.enum(["GET", "HEAD"]),
      ua: z.string().max(512).optional(),
      key: target.optional(),
    }),
  }),
  serverEvent.extend({
    kind: z.literal("contact_form:submit"),
    props: z.strictObject({
      method: z.literal("form").optional(),
      result: z.enum(["ok", "validation_error", "server_error"]).optional(),
    }),
  }),
]).openapi("WebsiteEventIngest");

export const websiteEventBatch = z.strictObject({
  events: z.array(websiteEventSchema).min(1).max(50),
}).openapi("WebsiteEventBatch");

export const websiteInquiryInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  topic: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(8_000),
  link_code: linkCode.nullish(),
}).openapi("WebsiteInquiryIngest");

export const websiteInquiryStatusInput = z.strictObject({
  status: z.enum(["new", "replied", "call_booked", "won", "lost"]),
}).openapi("WebsiteInquiryStatusUpdate");

export type WebsiteEvent = z.infer<typeof websiteEventSchema>;
export type WebsiteInquiryInput = z.infer<typeof websiteInquiryInput>;
