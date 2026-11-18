import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { agentInboxTodoResource, createAgentInboxTodo, inboxTodoView } from "./agent-inbox-todo";
import { jsonAuthorizationFailure } from "./authorization-response";
import { JobsError } from "./jobs-error";
import { idempotencyHeader } from "./jobs-contract";
import { runIdempotentCommand } from "./idempotency";

export const agentInboxTodoPath = "/api/v1/agent-inbox-todos";

type Env = { Variables: { accessContext: AccessContext | null } };

const title = z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const note = z.string().max(10_000);
const todo = z.object({
  id: z.uuid(), title, note, revision: z.number().int().positive(), completed: z.boolean(), auditId: z.uuid().nullable(),
}).openapi("AgentInboxTodo");
const createdTodoStatus = z.object({ id: z.uuid(), status: z.enum(["inbox", "completed", "undone"]) });
const example = {
  id: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", title: "Call the plumber", note: "", revision: 1, completed: false,
  auditId: "c7d24ca9-087e-4468-bbb7-6f04c1c83b53",
};
const failure = {
  description: "The request could not be applied.",
  content: { "application/json": { schema: z.object({ message: z.string() }), example: { message: "The To-do changed. Refresh and retry." } } },
};
const shared = { tags: ["To-Dos"], "x-destructive": false };
const ownerOnly = { security: [{ ownerSession: [] }] };
const errors = { 400: failure, 401: failure, 403: failure, 409: failure };

