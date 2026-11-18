import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { habitAsks } from "./habits-ask";
import { askInputSchema, askRecordSchema, askPageSchema } from "./habits-ask-schema";
import { HabitError } from "./habits-service";
type Env = { Variables: { accessContext: AccessContext | null } };
const auth = (write: boolean) => createMiddleware<Env>(async (c, next) => {
  const a = c.get("accessContext");
  if (!a) return c.json({ message: "Authentication required." }, 401);
  if (!a.permissions.includes("habits:read") || write && !a.permissions.includes("habits:write")) return c.json({ message: "Missing habits permission." }, 403);
  c.header("Cache-Control", "no-store"); await next();
});
const error = (description: string) => ({ description, content: { "application/json": { schema: z.object({ message: z.string() }), example: { message: description } } } });
const errors = { 400: error("Invalid ask."), 401: error("Authentication required."), 403: error("Missing habits permission."), 409: error("Ask processing or input conflict."), 413: error("Ask too large."), 503: error("Jarvis unavailable. Retry the same ask.") };
const sample = { id: "00000000-0000-4000-8000-000000000001", habitId: "walk", text: "I'm tired", feeling: "Tired" as const, at: "2026-11-13T12:00:00Z", date: "2026-11-13", outcome: "open" as const, outcomeRevision: null, answer: { feeling: "Tired" as const, lead: "Keep it small today.", step: "Put your shoes on and step outside.", support: "The minimum counts." } };
export function registerHabitAskRoutes(app: OpenAPIHono<Env>, service = habitAsks) {
  app.openapi(createRoute({ method: "get", path: "/api/v1/habits/asks", operationId: "getHabitAsks", summary: "Read recent Habit asks and check-in outcomes", tags: ["Habits"],
    description: "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read. Inputs: optional opaque cursor. Success response: 200, up to 100 asks in the last 14 Halifax dates with an outcome joined from that day's check-in, and next cursor (null at end). Follow every next cursor for complete analytics. Failure responses: 400 invalid cursor, 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe read. One bulk database join per page.",
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<string, string[]>[], "x-required-permissions": ["habits:read"], "x-destructive": false,
    middleware: [auth(false)], request: { query: z.object({ cursor: z.string().max(500).optional() }) }, responses: { 200: { description: "Recent asks.", content: { "application/json": { schema: askPageSchema, example: { rows: [sample], next: null } } } }, ...errors },
  }), async c => {
    try { return c.json(await service.read(c.get("accessContext")!.owner.id, c.req.valid("query").cursor), 200); }
    catch (e) { return c.json({ message: e instanceof HabitError ? e.message : "Habit asks unavailable." }, e instanceof HabitError ? e.status : 503); }
  });
  app.openapi(createRoute({ method: "post", path: "/api/v1/habits/ask", operationId: "askHabit", summary: "Ask Jarvis for one next step", tags: ["Habits"],
    description: "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read and habits:write. Inputs: habitId and text (1–2000 characters); optional Idempotency-Key UUID, allocated once and retained for retries. Success response: 200 saved ask, inferred feeling, short model answer and check-in outcome. Failure responses: 400 invalid/oversized context, 401 unauthenticated, 403 forbidden, 409 same key changed input or generation still pending, 413 body above 16KB, 503 unavailable/timeout. Side effects: stores the ask and model answer. No check-in or tool execution. Destructive: no. Retry safety: same owner/client/key and input replays a saved answer; uncertain delivery must retain the key. Failed generation may retry after failure, abandoned claims after 60s. Context/model deadline 20s, context 32KB, provider response 64KB. Reuses configured Jarvis agent/model with tools and MCP disabled for this conversation.",
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<string, string[]>[], "x-required-permissions": ["habits:read", "habits:write"], "x-destructive": false,
    middleware: [auth(true), bodyLimit({ maxSize: 16_384, onError: c => c.json({ message: "Ask too large." }, 413) })], request: { headers: z.object({ "idempotency-key": z.uuid().optional() }), body: { required: true, content: { "application/json": { schema: askInputSchema, example: { habitId: "walk", text: "I'm tired" } } } } },
    responses: { 200: { description: "Saved ask and answer.", content: { "application/json": { schema: askRecordSchema, example: sample } } }, ...errors },
  }), async c => {
    const a = c.get("accessContext")!;
    try { return c.json(await service.ask(a.owner.id, a.client.id, c.req.valid("json"), c.req.valid("header")["idempotency-key"]), 200); }
    catch (e) { return c.json({ message: e instanceof HabitError ? e.message : "Jarvis unavailable. Retry the same ask." }, e instanceof HabitError ? e.status : 503); }
  });
}
