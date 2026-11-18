import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerJarvisRoutes } from "./todos-jarvis-route";
import type { AccessContext } from "@quantself/auth";
import type { CaptureStore } from "./todos-captures";

const id = "5d72f10e-99cc-4d46-8bf8-d09f420ba453";
const access: AccessContext = {
  owner: { id: "owner", email: "owner@example.com", name: "Owner" },
  client: { id: "quantself-web", kind: "web", name: "Web" },
  permissions: ["todos:read"],
};
function fixture() {
  const rows = new Map<string, Awaited<ReturnType<CaptureStore["reserve"]>>>();
  const store: CaptureStore = {
    async reserve(key, input) {
      const prior = rows.get(key);
      if (prior && JSON.stringify(prior.input) !== JSON.stringify(input))
        throw Error("conflict");
      if (prior) return prior;
      const row = { input, result: null };
      rows.set(key, row);
      return row;
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async save(key, result) {
      rows.get(key)!.result = result;
    },
    async list(prefix) {
      return [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value);
    },
  };
  let context: AccessContext | null = access;
  let ready = false;
  let mediaReady = false;
  let source = id;
  const files = new Map<string, Uint8Array>();
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", context);
    await next();
  });
  registerJarvisRoutes(
    app,
    {
      list: async () => [],
      detail: async () => {
        throw Error();
      },
    },
    {
      store,
      provider: {
        async temporaryAccess() {
          return "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary";
        },
        async finalConversation() {
          return {
            agentId: "agent",
            userId: source,
            conversationId: "conv_1",
            done: ready,
            capturedAt: "2026-10-26T12:00:00Z",
            conversation: [
              { role: "user" as const, text: "Read my tasks" },
              { role: "assistant" as const, text: "You have no tasks" },
            ],
          };
        },
        async audio() {
          if (!mediaReady) throw Error("not ready");
          return { bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" };
        },
        agentId: () => "agent",
      },
      audio: {
        async put(key, bytes) {
          files.set(key, bytes);
          return { sha256: "", size: bytes.length };
        },
        async read(key) {
          if (!files.has(key)) throw Error();
          return Buffer.from(files.get(key)!);
        },
        async remove(key) {
          files.delete(key);
        },
      },
    },
  );
  const request = (suffix: string, body: unknown = {}) =>
    app.request(`/api/v1/todo-jarvis/${id}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    rows,
    app,
    files,
    request,
    context: (value: AccessContext | null) => {
      context = value;
    },
    ready: () => {
      ready = true;
    },
    mediaReady: () => {
      mediaReady = true;
    },
    source: (value: string) => {
      source = value;
    },
  };
}
test("temporary access requires Owner read; archive waits for final provider bytes and replay retains one capture", async () => {
  const f = fixture();
  f.context(null);
  expect((await f.request("/access")).status).toBe(401);
  f.context({ ...access, permissions: [] });
  expect((await f.request("/access")).status).toBe(403);
  f.context({ ...access, client: { ...access.client, kind: "api-key" } });
  expect((await f.request("/access")).status).toBe(403);
  f.context(access);
  const response = await f.request("/access");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({
    captureId: id,
    signedUrl: expect.stringContaining("wss:"),
  });
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(202);
  expect(f.rows.has(`capture:${id}`)).toBe(false);
  f.ready();
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(503);
  f.mediaReady();
  expect(
    await (await f.request("/reconcile", { conversationId: "conv_1" })).json(),
  ).toMatchObject({ status: "archived", captureId: id });
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(200);
  expect(f.files.size).toBe(1);
  expect(f.rows.get(`capture:${id}`)!.input.transcript).toBe(
    "user: Read my tasks\n\nassistant: You have no tasks",
  );
});

test("source isolation rejects another capture, owner, changed conversation and deleted source", async () => {
  const f = fixture();
  await f.request("/access");
  f.source(crypto.randomUUID());
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(409);
  expect(f.rows.has(`capture:${id}`)).toBe(false);
  f.source(id);
  f.context({ ...access, owner: { ...access.owner, id: "other" } });
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(409);
  f.context(access);
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(202);
  expect(
    (await f.request("/reconcile", { conversationId: "conv_2" })).status,
  ).toBe(409);
  expect(
    (await f.request("/access", { repository: "other/repo" })).status,
  ).toBe(400);
  f.rows.set(`deleted:${id}`, { input: { id }, result: null });
  f.ready();
  f.mediaReady();
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(409);
  expect(f.files.size).toBe(0);
});

test("expired or revoked access cannot reconcile a recording", async () => {
  const f = fixture();
  await f.request("/access");
  f.ready();
  f.mediaReady();
  f.context(null);
  expect(
    (await f.request("/reconcile", { conversationId: "conv_1" })).status,
  ).toBe(401);
  expect(f.files.size).toBe(0);
});

test("public authenticated HTTPS tool routes reject expired/insufficient keys and cannot switch task source", async () => {
  const { createApp } = await import("./app");
  let current: AccessContext | null = null;
  let reads = 0;
  const app = createApp({
    emitAccessLog() {},
    resolveAccessContext: async () => current,
    todos: {
      list: async () => {
        reads++;
        return [];
      },
      detail: async () => {
        throw Error();
      },
    },
  });
  expect(
    (
      await app.request("https://quantself.example/api/v1/todos", {
        headers: { "X-API-Key": "expired" },
      })
    ).status,
  ).toBe(401);
  current = {
    ...access,
    client: { ...access.client, kind: "api-key" },
    permissions: ["inventory:read"],
  };
  expect(
    (await app.request("https://quantself.example/api/v1/todos")).status,
  ).toBe(403);
  expect(reads).toBe(0);
  current.permissions = ["todos:read"];
  expect(
    (
      await app.request(
        "https://quantself.example/api/v1/todos?repository=unrelated/repository&callback=https://other.example",
      )
    ).status,
  ).toBe(200);
  expect(reads).toBe(1);
  expect(
    (
      await app.request("https://quantself.example/api/v1/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          title: "not authorized",
        }),
      })
    ).status,
  ).toBe(403);
  const accessResponse = await app.request(
    "https://quantself.example/api/v1/access-context",
  );
  expect(accessResponse.status).toBe(200);
  current = null;
  expect(
    (await app.request("https://quantself.example/api/v1/access-context"))
      .status,
  ).toBe(401);
});

test("Jarvis validation identifies invalid command fields without demanding an unrelated header", async () => {
  const { createApp } = await import("./app");
  let writes = 0;
  const app = createApp({
    emitAccessLog() {},
    resolveAccessContext: async () => ({ ...access, permissions: ["todos:read", "todos:write"] }),
    todos: {
      list: async () => [],
      detail: async () => { throw Error("Unused"); },
      write: async () => { writes++; throw Error("Invalid input must not reach writes"); },
    },
  });
  const response = await app.request(`http://localhost/api/v1/todo-jarvis/${id}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conv_example", intent: "requested", command: {
      commandId: crypto.randomUUID(), title: "Calendar fixture", fields: { Due: "2026-10-27T17:00" },
    } }),
  });
  expect(response.status).toBe(400);
  const error = await response.json() as { code: string; message: string };
  expect(error.code).toBe("INVALID_REQUEST");
  expect(error.message).toContain("command.fields.Due");
  expect(error.message).not.toContain("Idempotency-Key");
  expect(writes).toBe(0);
});

