import { agentInboxTodoResource, undoAgentInboxTodo } from "./agent-inbox-todo";
import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { AgentWriteAudit, PrismaClient } from "@quantself/db/generated/prisma/client";
import { createMiddleware } from "hono/factory";
import { JobsError } from "./jobs-error";
import { undoJobAgentWrite } from "./jobs-agent-write";
import { jobInterviewAuditResource, undoNativeJobInterview } from "./jobs-interview";
import { toTodoDelegation, todoAcceptanceSourceRevision, todoDelegationResource, todoDelegationSchema, TodoDelegationError, undoTodoDelegation, withTodoDelegationActivity } from "./todo-delegation";
import { runTodoHandBackClosure } from "./todo-handback-closure";
import { personalAssistantCaptureResource, undoPersonalAssistantCapture } from "./personal-assistant-capture";
import { todoSchema, type Todo, type TodoReader } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };

const auditSchema = z.object({
  id: z.uuid(),
  clientId: z.string(),
  clientName: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  revisionBefore: z.number().int(),
  revisionAfter: z.number().int(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  undoneAt: z.iso.datetime().nullable(),
});

const id = "c7d24ca9-087e-4468-bbb7-6f04c1c83b53";
const example = {
  id,
  clientId: "504da83c-1bb5-4492-9d03-57174c3187b1",
  clientName: "Sam Lee",
  resourceType: "jobApplication",
  resourceId: "49db114d-041b-4e68-a82c-2050a3a47ac5",
  revisionBefore: 1,
  revisionAfter: 2,
  before: { summary: "Application draft" },
  after: { summary: "Application draft with API experience" },
  createdAt: "2026-11-14T12:00:00Z",
  undoneAt: null,
};

const error = {
  description: "Audit request refused.",
  content: { "application/json": {
    schema: z.object({ message: z.string() }),
    example: { message: "This Agent write has been superseded." },
  } },
};

const authorizeOwner = createMiddleware<Env>(async (context, next) => {
  context.header("Cache-Control", "no-store");
  const access = context.get("accessContext");
  if (!access) return context.json({ message: "Authentication required." }, 401);
  if (access.client.kind !== "web") return context.json({ message: "An Owner Session is required." }, 403);
  if (context.req.method === "POST" &&
    context.req.header("origin") !== (getPublicOrigin() ?? new URL(context.req.url).origin)) {
    return context.json({ message: "Invalid origin." }, 403);
  }
  await next();
});

const shared = {
  tags: ["Auth"],
  security: [{ ownerSession: [] }],
  middleware: [authorizeOwner],
  "x-required-permissions": [],
  "x-destructive": false,
};

function auditResponse({ ownerId: _ownerId, createdAt, undoneAt, ...record }: AgentWriteAudit) {
  return {
    ...record,
    before: record.before as Record<string, unknown>,
    after: record.after as Record<string, unknown>,
    createdAt: createdAt.toISOString(),
    undoneAt: undoneAt?.toISOString() ?? null,
  };
}

export function registerAgentAuditRoutes(app: OpenAPIHono<Env>, db: PrismaClient = prisma, todos?: TodoReader, notify?: (number: number) => Promise<unknown>) {
  app.openapi(createRoute({
    ...shared,
    method: "get",
    path: "/api/v1/agent-audit",
    operationId: "listAgentWriteAudit",
    summary: "List audited Agent writes",
    description: "Authentication: trusted Owner ingress. Required permissions: none. Inputs: optional page limit and cursor. Success response: the latest Agent writes with before and after values and Undo status. Failure responses: invalid input or access denied. Side effects: none. Destructive: no. Retry safety: safe read.",
    request: { query: z.object({
      cursor: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }) },
    responses: {
      200: {
        description: "Owner audit page, newest first.",
        content: { "application/json": {
          schema: z.object({ audits: z.array(auditSchema), nextCursor: z.uuid().nullable() }),
          example: { audits: [example], nextCursor: null },
        } },
      },
      400: error, 401: error, 403: error,
    },
  }), async context => {
    const ownerId = context.get("accessContext")!.owner.id;
    const { cursor, limit } = context.req.valid("query");
    const rows = await db.agentWriteAudit.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor, ownerId }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return context.json({
      audits: page.map(auditResponse),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    }, 200);
  });

  app.openapi(createRoute({
    ...shared,
    method: "post",
    path: "/api/v1/agent-audit/{id}/undo",
    operationId: "undoAgentWrite",
    summary: "Undo an Agent write",
    description: "Authentication: same-origin Owner ingress. Required permissions: none. To-Do Write applies when reopening an accepted hand-back. Inputs: audit record ID. Success response: audit record with its Undo timestamp. Failure responses: invalid ID, access denied, audit not found, conflict if superseded, or unconfirmed GitHub reopening. Side effects: restores recorded values or cancels an unchanged native Appointment or Inbox To-do with a new record revision and marks the audit undone in the same transaction. Undo of acceptance reconciles GitHub before restoring the hand-back. Destructive: no. Retry safety: repeating the same audit ID reconciles or returns the completed Undo.",
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        description: "Agent write reverted.",
        content: { "application/json": {
          schema: z.object({ audit: auditSchema, delegation: todoDelegationSchema.optional(), sourceRevision: z.string().optional(),
            todo: todoSchema.optional(), cacheGeneration: z.number().int().nonnegative().optional() }),
          example: { audit: { ...example, undoneAt: "2026-11-14T12:01:00Z" } },
        } },
      },
      400: error, 401: error, 403: error, 404: error, 409: error, 503: error,
    },
  }), async context => {
    const access = context.get("accessContext")!;
    const ownerId = access.owner.id;
    const { id } = context.req.valid("param");
    try {
      let audit = await db.$transaction(async tx => {
        const record = await tx.agentWriteAudit.findFirst({ where: { id, ownerId } });
        if (!record) throw new JobsError(404, "Audit entry not found.");
        if (record.undoneAt || record.resourceType === personalAssistantCaptureResource || todoAcceptanceSourceRevision(record)) return record;
        try {
          if (record.resourceType === "jobApplication") await undoJobAgentWrite(tx, record);
          else if (record.resourceType === jobInterviewAuditResource) await undoNativeJobInterview(tx, record);
          else if (record.resourceType === agentInboxTodoResource) await undoAgentInboxTodo(tx, record);
          else if (record.resourceType === todoDelegationResource) await undoTodoDelegation(tx, record);
          else throw new JobsError(409, "Undo is unavailable for this entry.");
        } catch (error) {
          if (!(error instanceof JobsError || error instanceof TodoDelegationError) || error.status !== 409) throw error;
          // The conditional update waits for a concurrent Undo to commit before losing.
          const latest = await tx.agentWriteAudit.findFirst({ where: { id, ownerId } });
          if (latest?.undoneAt) return latest;
          throw error;
        }
        return tx.agentWriteAudit.update({ where: { id, ownerId }, data: { undoneAt: new Date() } });
      });
      let sourceRevision: string | undefined;
      let updatedTodo: Todo | undefined;
      let cacheGeneration: number | undefined;
      if (audit.resourceType === personalAssistantCaptureResource) {
        const undone = await undoPersonalAssistantCapture(db, todos, access, audit);
        ({ audit, cacheGeneration } = undone);
        updatedTodo = undone.todo;
      } else if (!audit.undoneAt) {
        const acceptedRevision = todoAcceptanceSourceRevision(audit);
        if (!todos || !acceptedRevision) throw new TodoDelegationError(503, "Task reopening is temporarily unavailable. Retry Undo.");
        const result = await runTodoHandBackClosure(db, todos, access, {
          commandId: audit.id, todoId: audit.resourceId, expectedRevision: audit.revisionAfter, sourceRevision: acceptedRevision,
        }, audit);
        sourceRevision = result.sourceRevision;
        audit = await db.agentWriteAudit.findUniqueOrThrow({ where: { id, ownerId } });
      } else if (todoAcceptanceSourceRevision(audit)) {
        const receipt = await db.apiIdempotencyKey.findUnique({ where: { clientId_operation_idempotencyKey: {
          clientId: ownerId, operation: "todoHandBackClosureFinish", idempotencyKey: id,
        } }, select: { responseBody: true } });
        const parsed = z.object({ sourceRevision: z.string() }).safeParse(receipt?.responseBody);
        if (parsed.success) sourceRevision = parsed.data.sourceRevision;
      }
      const row = audit.resourceType === todoDelegationResource
        ? await db.todoDelegation.findUnique({ where: { ownerId_todoId: { ownerId, todoId: audit.resourceId } } }) : undefined;
      if (row) await notify?.(row.number).catch(() => {});
      return context.json({ audit: auditResponse(audit), ...(row && { delegation: withTodoDelegationActivity(toTodoDelegation(row), row, access) }), ...(sourceRevision && { sourceRevision }),
        ...(updatedTodo && { todo: updatedTodo }), ...(cacheGeneration !== undefined && { cacheGeneration }) }, 200);
    } catch (error) {
      if (!(error instanceof JobsError || error instanceof TodoDelegationError)) throw error;
      if (error.status === 404) return context.json({ message: error.message }, 404);
      if (error.status === 409) return context.json({ message: error.message }, 409);
      if (error.status === 403 || error.status === 503) return context.json({ message: error.message }, error.status);
      throw error;
    }
  });
}