export function registerAgentInboxTodoRoutes(app: OpenAPIHono<Env>, db: PrismaClient = prisma) {
  app.openapi(createRoute({
    ...shared,
    method: "post", path: agentInboxTodoPath, operationId: "createAgentInboxTodo",
    summary: "Add a Quantself To-do to the Owner's Inbox",
    description: "Authentication: Agent X-API-Key. Required permissions: todos:write. Inputs: title, optional note, and a stable Idempotency-Key. Success response: saved Quantself To-do and its Owner Undo audit ID. Failure responses: invalid input, access denied, or reuse of the key with different input. Side effects: creates one Owner Inbox To-do and audit atomically. Destructive: no. Retry safety: reuse the same key and input even after an uncertain response.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": ["todos:write"],
    request: {
      headers: idempotencyHeader,
      body: { required: true, content: { "application/json": {
        schema: z.object({ title, note: note.optional() }).strict(),
        example: { title: example.title },
      } } },
    },
    responses: { ...errors, 201: {
      description: "The creation receipt.",
      content: { "application/json": {
        schema: z.object({ todo, auditId: z.uuid() }), example: { todo: example, auditId: example.auditId },
      } },
    } },
  }), async c => {
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:write");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    if (auth.accessContext.client.kind !== "agent") return c.json({ message: "An Agent API key is required." }, 403);
    c.header("Cache-Control", "private, no-store");
    const input = c.req.valid("json");
    const result = await createAgentInboxTodo(db, auth.accessContext, c.req.valid("header")["idempotency-key"], {
      title: input.title, note: input.note ?? "",
    });
    if (result.kind === "conflict") return c.json({ message: result.message }, 409);
    return c.json(result.body, 201);
  });

  app.openapi(createRoute({
    ...shared,
    method: "get", path: `${agentInboxTodoPath}/{id}`, operationId: "getCreatedInboxTodoStatus",
    summary: "Check the status of a Quantself To-do you created",
    description: "Authentication: Agent X-API-Key. Required permissions: todos:read. Inputs: To-do ID from your creation receipt. Success response: ID and current status (inbox, completed, or undone). Failure responses: invalid ID, access denied, or no matching creation by this Agent Client for this Owner. Side effects: none. Destructive: no. Retry safety: safe read. Task content and Owner edits are private.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": ["todos:read"],
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        description: "Current status with no task content.",
        content: { "application/json": {
          schema: createdTodoStatus,
          example: { id: example.id, status: "inbox" },
        } },
      },
      400: failure, 401: failure, 403: failure,
      404: { ...failure, description: "No matching To-do created by this Agent for this Owner.",
        content: { "application/json": { schema: z.object({ message: z.string() }), example: { message: "To-do not found." } } } },
    },
  }), async c => {
    c.header("Cache-Control", "private, no-store");
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    const { owner, client } = auth.accessContext;
    if (client.kind !== "agent") return c.json({ message: "An Agent API key is required." }, 403);
    const { id } = c.req.valid("param");
    const row = await db.agentInboxTodo.findUnique({
      where: {
        id, ownerId: owner.id,
        creationAudit: { ownerId: owner.id, clientId: client.id, resourceType: agentInboxTodoResource },
      },
      select: { completedAt: true, cancelledAt: true },
    });
    if (!row) return c.json({ message: "To-do not found." }, 404);
    const status = row.cancelledAt ? "undone" : row.completedAt ? "completed" : "inbox";
    return c.json<z.infer<typeof createdTodoStatus>, 200>({ id, status }, 200);
  });

  app.openapi(createRoute({
    ...shared, ...ownerOnly,
    method: "get", path: agentInboxTodoPath, operationId: "listAgentInboxTodos",
    summary: "List the Owner's Agent-created Quantself To-dos",
    description: "Authentication: trusted Owner ingress. Required permissions: todos:read. Inputs: completion filter and optional page cursor. Success response: one page of the Owner's To-dos. Failure responses: invalid input or access denied. Side effects: none. Destructive: no. Retry safety: safe read.",
    "x-required-permissions": ["todos:read"],
    request: { query: z.object({
      state: z.enum(["inbox", "done"]).default("inbox"), cursor: z.uuid().optional(),
    }) },
    responses: { ...errors, 200: {
      description: "One page of the Owner's To-dos.",
      content: { "application/json": {
        schema: z.object({ todos: z.array(todo), nextCursor: z.uuid().nullable() }),
        example: { todos: [example], nextCursor: null },
      } },
    } },
  }), async c => {
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    if (auth.accessContext.client.kind !== "web") return c.json({ message: "An Owner Session is required." }, 403);
    c.header("Cache-Control", "private, no-store");
    const { state, cursor } = c.req.valid("query");
    const ownerId = auth.accessContext.owner.id;
    const pageSize = 50;
    const rows = await db.agentInboxTodo.findMany({
      where: { ownerId, cancelledAt: null, completedAt: state === "inbox" ? null : { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor && { cursor: { id: cursor, ownerId }, skip: 1 }),
    });
    const page = rows.slice(0, pageSize);
    return c.json({ todos: page.map(inboxTodoView), nextCursor: rows.length > pageSize ? page.at(-1)!.id : null }, 200);
  });

  app.openapi(createRoute({
    ...shared, ...ownerOnly,
    method: "patch", path: `${agentInboxTodoPath}/{id}`, operationId: "editAgentInboxTodo",
    summary: "Edit, complete or reopen an Agent-created Quantself To-do",
    description: "Authentication: trusted Owner ingress. Required permissions: todos:write. Inputs: To-do ID, expected revision, changes, and a stable Idempotency-Key. Success response: updated To-do with a new revision. Failure responses: invalid input, access denied, or stale revision. Side effects: updates one Owner To-do. Destructive: no. Retry safety: reuse the same key and input.",
    "x-required-permissions": ["todos:write"],
    request: {
      params: z.object({ id: z.uuid() }), headers: idempotencyHeader,
      body: { required: true, content: { "application/json": {
        schema: z.object({
          expectedRevision: z.number().int().positive(), title: title.optional(), note: note.optional(), completed: z.boolean().optional(),
        }).strict().refine(input => input.title !== undefined || input.note !== undefined || input.completed !== undefined),
        example: { expectedRevision: 1, completed: true },
      } } },
    },
    responses: { ...errors, 200: {
      description: "The updated To-do.",
      content: { "application/json": { schema: z.object({ todo }),
        example: { todo: { ...example, revision: 2, completed: true, auditId: null } } } },
    } },
  }), async c => {
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:write");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    const access = auth.accessContext;
    if (access.client.kind !== "web") return c.json({ message: "An Owner Session is required." }, 403);
    c.header("Cache-Control", "private, no-store");
    const { id } = c.req.valid("param");
    const { expectedRevision, title, note, completed } = c.req.valid("json");
    const ownerId = access.owner.id;
    try {
      const result = await runIdempotentCommand({
        operation: "editAgentInboxTodo", clientId: access.client.id, isolationLevel: "ReadCommitted",
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        request: { id, ownerId, expectedRevision, title, note, completed },
        execute: async tx => {
          const [row] = await tx.agentInboxTodo.updateManyAndReturn({
            where: { id, ownerId, revision: expectedRevision, cancelledAt: null },
            data: {
              ...(title !== undefined && { title }),
              ...(note !== undefined && { note }),
              ...(completed !== undefined && { completedAt: completed ? new Date() : null }),
              revision: { increment: 1 },
            },
          });
          if (!row) throw new JobsError(409, "The To-do changed. Refresh and retry.");
          return { kind: "success", status: 200, body: { todo: inboxTodoView(row) } };
        },
      }, db);
      if (result.kind === "conflict") return c.json({ message: result.message }, 409);
      return c.json(result.body, 200);
    } catch (error) {
      if (error instanceof JobsError && error.status === 409) return c.json({ message: error.message }, 409);
      throw error;
    }
  });
}
