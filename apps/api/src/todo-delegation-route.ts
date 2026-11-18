import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { listApiKeys, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { runIdempotentCommand } from "./idempotency";
import { personalCaptureResourceIds } from "./personal-capture-provenance";
import { setTodoDelegate, toTodoDelegation, todoDelegateSchema, TodoDelegationError, todoDelegationSchema, withTodoDelegationActivity } from "./todo-delegation";
import { readTodoDelegateActivityConfig, recordTodoDelegateActivity } from "./todo-delegate-activity";
import { TodoReadError, type Todo, type TodoReader } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };
type AgentDirectory = (ownerId: string) => Promise<z.infer<typeof todoDelegateSchema>[]>;

async function availableAgents(ownerId: string) {
  const keys = await listApiKeys({ userId: ownerId });
  const agents = new Map<string, z.infer<typeof todoDelegateSchema>>();
  for (const { agentClient, permissions, status } of keys) {
    if (agentClient && (status === "active" || status === "rotating") && permissions.includes("todos:read")) {
      agents.set(agentClient.id, { id: agentClient.id, name: agentClient.name });
    }
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function inaccessibleAgentTodoRoute(path: string) {
  return /^\/api\/v1\/(?:todos(?:\/|$)|todo-|jarvis(?:\/|$)|phone-jarvis(?:\/|$))/.test(path) &&
    !/^\/api\/v1\/todos(?:\/[1-9]\d*)?$/.test(path);
}

function missingTodo(): never {
  throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
}

export function createTodoDelegationReads(db: typeof prisma = prisma, notify?: (numbers: readonly number[]) => Promise<unknown>) {
  const activityConfig = readTodoDelegateActivityConfig();
  async function visibleTasks(access: AccessContext, todos: Todo[]) {
    if (access.client.kind === "web") return todos;
    const privateIds = await personalCaptureResourceIds(db, access.owner.id, todos);
    return todos.filter(todo => !privateIds.has(todo.id));
  }
  async function projectVisibleTasks(access: AccessContext, todos: Todo[]) {
    const isAgent = access.client.kind === "agent";
    const rows = todos.length ? await db.todoDelegation.findMany({
      where: {
        ownerId: access.owner.id,
        todoId: { in: todos.map(todo => todo.id) },
        ...(isAgent ? { delegateId: access.client.id } : {}),
      },
    }) : [];
    const byId = new Map(rows.map(row => [row.todoId, row]));
    const now = new Date();
    return todos.flatMap(todo => {
      const row = byId.get(todo.id);
      const delegation = withTodoDelegationActivity(toTodoDelegation(row, access.client.kind === "web"), row,
        access, activityConfig, now, todo.state === "open" && !todo.trashed);
      if (!isAgent) return [{ ...todo, delegation }];
      if (!row || row.number !== todo.number || row.repository !== todo.repository) return [];
      const { blockedBy, children, parent, duplicateOf, prerequisiteStates, readiness, relationshipError, timingWarnings, approvalRevision, ...assigned } = todo;
      return [{ ...assigned, delegation }];
    });
  }

  const readScope = { todoId: true, revision: true, repository: true, number: true } as const;
  async function finishRead(access: AccessContext, tasks: Todo[],
    observed: { todoId: string; revision: number; repository: string; number: number }[], at?: Date) {
    const byId = new Map(observed.map(row => [row.todoId, row]));
    const eligible = await visibleTasks(access, tasks.filter(task => {
      const scope = byId.get(task.id);
      return !task.trashed && scope?.number === task.number && scope.repository === task.repository;
    }));
    const updated = at ? await recordTodoDelegateActivity(db, access, "read", eligible.map(task => byId.get(task.id)!), at) : 0;
    // Recheck membership after the source read and atomic touch, including concurrent reassignment.
    const projected = await projectVisibleTasks(access, eligible);
    if (updated) await notify?.(eligible.map(task => task.number)).catch(() => {});
    return projected;
  }

  return {
    async project(access: AccessContext, todos: Todo[]) {
      return projectVisibleTasks(access, await visibleTasks(access, todos));
    },
    async listAssigned(access: AccessContext, reader: TodoReader, include: (todo: Todo) => boolean) {
      if (!reader.assignedList) return [];
      const at = new Date();
      const assignments = await db.todoDelegation.findMany({
        where: { ownerId: access.owner.id, delegateId: access.client.id },
        select: readScope,
      });
      if (!assignments.length) return [];
      const tasks = await reader.assignedList(assignments.map(row => row.todoId));
      return finishRead(access, tasks.filter(include), assignments, at);
    },
    async readAssigned(access: AccessContext, reader: TodoReader, number: number, recordActivity = false) {
      if (!reader.assignedDetail || number > 2_147_483_647) missingTodo();
      const at = recordActivity ? new Date() : undefined;
      const assigned = await db.todoDelegation.findMany({
        where: { ownerId: access.owner.id, delegateId: access.client.id, number },
        select: readScope,
      });
      if (!assigned.length) missingTodo();
      const task = await reader.assignedDetail(number);
      return (await finishRead(access, [task], assigned, at))[0] ?? missingTodo();
    },
  };
}

const shared = {
  tags: ["To-Dos"], security: [{ ownerSession: [] }], "x-destructive": false,
};
const error = { description: "Delegation request refused.", content: { "application/json": {
  schema: z.object({ message: z.string() }), example: { message: "Refresh and try again." },
} } };
const setInput = z.object({
  commandId: z.uuid(),
  todoId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative().max(2_147_483_645),
  delegateId: z.string().min(1).max(256).nullable(),
}).strict();

export function registerTodoDelegationRoutes(
  app: OpenAPIHono<Env>,
  reader: TodoReader,
  db: typeof prisma = prisma,
  directory: AgentDirectory = availableAgents,
  notify?: (number: number) => Promise<unknown>,
) {
  app.openapi(createRoute({
    ...shared, method: "get", path: "/api/v1/todo-delegates", operationId: "listTodoDelegates",
    summary: "List eligible To-Do delegates", "x-required-permissions": ["todos:write"],
    description: "Authentication: trusted Owner ingress. Required permissions: todos:write. Inputs: none. Success response: active Agent Clients with todos:read identified by stable Client ID. Failure responses: unauthenticated, forbidden, or directory unavailable. Side effects: none. Destructive: no. Retry safety: safe read.",
    responses: { 200: { description: "Eligible Agents.", content: { "application/json": {
      schema: z.object({ agents: z.array(todoDelegateSchema) }), example: { agents: [] },
    } } }, 401: error, 403: error, 503: error },
  }), async c => {
    c.header("Cache-Control", "private, no-store");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (access.client.kind !== "web" || !access.permissions.includes("todos:write")) return c.json({ message: "An Owner Session with To-Do Write is required." }, 403);
    try { return c.json({ agents: await directory(access.owner.id) }, 200); }
    catch { return c.json({ message: "Agents are temporarily unavailable." }, 503); }
  });

  app.openapi(createRoute({
    ...shared, method: "patch", path: "/api/v1/todos/{number}/delegation", operationId: "setTodoDelegate",
    summary: "Set or remove a To-Do delegate", "x-required-permissions": ["todos:write"],
    description: "Authentication: same-origin Owner ingress. Required permissions: todos:write. Inputs: issue number, immutable task ID, expected delegation revision, nullable delegate ID, and command ID. Success response: confirmed delegation and audit ID. Failure responses: invalid input, denied access, personal Gmail capture, missing task, stale revision or unavailable source. Side effects: updates assignment and audit together. Destructive: no. Retry safety: repeat the same command ID and input.",
    request: { params: z.object({ number: z.coerce.number().int().min(1).max(2_147_483_647) }), body: {
      required: true, content: { "application/json": { schema: setInput, example: {
        commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", todoId: "I_example", expectedRevision: 0, delegateId: null,
      } } },
    } },
    responses: { 200: { description: "Saved delegation.", content: { "application/json": {
      schema: z.object({ delegation: todoDelegationSchema, auditId: z.uuid().nullable() }),
      example: { delegation: { revision: 0, delegate: null, state: null }, auditId: null },
    } } }, 400: error, 401: error, 403: error, 404: error, 409: error, 503: error },
  }), async c => {
    c.header("Cache-Control", "private, no-store");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (access.client.kind !== "web" || !access.permissions.includes("todos:write")) return c.json({ message: "An Owner Session with To-Do Write is required." }, 403);
    if (c.req.header("origin") !== (getPublicOrigin() ?? new URL(c.req.url).origin)) return c.json({ message: "Invalid origin." }, 403);

    const { number } = c.req.valid("param");
    const input = c.req.valid("json");
    try {
      const operation = "setTodoDelegate";
      // A committed retry can return its receipt even if the task or Agent is gone.
      const receipt = await db.apiIdempotencyKey.findUnique({
        where: { clientId_operation_idempotencyKey: { clientId: access.owner.id, operation, idempotencyKey: input.commandId } },
        select: { idempotencyKey: true },
      });
      let facts: { todo: Todo; delegate: z.infer<typeof todoDelegateSchema> | null } | undefined;
      if (!receipt) {
        const [todo, agents] = await Promise.all([
          reader.assignedDetail ? reader.assignedDetail(number, false) : reader.detail(number),
          input.delegateId === null ? [] : directory(access.owner.id),
        ]);
        if (todo.id !== input.todoId || todo.trashed) missingTodo();
        const delegate = agents.find(agent => agent.id === input.delegateId) ?? null;
        if (input.delegateId !== null && !delegate) throw new TodoDelegationError(409, "That Agent is unavailable for delegation.");
        facts = { todo, delegate };
      }
      const result = await runIdempotentCommand({
        operation, clientId: access.owner.id, idempotencyKey: input.commandId,
        request: { number, ...input },
        async execute(tx) {
          if (!facts) throw Error("Delegation receipt was removed during retry.");
          return { kind: "success", status: 200, body: await setTodoDelegate(tx, access, facts.todo, { ...input, delegate: facts.delegate }) };
        },
      }, db);
      if (result.kind === "conflict") return c.json({ message: result.message }, 409);
      if (result.body.auditId) await notify?.(number).catch(() => {});
      return c.json(result.body, 200);
    } catch (error) {
      if (error instanceof TodoDelegationError) return c.json({ message: error.message }, error.status);
      if (error instanceof TodoReadError && error.code === "TODO_NOT_FOUND") return c.json({ message: error.message }, 404);
      return c.json({ message: "Delegation is temporarily unavailable. Retry this change." }, 503);
    }
  });
}
