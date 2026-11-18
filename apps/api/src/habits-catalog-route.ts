import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { AccessContext } from "@quantself/auth";
import {
  habitCatalog,
  HabitCatalogError,
  catalogCommandSchema,
  catalogResultSchema,
  revisionEntrySchema,
} from "./habits-catalog";
type Env = { Variables: { accessContext: AccessContext | null } };
export function registerHabitCatalogRoutes(
  app: OpenAPIHono<Env>,
  catalog = habitCatalog,
) {
  const authorize = createMiddleware<Env>(async (c, next) => {
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    const permission = c.req.method === "GET" ? "habits:read" : "habits:write";
    if (!access.permissions.includes(permission))
      return c.json({ message: `Missing ${permission}.` }, 403);
    if (
      c.req.method !== "GET" &&
      access.client.kind === "web" &&
      c.req.header("origin") !==
        (getPublicOrigin() ?? new URL(c.req.url).origin)
    )
      return c.json({ message: "Invalid origin." }, 403);
    c.header("Cache-Control", "no-store");
    await next();
  });
  const failure = {
    description:
      "Invalid input, authentication, permission, conflict or unavailable.",
    content: {
      "application/json": {
        schema: z.object({ message: z.string() }),
        example: { message: "Unavailable." },
      },
    },
  };
  const errors = {
    400: failure,
    401: failure,
    403: failure,
    409: failure,
    503: failure,
  };
  const common = (write = false) => ({
    tags: ["Habits"],
    middleware: [authorize],
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<
      string,
      string[]
    >[],
    "x-required-permissions": [write ? "habits:write" : "habits:read"],
    "x-destructive": false,
    description: `Authentication: trusted Owner ingress or API Key. Required permissions: ${write ? "habits:write" : "habits:read"}. Inputs: ${write ? "commandId, expectedRevision, reason and typed changes" : "optional history cursor and limit"}. Success response: 200 catalog projection and revision or revision history. Failure responses: 400 invalid input, 401 unauthenticated, 403 forbidden, 409 stale revision or changed command reuse, 503 unavailable. Side effects: ${write ? "atomic current definitions and append-only revision receipt; archive retains records" : "none"}. Destructive: no. Retry safety: ${write ? "identical commandId and payload replay original result" : "safe read"}.`,
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/definitions",
      operationId: "getHabitDefinitions",
      summary: "Read the Habit Catalog",
      ...common(),
      responses: {
        200: {
          description: "Current catalog.",
          content: {
            "application/json": {
              schema: catalogResultSchema,
              example: {
                projection: {
                  stacks: [],
                  habits: [],
                  gate: { window: 14, required: 10 },
                  diagnostics: [],
                },
                revision: 0,
              },
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await catalog.current(c.get("accessContext")!.owner.id),
          200,
        );
      } catch {
        return c.json({ message: "Catalog unavailable." }, 503);
      }
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/habits/definitions/changes",
      operationId: "changeHabitDefinitions",
      summary: "Apply atomic Habit Catalog changes",
      ...common(true),
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: catalogCommandSchema,
              example: {
                commandId: "00000000-0000-4000-8000-000000000001",
                expectedRevision: 0,
                reason: "Adjust gate",
                changes: [
                  {
                    type: "setGateDefaults",
                    gate: { window: 14, required: 10 },
                  },
                ],
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved catalog revision.",
          content: {
            "application/json": {
              schema: catalogResultSchema,
              example: {
                projection: {
                  stacks: [],
                  habits: [],
                  gate: { window: 14, required: 10 },
                  diagnostics: [],
                },
                revision: 1,
              },
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const access = c.get("accessContext")!;
      try {
        return c.json(
          await catalog.apply(
            access.owner.id,
            c.req.valid("json"),
            access.client.kind === "web" ? "Owner Session" : access.client.name,
          ),
          200,
        );
      } catch (e) {
        return c.json(
          {
            message:
              e instanceof HabitCatalogError
                ? e.message
                : "Save uncertain. Retry the same command.",
          },
          e instanceof HabitCatalogError ? e.status : 503,
        );
      }
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/definitions/history",
      operationId: "getHabitDefinitionHistory",
      summary: "Read Habit Revisions",
      ...common(),
      request: {
        query: z.object({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
      responses: {
        200: {
          description:
            "Newest revisions first. Use last revision as before cursor.",
          content: {
            "application/json": {
              schema: z.array(revisionEntrySchema),
              example: [],
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await catalog.history(
            c.get("accessContext")!.owner.id,
            c.req.valid("query"),
          ),
          200,
        );
      } catch {
        return c.json({ message: "History unavailable." }, 503);
      }
    },
  );
}
