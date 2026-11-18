import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { AccessContext } from "@quantself/auth";
import {
  catalogCommandSchema,
  catalogResultSchema,
  habitCatalog,
  HabitCatalogError,
  revisionEntrySchema,
} from "./habits-catalog";

type Env = { Variables: { accessContext: AccessContext | null } };
const message = z.object({ message: z.string() });
const json = <Schema extends z.ZodType>(schema: Schema, description: string, example: unknown) => ({
  description,
  content: { "application/json": { schema, example } },
});
const failure = (description: string) => json(message, description, { message: description });
const failures = {
  401: failure("Authentication required."),
  403: failure("Forbidden."),
  503: failure("Habit catalog unavailable."),
};
const projection = { stacks: [], habits: [], gate: { window: 14, required: 10 }, diagnostics: [] };
const security: Record<string, string[]>[] = [{ apiKeyAuth: [] }, { ownerSession: [] }];
const systemSchema = catalogResultSchema.extend({
  history: z.array(revisionEntrySchema),
});
// Webhook parameters lack the catalog's discriminated union and open details map.
const webhookCommandSchema = catalogCommandSchema.omit({ changes: true }).extend({
  changesJson: z.string().min(1).max(1_000_000).describe("JSON-encoded HabitChange array."),
});

export function registerJarvisHabitRoutes(
  app: OpenAPIHono<Env>,
  catalog: Pick<typeof habitCatalog, "current" | "history" | "apply"> = habitCatalog,
) {
  const authorize = (permission: "habits:read" | "habits:write") =>
    createMiddleware<Env>(async (c, next) => {
      const access = c.get("accessContext");
      if (!access) return c.json({ message: "Authentication required." }, 401);
      if (!access.permissions.includes(permission))
        return c.json({ message: `Missing ${permission}.` }, 403);
      if (permission === "habits:write" && access.client.kind === "web") {
        const expected = (getPublicOrigin() ?? new URL(c.req.url).origin);
        if (c.req.header("origin") !== expected)
          return c.json({ message: "Invalid origin." }, 403);
      }
      c.header("Cache-Control", "no-store");
      await next();
    });

  app.openapi(createRoute({
    method: "get",
    path: "/api/v1/habits/system",
    operationId: "readHabitSystem",
    summary: "Read the habit system for Jarvis",
    tags: ["Habits"],
    security,
    "x-required-permissions": ["habits:read"],
    "x-destructive": false,
    middleware: [authorize("habits:read")] as const,
    description: "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read. Inputs: none. Success response: 200 with the current catalog and up to five revisions through that revision. Failure responses: 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe read.",
    responses: { 200: json(systemSchema, "Current habit system.", { projection, revision: 0, history: [] }), ...failures },
  }), async (c) => {
    const ownerId = c.get("accessContext")!.owner.id;
    try {
      const current = await catalog.current(ownerId);
      const history = current.revision === 0 ? [] :
        await catalog.history(ownerId, { before: current.revision + 1, limit: 5 });
      return c.json({ ...current, history }, 200);
    } catch {
      return c.json({ message: "Habit catalog unavailable." }, 503);
    }
  });

  app.openapi(createRoute({
    method: "post",
    path: "/api/v1/habits/system/changes",
    operationId: "changeHabitSystem",
    summary: "Apply a habit system change from Jarvis",
    tags: ["Habits"],
    security,
    "x-required-permissions": ["habits:write"],
    "x-destructive": false,
    middleware: [authorize("habits:write")] as const,
    description: "Authentication: trusted Owner ingress or API Key. Required permissions: habits:write. Inputs: command ID, expected revision, reason and JSON-encoded catalog changes. Success response: 200 with the saved catalog revision. Failure responses: 400 invalid command, 401 unauthenticated, 403 forbidden, 409 conflict, 503 unavailable. Side effects: atomically changes definitions and records a revision. Destructive: no. Retry safety: identical commandId and payload replay the original result. A stale revision or changed payload conflicts.",
    request: { body: { required: true, ...json(webhookCommandSchema, "Jarvis habit catalog command.", {
      commandId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
      reason: "Adjust gate",
      changesJson: JSON.stringify([{ type: "setGateDefaults", gate: { window: 14, required: 10 } }]),
    }) } },
    responses: {
      200: json(catalogResultSchema, "Saved habit system.", { projection, revision: 1 }),
      400: failure("Invalid habit catalog command."),
      409: failure("Conflicting habit catalog command."),
      ...failures,
    },
  }), async (c) => {
    const access = c.get("accessContext")!;
    const { changesJson, ...command } = c.req.valid("json");
    let changes: unknown;
    try {
      changes = JSON.parse(changesJson);
    } catch {
      return c.json({ message: "changesJson must contain a JSON array." }, 400);
    }
    const parsed = catalogCommandSchema.safeParse({ ...command, changes });
    if (!parsed.success)
      return c.json({ message: parsed.error.message }, 400);
    try {
      const actor = access.client.kind === "web" ? "Owner Session" : access.client.name;
      return c.json(await catalog.apply(access.owner.id, parsed.data, actor), 200);
    } catch (error) {
      if (error instanceof HabitCatalogError)
        return c.json({ message: error.message }, error.status);
      return c.json({ message: "Habit catalog unavailable." }, 503);
    }
  });
}
