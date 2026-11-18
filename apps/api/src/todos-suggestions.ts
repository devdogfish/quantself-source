import { isDeepStrictEqual } from "node:util";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";
import { TodoReadError, type TodoReader, type Todo } from "./todos-github";
import { captureStore, type CaptureStore } from "./todos-captures";
import { TodoWriteError, todoEditSchema } from "./todos-write";

const example = {
  number: 1,
  reason: "Allow time for preparation",
  revision: "2026-10-26T12:00:00Z",
  command: {
    commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
    fields: { Estimate: { before: 30, after: 45 } },
  },
};

// Advice carries ordinary narrow commands, never an alternative saved plan.
export const todoSuggestionSchema = z
  .object({
    number: z.number().int().positive().safe(),
    reason: z.string().trim().min(1).max(1000),
    revision: z.string().min(1),
    command: todoEditSchema.refine(
      (command) =>
        Object.keys(command).every((key) =>
          ["commandId", "revision", "fields", "start", "end", "allDay", "fixed"].includes(key),
        ) &&
        Object.keys(command.fields ?? {}).every((key) =>
          ["Rank", "Top priority", "Estimate"].includes(key),
        ),
      "Suggestions may change only order, priority, estimates and Flexible Task timing.",
    ),
  })
  .strict()
  .openapi("TodoSuggestion");

type Suggestion = z.infer<typeof todoSuggestionSchema>;

function isSuggestionStale(todo: Todo, proposal: Suggestion): boolean {
  const { command } = proposal;
  const fieldsChanged = Object.entries(command.fields ?? {}).some(
    ([key, change]) =>
      !isDeepStrictEqual(todo.fields[key] ?? null, change.before),
  );
  const timingChanged = command.start !== undefined || command.end !== undefined || command.allDay !== undefined || command.fixed !== undefined;
  return todo.updatedAt !== proposal.revision || fieldsChanged || (timingChanged && command.revision !== proposal.revision);
}

// Match the proposed changes even when a Client rephrases or republishes them.
function suggestionChanges(proposal: Suggestion) {
  const { commandId: _, ...command } = proposal.command;
  return { number: proposal.number, revision: proposal.revision, command };
}

