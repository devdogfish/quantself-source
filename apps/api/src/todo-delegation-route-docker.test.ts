import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { createApp } from "./app";
import { type Todo, TodoReadError } from "./todos-github";

const makeTask = (number: number): Todo => ({
  id: `fixture-${number}`, databaseId: number, number, title: `Task ${number}`,
  repository: "fixture/tasks", url: `https://github.com/fixture/tasks/issues/${number}`,
  body: null, state: "open", closureReason: null, updatedAt: "2026-11-14T00:00:00Z",
  labels: [], fields: {}, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null,
});

test.skipIf(process.env.TODO_DELEGATION_DOCKER_TEST !== "1")(
  "delegation API projects Owner assignments, isolates Agent reads, and undoes audited changes",
  async () => {
    const owner = { id: crypto.randomUUID(), name: "Owner", email: "owner@example.com" };
    const sam = { id: crypto.randomUUID(), name: "Sam" };
    const stacy = { id: crypto.randomUUID(), name: "Stacy" };
    const unassigned = makeTask(2);
    const assigned = { ...makeTask(1), children: [unassigned] };
    const rows = [assigned, unassigned];
    const calls: string[] = [];
    let beforeDetailReturns: (() => Promise<void>) | undefined;
    const access = (key: string | null): AccessContext => ({
      owner,
      client: key === "sam" || key === "rotated-sam" ? { kind: "agent", ...sam, avatar: null }
        : key === "stacy" ? { kind: "agent", ...stacy, avatar: null }
        : key === "reader" ? { kind: "api-key", id: key, name: key }
        : { kind: "web", id: "quantself-web", name: "Quantself Web Client" },
      permissions: ["todos:read", "todos:write"],
    });
    function detail(number: number) {
      const todo = rows.find(row => row.number === number);
      if (!todo) throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
      return todo;
    }

    const app = createApp({
      resolveAccessContext: async headers => access(headers.get("x-api-key")),
      emitAccessLog: () => {},
      todoDelegation: { db: prisma, directory: async () => [sam, stacy] },
      todos: {
        list: async () => { calls.push("owner-list"); return rows; },
        detail: async number => { calls.push(`owner:${number}`); return detail(number); },
        assignedList: async ids => { calls.push(`assigned-list:${ids.join(",")}`); return rows.filter(row => ids.includes(row.id)); },
        assignedDetail: async number => { calls.push(`assigned:${number}`); await beforeDetailReturns?.(); return detail(number); },
      },
    });
    const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
    const get = (path: string, key?: string) => app.request(`${origin}/api/v1/${path}`, { headers: key ? { "x-api-key": key } : {} });
    const assign = (expectedRevision: number, delegateId: string | null, key?: string, commandId: string = crypto.randomUUID(), todoId = assigned.id) =>
      app.request(`${origin}/api/v1/todos/1/delegation`, {
        method: "PATCH", headers: { origin, "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
        body: JSON.stringify({ expectedRevision, commandId, todoId, delegateId }),
      });
    const undo = (id: string) => app.request(`${origin}/api/v1/agent-audit/${id}/undo`, { method: "POST", headers: { origin } });

    try {
      expect(await (await get("todo-delegates")).json()).toEqual({ agents: [sam, stacy] });
      expect((await assign(0, sam.id, "sam")).status).toBe(403);
      expect((await assign(0, sam.id, "reader")).status).toBe(403);
      expect((await assign(0, sam.id, undefined, undefined, "old-task-id")).status).toBe(404);
      const commandId = crypto.randomUUID();
      const response = await assign(0, sam.id, undefined, commandId);
      expect(response.status).toBe(200);
      const saved = await response.json() as { auditId: string; delegation: Todo["delegation"] };
      expect(saved.delegation).toMatchObject({ delegate: sam, revision: 1, state: "working", activity: { lastActivityAt: null, stale: false } });
      expect(await (await assign(0, sam.id, undefined, commandId)).json()).toEqual(saved);
      expect((await assign(0, stacy.id, undefined, commandId)).status).toBe(409);
      expect((await assign(0, stacy.id)).status).toBe(409);

      expect(await (await get("todos")).json()).toMatchObject({ todos: [
        { id: assigned.id, children: [{ id: unassigned.id }], delegation: saved.delegation },
        { id: unassigned.id, delegation: { delegate: null, revision: 0, state: null } },
      ] });
      expect(await (await get("todos/1")).json()).toMatchObject({ todo: { delegation: saved.delegation } });

      calls.length = 0;
      const mine = await (await get("todos?includeCategories=true", "rotated-sam")).json() as { todos: Todo[]; categories?: unknown };
      expect(mine.todos.map(todo => todo.id)).toEqual([assigned.id]);
      expect(mine.todos[0].children).toBeUndefined();
      expect(mine.categories).toBeUndefined();
      expect(await (await get("todos", "stacy")).json()).toMatchObject({ todos: [] });
      expect((await get("todos/2", "sam")).status).toBe(404);
      expect((await get("todos/1", "stacy")).status).toBe(404);
      expect(calls).toEqual([`assigned-list:${assigned.id}`]);
      const assignedDetail = await (await get("todos/1", "sam")).json() as { todo: Todo };
      expect(assignedDetail.todo.id).toBe(assigned.id);
      expect(assignedDetail.todo.children).toBeUndefined();
      for (const path of ["todos/live", "todo-captures", "todo-categories", "todo-delegates", "jarvis/conversations", "phone-jarvis/calls"]) {
        expect((await get(path, "sam")).status).toBe(403);
      }
      const review = (number: number, key: string) => app.request(`${origin}/api/v1/todo-suggestions/review`, {
        method: "POST", headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ number, reason: "Adjust the estimate", revision: assigned.updatedAt,
          command: { commandId: crypto.randomUUID(), fields: { Estimate: { before: null, after: 45 } } } }),
      });
      expect((await review(1, "sam")).status).toBe(200);
      expect((await review(2, "sam")).status).toBe(404);
      expect((await review(1, "stacy")).status).toBe(404);

      beforeDetailReturns = async () => {
        beforeDetailReturns = undefined;
        expect((await assign(1, null)).status).toBe(200);
      };
      expect((await get("todos/1", "sam")).status).toBe(404);
      expect((await undo(saved.auditId)).status).toBe(409);
      const removal = await prisma.agentWriteAudit.findFirstOrThrow({ where: { ownerId: owner.id, revisionAfter: 2 } });
      const undone = await Promise.all([undo(removal.id), undo(removal.id)]);
      expect(undone.map(result => result.status)).toEqual([200, 200]);
      expect(await undone[0].json()).toEqual(await undone[1].json());
      expect(await (await get("todos/1", "sam")).json()).toMatchObject({ todo: { delegation: { delegate: sam, revision: 3, state: "working" } } });
    } finally {
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: { ownerId: owner.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apiIdempotencyKey.deleteMany({ where: { clientId: owner.id } }),
      ]);
    }
  },
);
