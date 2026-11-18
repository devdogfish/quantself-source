import { expect, test } from "bun:test";
import { deriveReadiness } from "./todos-relationships";
test("chains reconcile duplicates; grouping never blocks and missing targets stay blocked", () => {
  const tasks: any[] = [
    {
      id: "a",
      state: "open",
      blockedBy: [{ id: "b" }],
      children: [{ id: "x" }],
    },
    {
      id: "b",
      state: "closed",
      closureReason: "duplicate",
      duplicateOf: { id: "c" },
    },
    { id: "c", state: "closed", closureReason: "completed" },
  ];
  expect(deriveReadiness(tasks)[0].readiness).toBe("ready");
  tasks[2].state = "open";
  expect(deriveReadiness(tasks)[0].readiness).toBe("blocked");
  tasks[2].state = "closed";
  tasks[2].closureReason = "not_planned";
  expect(deriveReadiness(tasks)[0].readiness).toBe("blocked");
  expect(
    deriveReadiness([{ id: "x", blockedBy: [{ id: "missing" }] }] as any)[0]
      .readiness,
  ).toBe("blocked");
});

test("HTTP relationships preserve unrelated edges, reject cycles and reconcile partial saves and lifecycle", async () => {
  const { createTodoWriter } = await import("./todos-write");
  const { createApp } = await import("./app");
  const tasks: any[] = [1, 2, 3, 4].map((number) => ({
    id: `I${number}`,
    databaseId: number,
    number,
    repository: "tasks/personal",
    url: `https://github.com/tasks/personal/issues/${number}`,
    title: `Task ${number}`,
    state: "open",
    closureReason: null,
    body: null,
    updatedAt: "now",
    labels: [],
    fields: { Commitment: number === 3 ? "Someday" : "Active" },
    fieldValues: [],
    start: null, end: null, allDay: false, fixed: false,
    scheduleError: null,
    blockedBy: [],
    children: [],
    parent: null,
    relationshipError: null,
  }));
  const ref = (n: number) => ({
    id: tasks[n - 1].id,
    databaseId: n,
    number: n,
    repository: "tasks/personal",
    url: tasks[n - 1].url,
    title: tasks[n - 1].title,
  });
  tasks[0].blockedBy = [ref(2)];
  tasks[1].blockedBy = [ref(3)];
  tasks[0].children = [ref(4)];
  const receipts = new Map<string, any>();
  const reader = {
    list: async () => structuredClone(tasks),
    detail: async (n: number) => structuredClone(tasks[n - 1]),
    write: undefined as any,
  };
  let fail = true;
  const writes: string[] = [];
  reader.write = createTodoWriter({
    reader,
    journal: {
      reserve: async (k, h) => {
        if (!receipts.has(k))
          receipts.set(k, { fresh: true, hash: h, state: { done: {} } });
        return receipts.get(k);
      },
      save: async (k, s) => {
        receipts.get(k).state = structuredClone(s);
      },
    },
    connect: async () => ({
      repository: "tasks/personal",
      definitions: [],
      syncProject: async () => {},
      request: async (path, method, body) => {
        writes.push(path);
        if (path === "/graphql") {
          const t = tasks.find((t) => t.id === body.variables.input.issueId);
          t.state = body.variables.input.stateReason ? "closed" : "open";
          t.closureReason =
            body.variables.input.stateReason?.toLowerCase() ?? null;
          return { data: { issue: { id: t.id } } };
        }
        const n = Number(path.match(/issues\/(\d+)/)?.[1]);
        if (path.endsWith("/sub_issues") && fail)
          throw Error("provider unavailable");
        if (path.includes("dependencies")) {
          const t = tasks[n - 1];
          if (method === "POST") t.blockedBy.push(ref(body.issue_id));
          else
            t.blockedBy = t.blockedBy.filter(
              (r: any) => r.databaseId !== Number(path.split("/").at(-1)),
            );
        } else if (path.endsWith("/sub_issues"))
          tasks[n - 1].children.push(ref(body.issue_id));
        else if (path.endsWith("/sub_issue"))
          tasks[n - 1].children = tasks[n - 1].children.filter(
            (r: any) => r.databaseId !== body.sub_issue_id,
          );
      },
    }),
  });
  const app = createApp({
    todos: reader,
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "o", name: "Owner", email: "o@example.com" },
      client: { id: "c", name: "Client", kind: "api-key" },
      permissions: ["todos:read", "todos:write"],
    }),
  });
  const patch = async (n: number, changes: any, id = crypto.randomUUID()) => {
    const response = await app.request(`/api/v1/todos/${n}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: id, ...changes }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const list = async () =>
    ((await (await app.request("/api/v1/todos")).json()) as any).todos;
  expect((await list())[0].readiness).toBe("blocked");
  expect(
    (
      await patch(3, {
        relationships: [
          { kind: "blockedBy", number: 1, before: false, after: true },
        ],
      })
    ).outcomes["blockedBy:1"],
  ).toBe("failed");
  expect(
    (
      await patch(1, {
        relationships: [
          { kind: "blockedBy", number: 1, before: false, after: true },
        ],
      })
    ).outcomes["blockedBy:1"],
  ).toBe("failed");
  const cmd = crypto.randomUUID();
  const edges = {
    relationships: [
      { kind: "blockedBy", number: 4, before: false, after: true },
      { kind: "children", number: 3, before: false, after: true },
    ],
  };
  const partial = await patch(1, edges, cmd);
  expect(partial.outcomes).toMatchObject({
    "blockedBy:4": "saved",
    "children:3": "uncertain",
  });
  fail = false;
  await patch(1, edges, cmd);
  expect(writes.filter((p) => p.endsWith("/sub_issues"))).toHaveLength(1);
  expect(tasks[0].blockedBy.map((r: any) => r.number)).toEqual([2, 4]);
  expect(tasks[0].children.map((r: any) => r.number)).toEqual([4]);
  await patch(3, {
    closure: { before: { outcome: "open" }, after: { outcome: "completed" } },
  });
  expect(tasks[2].fields.Commitment).toBe("Someday");
  await patch(2, {
    closure: { before: { outcome: "open" }, after: { outcome: "completed" } },
  });
  await patch(1, {
    relationships: [
      { kind: "blockedBy", number: 4, before: true, after: false },
    ],
  });
  expect((await list())[0].readiness).toBe("ready");
  await patch(2, {
    closure: { before: { outcome: "completed" }, after: { outcome: "open" } },
  });
  expect((await list())[0].readiness).toBe("blocked");
  await patch(1, {
    relationships: [
      { kind: "children", number: 4, before: true, after: false },
    ],
  });
  expect(tasks[0].children).toEqual([]);
  const raceId = crypto.randomUUID();
  const raceEdge = {
    relationships: [
      { kind: "blockedBy", number: 4, before: false, after: true },
    ],
  };
  expect((await patch(1, raceEdge, raceId)).outcomes["blockedBy:4"]).toBe(
    "saved",
  );
  tasks[0].blockedBy = [ref(2), ref(3)]; // An external edit after our saved result.
  expect((await patch(1, raceEdge, raceId)).outcomes["blockedBy:4"]).toBe(
    "conflict",
  );
  expect(tasks[0].blockedBy.map((r: any) => r.number)).toEqual([2, 3]);
  tasks[3].repository = "external/private";
  expect((await patch(1, raceEdge)).outcomes["blockedBy:4"]).toBe("failed");
});
