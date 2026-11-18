import { getPublicOrigin } from "@quantself/auth/public-origin";
import { registerHabitAskRoutes } from "./habits-ask-route";
import { registerHabitSummaryRoutes } from "./habits-summary-route";
import { catalogSource } from "./habits-catalog";
import type { HabitDefinitions } from "./habits-source";
import { registerHabitCatalogRoutes } from "./habits-catalog-route";
import { habitBlocks, habitBlockSchema } from "./habits-calendar";
import { habitReviewService, contextSchema } from "./habits-review";
import { registerHabitOverviewRoutes } from "./habits-insights-route";
import { registerJarvisHabitRoutes } from "./jarvis-habits-route";
import {
  slipService,
  slipSchema,
  slipInputSchema,
  deleteSlipSchema,
} from "./habits-slips";
import {
  habitDocuments,
  documentPath,
  documentSchema,
} from "./habits-documents";
import { createMiddleware } from "hono/factory";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import {
  commandSchema,
  occurrenceSchema,
  habitService,
  HabitError,
} from "./habits-service";
import {
  habitDate,
  habitSchema,
  stackSchema,
  localHabitDate,
} from "./habits-definition";
type Env = { Variables: { accessContext: AccessContext | null } };
const error = z.object({ message: z.string() });
const definition = z
  .object({
    stacks: z.array(stackSchema),
    habits: z.array(habitSchema),
    gate: z.object({ window: z.number(), required: z.number() }).passthrough(),
    diagnostics: z.array(z.string()),
  })
  .passthrough();
