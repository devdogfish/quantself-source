import { computeHabitSummary } from "./habits-summary-core";
import type { AccessContext } from "@quantself/auth";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { habitSummary } from "./habits-summary";
import { habitSummarySchema } from "./habits-summary-schema";
type Env = { Variables: { accessContext: AccessContext | null } };
const sample = computeHabitSummary({ projection: { habits: [], stacks: [], gate: { window: 14, required: 10 }, diagnostics: [] }, revisions: [], occurrences: [], today: "2026-11-13" });
const authorize = createMiddleware<Env>(async (c, next) => {
  const access = c.get("accessContext");
  if (!access) return c.json({ message: "Authentication required." }, 401);
  if (!access.permissions.includes("habits:read")) return c.json({ message: "Missing habits:read." }, 403);
  c.header("Cache-Control", "no-store"); await next();
});
const error = (description: string) => ({ description, content: { "application/json": { schema: z.object({ message: z.string() }), example: { message: description } } } });
export function registerHabitSummaryRoutes(app: OpenAPIHono<Env>, service = habitSummary) {
  app.openapi(createRoute({
    method: "get", path: "/api/v1/habits/summary", operationId: "getHabitSummary", summary: "Read the complete Habits Summary",
    description: "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read. Inputs: none. Success response: 200 complete server-derived Summary, header counts, weighted system health, readiness, 52-week activity and catalog load, slots and findings. Review completion uses the review habit's Done/Minimum check-ins; document existence is not completion. Autopilot dates come from recorded Catalog status changes. Failure responses: 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe read. Four bulk database reads; no per-habit or per-day fan-out.",
    tags: ["Habits"], security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<string, string[]>[], "x-required-permissions": ["habits:read"], "x-destructive": false,
    middleware: [authorize], responses: { 200: { description: "Complete Summary at the current Halifax date.", content: { "application/json": { schema: habitSummarySchema, example: { ...sample, activity: [], load: [] } } } }, 401: error("Authentication required."), 403: error("Missing habits:read."), 503: error("Habit Summary unavailable.") },
  }), async c => {
    try { return c.json(await service.read(c.get("accessContext")!.owner.id), 200); }
    catch { return c.json({ message: "Habit Summary unavailable." }, 503); }
  });
}
