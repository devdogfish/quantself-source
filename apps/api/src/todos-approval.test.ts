import { expect, test } from "bun:test";
import { createApp } from "./app";
import { approvalRevision, createTodoApprover } from "./todos-approval";
import type { Todo, TodoReader } from "./todos-github";
import type { CommandJournal } from "./todos-write";

function fixture(permissions = ["todos:approve"]) {
  let todo: Todo = {
    id: "I_1",
    databaseId: 1,
    number: 1,
    repository: "tasks/personal",
    url: "https://example.com/1",
    title: "Research",
    body: "Description",
    state: "open",
    closureReason: null,
    updatedAt: "now",
    labels: ["task", "ready-for-agent"],
    fields: {},
    fieldValues: [],
    start: null, end: null, allDay: false, fixed: false,
    scheduleError: null,
    blockedBy: [],
    readiness: "ready",
    comments: [
      {
        id: 1,
        body: "Agent Brief\nGoal: compare\nInputs: notes\nOutput / destination: issue\nConstraints: no spending\nDone-when: options documented",
        url: "https://example.com/comment",
        updatedAt: "now",
      },
    ],
  };
  let duringReservation: (() => void) | undefined;
  const receipts = new Set<string>();
  const journal: CommandJournal = {
    reserve: async (key, hash) => {
      duringReservation?.();
      duringReservation = undefined;
      const fresh = !receipts.has(key);
      receipts.add(key);
      return { fresh, hash, state: { done: {} } };
    },
    save: async () => {},
  };
  const reader: TodoReader = {
    list: async () => [structuredClone(todo)],
    detail: async () => structuredClone(todo),
  };
  const writes: unknown[] = [];
  let fail = false;
  reader.approve = createTodoApprover(
    reader,
    journal,
    async (_p, _m, body: any) => {
      writes.push(body);
      if (fail) throw Error();
      todo.labels.push(...body.labels);
    },
  );
  const app = createApp({
    todos: reader,
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "o@example.com", name: "Owner" },
      client: { id: "client", name: "Client", kind: "api-key" },
      permissions,
    }),
  });
  const input = () => ({
    commandId: crypto.randomUUID(),
    revision: approvalRevision(todo, [todo]),
    intent: "execute",
    confirmed: true,
  });
  const send = (
    body: unknown,
    path = "/api/v1/todos/1/approval",
    method = "POST",
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    todo,
    input,
    send,
    writes,
    duringReservation: (change: () => void) => {
      duringReservation = change;
    },
    fail: () => {
      fail = true;
    },
  };
}
test("ordinary editor cannot approve; approval permission is independent and explicit", async () => {
  const editor = fixture(["todos:read", "todos:write"]);
  expect((await editor.send(editor.input())).status).toBe(403);
  expect(
    (
      await editor.send(
        { commandId: crypto.randomUUID(), labels: ["agent:implement"] },
        "/api/v1/todos/1",
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(editor.writes).toEqual([]);
  const owner = fixture();
  expect(
    (await owner.send({ ...owner.input(), confirmed: false })).status,
  ).toBe(400);
  expect((await owner.send(owner.input())).status).toBe(200);
  expect(owner.writes).toEqual([{ labels: ["agent:implement"] }]);
  owner.todo.labels = ["task", "ready-for-agent"];
  expect((await owner.send(owner.input())).status).toBe(409);
  expect(owner.writes).toHaveLength(1);
});
test("changed brief, consumed approval and ambiguous delivery never replay approval", async () => {
  const f = fixture();
  const stale = f.input();
  f.todo.comments![0].body += " changed";
  expect((await f.send(stale)).status).toBe(409);
  const current = f.input();
  f.fail();
  expect(await (await f.send(current)).json()).toMatchObject({
    outcomes: { approval: "uncertain" },
    retryable: false,
  });
  expect(
    (await f.send({ ...current, commandId: crypto.randomUUID() })).status,
  ).toBe(409);
  expect(f.writes).toHaveLength(1);
});
test("waiting requires blocked state and Decision labels remain untouched", async () => {
  const f = fixture();
  f.todo.readiness = "blocked";
  expect((await f.send(f.input())).status).toBe(409);
  expect((await f.send({ ...f.input(), intent: "wait" })).status).toBe(200);
  expect(f.writes).toEqual([{ labels: ["agent:queued"] }]);
  const decision = fixture();
  decision.todo.labels = ["wayfinder:research"];
  expect((await decision.send(decision.input())).status).toBe(409);
  expect(decision.todo.labels).toEqual(["wayfinder:research"]);
  expect(decision.writes).toEqual([]);
});

test.each(["brief", "prerequisite", "runner"] as const)(
  "approval rejects %s changes during receipt reservation before dispatch",
  async (change) => {
    const f = fixture();
    const reviewed = f.input();
    f.duringReservation(() => {
      if (change === "brief") f.todo.comments![0].body += " revised constraints";
      if (change === "prerequisite") {
        f.todo.blockedBy = [
          {
            id: "I_2",
            databaseId: 2,
            number: 2,
            repository: "tasks/personal",
            url: "https://example.com/2",
            title: "New prerequisite",
          },
        ];
        f.todo.readiness = "blocked";
      }
      if (change === "runner") f.todo.labels.push("agent:in-progress");
    });
    const response = await f.send(reviewed);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_APPROVAL" });
    expect(f.writes).toEqual([]);
  },
);
