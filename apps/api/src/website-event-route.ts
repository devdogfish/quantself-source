import { getPublicOrigin } from "@quantself/auth/public-origin";
import { timingSafeEqual } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import {
  websiteAnalyticsMaxBytes,
  websiteEventBatch,
  websiteInquiryInput,
  websiteInquiryStatusInput,
} from "./website-event-contract";
import { websiteEventStore, type WebsiteEventStore } from "./website-event-store";

type Env = { Variables: { accessContext: AccessContext | null } };
const path = "/api/v1/website-analytics";
const id = "10000000-0000-4000-8000-000000000001";
const exampleEvent = {
  id,
  kind: "link:open",
  occurred_at: "2026-11-14T17:59:59Z",
  path: "/r/k3Vw9QpX/rbc",
  link_code: "k3Vw9QpX",
  props: { method: "HEAD", key: "rbc", ua: "Synthetic browser" },
} as const;
const exampleInquiry = {
  id,
  name: "Example Person",
  email: "inquiry@example.test",
  topic: "Website project",
  message: "Could we schedule a call about a website project?",
};
const exampleStatus = { status: "replied" } as const;

function json<T extends z.ZodType>(schema: T, example: z.input<T>) {
  return { "application/json": { schema, example } };
}

const errorSchema = z.object({ code: z.string(), message: z.string() });
const errors = {
  invalid: { code: "INVALID_REQUEST", message: "Invalid website analytics request." },
  unauthenticated: { code: "UNAUTHENTICATED", message: "Authentication required." },
  forbidden: { code: "FORBIDDEN", message: "Same-origin Owner access is required." },
  notFound: { code: "NOT_FOUND", message: "Inquiry not found." },
  tooLarge: { code: "PAYLOAD_TOO_LARGE", message: "JSON payload exceeds 32 KiB." },
  unavailable: { code: "ANALYTICS_UNAVAILABLE", message: "Website analytics is unavailable." },
};
const errorResponse = (error: z.input<typeof errorSchema>) => ({
  description: error.message, content: json(errorSchema, error),
});
const shared = { tags: ["Website Analytics"], "x-required-permissions": [], "x-destructive": false };
const sizeLimit = bodyLimit({
  maxSize: websiteAnalyticsMaxBytes,
  onError: context => context.json(errors.tooLarge, 413),
});

