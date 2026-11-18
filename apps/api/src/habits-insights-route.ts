import type { AccessContext } from "@quantself/auth";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { habitInsights } from "./habits-insights";
import { habitOverviewSchema } from "./habits-insights-schema";

type Env = { Variables: { accessContext: AccessContext | null } };
const error = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: z.object({ message: z.string() }),
      example: { message: description },
    },
  },
});
const authorize = createMiddleware<Env>(async (c, next) => {
  const access = c.get("accessContext");
  if (!access) return c.json({ message: "Authentication required." }, 401);
  if (!access.permissions.includes("habits:read"))
    return c.json({ message: "Missing habits:read." }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});

const overviewRoute = createRoute({
  method: "get",
  path: "/api/v1/habits/overview",
  operationId: "getHabitOverview",
  summary: "Read habit overview",
  description:
    "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read. Inputs: optional display range of 1–52 weeks, default 4. Success response: 200 habit fabric, chains, gates, momentum, rollout, ranked insights and weekly review status. Failure responses: 400 invalid weeks, 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe read.",
  tags: ["Habits"],
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  "x-required-permissions": ["habits:read"],
  "x-destructive": false,
  middleware: [authorize] as const,
  request: {
    query: z.object({
      weeks: z.coerce.number().int().min(1).max(52).default(4),
    }),
  },
  responses: {
    200: {
      description: "Habit overview at the current Halifax date.",
      content: {
        "application/json": {
          schema: habitOverviewSchema,
          example: {
            asOf: "2026-11-07",
            range: { from: "2026-10-11", to: "2026-11-07" },
            totals: { votes: 0, votesThisWeek: 0, votesLastWeek: 0 },
            habits: [],
            upcoming: [],
            insights: [],
            reviewDue: { date: "2026-11-08", done: false, status: "missing" },
          },
        },
      },
    },
    400: error("Invalid range."),
    401: error("Authentication required."),
    403: error("Missing habits:read."),
    503: error("Habit overview unavailable."),
  },
});

export function registerHabitOverviewRoutes(
  app: OpenAPIHono<Env>,
  insights = habitInsights,
) {
  app.openapi(overviewRoute, async (c) => {
    try {
      return c.json(
        await insights.overview(c.get("accessContext")!.owner.id, {
          asOf: new Date(),
          weeks: c.req.valid("query").weeks,
        }),
        200,
      );
    } catch {
      return c.json({ message: "Habit overview unavailable." }, 503);
    }
  });
}
