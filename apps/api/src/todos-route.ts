import { categorySchema } from "./todos-categories";
import { registerCategoryRoutes } from "./todos-categories-route";
import { registerSuggestionRoutes } from "./todos-suggestions";
import { todoApprovalSchema } from "./todos-approval";
import { deriveReadiness } from "./todos-relationships";
import { withTimingWarnings } from "./todos-timing";
import { localDate, timingOverlapsDates } from "./todos-schedule";
import { registerCaptureRoutes } from "./todos-captures-route";
import {
  todoCreateSchema,
  todoEditSchema,
  todoWriteResultSchema,
  TodoWriteError,
} from "./todos-write";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import {
  authorizationErrorSchema,
  jsonAuthorizationFailure,
} from "./authorization-response";
import { TodoReadError, todoSchema, type Todo, type TodoReader } from "./todos-github";
import type { createTodoDelegationReads } from "./todo-delegation-route";
import { prisma } from "@quantself/db";
import { personalCaptureUndoId } from "./personal-assistant-capture";

const errorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryAfter: z.number().optional(),
  })
  .openapi("TodoReadError");
const failureResponses = {
  400: {
    description: "Invalid issue number.",
    content: {
      "application/json": {
        schema: errorSchema,
        example: {
          code: "TODO_UNAVAILABLE",
          message: "To-Dos unavailable.",
          retryAfter: 30,
        },
      },
    },
  },
  401: {
    description: "Authentication required.",
    content: {
      "application/json": {
        schema: authorizationErrorSchema,
        example: { code: "FORBIDDEN", message: "Required permission missing." },
      },
    },
  },
  403: {
    description: "To-Do Read required.",
    content: {
      "application/json": {
        schema: authorizationErrorSchema,
        example: { code: "FORBIDDEN", message: "Required permission missing." },
      },
    },
  },
  404: {
    description: "Task not found, including pull requests.",
    content: {
      "application/json": {
        schema: errorSchema,
        example: {
          code: "TODO_UNAVAILABLE",
          message: "To-Dos unavailable.",
          retryAfter: 30,
        },
      },
    },
  },
  503: {
    description:
      "Configuration mismatch or GitHub unavailable. Retry-After indicates the minimum retry delay when supplied. Loaded records must be marked stale and edits paused.",
    content: {
      "application/json": {
        schema: errorSchema,
        example: {
          code: "TODO_UNAVAILABLE",
          message: "To-Dos unavailable.",
          retryAfter: 30,
        },
      },
    },
  },
};
const description =
  "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:read. Agent Clients can only see To-Dos currently delegated to their stable Client ID. Inputs: an issue number for detail; optional inclusive from/through local dates and viewing IANA timeZone for calendar reads; no repository override. Each task has one optional start/end range shared by list and calendar. Duration is derived. Date reads return overlapping ranges, native Due dates and invalid legacy timing diagnostics. timingWarnings are derived for overlaps and overfull dates, including DST. Success response: 200 with live dedicated-repository issues, typed fields, original prose and scheduling diagnostics. Failure responses: 400 invalid issue number, 401 unauthenticated, 403 missing read, 404 missing task, 503 GitHub unavailable or configuration mismatch. Side effects: Agent reads advance last activity for the assigned To-Dos returned. Destructive: no. Retry safety: safe to repeat; concurrent source reads coalesce. Responses must not be cached as authoritative task state.";
