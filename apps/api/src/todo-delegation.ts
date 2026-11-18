import { z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { Prisma, type AgentWriteAudit, type TodoDelegation } from "@quantself/db/generated/prisma/client";
import { todoHandBackSchema, todoOwnerReplySchema, type TodoHandBack, type TodoOwnerReply } from "./todo-handback-contract";
import { recordTodoDelegateActivity, toTodoDelegateActivity, todoDelegateActivitySchema, type TodoDelegateActivityConfig } from "./todo-delegate-activity";
import { personalCaptureResourceIds } from "./personal-capture-provenance";

export const todoDelegateSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const assignmentSchema = z.object({
  delegate: todoDelegateSchema.nullable(),
  handBack: todoHandBackSchema.optional(),
  ownerReply: todoOwnerReplySchema.optional(),
  accepted: z.boolean().optional(),
});
export const todoDelegationSchema = assignmentSchema.extend({
  revision: z.number().int().nonnegative(),
  state: z.enum(["working", "waiting_on_owner", "handed_back"]).nullable(),
  activity: todoDelegateActivitySchema.optional(),
  pendingDecision: z.object({ commandId: z.uuid(), kind: z.enum(["accept", "undo_accept"]), sourceRevision: z.string(), auditId: z.uuid().nullable() }).optional(),
}).omit({ accepted: true }).openapi("TodoDelegation");

type Delegate = z.infer<typeof todoDelegateSchema>;
type Delegation = z.infer<typeof todoDelegationSchema>;
type Transaction = Prisma.TransactionClient;
export type TodoReference = { id: string; repository: string; number: number };
type DelegationFields = Pick<TodoDelegation, "delegateId" | "delegateName" | "revision"> & Partial<Pick<TodoDelegation, "handBack" | "ownerReply" | "accepted" | "pendingClosure">>;
type Assignment = z.infer<typeof assignmentSchema>;

export const todoDelegationResource = "todoDelegation";

export class TodoDelegationError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

export const staleDelegation = () => new TodoDelegationError(409, "This delegation changed. Refresh to review the latest assignment.");

export function assignment(row?: DelegationFields | null): Assignment {
  const handBack = todoHandBackSchema.safeParse(row?.handBack);
  const ownerReply = todoOwnerReplySchema.safeParse(row?.ownerReply);
  return {
    delegate: row?.delegateId != null && row.delegateName != null ? { id: row.delegateId, name: row.delegateName } : null,
    ...(handBack.success && { handBack: handBack.data }),
    ...(ownerReply.success && { ownerReply: ownerReply.data }),
    ...(row?.accepted && { accepted: true }),
  };
}

export function toTodoDelegation(row?: DelegationFields | null, owner = true): Delegation {
  const { accepted, ...facts } = assignment(row);
  const state = !facts.delegate ? null : accepted ? "handed_back" : facts.handBack ? "waiting_on_owner" : "working";
  const pending = owner && todoDelegationSchema.shape.pendingDecision.safeParse(row?.pendingClosure);
  return { ...facts, state, revision: row?.revision ?? 0, ...(pending && pending.success && pending.data && { pendingDecision: pending.data }) };
}

type ActivityFields = Pick<TodoDelegation, "ownerId" | "delegateId" | "assignedAt" | "lastActivityAt">;
export function withTodoDelegationActivity(delegation: Delegation, row: ActivityFields | undefined | null,
  access: AccessContext, config?: TodoDelegateActivityConfig, now?: Date, open = true): Delegation {
  const activity = toTodoDelegateActivity(row, access, open && delegation.state === "working", config, now);
  return activity ? { ...delegation, activity } : delegation;
}

function delegateFields(delegate: Delegate | null) {
  return { delegateId: delegate?.id ?? null, delegateName: delegate?.name ?? null };
}

export function factFields(next: Assignment) {
  return { ...delegateFields(next.delegate), handBack: next.handBack ?? Prisma.DbNull, ownerReply: next.ownerReply ?? Prisma.DbNull, accepted: next.accepted ?? false };
}

export function todoAcceptanceSourceRevision(audit: AgentWriteAudit) {
  const prior = assignmentSchema.safeParse(audit.before);
  const next = assignmentSchema.extend({ sourceRevision: z.string().min(1) }).safeParse(audit.after);
  return audit.resourceType === todoDelegationResource && prior.success && !prior.data.accepted && next.success && next.data.accepted
    ? next.data.sourceRevision : null;
}

export async function auditTodoDelegation(tx: Transaction, access: AccessContext, todoId: string, revision: number, before: Assignment, after: Assignment, sourceRevision?: string) {
  return tx.agentWriteAudit.create({ data: {
    ownerId: access.owner.id,
    clientId: access.client.id,
    clientName: access.client.name,
    resourceType: todoDelegationResource,
    resourceId: todoId,
    revisionBefore: revision,
    revisionAfter: revision + 1,
    before,
    after: { ...after, ...(sourceRevision && { sourceRevision }) },
  }, select: { id: true } });
}

export async function setTodoDelegate(
  tx: Transaction,
  access: AccessContext,
  todo: TodoReference & { body?: string | null },
  input: { expectedRevision: number; delegate: Delegate | null },
  now = new Date(),
) {
  if (access.client.kind !== "web") {
    throw new TodoDelegationError(403, "An Owner Session is required.");
  }
  if (input.delegate && (await personalCaptureResourceIds(tx, access.owner.id, [todo])).has(todo.id)) {
    throw new TodoDelegationError(403, "Personal Gmail captures cannot be delegated.");
  }

  const identity = { ownerId: access.owner.id, todoId: todo.id };
  const current = await tx.todoDelegation.findUnique({ where: { ownerId_todoId: identity } });
  const prior = toTodoDelegation(current);
  if (prior.revision !== input.expectedRevision || current?.pendingClosure) throw staleDelegation();
  if (prior.delegate?.id === input.delegate?.id && prior.delegate?.name === input.delegate?.name) {
    return { delegation: withTodoDelegationActivity(prior, current, access, undefined, now), auditId: null };
  }

  const revision = prior.revision + 1;
  const changed = prior.delegate?.id !== input.delegate?.id;
  const activity = changed ? { assignedAt: input.delegate ? now : null, lastActivityAt: null } : {};
  const next = { ...(changed ? {} : assignment(current)), delegate: input.delegate };
  const values = { ...factFields(next), ...activity, revision, repository: todo.repository, number: todo.number, ownerEditedAt: now };
  const saved = current
    ? await tx.todoDelegation.updateMany({ where: { ...identity, revision: prior.revision, pendingClosure: { equals: Prisma.DbNull } }, data: values })
    : await tx.todoDelegation.createMany({ data: { ...identity, ...values }, skipDuplicates: true });
  if (saved.count !== 1) throw staleDelegation();

  const audit = await auditTodoDelegation(tx, access, todo.id, prior.revision, assignment(current), next);
  const fields = { ...delegateFields(input.delegate), revision, handBack: next.handBack ?? null, ownerReply: next.ownerReply ?? null, accepted: next.accepted };
  const dates = { assignedAt: current?.assignedAt ?? null, lastActivityAt: current?.lastActivityAt ?? null, ...activity };
  return { delegation: withTodoDelegationActivity(toTodoDelegation(fields), { ownerId: access.owner.id, ...fields, ...dates }, access, undefined, now), auditId: audit.id };
}

export async function mutateTodoHandBack(tx: Transaction, access: AccessContext, todo: TodoReference, revision: number,
  action: { handBack: TodoHandBack } | { reply: TodoOwnerReply }, observedAt = new Date()) {
  const identity = { ownerId: access.owner.id, todoId: todo.id };
  const row = await tx.todoDelegation.findUnique({ where: { ownerId_todoId: identity } });
  const current = toTodoDelegation(row);
  const byAgent = "handBack" in action;
  if (byAgent ? access.client.kind !== "agent" : access.client.kind !== "web") throw new TodoDelegationError(403, "This Client cannot take that action.");
  if (!row?.delegateId || (byAgent && row.delegateId !== access.client.id)) throw new TodoDelegationError(404, "Task not found.");
  if (row.revision !== revision || row.pendingClosure || current.state !== (byAgent ? "working" : "waiting_on_owner")) throw staleDelegation();
  if (byAgent && row.ownerEditedAt && Date.now() - row.ownerEditedAt.getTime() < 180_000) {
    throw new TodoDelegationError(409, "The Owner edited this delegation in the last three minutes. Refresh before trying again.");
  }
  if (!byAgent && action.reply.kind === "choice" && (current.handBack?.kind !== "question" || !current.handBack.choices?.includes(action.reply.choice))) {
    throw new TodoDelegationError(409, "Choose an answer from the current hand-back.");
  }
  const before = assignment(row);
  const after: Assignment = { delegate: before.delegate, ...(byAgent ? { handBack: action.handBack } : { ownerReply: action.reply }) };
  const saved = await tx.todoDelegation.updateMany({ where: { ...identity, revision, pendingClosure: { equals: Prisma.DbNull } }, data: {
    ...factFields(after), revision: { increment: 1 }, ...(!byAgent && { ownerEditedAt: new Date() }),
  } });
  if (saved.count !== 1) throw staleDelegation();
  const touched = byAgent && await recordTodoDelegateActivity(tx, access, "write", [{ todoId: todo.id, revision: revision + 1 }], observedAt);
  const audit = await auditTodoDelegation(tx, access, todo.id, revision, before, after);
  const next = { ...row, ...factFields(after), handBack: after.handBack ?? null, ownerReply: after.ownerReply ?? null, revision: revision + 1,
    lastActivityAt: touched ? observedAt : row.lastActivityAt };
  return { delegation: withTodoDelegationActivity(toTodoDelegation(next, !byAgent), next, access), auditId: audit.id };
}

export async function undoTodoDelegation(tx: Transaction, audit: AgentWriteAudit, now = new Date()) {
  const before = assignmentSchema.safeParse(audit.before);
  const after = assignmentSchema.safeParse(audit.after);
  if (audit.resourceType !== todoDelegationResource || audit.undoneAt || !before.success || !after.success || after.data.accepted && !before.data.accepted) {
    throw new TodoDelegationError(409, "Undo is unavailable for this entry.");
  }
  if (before.data.delegate && (await personalCaptureResourceIds(tx, audit.ownerId, [{ id: audit.resourceId }])).has(audit.resourceId)) {
    throw new TodoDelegationError(403, "Personal Gmail captures cannot be delegated.");
  }

  const activity = before.data.delegate?.id !== after.data.delegate?.id
    ? { assignedAt: before.data.delegate ? now : null, lastActivityAt: null }
    : {};
  const restored = await tx.todoDelegation.updateMany({
    where: {
      ownerId: audit.ownerId,
      todoId: audit.resourceId,
      revision: audit.revisionAfter,
      ...delegateFields(after.data.delegate), pendingClosure: { equals: Prisma.DbNull },
    },
    data: { ...factFields(before.data), ...activity, revision: { increment: 1 }, ownerEditedAt: now },
  });
  if (restored.count !== 1) throw staleDelegation();
}
