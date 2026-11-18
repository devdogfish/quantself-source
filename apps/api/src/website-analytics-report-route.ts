import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { bodyLimit } from "hono/body-limit";
import { runIdempotentCommand } from "./idempotency";
import { trackedLinkCode, trackedShareInput } from "./tracked-links-contract";
import { archiveTrackedShare, registerTrackedShare } from "./tracked-links-store";
import { createMiddleware } from "hono/factory";
import { authorizationErrorSchema } from "./authorization-response";
import { jobSearchReportOutput, websiteShare, websiteReportOutput, websiteReportQuery, type JobSearchReport, type WebsiteReport, type WebsiteReportQuery } from "./website-analytics-report-contract";
import { loadJobSearchReport, loadWebsiteReport } from "./website-analytics-report-store";

type Env = { Variables: { accessContext: AccessContext | null } };
export type WebsiteAnalyticsReportReaders = {
  website: (ownerId: string, query: WebsiteReportQuery) => Promise<WebsiteReport>;
  jobSearch: (ownerId: string) => Promise<JobSearchReport>;
};

const requireOwner = createMiddleware<Env>(async (c, next) => {
  c.header("Cache-Control", "no-store");
  const access = c.get("accessContext");
  if (!access) return c.json({ code: "UNAUTHENTICATED", message: "Authentication required." }, 401);
  if (access.client.kind !== "web") return c.json({ code: "FORBIDDEN", message: "Owner session required." }, 403);
  await next();
});

function json<T extends z.ZodType>(description: string, schema: T, example: z.input<T>) {
  return { description, content: { "application/json": { schema, example } } };
}

const unavailable = { code: "ANALYTICS_UNAVAILABLE", message: "Website analytics is unavailable." } as const;
const errors = {
  401: json("Authentication required.", authorizationErrorSchema, { code: "UNAUTHENTICATED", message: "Authentication required." }),
  403: json("Owner session required.", authorizationErrorSchema, { code: "FORBIDDEN", message: "Owner session required." }),
  503: json("Analytics data is unavailable.", z.object({ code: z.literal(unavailable.code), message: z.string() }), unavailable),
};
const common = {
  method: "get" as const,
  tags: ["Website analytics"],
  security: [{ ownerSession: [] }],
  "x-required-permissions": [],
  "x-destructive": false,
  middleware: requireOwner,
};

const websiteRoute = createRoute({
  ...common,
  path: "/api/v1/website-analytics/website",
  operationId: "getWebsiteAnalyticsReport",
  summary: "Read Website analytics",
  description: "Authentication: trusted Owner ingress. Required permissions: none. Inputs: date range, channel, project path, and device. Success response: Website traffic, engagement, and contact report. Failure responses: invalid filters, denied access, or unavailable data. Side effects: none. Destructive: no. Retry safety: safe read.",
  request: { query: websiteReportQuery },
  responses: {
    200: json("Filtered Website report.", websiteReportOutput, {
      generatedAt: "2026-11-14T18:00:00Z", lastEventAt: null, excludedScanners: 0,
      range: { days: 7, from: "2026-11-08", to: "2026-11-14" }, previousPeriod: "complete",
      totals: { visitors: 0, previousVisitors: 0, avgActiveSeconds: 0, previousAvgActiveSeconds: 0, contactClicks: 0, previousContactClicks: 0 },
      daily: [], channels: [], projects: [], inquiries: [],
    }),
    400: json("Invalid filters.", z.object({ code: z.literal("INVALID_REQUEST"), message: z.string() }),
      { code: "INVALID_REQUEST", message: "Request validation failed." }),
    ...errors,
  },
});

const jobSearchRoute = createRoute({
  ...common,
  path: "/api/v1/website-analytics/job-search",
  operationId: "getJobSearchAnalyticsReport",
  summary: "Read Job search analytics",
  description: "Authentication: trusted Owner ingress. Required permissions: none. Inputs: none. Success response: each registered application with its retained visit history. Failure responses: denied access or unavailable data. Side effects: none. Destructive: no. Retry safety: safe read.",
  responses: {
    200: json("Registered applications and visit history.", jobSearchReportOutput, {
      generatedAt: "2026-11-14T18:00:00Z", lastEventAt: null, excludedScanners: 0,
      shares: [],
      applications: [{
        applicationId: "49db114d-041b-4e68-a82c-2050a3a47ac5", code: "d7d720045e623295a0d15c07", company: "Example Studio",
        role: "Web Engineer", resume: "web-cms", resumeLabel: "Web / CMS", sentAt: null, outcome: "none", outcomeAt: null,
        portfolioUrl: "https://girke.dev/r/d7d720045e623295a0d15c07", visits: [],
      }],
    }),
    ...errors,
  },
});