export function registerSuggestionRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  reader: TodoReader,
  store: CaptureStore = captureStore,
  readAssigned?: (access: AccessContext, reader: TodoReader, number: number) => Promise<Todo>,
) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/todo-suggestions/review",
      operationId: "reviewTodoSuggestion",
      summary: "Review explained planning advice without changing tasks",
      tags: ["To-Dos"],
      security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
      "x-required-permissions": ["todos:read"],
      "x-destructive": false,
      description:
        "Authentication: API Key or trusted Owner ingress. Required permissions: todos:read. Agent Clients can review only their assigned To-Dos. Inputs: one explained ordinary task command with source updatedAt revision. Read GET /api/v1/todos without a date filter first. Consider prerequisites of important work when visible; never infer importance using a server formula. Success response: 200 validated advice and stale status. Failure responses: 400 invalid/fixed Appointment, 401/403 denied, 404 task unavailable to the Agent, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe to repeat. No ranks, timing or commitment change on review. Present changes/reasons to the Owner; edit or dismiss within the active review. Apply only after explicit acceptance using PATCH /api/v1/todos/{number}, retaining commandId, before values and revision. That ordinary command requires todos:write and returns individual conflict/partial outcomes. Refresh/review stale advice. No auto-activation, fixed Appointment movement, optimizer, daily snapshot or learning store.",
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: todoSuggestionSchema, example },
          },
        },
      },
      responses: {
        200: {
          description: "Advice only; stale proposals require fresh review.",
          content: {
            "application/json": {
              example: { proposal: example, stale: false },
              schema: z
                .object({ proposal: todoSuggestionSchema, stale: z.boolean() })
                .openapi("TodoSuggestionReview"),
            },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 503].map((status) => [
            status,
            {
              description: "Invalid, denied or unavailable.",
              content: {
                "application/json": {
                  example: {
                    code: "TODO_UNAVAILABLE",
                    message: "Refresh task data.",
                  },
                  schema: z.object({ code: z.string(), message: z.string() }),
                },
              },
            },
          ]),
        ),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "private, no-store");
      const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
      if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
      const proposal = todoSuggestionSchema.parse(await c.req.json());
      try {
        const agent = auth.accessContext.client.kind === "agent";
        const todo = agent ? await readAssigned?.(auth.accessContext, reader, proposal.number) : await reader.detail(proposal.number);
        if (!todo || (agent && todo.trashed)) return c.json({ code: "TODO_NOT_FOUND", message: "Task not found." }, 404);
        const changesTiming = proposal.command.start !== undefined || proposal.command.end !== undefined || proposal.command.allDay !== undefined || proposal.command.fixed !== undefined;
        const fixed = changesTiming && (todo.fixed || proposal.command.fixed);
        if (fixed)
          return c.json(
            {
              code: "FIXED_APPOINTMENT",
              message:
                "Preserve fixed Appointments. Use an explicit task edit to change them.",
            },
            400,
          );
        return c.json(
          {
            proposal,
            stale: isSuggestionStale(todo, proposal),
          },
          200,
        );
      } catch (error) {
        if (error instanceof TodoReadError && error.code === "TODO_NOT_FOUND" && auth.accessContext.client.kind === "agent") return c.json({ code: "TODO_NOT_FOUND", message: "Task not found." }, 404);
        if (error instanceof TodoReadError && error.retryAfter)
          c.header("Retry-After", String(error.retryAfter));
        return c.json(
          {
            code: "TODO_UNAVAILABLE",
            message: "Refresh task data before reviewing advice.",
          },
          503,
        );
      }
    },
  );
  const params = z.object({ reviewId: z.string().uuid() });
  const responseError = {
    description: "Denied, conflict or unavailable.",
    content: {
      "application/json": {
        schema: z.object({ code: z.string(), message: z.string() }),
        example: { code: "TODO_UNAVAILABLE", message: "Review unavailable." },
      },
    },
  };
  for (const operation of ["list", "publish", "dismiss"] as const) {
    app.openapi(
      createRoute({
        method: operation === "list" ? "get" : "post",
        path: `/api/v1/todo-suggestions/{reviewId}${operation === "dismiss" ? "/dismiss" : ""}`,
        operationId: `${operation}TodoSuggestions`,
        summary: `${operation} advice in an active review`,
        tags: ["To-Dos"],
        security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
        "x-required-permissions": [
          operation === "list" ? "todos:read" : "todos:write",
        ],
        "x-destructive": false,
        description: `Authentication: API Key or trusted Owner ingress. Required permissions: ${operation === "list" ? "todos:read" : "todos:write"}. Inputs: shared active review UUID and explained proposal (publish), or commandId (dismiss). Success response: 200 review operations with dismissed state. Failure responses: 400 invalid, 401/403 denied, 409 incompatible proposal ID, 503 unavailable. Side effects: review command metadata only; never changes task facts. Destructive: no. Retry safety: identical proposal/commandId reconciles. Dismissal persists within this Owner review and publication retries cannot clear it. Start a new review to reconsider changed context. Application uses ordinary task PATCH after Owner acceptance, with the original command ID, source revision and before values; inspect partial outcomes. No daily plan snapshot or task cache.${operation === "list" ? "" : " Agent Clients cannot perform this mutation."}`,
        request: {
          params,
          ...(operation !== "list"
            ? {
                body: {
                  required: true,
                  content: {
                    "application/json": {
                      schema:
                        operation === "publish"
                          ? todoSuggestionSchema
                          : z.object({ commandId: z.string().uuid() }).strict(),
                      example:
                        operation === "publish"
                          ? example
                          : { commandId: example.command.commandId },
                    },
                  },
                },
              }
            : {}),
        },
        responses: {
          200: {
            description: "Review command metadata only.",
            content: {
              "application/json": {
                schema: z
                  .object({
                    suggestions: z.array(
                      z.object({
                        proposal: todoSuggestionSchema,
                        dismissed: z.boolean(),
                      }),
                    ),
                  })
                  .openapi("TodoSuggestions"),
                example: { suggestions: [] },
              },
            },
          },
          400: responseError,
          401: responseError,
          403: responseError,
          409: responseError,
          503: responseError,
        },
      }),
      async (c) => {
        c.header("Cache-Control", "private, no-store");
        const access = c.get("accessContext");
        const auth = authorizeAccessContext(
          access,
          operation === "list" ? "todos:read" : "todos:write",
        );
        if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
        const prefix = `suggestion:${access!.owner.id}:${c.req.param("reviewId")}:`;
        try {
          if (operation === "publish") {
            const proposal = todoSuggestionSchema.parse(await c.req.json());
            await store.reserve(prefix + proposal.command.commandId, proposal);
          } else if (operation === "dismiss") {
            const input = (await c.req.json()) as { commandId: string };
            const key = prefix + input.commandId;
            if (!(await store.get(key)))
              throw new TodoWriteError(
                "REVIEW_NOT_FOUND",
                "Suggestion not found.",
              );
            await store.save(key, { dismissed: true });
          }
          const rows = await store.list(prefix);
          const reviewed = rows.map((row) => ({
            proposal: todoSuggestionSchema.parse(row.input),
            dismissed: row.result?.dismissed === true,
          }));
          const dismissed = reviewed
            .filter((row) => row.dismissed)
            .map((row) => suggestionChanges(row.proposal));
          return c.json(
            {
              suggestions: reviewed.map((row) => ({
                ...row,
                dismissed:
                  row.dismissed ||
                  dismissed.some((value) =>
                    isDeepStrictEqual(value, suggestionChanges(row.proposal)),
                  ),
              })),
            },
            200,
          );
        } catch (error) {
          if (error instanceof TodoWriteError)
            return c.json(
              { code: error.code, message: error.message },
              error.status,
            );
          return c.json(
            {
              code: "TODO_UNAVAILABLE",
              message: "Review unavailable. Retry identical input.",
            },
            503,
          );
        }
      },
    );
  }
}
