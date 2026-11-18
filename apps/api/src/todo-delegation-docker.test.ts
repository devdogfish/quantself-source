import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { setTodoDelegate, toTodoDelegation, undoTodoDelegation } from "./todo-delegation";

test.skipIf(process.env.TODO_DELEGATION_DOCKER_TEST !== "1")(
  "delegation is Owner-only, revisioned, audited, and conditionally undoable",
  async () => {
    const owner = { id: crypto.randomUUID(), name: "Owner", email: "owner@example.com" };
    const access: AccessContext = {
      owner,
      client: { id: "quantself-web", kind: "web", name: "Quantself Web Client" },
      permissions: ["todos:write"],
    };
    const sam = { id: crypto.randomUUID(), name: "Sam" };
    const stacy = { id: crypto.randomUUID(), name: "Stacy" };
    const todo = { id: "issue-node-1", repository: "owner/tasks", number: 1 };
    const identity = { ownerId: owner.id, todoId: todo.id };
    const read = async () => toTodoDelegation(await prisma.todoDelegation.findUnique({
      where: { ownerId_todoId: identity },
    }));
    const change = (expectedRevision: number, delegate: { id: string; name: string } | null, caller = access) =>
      prisma.$transaction(tx => setTodoDelegate(tx, caller, todo, { expectedRevision, delegate }));

    try {
      expect(await read()).toEqual({ delegate: null, revision: 0, state: null });
      await expect(change(0, sam, {
        ...access, client: { ...sam, avatar: null, kind: "agent" },
      })).rejects.toMatchObject({ status: 403 });

      const concurrent = await Promise.allSettled([change(0, sam), change(0, stacy)]);
      const committed = concurrent.find(result => result.status === "fulfilled");
      expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
      if (!committed) throw new Error("No delegation committed");
      const { delegation, auditId } = committed.value;
      expect(delegation).toMatchObject({ revision: 1, state: "working" });
      expect(await read()).toEqual(delegation);

      const audit = await prisma.agentWriteAudit.findUniqueOrThrow({ where: { id: auditId! } });
      expect(audit).toMatchObject({
        ownerId: owner.id, resourceId: todo.id,
        clientId: access.client.id, revisionBefore: 0, revisionAfter: 1,
        before: { delegate: null }, after: { delegate: delegation.delegate },
      });
      expect((await change(1, delegation.delegate)).auditId).toBeNull();

      // An exception after the write must roll back both the state and audit.
      await expect(prisma.$transaction(async tx => {
        await setTodoDelegate(tx, access, todo, { expectedRevision: 1, delegate: null });
        throw new Error("Abort fixture transaction");
      })).rejects.toThrow("Abort fixture transaction");
      expect(await read()).toEqual(delegation);
      expect(await prisma.agentWriteAudit.count({ where: { ownerId: owner.id } })).toBe(1);

      const removed = await change(1, null);
      expect(removed.delegation).toEqual({ delegate: null, revision: 2, state: null });
      await expect(prisma.$transaction(tx => undoTodoDelegation(tx, audit))).rejects.toMatchObject({ status: 409 });
      await prisma.$transaction(async tx => {
        const removal = await tx.agentWriteAudit.findUniqueOrThrow({ where: { id: removed.auditId! } });
        await undoTodoDelegation(tx, removal);
        await tx.agentWriteAudit.update({ where: { id: removal.id }, data: { undoneAt: new Date() } });
      });
      expect(await read()).toEqual({ ...delegation, revision: 3 });
      await expect(change(2, null)).rejects.toMatchObject({ status: 409 });
    } finally {
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: { ownerId: owner.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
      ]);
    }
  },
);