const shared = {
  method: "get" as const,
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  tags: ["To-Dos"],
  "x-required-permissions": ["todos:read"],
  "x-destructive": false,
  description,
};
const listRoute = createRoute({
  ...shared,
  path: "/api/v1/todos",
  request: {
    query: z
      .object({
        trash: z.enum(["exclude", "include", "only"]).optional().default("exclude"),
        includeCategories: z.enum(["true", "false"]).optional().describe("Include current category options once for classification; omitted by default."),
        from: localDate.optional(),
        through: localDate.optional(),
        timeZone: z
          .string()
          .default("America/Halifax")
          .refine((value) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: value });
              return true;
            } catch {
              return false;
            }
          }),
      })
      .refine(
        (v) =>
          (!v.from && !v.through) ||
          (!!v.from && !!v.through && v.from <= v.through),
        "Supply an ordered from/through date range.",
      ),
  },
  operationId: "listTodos",
  summary: "Read live To-Dos",
  responses: {
    ...failureResponses,
    200: {
      description:
        "Live To-Dos ordered by current Rank, then stable identity. Unknown fields and scheduling errors are retained.",
      content: {
        "application/json": {
          example: { todos: [], readAt: "2026-10-26T12:00:00Z" },
          schema: z
            .object({ todos: z.array(todoSchema), categories: z.array(categorySchema).optional(), readAt: z.string(), generation: z.number().optional(), stale: z.boolean().optional() })
            .openapi("TodosResponse"),
        },
      },
    },
  },
});
const detailRoute = createRoute({
  ...shared,
  path: "/api/v1/todos/{number}",
  operationId: "getTodo",
  summary: "Read a live To-Do",
  request: {
    params: z.object({
      number: z
        .string()
        .regex(/^[1-9]\d*$/)
        .refine((value) => Number.isSafeInteger(Number(value))),
    }),
  },
  responses: {
    ...failureResponses,
    200: {
      description: "Live task detail, fetched on demand.",
      content: {
        "application/json": {
          example: {
            todo: {
              id: "I_example",
              databaseId: 1,
              repository: "example/tasks",
              number: 1,
              url: "https://github.com/example/tasks/issues/1",
              title: "Example task",
              body: null,
              state: "open",
              closureReason: null,
              updatedAt: "2026-10-26T12:00:00Z",
              labels: [],
              fields: {},
              fieldValues: [],
              start: null, end: null, allDay: false, fixed: false,
              scheduleError: null,
            },
            readAt: "2026-10-26T12:00:00Z",
          },
          schema: z
            .object({ todo: todoSchema, readAt: z.string() })
            .openapi("TodoResponse"),
        },
      },
    },
  },
});

function jsonTodoReadFailure(context: Context, error: unknown) {
  const failure =
    error instanceof TodoReadError
      ? error
      : new TodoReadError(
          "TODO_UNAVAILABLE",
          "To-Dos are temporarily unavailable.",
        );
  if (failure.code === "TODO_ACCESS_DENIED") return context.json({ code: "FORBIDDEN" as const, message: failure.message }, 403);
  if (failure.retryAfter)
    context.header("Retry-After", String(failure.retryAfter));
  return context.json(
    {
      code: failure.code,
      message: failure.message,
      retryAfter: failure.retryAfter,
    },
    failure.code === "TODO_NOT_FOUND" ? 404 : 503,
  );
}

