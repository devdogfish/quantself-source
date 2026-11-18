import type { AccessContext } from "@quantself/auth";
import type { AgentInboxTodo, AgentWriteAudit, Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { runIdempotentCommand } from "./idempotency";
import { JobsError } from "./jobs-error";

export const agentInboxTodoResource = "agentInboxTodo";

export function inboxTodoView({ id, title, note, revision, completedAt, creationAuditId }: AgentInboxTodo) {
  return { id, title, note, revision, completed: completedAt !== null, auditId: revision === 1 ? creationAuditId : null };
}

export async function createAgentInboxTodo(
  db: PrismaClient, access: AccessContext, key: string, input: { title: string; note: string },
) {
  const ownerId = access.owner.id;
  const clientId = access.client.id;
  return runIdempotentCommand({
    operation: "createAgentInboxTodo",
    clientId,
    idempotencyKey: key,
    request: { ownerId, ...input },
    isolationLevel: "ReadCommitted",
    execute: async tx => {
      const id = crypto.randomUUID();
      const audit = await tx.agentWriteAudit.create({
        data: {
          ownerId, clientId, clientName: access.client.name, resourceType: agentInboxTodoResource, resourceId: id,
          revisionBefore: 0, revisionAfter: 1, before: { exists: false }, after: { ...input, commitment: "Inbox" },
        },
        select: { id: true },
      });
      const todo = await tx.agentInboxTodo.create({ data: { ...input, id, ownerId, creationAuditId: audit.id } });
      return { kind: "success", status: 201, body: { todo: inboxTodoView(todo), auditId: audit.id } };
    },
  }, db);
}

export async function undoAgentInboxTodo(tx: Prisma.TransactionClient, audit: AgentWriteAudit) {
  const result = await tx.agentInboxTodo.updateMany({
    where: {
      id: audit.resourceId, ownerId: audit.ownerId, creationAuditId: audit.id,
      revision: audit.revisionAfter, cancelledAt: null,
    },
    data: { cancelledAt: new Date(), revision: { increment: 1 } },
  });
  if (!result.count) throw new JobsError(409, "The To-do changed after creation. Undo is no longer available.");
}
