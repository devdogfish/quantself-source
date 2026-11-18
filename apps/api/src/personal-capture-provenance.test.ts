import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import type { AgentWriteAudit, PrismaClient } from "@quantself/db/generated/prisma/client";
import { createTodoDelegationReads } from "./todo-delegation-route";
import { setTodoDelegate, undoTodoDelegation } from "./todo-delegation";
import type { Todo, TodoReader } from "./todos-github";

const owner = { id: "owner", email: "owner@example.invalid", name: "Owner" };
const sam = { id: "sam", name: "Sam" };
const web: AccessContext = { owner, client: { id: "web", name: "Owner", kind: "web" }, permissions: ["todos:read", "todos:write"] };
const agent: AccessContext = { owner, client: { ...sam, kind: "agent", avatar: null }, permissions: ["todos:read"] };
const integration: AccessContext = { owner, client: { id: "ordinary-api-key", name: "Integration", kind: "api-key" }, permissions: ["todos:read"] };
const auditId = "5d72f10e-99cc-4d46-8bf8-d09f420ba453";
const sourceStamp = `Source: Personal Gmail\nCaptured: 2026-11-17T11:00:00Z\nCommand ID: ${auditId}\n<!-- quantself:command ${"a".repeat(64)} -->`;

function task(id: string, number: number, body: string | null = null): Todo {
  return { id, number, repository: "private/tasks", body, title: id, state: "open" } as Todo;
}

const draftCapture = task("stamped-private-capture", 1, sourceStamp);
const editedCapture = task("audited-private-capture", 2, "The managed source stamp was removed.");
const ordinary = task("ordinary", 3);

function fixture() {
  const auditReads: string[][] = [];
  const touches: string[][] = [];
  const tasks = [draftCapture, editedCapture, ordinary];
  // Simulate stale assignments, including one made before the capture audit committed.
  const assignments = tasks.map(todo => ({ ownerId: owner.id, todoId: todo.id, delegateId: sam.id, delegateName: sam.name,
    repository: todo.repository, number: todo.number, revision: 1, assignedAt: null, lastActivityAt: null }));
  const db = {
    agentWriteAudit: {
      findMany: async ({ where }: { where: { ownerId: string; resourceType: string; resourceId: { in: string[] } } }) => {
        expect(where.ownerId).toBe(owner.id);
        expect(where.resourceType).toBe("personalAssistantCapture");
        auditReads.push(where.resourceId.in);
        return where.resourceId.in.includes(editedCapture.id) ? [{ resourceId: editedCapture.id }] : [];
      },
    },
    todoDelegation: {
      findMany: async ({ where }: { where: { delegateId?: string; number?: number; todoId?: { in: string[] } } }) =>
        assignments.filter(row => (!where.delegateId || where.delegateId === row.delegateId) &&
          (!where.number || where.number === row.number) && (!where.todoId || where.todoId.in.includes(row.todoId))),
      findUnique: async ({ where }: { where: { ownerId_todoId: { todoId: string } } }) =>
        assignments.find(row => row.todoId === where.ownerId_todoId.todoId),
      updateMany: async ({ where }: { where: { OR: { todoId: string }[] } }) => {
        touches.push(where.OR.map(row => row.todoId));
        return { count: where.OR.length };
      },
    },
  } as unknown as PrismaClient;
  const reader: TodoReader = {
    list: async () => tasks,
    detail: async number => tasks.find(todo => todo.number === number)!,
    assignedList: async ids => tasks.filter(todo => ids.includes(todo.id)),
    assignedDetail: async number => tasks.find(todo => todo.number === number)!,
  };
  return { db, reader, auditReads, touches };
}

test("Owner delegation rejects both in-flight Gmail captures and durable captures whose stamp was removed", async () => {
  const { db, auditReads, touches } = fixture();
  for (const todo of [draftCapture, editedCapture]) {
    await expect(setTodoDelegate(db, web, todo, { expectedRevision: 1, delegate: sam })).rejects.toMatchObject({ status: 403 });
  }
  expect(auditReads).toEqual([[editedCapture.id]]);
  await expect(setTodoDelegate(db, web, ordinary, { expectedRevision: 1, delegate: sam })).resolves.toMatchObject({ delegation: { delegate: sam } });
  const undoAssignment: AgentWriteAudit = {
    id: auditId, clientId: web.client.id, clientName: web.client.name, revisionBefore: 1, revisionAfter: 2,
    resourceType: "todoDelegation", resourceId: editedCapture.id, ownerId: owner.id, before: { delegate: sam },
    after: { delegate: null }, createdAt: new Date("2026-11-17T11:00:00Z"), undoneAt: null,
  };
  await expect(undoTodoDelegation(db, undoAssignment)).rejects.toMatchObject({ status: 403 });
  expect(touches).toEqual([]);
});

test("stale assignments expose no Gmail captures through the Agent list, detail or projection", async () => {
  const { db, reader, auditReads, touches } = fixture();
  const reads = createTodoDelegationReads(db);
  const visible = await reads.listAssigned(agent, reader, () => true);
  expect(visible.map(todo => todo.id)).toEqual([ordinary.id]);
  expect(auditReads).toEqual([[editedCapture.id, ordinary.id]]);
  expect(touches).toEqual([[ordinary.id]]);
  await expect(reads.readAssigned(agent, reader, draftCapture.number, true)).rejects.toMatchObject({ code: "TODO_NOT_FOUND" });
  await expect(reads.readAssigned(agent, reader, editedCapture.number, true)).rejects.toMatchObject({ code: "TODO_NOT_FOUND" });
  expect(auditReads).toEqual([[editedCapture.id, ordinary.id], [editedCapture.id]]);
  expect(touches).toEqual([[ordinary.id]]);
  expect(await reads.project(agent, [editedCapture])).toEqual([]);
  expect((await reads.project(integration, [draftCapture, editedCapture, ordinary])).map(todo => todo.id)).toEqual([ordinary.id]);
  const beforeOwnerRead = auditReads.length;
  const projected = await reads.project(web, [draftCapture, editedCapture, ordinary]);
  expect(projected.map(todo => todo.id)).toEqual([draftCapture.id, editedCapture.id, ordinary.id]);
  expect(auditReads).toHaveLength(beforeOwnerRead);
});