export function registerTodoRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  reader: TodoReader,
  delegations?: ReturnType<typeof createTodoDelegationReads>,
  db = prisma,
) {
  registerCategoryRoutes(app, reader);
  registerCaptureRoutes(app, reader);
  registerSuggestionRoutes(app, reader, undefined, delegations?.readAssigned);
  const writeShared = {
    security: shared.security,
    tags: ["To-Dos"],
    "x-required-permissions": ["todos:write"],
    "x-destructive": false,
    description:
      "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:write. Inputs: stable commandId and supplied task facts; edits include before/after target values. agentBrief appends an idempotent Agent Brief comment with goal, inputs, output/destination, constraints and doneWhen; Decision issues reject briefs and retain wayfinder labels. No approval labels can be supplied by ordinary editors. Relationship edits supply relationships: [{kind: blockedBy or children, number, before, after}]; booleans target a single native edge, never replace all edges. Only configured-repository targets may be edited. Self-links, cycles and unverified graphs fail explicitly per edge; parenthood does not imply blocking. Readiness releases only completed prerequisites, following duplicate targets; missing/external targets remain blocked. Relationships may change concurrently on GitHub; readback detects divergence, ambiguous edge mutations are never blindly replayed, and a fresh explicit command is needed after refresh. Creation accepts start/end in the same POST. Timing edits supply one or both non-null bounds, or both null to clear, plus revision copied from updatedAt. A lone supplied bound seeds a missing opposite bound thirty elapsed minutes away; an existing opposite bound stays unchanged. Optional deadlineAt is independent of work timing: on create supply an offset instant matching fields.Due in America/Halifax; on edit supply before/after and revision. Native Due changes retain mismatched deadline metadata with deadlineError until explicit repair. Stale revisions conflict. Optional allDay/fixed flags belong to that range. Preserve issue prose and version-2 extensions; ambiguous legacy blocks require review. Copying a task uses POST and creates a new identity. Commitment is independent of closure; closure supports open, completed, not_planned and duplicate with a validated canonical issue number in the configured repository. Native closure never edits timing or workflow labels. Success response: 200 with per-operation outcomes, including partial failure and separate Project sync. Failure responses: 400 invalid input, 401 unauthenticated, 403 missing write or Agent Client, 409 incompatible command reuse, 503 unavailable. Side effects: creates or edits one GitHub Task; no execution approval. Destructive: no. Retry safety: repeat identical commandId/input to reconcile. An uncertain create is never blindly repeated. Lifecycle transitions are sent at most once per command; ambiguous retries read current state only. For other Clients, Undo uses a new narrow inverse patch. Agent writes are disabled: GitHub does not let Quantself atomically compare the current revision, apply the mutation, and record its audit entry. Direct edits can race with a preflight check, preventing enforcement of the three-minute Owner hands-off window and conditional Undo.",
    responses: {
      ...failureResponses,
      403: {
        ...failureResponses[403],
        description: "Required permission missing or Agent mutation unsupported.",
      },
      409: {
        description: "Command conflict.",
        content: {
          "application/json": {
            schema: errorSchema,
            example: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Command ID already used with different input.",
            },
          },
        },
      },
      200: {
        description:
          "Task command outcomes. Inspect every operation; a 200 does not imply every operation succeeded.",
        content: {
          "application/json": {
            schema: todoWriteResultSchema(todoSchema),
            example: {
              commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
              todo: null,
              outcomes: { issue: "uncertain", project: "not-attempted" },
              message: "Creation uncertain. Retry this command to reconcile.",
              retryable: true,
            },
          },
        },
      },
    },
  };
  async function write(
    context: Context,
    command: Parameters<NonNullable<TodoReader["write"]>>[1],
  ) {
    context.header("Cache-Control", "private, no-store");
    const access = context.get("accessContext") as AccessContext | null;
    const authorization = authorizeAccessContext(access, {
      domain: "todos",
      action: "write",
    });
    if (!authorization.ok)
      return jsonAuthorizationFailure(context, authorization.error);
    try {
      if (!reader.write)
        throw new TodoReadError("TODO_UNAVAILABLE", "Task writes unavailable.");
      return context.json(await reader.write(access!.client.id, command), 200);
    } catch (error) {
      if (error instanceof TodoWriteError)
        return context.json(
          { code: error.code, message: error.message },
          error.status,
        );
      return jsonTodoReadFailure(context, error);
    }
  }
  app.openapi(
    createRoute({
      ...writeShared,
      method: "post",
      path: "/api/v1/todos",
      operationId: "createTodo",
      summary: "Capture a durable task",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: todoCreateSchema,
              example: {
                commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                title: "Call plumber",
              },
            },
          },
        },
      },
    }),
    (context) => write(context, context.req.valid("json")),
  );
  app.openapi(
    createRoute({
      ...writeShared,
      method: "patch",
      path: "/api/v1/todos/{number}",
      operationId: "editTodo",
      summary: "Partially edit task facts and lifecycle",
      request: {
        params: detailRoute.request.params,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: todoEditSchema,
              example: {
                commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                title: {
                  before: "Call plumber",
                  after: "Call plumber about sink",
                },
              },
            },
          },
        },
      },
    }),
    (context) =>
      write(context, {
        ...context.req.valid("json"),
        number: Number(context.req.valid("param").number),
      }),
  );
  app.openapi(
    createRoute({
      ...writeShared,
      method: "post",
      path: "/api/v1/todos/{number}/approval",
      operationId: "approveTodo",
      summary: "Explicitly approve reviewed delegation",
      "x-required-permissions": ["todos:approve"],
      description:
        "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:approve independently of write. Inputs: explicit reviewed intent. Success response: 200 per-operation outcomes. Failure responses: 400 invalid intent, 403 missing approval or Agent Client, 409 stale/replayed approval, 503 unavailable. Side effects: adds an approval label. Destructive: no. Retry safety: never replay; refresh and review. Supply confirmed Owner intent, exact reviewed approvalRevision and execute/wait choice. Stale or replayed intent is rejected. Adds only agent:implement or agent:queued; the separate runner owns consumption, progress and release. Generic approval grants no messaging, spending or other external authority. Uncertain writes must be reviewed, never blindly retried. Agent Clients cannot approve GitHub-backed tasks.",
      request: {
        params: detailRoute.request.params,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: todoApprovalSchema,
              example: {
                commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                revision: "a".repeat(64),
                intent: "execute",
                confirmed: true,
              },
            },
          },
        },
      },
    }),
    async (context) => {
      context.header("Cache-Control", "private, no-store");
      const access = context.get("accessContext");
      const auth = authorizeAccessContext(access, {
        domain: "todos",
        action: "approve",
      });
      if (!auth.ok) return jsonAuthorizationFailure(context, auth.error);
      try {
        if (!reader.approve)
          throw new TodoReadError("TODO_UNAVAILABLE", "Approval unavailable.");
        return context.json(
          await reader.approve(
            access!.client.id,
            Number(context.req.valid("param").number),
            context.req.valid("json"),
          ),
          200,
        );
      } catch (error) {
        if (error instanceof TodoWriteError)
          return context.json(
            { code: error.code, message: error.message },
            error.status,
          );
        return jsonTodoReadFailure(context, error);
      }
    },
  );
  app.openapi(listRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      domain: "todos",
      action: "read",
    });
    if (!authorization.ok)
      return jsonAuthorizationFailure(context, authorization.error);
    const { from, through, timeZone, trash, includeCategories } = context.req.valid("query");
    const access = authorization.accessContext;
    const agent = access.client.kind === "agent";
    const wantsCategories = !agent && includeCategories === "true";
    const include = (todo: Todo) => {
      if ((trash === "exclude" && todo.trashed) || (trash === "only" && !todo.trashed)) return false;
      if (!from || !through || todo.scheduleError) return true;
      return timingOverlapsDates(todo, from, through, timeZone) || (typeof todo.fields.Due === "string" && todo.fields.Due >= from && todo.fields.Due <= through);
    };
    try {
      if (wantsCategories && !reader.categories) throw new TodoReadError("TODO_UNAVAILABLE", "Category options unavailable.");
      const [rows, categoryOptions] = await Promise.all([
        agent ? delegations?.listAssigned(access, reader, include) ?? [] : reader.list(),
        wantsCategories ? reader.categories!.list() : undefined,
      ]);
      const [freshness, projected] = await Promise.all([
        agent ? undefined : reader.freshness?.(rows),
        agent ? rows : delegations?.project(access, rows) ?? rows,
      ]);
      return context.json(
        {
          todos: agent ? projected : withTimingWarnings(deriveReadiness(projected), timeZone).filter(include),
          ...(categoryOptions ? { categories: categoryOptions.categories } : {}),
          readAt: freshness?.readAt ?? new Date().toISOString(),
          ...(freshness ? { generation: freshness.generation, stale: freshness.stale } : {}),
        },
        200,
      );
    } catch (error) {
      return jsonTodoReadFailure(context, error);
    }
  });
  app.openapi(detailRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      domain: "todos",
      action: "read",
    });
    if (!authorization.ok)
      return jsonAuthorizationFailure(context, authorization.error);
    try {
      const access = authorization.accessContext;
      const number = Number(context.req.valid("param").number);
      if (access.client.kind === "agent") {
        const todo = await delegations?.readAssigned(access, reader, number, true);
        if (!todo || todo.trashed) throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
        return context.json({ todo, readAt: new Date().toISOString() }, 200);
      }
      const todo = await reader.detail(number);
      const [projected, auditId] = await Promise.all([
        delegations?.project(access, [todo]) ?? [todo],
        personalCaptureUndoId(db, access, todo),
      ]);
      if (!projected.length) throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
      return context.json(
        {
          todo: { ...withTimingWarnings(projected, "America/Halifax")[0]!, ...(auditId && { personalCaptureUndoId: auditId }) },
          readAt: new Date().toISOString(),
        },
        200,
      );
    } catch (error) {
      return jsonTodoReadFailure(context, error);
    }
  });
}
