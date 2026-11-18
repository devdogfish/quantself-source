import { expect, test } from "bun:test";
import { createApp } from "./app";
import { TodoReadError, type TodoReader, type Todo } from "./todos-github";

const access = {
  owner: { id: "owner", email: "owner@example.com", name: "Owner" },
  client: { id: "reader", name: "Reader", kind: "api-key" as const },
  permissions: ["todos:read"],
};
test("public list/detail enforce Owner and independent Client read permissions before GitHub", async () => {
  let calls = 0;
  const todos: TodoReader = {
    list: async () => {
      calls++;
      return [];
    },
    detail: async () => {
      calls++;
      throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
    },
  };
  for (const [context, status] of [
    [null, 401],
    [
      {
        ...access,
        permissions: [
          "inventory:read",
          "todos:write",
          "todos:approve",
          "todos:delete",
        ],
      },
      403,
    ],
    [access, 200],
    [{ ...access, client: { ...access.client, kind: "web" as const } }, 200],
  ] as const) {
    const app = createApp({
      todos,
      emitAccessLog: () => {},
      resolveAccessContext: async () =>
        context && { ...context, permissions: [...context.permissions] },
    });
    expect((await app.request("/api/v1/todos")).status).toBe(status);
    expect((await app.request("/api/v1/todos/1")).status).toBe(
      status === 200 ? 404 : status,
    );
  }
  expect(calls).toBe(4);
});

test("public responses distinguish field mismatch, outage, recovery and invalid identity", async () => {
  let error: TodoReadError | null = new TodoReadError(
    "TODO_CONFIGURATION_ERROR",
    "Canonical organization field mismatch: Rank.",
  );
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => access,
    todos: {
      list: async () => {
        if (error) throw error;
        return [];
      },
      detail: async () => {
        throw Error("must not reach GitHub");
      },
    },
  });
  expect((await app.request("/api/v1/todos")).status).toBe(503);
  error = new TodoReadError("TODO_UNAVAILABLE", "GitHub unavailable.", 30);
  const response = await app.request("/api/v1/todos");
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("30");
  expect(await response.json()).toMatchObject({
    code: "TODO_UNAVAILABLE",
    retryAfter: 30,
  });
  error = null;
  expect(await (await app.request("/api/v1/todos")).json()).toMatchObject({
    todos: [],
  });
  expect((await app.request("/api/v1/todos/nope")).status).toBe(400);
});

test("create and partial edit require todos:write and expose explicit save outcomes", async () => {
  let calls = 0;
  const todos: TodoReader = {
    list: async () => [],
    detail: async () => {
      throw Error();
    },
    write: async (_client, command) => {
      calls++;
      return {
        commandId: command.commandId,
        todo: null,
        outcomes: { issue: "saved", project: "failed" },
        message: "Task saved; Project sync failed.",
        retryable: true,
      };
    },
  };
  for (const permissions of [["todos:read"], ["todos:write"]]) {
    const app = createApp({
      todos,
      emitAccessLog: () => {},
      resolveAccessContext: async () => ({ ...access, permissions }),
    });
    const response = await app.request("/api/v1/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        title: "Minimal capture",
      }),
    });
    expect(response.status).toBe(
      permissions.includes("todos:write") ? 200 : 403,
    );
    const edit = await app.request("/api/v1/todos/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        title: { before: "Old", after: "New" },
      }),
    });
    expect(edit.status).toBe(permissions.includes("todos:write") ? 200 : 403);
    if (response.status === 200)
      expect(await response.json()).toMatchObject({
        outcomes: { issue: "saved", project: "failed" },
      });
  }
  expect(calls).toBe(2);
});