test("Jarvis timing validation points to the missing revision before any write", async () => {
  const { createApp } = await import("./app");
  let writes = 0;
  const app = createApp({
    emitAccessLog() {},
    resolveAccessContext: async () => ({ ...access, permissions: ["todos:read", "todos:write"] }),
    todos: {
      list: async () => [],
      detail: async () => { throw Error("Unused"); },
      write: async () => { writes++; throw Error("Invalid input must not reach writes"); },
    },
  });
  const command = { commandId: crypto.randomUUID(), number: 3, start: "2026-10-27T18:00:00-03:00", end: "2026-10-27T22:00:00-03:00" };
  for (const input of [command, JSON.stringify(command)]) {
    const response = await app.request(`http://localhost/api/v1/todo-jarvis/${id}/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conv_example", intent: "requested", command: input }),
    });
    expect(response.status).toBe(400);
    const error = await response.json() as { message: string };
    expect(error.message).toContain("command.revision");
    expect(error.message).not.toContain("Supply at least one change");
  }
  expect(writes).toBe(0);
});


test("pending prep receipts expose task number and prep intent without fetching task details", async () => {
  const f = fixture();
  await f.request("/access");
  const commandId = crypto.randomUUID();
  f.rows.set(`jarvis-command:${id}:${commandId}`, { input: { command: { commandId, number: 7, revision: "r1", beforeMinutes: 10, afterMinutes: 5 } }, result: null });
  const response = await f.app.request(`/api/v1/todo-jarvis/${id}/commands`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { commands: unknown[] }).commands).toEqual([expect.objectContaining({ commandId, number: 7, state: "pending", prep: { beforeMinutes: 10, afterMinutes: 5 } })]);
});