export const habitDaySchema = z.object({
  date: habitDate,
  today: habitDate,
  projection: definition.nullable(),
  sha: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  occurrences: z.array(occurrenceSchema),
});
export function registerHabitRoutes(
  app: OpenAPIHono<Env>,
  service = habitService,
  slips = slipService,
  documents = habitDocuments,
  reviews: Pick<typeof habitReviewService, "start" | "context"> = habitReviewService,
  calendarSource: { read(ownerId: string): Promise<HabitDefinitions> } = catalogSource,
) {
  registerHabitCatalogRoutes(app);
  registerHabitSummaryRoutes(app);
  registerHabitAskRoutes(app);
  registerHabitOverviewRoutes(app);
  registerJarvisHabitRoutes(app);
  const common = (permission: string, write: boolean) => ({
    tags: ["Habits"],
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<
      string,
      string[]
    >[],
    "x-required-permissions": [permission],
    "x-destructive": false,
    description: `Authentication: trusted Owner ingress or API Key. Required permissions: ${permission}. Inputs: ${write ? "stable commandId, date, habitId, revision and before/after status and note" : "one local date, defaults to Halifax today"}. Success response: 200 ${write ? "saved occurrence" : "definitions, diagnostics and occurrences"}. Failure responses: 400 invalid input, 401 unauthenticated, 403 forbidden, 409 conflict, 503 unavailable. Side effects: ${write ? "saves one observation and durable command receipt" : "lazily materializes today's eligible observations"}. Destructive: no. Retry safety: ${write ? "identical commandId replays original result; changed payload conflicts" : "idempotent daily materialization"}.`,
  });
  const failures = {
    400: {
      description: "Invalid request.",
      content: {
        "application/json": {
          schema: error,
          example: { message: "Unavailable." },
        },
      },
    },
    401: {
      description: "Unauthenticated.",
      content: {
        "application/json": {
          schema: error,
          example: { message: "Unavailable." },
        },
      },
    },
    403: {
      description: "Forbidden.",
      content: {
        "application/json": {
          schema: error,
          example: { message: "Unavailable." },
        },
      },
    },
    409: {
      description: "Conflict.",
      content: {
        "application/json": {
          schema: error,
          example: { message: "Unavailable." },
        },
      },
    },
    503: {
      description: "Unavailable.",
      content: {
        "application/json": {
          schema: error,
          example: { message: "Unavailable." },
        },
      },
    },
  };
  const authorize = createMiddleware<Env>(async (c, next) => {
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    let permission = "habits:write";
    if (c.req.method === "GET") permission = "habits:read";
    else if (c.req.method === "DELETE") permission = "habits:delete";
    if (!access.permissions.includes(permission))
      return c.json({ message: `Missing ${permission}.` }, 403);
    if (c.req.method !== "GET" && access.client.kind === "web") {
      const expected = (getPublicOrigin() ?? new URL(c.req.url).origin);
      if (c.req.header("origin") !== expected)
        return c.json({ message: "Invalid origin." }, 403);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/calendar",
      operationId: "getHabitCalendar",
      summary: "Read derived habit blocks",
      middleware: [authorize],
      ...common("habits:read", false),
      description:
        "Authentication: trusted Owner ingress or API Key. Required permissions: habits:read. Inputs: inclusive from/to Halifax dates, at most 31 days. Success response: 200 derived read-only blocks with freshness. Failure responses: 400 invalid range, 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe read; one coalesced definition refresh, no per-date requests.",
      request: {
        query: z
          .object({ from: habitDate, to: habitDate })
          .refine(
            (q) =>
              q.to >= q.from &&
              Date.parse(q.to) - Date.parse(q.from) <= 30 * 86400000,
          ),
      },
      responses: {
        200: {
          description: "Derived blocks and freshness.",
          content: {
            "application/json": {
              schema: z.object({
                blocks: z.array(habitBlockSchema),
                stale: z.boolean(),
                error: z.string().nullable(),
              }),
              example: { blocks: [], stale: false, error: null },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      const state = await calendarSource.read(c.get("accessContext")!.owner.id);
      const { from, to } = c.req.valid("query");
      return c.json(
        {
          blocks: state.projection
            ? habitBlocks(state.projection, from, to)
            : [],
          stale: state.stale,
          error: state.error,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/day",
      operationId: "getHabitDay",
      summary: "Read one habit day",
      middleware: [authorize],
      ...common("habits:read", false),
      request: { query: z.object({ date: habitDate.optional() }) },
      responses: {
        200: {
          description: "Habit day.",
          content: {
            "application/json": {
              schema: habitDaySchema,
              example: {
                date: "2026-11-04",
                today: "2026-11-04",
                projection: {
                  stacks: [],
                  habits: [],
                  gate: { window: 14, required: 10 },
                  diagnostics: [],
                },
                sha: "abc",
                stale: false,
                error: null,
                occurrences: [],
              },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await service.read(
            c.get("accessContext")!.owner.id,
            c.req.valid("query").date ?? localHabitDate(),
          ),
          200,
        );
      } catch {
        return c.json({ message: "Habit observations unavailable." }, 503);
      }
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/habits/commands",
      operationId: "applyHabitCommand",
      summary: "Correct habit status or note",
      middleware: [authorize],
      ...common("habits:write", true),
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: commandSchema,
              example: {
                commandId: "00000000-0000-4000-8000-000000000001",
                habitId: "stretch",
                date: "2026-11-04",
                revision: 0,
                before: { status: "open", note: "" },
                after: { status: "done", note: "" },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved occurrence.",
          content: {
            "application/json": {
              schema: occurrenceSchema,
              example: {
                habitId: "stretch",
                date: "2026-11-04",
                definitionSha: "abc",
                status: "done",
                note: "",
                revision: 1,
                missed: false,
              },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      const access = c.get("accessContext")!;
      try {
        return c.json(
          await service.command(
            access.owner.id,
            access.client.id,
            c.req.valid("json"),
          ),
          200,
        );
      } catch (e) {
        return c.json(
          {
            message:
              e instanceof HabitError
                ? e.message
                : "Save uncertain. Retry the same command.",
          },
          e instanceof HabitError ? e.status : 503,
        );
      }
    },
  );
  const extensionContract = (
    permission: string,
    inputs: string,
    success: string,
    effects: string,
    destructive = false,
  ) => ({
    ...common(permission, permission !== "habits:read"),
    "x-destructive": destructive,
    description: `Authentication: trusted Owner ingress or API Key. Required permissions: ${permission}. Inputs: ${inputs}. Success response: 200 ${success}. Failure responses: 400 invalid request, 401 unauthenticated, 403 forbidden, 409 command conflict, 503 unavailable. Side effects: ${effects}. Destructive: ${destructive ? "yes" : "no"}. Retry safety: reads are safe to repeat; mutations replay the durable original result for identical commandId and payload, conflicting on changed reuse.`,
  });
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/habits/review",
      operationId: "startHabitReview",
      summary: "Create or reopen this week's review",
      middleware: [authorize],
      ...extensionContract(
        "habits:write",
        "Halifax local date",
        "Sunday review path",
        "source-verified atomic create-if-absent; retries and concurrent requests preserve existing answers",
      ),
      description:
        "Authentication: trusted Owner ingress or API Key. Required permissions: habits:write. Inputs: Halifax local date. Success response: 200 Sunday review path. Failure responses: 400 invalid date, 401 unauthenticated, 403 forbidden, 503 unavailable. Side effects: repository-scoped App verifies current source and atomically creates the week's review if absent. Destructive: no. Retry safety: retries and concurrent requests reopen existing files without replacing answers; no commandId required.",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ date: habitDate }),
              example: { date: "2026-11-04" },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Review path for read-only document viewer and GitHub editing.",
          content: {
            "application/json": {
              schema: z.object({ path: z.string() }),
              example: { path: "reviews/2026-11-08.md" },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await reviews.start(
            c.get("accessContext")!.owner.id,
            c.req.valid("json").date,
          ),
          200,
        );
      } catch {
        return c.json(
          {
            message:
              "Review unavailable. Retry to reopen without replacing answers.",
          },
          503,
        );
      }
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/context",
      operationId: "getHabitContext",
      summary: "Export Habit System and recent observations",
      request: { query: z.object({ days: z.enum(["14", "28"]).default("28") }) },
      middleware: [authorize],
      ...extensionContract(
        "habits:read",
        "optional days=14 or 28 (default 28)",
        "Markdown bundle and unavailable inputs",
        "bounded parallel documents, latest four reviews, complete paginated 14 or 28-local-day observations and slips",
      ),
      responses: {
        200: {
          description: "Complete context or explicit unavailable inputs.",
          content: {
            "application/json": {
              schema: contextSchema,
              example: { text: "# Habit context", unavailable: [] },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await reviews.context(
            c.get("accessContext")!.owner.id,
            c.req.valid("query").days === "14" ? 14 : 28,
          ),
          200,
        );
      } catch {
        return c.json(
          {
            message:
              "Context observations unavailable. No partial export produced.",
          },
          503,
        );
      }
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/document",
      operationId: "getHabitDocument",
      summary: "Read a Habit System document",
      middleware: [authorize],
      ...extensionContract(
        "habits:read",
        "allowlisted document path",
        "text, edit URL and freshness",
        "short coalesced read cache refresh",
      ),
      request: { query: z.object({ path: documentPath }) },
      responses: {
        200: {
          description: "Document, freshness and GitHub edit link.",
          content: {
            "application/json": {
              schema: documentSchema,
              example: {
                path: "SYSTEM.md",
                text: "# System",
                sha: "abc",
                editUrl:
                  "https://github.com/example/habits/edit/HEAD/SYSTEM.md",
                stale: false,
                error: null,
              },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) =>
      c.json(await documents.document(c.req.valid("query").path), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/reviews",
      operationId: "listHabitReviews",
      summary: "Read a page of past review paths",
      middleware: [authorize],
      ...extensionContract(
        "habits:read",
        "optional nonnegative offset",
        "twenty review paths and next offset; truncated trees return explicit stale/error",
        "one cached bulk tree read; no review body fan-out",
      ),
      request: {
        query: z.object({
          offset: z.coerce.number().int().nonnegative().max(1000000).default(0),
        }),
      },
      responses: {
        200: {
          description:
            "Twenty reviews; next offset when more exist. Truncated source trees fail explicitly.",
          content: {
            "application/json": {
              schema: z.object({
                paths: z.array(z.string()),
                next: z.number().nullable(),
                stale: z.boolean(),
                error: z.string().nullable(),
              }),
              example: { paths: [], next: null, stale: false, error: null },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) =>
      c.json(await documents.reviews(c.req.valid("query").offset), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/habits/slips",
      operationId: "listHabitSlips",
      summary: "Read recorded urges",
      middleware: [authorize],
      ...extensionContract(
        "habits:read",
        "optional before ID cursor",
        "fifty urges in stable descending creation ID order and next cursor",
        "none",
      ),
      request: { query: z.object({ before: z.uuid().optional() }) },
      responses: {
        200: {
          description:
            "Fifty events in stable ID order, with continuation cursor.",
          content: {
            "application/json": {
              schema: z.object({
                slips: z.array(slipSchema),
                next: z.string().nullable(),
              }),
              example: { slips: [], next: null },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await slips.list(
            c.get("accessContext")!.owner.id,
            c.req.valid("query").before,
          ),
          200,
        );
      } catch {
        return c.json({ message: "Urges unavailable." }, 503);
      }
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/habits/slips",
      operationId: "createHabitSlip",
      summary: "Record an urge outcome",
      middleware: [authorize],
      ...extensionContract(
        "habits:write",
        "commandId, break habitId, offset occurredAt timestamp (not future), resisted/slipped outcome, optional trigger and note",
        "saved urge",
        "appends one urge and command receipt without changing build occurrences",
      ),
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: slipInputSchema,
              example: {
                commandId: "00000000-0000-4000-8000-000000000001",
                habitId: "pause",
                occurredAt: "2026-11-04T12:00:00Z",
                outcome: "resisted",
                trigger: "waiting",
                note: "",
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved urge.",
          content: {
            "application/json": {
              schema: slipSchema,
              example: {
                id: "00000000-0000-4000-8000-000000000001",
                definitionSha: "abc",
                habitId: "pause",
                occurredAt: "2026-11-04T12:00:00Z",
                outcome: "resisted",
                trigger: "waiting",
                note: "",
              },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      const access = c.get("accessContext")!;
      try {
        return c.json(
          slipSchema.parse(
            await slips.command(
              access.owner.id,
              access.client.id,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (e) {
        return c.json(
          {
            message:
              e instanceof HabitError
                ? e.message
                : "Save uncertain. Retry the same command.",
          },
          e instanceof HabitError ? e.status : 503,
        );
      }
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/habits/slips",
      operationId: "deleteHabitSlip",
      summary: "Delete an erroneous urge record",
      middleware: [authorize],
      ...extensionContract(
        "habits:delete",
        "commandId and event ID",
        "deleted event ID",
        "permanently deletes only the Owner's named urge and saves a command receipt; habits:write alone is insufficient",
        true,
      ),
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: deleteSlipSchema,
              example: {
                commandId: "00000000-0000-4000-8000-000000000001",
                id: "00000000-0000-4000-8000-000000000002",
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Deleted event ID.",
          content: {
            "application/json": {
              schema: z.object({ id: z.string() }),
              example: { id: "00000000-0000-4000-8000-000000000002" },
            },
          },
        },
        ...failures,
      },
    }),
    async (c) => {
      const access = c.get("accessContext")!;
      try {
        const result = await slips.command(
          access.owner.id,
          access.client.id,
          c.req.valid("json"),
          true,
        );
        return c.json({ id: String(result.id) }, 200);
      } catch (e) {
        return c.json(
          {
            message:
              e instanceof HabitError
                ? e.message
                : "Delete uncertain. Retry the same command.",
          },
          e instanceof HabitError ? e.status : 503,
        );
      }
    },
  );
}
