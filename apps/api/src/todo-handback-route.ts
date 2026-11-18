import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { type createTodoDelegationReads } from "./todo-delegation-route";
import { mutateTodoHandBack, TodoDelegationError, todoDelegationSchema } from "./todo-delegation";
import { todoHandBackDecisionInput, todoHandBackInput } from "./todo-handback-contract";
import { runTodoHandBackClosure } from "./todo-handback-closure";
import { runIdempotentCommand } from "./idempotency";
import { TodoReadError, type Todo, type TodoReader } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };
const params = z.object({ number: z.coerce.number().int().min(1).max(2_147_483_647) });
const error = { description: "Hand-back request refused.", content: { "application/json": {
  schema: z.object({ message: z.string() }), example: { message: "Refresh the task and review its current delegation." },
} } };
const responses = { 200: { description: "Saved decision and audit receipt.", content: { "application/json": {
  schema: z.object({ delegation: todoDelegationSchema, auditId: z.uuid(), sourceRevision: z.string().optional() }),
  example: { delegation: { delegate: { id: "agent-client", name: "Sam" }, state: "working", revision: 3 }, auditId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453" },
} } }, 400: error, 401: error, 403: error, 404: error, 409: error, 503: error };
const shared = { tags: ["To-Dos"], "x-destructive": false };
const example = { commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", todoId: "I_example", expectedRevision: 2 };

function errorResult(error: unknown) {
  if (error instanceof TodoDelegationError) return { message: error.message, status: error.status };
  if (error instanceof TodoReadError && error.code === "TODO_NOT_FOUND") return { message: "Task not found.", status: 404 } as const;
  return { message: "Hand-back is temporarily unavailable. Retry the same command.", status: 503 } as const;
}

export function registerTodoHandBackRoutes(app: OpenAPIHono<Env>, reader: TodoReader,
  reads?: ReturnType<typeof createTodoDelegationReads>, db = prisma, notify?: (number: number) => Promise<unknown>) {
  async function saveLocal(access: AccessContext, number: number,
    input: z.infer<typeof todoHandBackInput> | Extract<z.infer<typeof todoHandBackDecisionInput>, { decision: "return" }>) {
    const agent = "handBack" in input;
    const observedAt = new Date();
    const operation = agent ? "todoHandBack" : "todoHandBackReturn";
    const receipt = await db.apiIdempotencyKey.findUnique({ where: { clientId_operation_idempotencyKey: {
      clientId: `${access.owner.id}:${access.client.id}`, operation, idempotencyKey: input.commandId,
    } }, select: { idempotencyKey: true } });
    let todo: Todo | undefined;
    if (!receipt) {
      todo = agent ? await reads?.readAssigned(access, reader, number) : await (reader.assignedDetail ? reader.assignedDetail(number, false) : reader.detail(number));
      if (!todo || todo.id !== input.todoId || todo.trashed || todo.state !== "open") throw new TodoDelegationError(404, "Task not found.");
    }
    const result = await runIdempotentCommand({
      operation, clientId: `${access.owner.id}:${access.client.id}`, idempotencyKey: input.commandId, request: { number, ...input },
      async execute(tx) {
        if (!todo) throw new TodoDelegationError(503, "Decision receipt unavailable. Retry the same command.");
        return { kind: "success", status: 200, body: await mutateTodoHandBack(tx, access, todo, input.expectedRevision, input, observedAt) };
      },
    }, db);
    if (result.kind === "conflict") throw new TodoDelegationError(409, result.message);
    return result.body;
  }

  app.openapi(createRoute({
    ...shared, method: "post", path: "/api/v1/todos/{number}/hand-back", operationId: "submitTodoHandBack",
    summary: "Hand an assigned To-Do back to the Owner", security: [{ apiKeyAuth: [] }], "x-required-permissions": ["todos:read", "todos:write"],
    description: "Authentication: Agent API Key. Required permissions: todos:read and todos:write. Inputs: assigned task identity, delegation revision, command ID and review or question. Success response: structured hand-back and audit receipt. Failure responses: denied access, missing assignment, stale revision, recent Owner edit or unavailable source. Side effects: records the hand-back, activity and audit together. Destructive: no. Retry safety: repeat the same command ID and payload.",
    request: { params, body: { required: true, content: { "application/json": {
      schema: todoHandBackInput, example: { ...example, handBack: { kind: "review", summary: "Ready for review", links: [] } },
    } } } }, responses,
  }), async c => {
    c.header("Cache-Control", "private, no-store");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (access.client.kind !== "agent" || !access.permissions.includes("todos:read") || !access.permissions.includes("todos:write")) return c.json({ message: "An Agent Key with To-Do Read and Write is required." }, 403);
    try {
      const { number } = c.req.valid("param");
      const saved = await saveLocal(access, number, c.req.valid("json"));
      await notify?.(number).catch(() => {});
      return c.json(saved, 200);
    }
    catch (error) { const result = errorResult(error); return c.json({ message: result.message }, result.status); }
  });

  app.openapi(createRoute({
    ...shared, method: "post", path: "/api/v1/todos/{number}/hand-back/decision", operationId: "decideTodoHandBack",
    summary: "Accept or return a To-Do hand-back", security: [{ ownerSession: [] }], "x-required-permissions": ["todos:write"],
    description: "Authentication: same-origin Owner ingress. Required permissions: todos:write. Inputs: delegation revision, task identity, command ID and decision. Accept requires the source revision. Return requires a note or offered answer. Success response: audited decision. Failure responses: invalid input, denied access, conflict or unconfirmed GitHub completion. Side effects: Return records the reply. Accept closes the issue as completed before finalizing the audit. Destructive: no. Retry safety: repeat the same command ID and payload to reconcile.",
    request: { params, body: { required: true, content: { "application/json": {
      schema: todoHandBackDecisionInput, example: { ...example, decision: "return", reply: { kind: "note", note: "Please expand the summary." } },
    } } } }, responses,
  }), async c => {
    c.header("Cache-Control", "private, no-store");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (access.client.kind !== "web" || !access.permissions.includes("todos:write")) return c.json({ message: "An Owner Session with To-Do Write is required." }, 403);
    if (c.req.header("origin") !== (getPublicOrigin() ?? new URL(c.req.url).origin)) return c.json({ message: "Invalid origin." }, 403);
    const { number } = c.req.valid("param");
    const input = c.req.valid("json");
    try {
      const saved = input.decision === "return" ? await saveLocal(access, number, input) : await runTodoHandBackClosure(db, reader, access, {
        number, commandId: input.commandId, todoId: input.todoId, expectedRevision: input.expectedRevision, sourceRevision: input.sourceRevision,
      });
      await notify?.(number).catch(() => {});
      return c.json(saved, 200);
    } catch (error) { const result = errorResult(error); return c.json({ message: result.message }, result.status); }
  });
}
