import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { recordTodoDelegateActivity } from "./todo-delegate-activity";
import { setTodoDelegate, undoTodoDelegation } from "./todo-delegation";

test.skipIf(process.env.TODO_DELEGATE_ACTIVITY_DOCKER_TEST !== "1")(
  "records read and write activity for exact assignments, preserving revision and clearing it on reassignment or undo",
  async () => {
    const connection = new URL(process.env.DATABASE_URL ?? "");
    if (connection.protocol !== "postgresql:" || connection.hostname !== "127.0.0.1" || !connection.port ||
        connection.pathname !== "/todo_activity_fixture") {
      throw new Error("Use the disposable Docker database named todo_activity_fixture.");
    }
    const { prisma } = await import("@quantself/db");
    const owner = { id: crypto.randomUUID(), name: "Fixture Owner", email: "owner@example.test" };
    const other = { ...owner, id: crypto.randomUUID() };
    const web: AccessContext = { owner, client: { kind: "web", id: "fixture-web", name: "Web" }, permissions: ["todos:read", "todos:write"] };
    const sam = { id: "fixture-sam", name: "Sam" };
    const stacy = { id: "fixture-stacy", name: "Stacy" };
    const agent = (delegate: typeof sam, owning = owner): AccessContext =>
      ({ owner: owning, client: { ...delegate, kind: "agent", avatar: null }, permissions: ["todos:read", "todos:write"] });
    const todo = { id: "fixture-todo-1", repository: "fixture/todos", number: 1 };
    const another = { ...todo, id: "fixture-todo-2", number: 2 };
    const more = { ...todo, id: "fixture-todo-3", number: 3 };
    const at = (minute: number) => new Date(`2026-11-14T12:${String(minute).padStart(2, "0")}:00Z`);
    const change = (target: typeof todo, expectedRevision: number, delegate: typeof sam | null, minute: number, access = web) =>
      prisma.$transaction(tx => setTodoDelegate(tx, access, target, { expectedRevision, delegate }, at(minute)));
    const read = (target: typeof todo, ownerId = owner.id) =>
      prisma.todoDelegation.findUniqueOrThrow({ where: { ownerId_todoId: { ownerId, todoId: target.id } } });
    const observed = (target: typeof todo, revision = 1) => ({ todoId: target.id, revision });

    try {
      await Promise.all([
        change(todo, 0, sam, 0), change(another, 0, stacy, 0), change(more, 0, sam, 0),
        change(todo, 0, sam, 0, { ...web, owner: other }),
      ]);
      expect(await read(todo)).toMatchObject({ assignedAt: at(0), revision: 1, lastActivityAt: null });
      expect(await recordTodoDelegateActivity(prisma, agent(sam), "read", [observed(todo), observed(another), observed(more)], at(5))).toBe(2);
      expect(await read(todo)).toMatchObject({ revision: 1, lastActivityAt: at(5) });
      expect(await read(more)).toMatchObject({ revision: 1, lastActivityAt: at(5) });
      expect(await read(another)).toMatchObject({ lastActivityAt: null });
      expect(await read(todo, other.id)).toMatchObject({ lastActivityAt: null });

      await Promise.all([
        recordTodoDelegateActivity(prisma, agent(sam), "write", [observed(todo)], at(8)),
        recordTodoDelegateActivity(prisma, agent(sam), "read", [observed(todo)], at(7)),
      ]);
      expect(await read(todo)).toMatchObject({ revision: 1, lastActivityAt: at(8) });
      await expect(prisma.$transaction(async tx => {
        expect(await recordTodoDelegateActivity(tx, agent(sam), "write", [observed(todo)], at(9))).toBe(1);
        throw new Error("Rollback Agent write");
      })).rejects.toThrow("Rollback Agent write");
      expect(await read(todo)).toMatchObject({ lastActivityAt: at(8) });

      await change(todo, 1, { ...sam, name: "Sam renamed" }, 10);
      expect(await read(todo)).toMatchObject({ revision: 2, assignedAt: at(0), lastActivityAt: at(8) });
      const reassigned = await change(todo, 2, stacy, 11);
      expect(await read(todo)).toMatchObject({ revision: 3, delegateId: stacy.id, assignedAt: at(11), lastActivityAt: null });
      expect(await recordTodoDelegateActivity(prisma, agent(sam), "read", [observed(todo, 2)], at(12))).toBe(0);
      expect(await recordTodoDelegateActivity(prisma, agent(stacy), "write", [observed(todo, 3)], at(12))).toBe(1);
      await prisma.$transaction(async tx => {
        const audit = await tx.agentWriteAudit.findUniqueOrThrow({ where: { id: reassigned.auditId! } });
        await undoTodoDelegation(tx, audit, at(13));
      });
      expect(await read(todo)).toMatchObject({ revision: 4, delegateId: sam.id, assignedAt: at(13), lastActivityAt: null });
      expect(await recordTodoDelegateActivity(prisma, agent(sam), "read", [observed(todo, 1), observed(todo, 2)], at(14))).toBe(0);
      expect(await recordTodoDelegateActivity(prisma, agent(sam), "read", [observed(todo, 4)], at(14))).toBe(1);
      await change(todo, 4, null, 15);
      expect(await read(todo)).toMatchObject({ revision: 5, delegateId: null, assignedAt: null, lastActivityAt: null });
    } finally {
      const scoped = { ownerId: { in: [owner.id, other.id] } };
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: scoped }),
        prisma.agentWriteAudit.deleteMany({ where: scoped }),
      ]);
      await prisma.$disconnect();
    }
  },
);