const sharesPath = "/api/v1/website-analytics/shares";
const shareMutationError = (message: string) => json(message, z.object({ code: z.string(), message: z.string() }), { code: "SHARE_ERROR", message });
const createShareRoute = createRoute({
  ...common,
  method: "post",
  path: sharesPath,
  operationId: "createWebsiteAnalyticsShare",
  summary: "Create a portfolio share",
  description: "Authentication: trusted Owner ingress. Required permissions: none. Inputs: title, optional audience, and Idempotency-Key. Success response: saved share. Failure responses: denied access, invalid input, conflicting replay, or unavailable storage. Side effects: creates one immutable share. Destructive: no. Retry safety: use the same key and input.",
  middleware: [requireOwner, bodyLimit({ maxSize: 4096, onError: c => c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request is too large." }, 413) })] as const,
  request: {
    headers: z.object({ "idempotency-key": z.uuid() }),
    body: { required: true, ...json("Share title and optional audience.", trackedShareInput, { title: "LinkedIn profile", track: "backend" }) },
  },
  responses: {
    ...errors,
    201: json("Saved share.", websiteShare, { code: "A7gd38MC", title: "LinkedIn profile", track: "backend", archived: false, opens: 0, visits: 0 }),
    400: shareMutationError("Invalid share."),
    409: shareMutationError("Idempotency key already used."),
    413: shareMutationError("Request is too large."),
  },
});

const archiveShareRoute = createRoute({
  ...common,
  method: "delete",
  path: `${sharesPath}/{code}`,
  operationId: "archiveWebsiteAnalyticsShare",
  summary: "Archive a portfolio share",
  description: "Authentication: trusted Owner ingress. Required permissions: none. Inputs: share code. Success response: no content. Failure responses: denied access, invalid code, or unavailable storage. Side effects: archives the share while preserving its URL and analytics. Destructive: no. Retry safety: safe to repeat.",
  request: { params: z.object({ code: trackedLinkCode }) },
  responses: { ...errors, 204: { description: "The share is no longer active in the dashboard." }, 400: shareMutationError("Invalid share code.") },
});

export function registerWebsiteAnalyticsReportRoutes(app: OpenAPIHono<Env>, readers?: Partial<WebsiteAnalyticsReportReaders>) {
  const website = readers?.website ?? ((ownerId, query) => loadWebsiteReport(prisma, ownerId, query));
  const jobSearch = readers?.jobSearch ?? (ownerId => loadJobSearchReport(prisma, ownerId));
  app.openapi(websiteRoute, async c => {
    try {
      return c.json(await website(c.get("accessContext")!.owner.id, c.req.valid("query")), 200);
    } catch {
      return c.json(unavailable, 503);
    }
  });
  app.openapi(jobSearchRoute, async c => {
    try {
      return c.json(await jobSearch(c.get("accessContext")!.owner.id), 200);
    } catch {
      return c.json(unavailable, 503);
    }
  });
  app.openapi(createShareRoute, async c => {
    try {
      const { title, track } = c.req.valid("json");
      const result = await runIdempotentCommand({
        clientId: c.get("accessContext")!.client.id,
        operation: "createWebsiteAnalyticsShare",
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        request: { title, track },
        execute: async tx => {
          const { code } = await registerTrackedShare({ title, track }, tx);
          return { kind: "success", status: 201, body: { code, title, track: track ?? null, archived: false, opens: 0, visits: 0 } };
        },
      });
      if (result.kind === "conflict") return c.json({ code: result.code, message: result.message }, 409);
      return c.json(result.body, 201);
    } catch {
      return c.json(unavailable, 503);
    }
  });
  app.openapi(archiveShareRoute, async c => {
    try {
      await archiveTrackedShare(c.req.valid("param").code);
      return c.body(null, 204);
    } catch {
      return c.json(unavailable, 503);
    }
  });
}