test("a scoped Agent cannot edit a GitHub task even with a revision", async () => {
  let calls = 0;
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      ...access,
      client: { id: "agent", name: "Agent", avatar: null, kind: "agent" as const },
      permissions: ["todos:write"],
    }),
    todos: {
      list: async () => [],
      detail: async () => {
        throw new Error("Unexpected task read");
      },
      write: async (_client, command) => {
        calls++;
        return {
          commandId: command.commandId,
          todo: null,
          outcomes: { issue: "saved" },
          message: "Task saved.",
          retryable: false,
        };
      },
    },
  });
  const response = await app.request("/api/v1/todos/1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-api-key": "test-agent-key" },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      revision: "2026-11-13T17:00:00Z",
      title: { before: "Before", after: "After" },
    }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringContaining("Undo"),
  });
  expect(calls).toBe(0);
});

test("suggestion review reads task data without writes and rejects activation or fixed appointment changes", async () => {
  let writes = 0;
  const todo: Todo = {
    id: "I_1",
    databaseId: 1,
    repository: "tasks/private",
    number: 1,
    url: "https://example.com/1",
    title: "Important blocked work",
    body: "Waiting for client",
    state: "open" as const,
    closureReason: null,
    updatedAt: "revision-1",
    labels: [],
    fields: {
      Commitment: "Someday" as const,
      Estimate: 30,
      "Cost of waiting": "High" as const,
    },
    fieldValues: [],
    start: null, end: null, allDay: false, fixed: false,
    scheduleError: null,
  };
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      ...access,
      client: { id: "reader", name: "Reader", kind: "api-key" as const },
    }),
    todos: {
      list: async () => [todo],
      detail: async () => todo,
      write: async () => {
        writes++;
        throw Error("Must not write");
      },
    },
  });
  const proposal = {
    number: 1,
    reason: "Enables the client commitment",
    revision: "revision-1",
    command: {
      commandId: crypto.randomUUID(),
      fields: { Estimate: { before: 30, after: 45 } },
    },
  };
  const review = (value: unknown) =>
    app.request("/api/v1/todo-suggestions/review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-reader-key" },
      body: JSON.stringify(value),
    });
  expect((await review(proposal)).status).toBe(200);
  expect(
    await (await review({ ...proposal, revision: "old" })).json(),
  ).toMatchObject({ stale: true });
  expect(
    (
      await review({
        ...proposal,
        command: {
          ...proposal.command,
          fields: { Commitment: { before: "Someday", after: "Active" } },
        },
      })
    ).status,
  ).toBe(400);
  Object.assign(todo, { start: "2026-10-27T09:30:00-03:00", end: "2026-10-27T10:00:00-03:00", fixed: true });
  for (const fixed of [false, true]) expect((await review({ ...proposal, command: { commandId: crypto.randomUUID(), revision: todo.updatedAt, start: todo.start, end: "2026-10-27T10:30:00-03:00", fixed } })).status).toBe(400);
  expect(writes).toBe(0);
});

test("API list emits the generation captured with its rows despite an intervening publication", async () => {
  const { createTodoFreshness } = await import("./todos-freshness");
  const { memoryTodoCache } = await import("./todos-freshness-store");
  const original = { id: "I1", number: 1, title: "Before", fields: {}, state: "open", updatedAt: "2026-10-28T00:00:00Z" } as Todo;
  let upstreamReads = 0;
  const cache = createTodoFreshness({ list: async () => { upstreamReads++; return [original]; }, detail: async () => original }, memoryTodoCache());
  let interleave = true;
  const app = createApp({
    emitAccessLog: () => {}, resolveAccessContext: async () => access,
    todos: { ...cache.reader, list: async () => {
      const rows = await cache.reader.list();
      if (interleave) { interleave = false; await cache.record({ ...original, title: "After" }); }
      return rows;
    } },
  });
  try {
    const first = await app.request("/api/v1/todos");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ todos: [{ title: "Before" }], generation: 1, stale: false });
    expect((await cache.status()).generation).toBe(2);
    const next = await app.request("/api/v1/todos");
    expect(await next.json()).toMatchObject({ todos: [{ title: "After" }], generation: 2, stale: false });
    expect(upstreamReads).toBe(1);
  } finally { cache.stop(); }
});
