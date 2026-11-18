import { timingSafeEqual } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { Env } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  newTrackedLink, trackedApplicationInput, trackedLinkCode, trackedLinkLookup, trackedLinkPath, trackedShareInput,
  type TrackedApplicationInput, type TrackedLinkLookup, type TrackedShareInput,
} from "./tracked-links-contract";
import { lookupTrackedLink, registerTrackedApplication, registerTrackedShare } from "./tracked-links-store";

type Scope = "read" | "application" | "share";
const tokens: Record<Scope, string> = {
  read: "QUANTSELF_TRACKED_LINKS_READ_TOKEN",
  application: "QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN",
  share: "QUANTSELF_TRACKED_LINKS_SHARE_TOKEN",
};
export type TrackedLinkRouteOptions = {
  token?: (scope: Scope) => string | undefined;
  lookup?: (code: string) => Promise<TrackedLinkLookup | null>;
  registerApplication?: (input: TrackedApplicationInput) => Promise<{code: string} | null>;
  registerShare?: (input: TrackedShareInput) => Promise<{ code: string }>;
};

function authorize(token: NonNullable<TrackedLinkRouteOptions["token"]>, scope: Scope) {
  return createMiddleware(async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "X-API-Key");
    const expected = Buffer.from(token(scope) ?? "");
    const supplied = Buffer.from(c.req.header("x-api-key") ?? "");
    if (expected.length < 32) return c.json({ code: "TRACKED_LINKS_UNAVAILABLE" }, 503);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ code: "UNAUTHENTICATED" }, 401);
    }
    await next();
  });
}

const error = (code: string) => ({
  description: code,
  content: { "application/json": { schema: z.object({ code: z.string() }), example: { code } } },
});

function json<Schema extends z.ZodType>(schema: Schema, example: unknown) {
  return { "application/json": { schema, example } };
}

const registrationResponses = {
  400: error("INVALID_REQUEST"),
  401: error("UNAUTHENTICATED"),
  413: error("PAYLOAD_TOO_LARGE"),
  503: error("TRACKED_LINKS_UNAVAILABLE"),
};
const registrationLimit = bodyLimit({
  maxSize: 4096,
  onError: c => c.json({ code: "PAYLOAD_TOO_LARGE" }, 413),
});

export function registerTrackedLinkRoutes<Environment extends Env>(app: OpenAPIHono<Environment>, {
  token = scope => process.env[tokens[scope]],
  lookup = lookupTrackedLink,
  registerApplication = registerTrackedApplication,
  registerShare = registerTrackedShare,
}: TrackedLinkRouteOptions = {}) {
  app.openapi(createRoute({
    method: "get",
    path: `${trackedLinkPath}/{code}`,
    summary: "Resolve a tracked link",
    operationId: "getTrackedLink",
    tags: ["Tracked links"],
    description: "Authentication: scoped X-API-Key. Required permissions: tracked-links:read. Inputs: case-sensitive link code. Success response: redirect fields only. Failure responses: unauthorized, unknown or unavailable. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": ["tracked-links:read"],
    "x-destructive": false,
    middleware: authorize(token, "read"),
    request: { params: z.object({ code: z.string().openapi({ example: "k3Vw9QpX" }) }) },
    responses: {
      200: { description: "Redirect fields", headers: {
        "Cache-Control": { schema: { type: "string" }, example: "public, max-age=86400" },
        Vary: { schema: { type: "string" }, example: "X-API-Key" },
      }, content: { "application/json": {
        schema: trackedLinkLookup, example: { code: "k3Vw9QpX", kind: "application", track: "backend" },
      } } },
      401: error("UNAUTHENTICATED"),
      404: error("NOT_FOUND"),
      503: error("TRACKED_LINKS_UNAVAILABLE"),
    },
  }), async c => {
    const { code } = c.req.valid("param");
    try {
      const result = trackedLinkCode.safeParse(code).success ? await lookup(code) : null;
      if (!result) return c.json({ code: "NOT_FOUND" }, 404);
      c.header("Cache-Control", "public, max-age=86400");
      return c.json(result, 200);
    } catch {
      return c.json({ code: "TRACKED_LINKS_UNAVAILABLE" }, 503);
    }
  });

  app.openapi(createRoute({
    method: "post",
    path: `${trackedLinkPath}/applications`,
    summary: "Register an application link",
    operationId: "registerTrackedApplication",
    tags: ["Tracked links"],
    description: "Authentication: scoped X-API-Key. Required permissions: tracked-links:application. Inputs: application ID, résumé track, company, role, and revision. Success response: the stable application code. Failure responses: invalid input, unauthorized, revision conflict or unavailable. Side effects: creates a link or records a higher revision. Destructive: no. Retry safety: repeat the same application ID, revision and fields.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": ["tracked-links:application"],
    "x-destructive": false,
    middleware: [authorize(token, "application"), registrationLimit],
    request: { body: { required: true, content: json(trackedApplicationInput, {
      applicationId: "49db114d-041b-4e68-a82c-2050a3a47ac5", company: "Example Studio", role: "Engineer", track: "backend", revision: 2,
    }) } },
    responses: {
      200: { description: "Stable application code", content: json(z.object({ code: z.string() }), { code: "k3Vw9QpX" }) },
      ...registrationResponses,
      409: error("APPLICATION_REVISION_CONFLICT"),
    },
  }), async c => {
    try {
      const result = await registerApplication(c.req.valid("json"));
      return result ? c.json(result, 200) : c.json({ code: "APPLICATION_REVISION_CONFLICT" }, 409);
    } catch {
      return c.json({ code: "TRACKED_LINKS_UNAVAILABLE" }, 503);
    }
  });

  app.openapi(createRoute({
    method: "post",
    path: `${trackedLinkPath}/shares`,
    summary: "Register a share link",
    operationId: "registerTrackedShare",
    tags: ["Tracked links"],
    description: "Authentication: scoped X-API-Key. Required permissions: tracked-links:share. Inputs: title and optional portfolio track. Success response: a new share code. Failure responses: invalid input, unauthorized or unavailable. Side effects: creates a share link. Destructive: no. Retry safety: repeated requests create separate links.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": ["tracked-links:share"],
    "x-destructive": false,
    middleware: [authorize(token, "share"), registrationLimit],
    request: { body: { required: true, content: json(trackedShareInput, { title: "Kristina Girke footer", track: "client" }) } },
    responses: {
      200: { description: "Share code", content: json(newTrackedLink, { code: "k3Vw9QpX" }) },
      ...registrationResponses,
    },
  }), async c => {
    try {
      return c.json(await registerShare(c.req.valid("json")), 200);
    } catch {
      return c.json({ code: "TRACKED_LINKS_UNAVAILABLE" }, 503);
    }
  });
}
