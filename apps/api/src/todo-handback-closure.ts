import type { AccessContext } from "@quantself/auth";
import { Prisma, type AgentWriteAudit, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { runIdempotentCommand } from "./idempotency";
import {
  assignment, assignmentSchema, auditTodoDelegation, factFields, staleDelegation, toTodoDelegation,
  todoAcceptanceSourceRevision, TodoDelegationError, withTodoDelegationActivity,
} from "./todo-delegation";
import type { Todo, TodoReader } from "./todos-github";

type ClosureRequest = { commandId: string; todoId: string; sourceRevision: string; expectedRevision: number; number?: number };

export async function runTodoHandBackClosure(db: PrismaClient, reader: TodoReader, access: AccessContext,
  request: ClosureRequest, auditToUndo?: AgentWriteAudit) {
  if (access.client.kind !== "web" || !access.permissions.includes("todos:write")) {
    throw new TodoDelegationError(403, "An Owner Session with To-Do Write is required.");
  }
  const undo = !!auditToUndo;
  const kind = undo ? "undo_accept" : "accept";
  const pending = { ...request, kind, auditId: auditToUndo?.id ?? null };
  const identity = { ownerId: access.owner.id, todoId: request.todoId };
  const idempotency = { idempotencyKey: request.commandId, clientId: access.owner.id, request: pending };
  if (auditToUndo && (auditToUndo.ownerId !== access.owner.id || auditToUndo.resourceId !== request.todoId || todoAcceptanceSourceRevision(auditToUndo) !== request.sourceRevision)) {
    throw staleDelegation();
  }

  const reservation = await runIdempotentCommand({ ...idempotency, operation: "todoHandBackClosureReserve", async execute(tx) {
    const row = await tx.todoDelegation.findUnique({ where: { ownerId_todoId: identity } });
    const state = toTodoDelegation(row).state;
    if (!row || (request.number !== undefined && row.number !== request.number) || row.revision !== request.expectedRevision || row.pendingClosure || state !== (undo ? "handed_back" : "waiting_on_owner")) throw staleDelegation();
    const reserved = await tx.todoDelegation.updateMany({
      where: { ...identity, revision: request.expectedRevision, pendingClosure: { equals: Prisma.DbNull } },
      data: { pendingClosure: pending },
    });
    if (reserved.count !== 1) throw staleDelegation();
    return { kind: "success", status: 200, body: { number: row.number, repository: row.repository } };
  } }, db);
  if (reservation.kind === "conflict") throw new TodoDelegationError(409, reservation.message);
  const { number, repository } = reservation.body;
  const finishOperation = "todoHandBackClosureFinish";
  const prior = await db.apiIdempotencyKey.findUnique({ where: { clientId_operation_idempotencyKey: {
    clientId: access.owner.id, operation: finishOperation, idempotencyKey: request.commandId,
  } }, select: { idempotencyKey: true } });

  let source: Todo | null | undefined;
  if (!prior) {
    if (!reader.write) throw new TodoDelegationError(503, "Task completion is temporarily unavailable. Retry this decision.");
    const before = undo ? "completed" : "open";
    const after = undo ? "open" : "completed";
    const result = await reader.write(`${access.owner.id}:hand-back`, {
      number, commandId: request.commandId, closure: { before: { outcome: before }, after: { outcome: after } },
      closureGuard: { todoId: request.todoId, sourceRevision: request.sourceRevision },
    }).catch(() => null);
    if (result?.outcomes.closure === "conflict" || result?.outcomes.closure === "failed" && !result.retryable) {
      await db.todoDelegation.updateMany({ where: { ...identity, revision: request.expectedRevision, pendingClosure: { equals: pending } }, data: { pendingClosure: Prisma.DbNull } });
      throw new TodoDelegationError(409, result.outcomes.closure === "failed" ? "GitHub refused the decision. Review the task before trying again." : "GitHub task changed. Refresh to review its current state.");
    }
    if (result?.outcomes.closure === "saved") source = result.todo ?? await reader.detail(number).catch(() => null);
    if (!source || source.id !== request.todoId || source.repository !== repository || source.trashed ||
      (undo ? source.state !== "open" : source.state !== "closed" || source.closureReason !== "completed")) {
      throw new TodoDelegationError(503, "GitHub completion is unconfirmed. Retry this same decision.");
    }
  }

  const finished = await runIdempotentCommand({ ...idempotency, operation: finishOperation, async execute(tx) {
    if (!source) throw new TodoDelegationError(503, "Decision receipt unavailable. Retry this decision.");
    const where = { ...identity, revision: request.expectedRevision, pendingClosure: { equals: pending } };
    const row = await tx.todoDelegation.findFirst({ where });
    if (!row) throw staleDelegation();
    const before = assignment(row);
    const after = auditToUndo ? assignmentSchema.parse(auditToUndo.before) : { ...before, accepted: true };
    const updated = await tx.todoDelegation.updateMany({ where, data: {
      ...factFields(after), revision: { increment: 1 }, pendingClosure: Prisma.DbNull, ownerEditedAt: new Date(),
    } });
    if (updated.count !== 1) throw staleDelegation();
    const audit = auditToUndo
      ? await tx.agentWriteAudit.update({ where: { id: auditToUndo.id, ownerId: access.owner.id }, data: { undoneAt: new Date() } })
      : await auditTodoDelegation(tx, access, request.todoId, request.expectedRevision, before, after, source.updatedAt);
    const saved = await tx.todoDelegation.findUniqueOrThrow({ where: { ownerId_todoId: identity } });
    return { kind: "success", status: 200, body: {
      auditId: audit.id, delegation: withTodoDelegationActivity(toTodoDelegation(saved), saved, access, undefined, undefined, undo), sourceRevision: source.updatedAt,
    } };
  } }, db);
  if (finished.kind === "conflict") throw new TodoDelegationError(409, finished.message);
  return finished.body;
}
