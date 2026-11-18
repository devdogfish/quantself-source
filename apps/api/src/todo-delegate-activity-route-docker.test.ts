import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { createApp } from "./app";
import { setTodoDelegate } from "./todo-delegation";
import type { Todo } from "./todos-github";

test.skipIf(process.env.TODO_DELEGATE_ACTIVITY_DOCKER_TEST !== "1")(
  "scoped reads and hand-backs track only the observed assignment and never call Bot HQ",
  async () => {
    const connection = new URL(process.env.DATABASE_URL ?? "");
    if (connection.hostname !== "127.0.0.1" || connection.pathname !== "/todo_activity_fixture") throw Error("Use disposable Postgres for this fixture.");
    const owner = { id: crypto.randomUUID(), name: "Owner", email: "owner@example.test" };
    const sam = { id: crypto.randomUUID(), name: "Sam" };
    const stacy = { id: crypto.randomUUID(), name: "Stacy" };
    const web: AccessContext = { owner, client: { kind: "web", id: "fixture-web", name: "Web" }, permissions: ["todos:read", "todos:write"] };
    const access = (key: string | null): AccessContext => key === "sam" || key === "stacy"
      ? { ...web, client: { ...(key === "sam" ? sam : stacy), kind: "agent", avatar: null } }
      : web;
    const makeTodo = (number: number, due: string): Todo => ({ id: `I_${crypto.randomUUID()}`, number, databaseId: number,
      repository: "fixture/tasks", title: `Task ${number}`, url: `https://example.test/tasks/${number}`,
      body: null, state: "open", closureReason: null, updatedAt: "2026-11-14T12:00:00Z", fields: { Due: due }, labels: [],
      fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null });
    const todo = makeTodo(1, "2026-11-14");
    const filtered = makeTodo(2, "2026-11-15");
    const otherAgentTodo = makeTodo(3, "2026-11-14");
    const rows = [todo, filtered, otherAgentTodo];
    const initial = new Date(Date.now() - 172_800_000);
    const botHqUrl = "https://bot-hq.example.test/agents/sam";
    const linksBefore = process.env.QUANTSELF_BOT_HQ_AGENT_LINKS;
    const staleBefore = process.env.QUANTSELF_TODO_DELEGATION_STALE_MINUTES;
    process.env.QUANTSELF_BOT_HQ_AGENT_LINKS = JSON.stringify({ [sam.id]: botHqUrl });
    process.env.QUANTSELF_TODO_DELEGATION_STALE_MINUTES = "1440";
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = Object.assign(async () => { outbound++; throw Error("Unexpected outbound request"); }, { preconnect: originalFetch.preconnect });

    const change = (task: Todo, revision: number, delegate: typeof sam, at = initial) => prisma.$transaction(tx =>
      setTodoDelegate(tx, web, task, { expectedRevision: revision, delegate }, at));
    const stored = (task: Todo) => prisma.todoDelegation.findUniqueOrThrow({ where: { ownerId_todoId: { ownerId: owner.id, todoId: task.id } } });
    let beforeDetailReturns: (() => Promise<void>) | undefined;
    const app = createApp({
      todoDelegation: { db: prisma, directory: async () => [sam, stacy] },
      todos: { list: async () => rows, detail: async number => rows.find(task => task.number === number)!,
        assignedList: async ids => rows.filter(task => ids.includes(task.id)),
        assignedDetail: async number => { await beforeDetailReturns?.(); return rows.find(task => task.number === number)!; },
      },
      emitAccessLog: () => {}, resolveAccessContext: async headers => access(headers.get("x-api-key")),
    });
    const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
    const get = (path: string, key?: string) => app.request(`${origin}/api/v1/${path}`, { headers: key ? { "x-api-key": key } : {} });
    const handBack = { commandId: crypto.randomUUID(), todoId: todo.id, expectedRevision: 1, handBack: { kind: "review", summary: "Complete", links: [] } };
    const sendHandBack = () => app.request(`${origin}/api/v1/todos/1/hand-back`, {
      method: "POST", headers: { "x-api-key": "sam", "content-type": "application/json" }, body: JSON.stringify(handBack),
    });

    try {
      await Promise.all([change(todo, 0, sam), change(filtered, 0, sam), change(otherAgentTodo, 0, stacy)]);
      expect(await (await get("todos/1")).json()).toMatchObject({ todo: { delegation: { activity: { lastActivityAt: null, stale: true, botHqUrl } } } });
      expect((await stored(todo)).lastActivityAt).toBeNull();
      expect((await get("todos/3", "sam")).status).toBe(404);
      const result = await (await get("todos?from=2026-11-14&through=2026-11-14", "sam")).json() as { todos: Todo[] };
      expect(result.todos.map(row => row.number)).toEqual([1]);
      expect(result.todos[0].delegation?.activity).toMatchObject({ lastActivityAt: expect.any(String), stale: false, botHqUrl: null });
      expect((await stored(filtered)).lastActivityAt).toBeNull();
      expect((await stored(otherAgentTodo)).lastActivityAt).toBeNull();

      expect((await sendHandBack()).status).toBe(200);
      const saved = (await stored(todo)).lastActivityAt;
      expect(saved).not.toBeNull();
      const replay = await (await sendHandBack()).json() as { delegation: Todo["delegation"] };
      expect(replay.delegation).toMatchObject({ state: "waiting_on_owner", revision: 2, activity: { lastActivityAt: saved!.toISOString() } });
      expect((await stored(todo)).lastActivityAt).toEqual(saved);

      beforeDetailReturns = async () => {
        beforeDetailReturns = undefined;
        await change(todo, 2, stacy, new Date());
        await change(todo, 3, sam, new Date());
      };
      expect((await get("todos/1", "sam")).status).toBe(200);
      expect(await stored(todo)).toMatchObject({ delegateId: sam.id, revision: 4, lastActivityAt: null });
      expect((await sendHandBack()).status).toBe(200);
      expect((await stored(todo)).lastActivityAt).toBeNull();
      expect(await (await get("todos/1")).json()).toMatchObject({ todo: { delegation: { activity: { lastActivityAt: null, stale: false, botHqUrl } } } });
      expect(outbound).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (linksBefore === undefined) delete process.env.QUANTSELF_BOT_HQ_AGENT_LINKS;
      else process.env.QUANTSELF_BOT_HQ_AGENT_LINKS = linksBefore;
      if (staleBefore === undefined) delete process.env.QUANTSELF_TODO_DELEGATION_STALE_MINUTES;
      else process.env.QUANTSELF_TODO_DELEGATION_STALE_MINUTES = staleBefore;
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: { ownerId: owner.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apiIdempotencyKey.deleteMany({ where: { clientId: { startsWith: `${owner.id}:` } } }),
      ]);
    }
  },
);