export function registerWebsiteAnalyticsIngestRoutes(
  app: OpenAPIHono<Env>,
  store: WebsiteEventStore = websiteEventStore(),
  token = () => process.env.QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN,
) {
  const authorizeIngest = createMiddleware<Env>(async (context, next) => {
    context.header("Cache-Control", "no-store");
    const expected = Buffer.from(token() ?? "");
    if (expected.length < 32) return context.json(errors.unavailable, 503);
    const supplied = Buffer.from(context.req.header("x-api-key") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      return context.json(errors.unauthenticated, 401);
    }
    await next();
  });
  const ingest = {
    ...shared,
    method: "post" as const,
    security: [{ websiteAnalyticsIngest: [] }],
    middleware: [authorizeIngest, sizeLimit],
  };
  const failures = {
    400: errorResponse(errors.invalid),
    401: errorResponse(errors.unauthenticated),
    413: errorResponse(errors.tooLarge),
    503: errorResponse(errors.unavailable),
  };

  app.openapi(createRoute({
    ...ingest,
    path: `${path}/events`,
    operationId: "ingestWebsiteEvents",
    summary: "Ingest one portfolio event batch",
    description: "Authentication: dedicated website analytics ingest key in X-API-Key. Required permissions: none. Inputs: 1–50 events in at most 32 KiB of JSON. Success response: 202 with received and inserted counts. Failure responses: invalid batch, missing credential, oversized request or store unavailable. Side effects: inserts new event UUIDs. Destructive: no. Retry safety: reuse event UUIDs. Existing rows are preserved.",
    request: { body: { required: true, content: json(websiteEventBatch, { events: [exampleEvent] }) } },
    responses: {
      ...failures,
      202: { description: "Accepted batch.", content: json(
        z.object({ received: z.number().int().min(1), inserted: z.number().int().min(0) }),
        { received: 1, inserted: 1 },
      ) },
    },
  }), async context => {
    const { events } = context.req.valid("json");
    try {
      return context.json({ received: events.length, inserted: await store.insertEvents(events) }, 202);
    } catch {
      return context.json(errors.unavailable, 503);
    }
  }, (result, context) => {
    if (!result.success) return context.json(errors.invalid, 400);
  });

  app.openapi(createRoute({
    ...ingest,
    path: `${path}/inquiries`,
    operationId: "ingestWebsiteInquiry",
    summary: "Ingest a portfolio inquiry",
    description: "Authentication: dedicated website analytics ingest key in X-API-Key. Required permissions: none. Inputs: inquiry UUID and contact form fields, at most 32 KiB of JSON. Success response: 202 with the inquiry UUID. Failure responses: invalid inquiry, missing credential, oversized request or store unavailable. Side effects: creates a private inquiry. Destructive: no. Retry safety: reuse the inquiry UUID. Existing inquiries are preserved.",
    request: { body: { required: true, content: json(websiteInquiryInput, exampleInquiry) } },
    responses: {
      ...failures,
      202: { description: "Accepted inquiry.", content: json(z.object({ id: z.uuid() }), { id }) },
    },
  }), async context => {
    const inquiry = context.req.valid("json");
    try {
      await store.insertInquiry(inquiry);
      return context.json({ id: inquiry.id }, 202);
    } catch {
      return context.json(errors.unavailable, 503);
    }
  }, (result, context) => {
    if (!result.success) return context.json(errors.invalid, 400);
  });
}

export function registerWebsiteInquiryStatusRoute(
  app: OpenAPIHono<Env>,
  store: WebsiteEventStore = websiteEventStore(),
) {
  const authorizeOwner = createMiddleware<Env>(async (context, next) => {
    context.header("Cache-Control", "no-store");
    const access = context.get("accessContext");
    if (!access) return context.json(errors.unauthenticated, 401);
    if (access.client.kind !== "web" ||
        context.req.header("origin") !== (getPublicOrigin() ?? new URL(context.req.url).origin)) {
      return context.json(errors.forbidden, 403);
    }
    await next();
  });
  app.openapi(createRoute({
    ...shared,
    method: "patch",
    path: `${path}/inquiries/{id}`,
    operationId: "updateWebsiteInquiryStatus",
    summary: "Update a website inquiry status",
    description: "Authentication: same-origin Owner ingress. Required permissions: none. Inputs: inquiry UUID and new status. Success response: 200 with the inquiry UUID and status. Failure responses: invalid request, access denied, missing inquiry or store unavailable. Side effects: updates inquiry status. Destructive: no. Retry safety: setting the same status again has the same effect.",
    security: [{ ownerSession: [] }],
    middleware: [authorizeOwner, sizeLimit],
    request: {
      params: z.object({ id: z.uuid().openapi({ example: id }) }),
      body: { required: true, content: json(websiteInquiryStatusInput, exampleStatus) },
    },
    responses: {
      200: { description: "Updated inquiry status.", content: json(
        websiteInquiryStatusInput.extend({ id: z.uuid() }), { id, ...exampleStatus },
      ) },
      400: errorResponse(errors.invalid),
      401: errorResponse(errors.unauthenticated),
      403: errorResponse(errors.forbidden),
      404: errorResponse(errors.notFound),
      413: errorResponse(errors.tooLarge),
      503: errorResponse(errors.unavailable),
    },
  }), async context => {
    const { id } = context.req.valid("param");
    const { status } = context.req.valid("json");
    try {
      if (!await store.updateInquiryStatus(id, status)) return context.json(errors.notFound, 404);
      return context.json({ id, status }, 200);
    } catch {
      return context.json(errors.unavailable, 503);
    }
  }, (result, context) => {
    if (!result.success) return context.json(errors.invalid, 400);
  });
}
