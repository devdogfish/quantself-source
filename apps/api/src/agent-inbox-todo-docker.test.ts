import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createAgentApiKey, createApiKey } from "@quantself/auth";
import { OWNER_INGRESS_HEADER } from "@quantself/auth/owner-ingress";
import { prisma } from "@quantself/db";
import { createApp } from "./app";

const endpoint = "/api/v1/agent-inbox-todos";
const cliEntry = fileURLToPath(new URL("../../../packages/cli/src/index.ts", import.meta.url));

test.skipIf(process.env.AGENT_INBOX_DOCKER_TEST !== "1")(
  "Agent CLI creates and verifies its own Inbox To-do, with a conditional and repeatable Owner Undo",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.hostname !== "127.0.0.1" || !database.port || database.pathname !== "/agent_inbox_fixture") {
      throw new Error("Use the disposable Docker database agent_inbox_fixture.");
    }
    const owner = { id: crypto.randomUUID(), name: "Owner", email: "owner@example.test" };
    const origin = "https://qs.girke.dev";
    const proof = "7f".repeat(32);
    const oldToken = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    const oldOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const ownerHeaders = { [OWNER_INGRESS_HEADER]: proof, origin };
    const agentClients: string[] = [];
    const app = createApp({
      emitAccessLog: () => {},
      todos: {
        list: async () => { throw new Error("Unexpected GitHub list call"); },
        detail: async () => { throw new Error("Unexpected GitHub detail call"); },
        write: async () => { throw new Error("Unexpected GitHub write"); },
      },
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const url = server.url.origin;
    const request = (path: string, init?: RequestInit) => {
      const headers = new Headers(ownerHeaders);
      for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
      if (headers.has("x-api-key")) headers.delete(OWNER_INGRESS_HEADER);
      return fetch(`${url}${path}`, { ...init, headers });
    };
    const undo = (auditId: string) => request(`/api/v1/agent-audit/${auditId}/undo`, { method: "POST" });
    async function cli(credential: string, ...args: string[]) {
      const child = Bun.spawn([
        process.execPath, "--no-env-file", cliEntry, ...args,
      ], { env: { QUANTSELF_API_URL: url, QUANTSELF_API_KEY: credential }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, body: JSON.parse(code === 0 ? stdout : stderr) };
    }
    const create = (title: string, key: string, credential: string) =>
      cli(credential, "createAgentInboxTodo", "--idempotency-key", key, "--body", JSON.stringify({ title }));
    const status = (id: string, credential: string) =>
      cli(credential, "getCreatedInboxTodoStatus", "--path", JSON.stringify({ id }));

    try {
      process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
      process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const [agent, readOnly, writeOnly, regular] = await Promise.all([
        createAgentApiKey({ userId: owner.id, name: "Inbox Agent", permissionIds: ["todos:read", "todos:write"] }),
        createAgentApiKey({ userId: owner.id, name: "Read-only Agent", permissionIds: ["todos:read"] }),
        createAgentApiKey({ userId: owner.id, name: "Write-only Agent", permissionIds: ["todos:write"] }),
        createApiKey({ userId: owner.id, name: "Regular key", preset: "custom", permissionIds: ["todos:read", "todos:write"] }),
      ]);
      agentClients.push(agent.client.id, readOnly.client.id, writeOnly.client.id);
      const key = crypto.randomUUID();
      expect(await create("Forbidden", key, readOnly.secret)).toMatchObject({ code: 1, body: { status: 403 } });
      expect(await create("Forbidden", key, regular.secret)).toMatchObject({ code: 1, body: { status: 403 } });
      const [first, replay] = await Promise.all([create("Call the plumber", key, agent.secret), create("Call the plumber", key, agent.secret)]);
      expect(first).toMatchObject({ code: 0, body: { todo: { title: "Call the plumber", revision: 1, completed: false } } });
      expect(replay).toEqual(first);
      expect(await create("Different title", key, agent.secret)).toMatchObject({ code: 1, body: { status: 409 } });
      const { auditId, todo } = first.body;
      const statusReadStarted = performance.now();
      const detail = await request(`${endpoint}/${todo.id}`, { headers: { "x-api-key": agent.secret } });
      expect(await detail.json()).toEqual({ id: todo.id, status: "inbox" });
      expect(detail.headers.get("cache-control")).toBe("private, no-store");
      console.info(`Agent status: one API request, zero GitHub calls, ${(performance.now() - statusReadStarted).toFixed(1)} ms with warm fixture database.`);
      expect(await status(todo.id, agent.secret)).toEqual({ code: 0, body: { id: todo.id, status: "inbox" } });
      const unauthorized = await status(todo.id, readOnly.secret);
      expect(unauthorized).toMatchObject({ code: 1, body: { status: 404 } });
      expect(await status(crypto.randomUUID(), readOnly.secret)).toEqual(unauthorized);
      expect(await status(todo.id, writeOnly.secret)).toMatchObject({ code: 1, body: { status: 403 } });
      expect(await status(todo.id, regular.secret)).toMatchObject({ code: 1, body: { status: 403 } });
      const startedAt = performance.now();
      expect(await (await request(endpoint)).json()).toEqual({ todos: [todo], nextCursor: null });
      console.info(`Owner Inbox: one API request, zero GitHub calls, ${(performance.now() - startedAt).toFixed(1)} ms with warm fixture database.`);
      expect((await request(endpoint, { headers: { "x-api-key": agent.secret } })).status).toBe(403);
      expect((await fetch(`${url}${endpoint}`)).status).toBe(401);
      expect(await (await request("/api/v1/agent-audit")).json()).toMatchObject({ audits: [{
        id: auditId, clientId: agent.client.id, resourceId: todo.id, revisionBefore: 0, revisionAfter: 1,
        before: { exists: false }, after: { title: todo.title, commitment: "Inbox" }, undoneAt: null,
      }] });
      const undone = await Promise.all([undo(auditId), undo(auditId)]);
      expect(undone.map(response => response.status)).toEqual([200, 200]);
      expect(await undone[0].json()).toMatchObject({ audit: { id: auditId, undoneAt: expect.any(String) } });
      expect(await undone[1].json()).toMatchObject({ audit: { id: auditId, undoneAt: expect.any(String) } });
      expect(await (await request(endpoint)).json()).toEqual({ todos: [], nextCursor: null });
      expect(await status(todo.id, agent.secret)).toEqual({ code: 0, body: { id: todo.id, status: "undone" } });
      expect(await create(todo.title, key, agent.secret)).toEqual(first);
      expect(await (await request(endpoint)).json()).toEqual({ todos: [], nextCursor: null });

      const edited = (await create("Original title", crypto.randomUUID(), agent.secret)).body;
      expect((await request(`${endpoint}/${edited.todo.id}`, {
        method: "PATCH", headers: { origin, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ title: "Owner edit", expectedRevision: 1 }),
      })).status).toBe(200);
      expect((await undo(edited.auditId)).status).toBe(409);
      expect(await (await request(endpoint)).json()).toMatchObject({ todos: [{
        id: edited.todo.id, title: "Owner edit", revision: 2, auditId: null,
      }] });
      expect(await status(edited.todo.id, agent.secret)).toEqual({ code: 0, body: { id: edited.todo.id, status: "inbox" } });
      expect((await request(`${endpoint}/${edited.todo.id}`, {
        method: "PATCH", headers: { origin, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ completed: true, expectedRevision: 2 }),
      })).status).toBe(200);
      expect(await status(edited.todo.id, agent.secret)).toEqual({ code: 0, body: { id: edited.todo.id, status: "completed" } });
    } finally {
      await server.stop(true);
      await prisma.$transaction([
        prisma.agentInboxTodo.deleteMany({ where: { ownerId: owner.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apiIdempotencyKey.deleteMany({ where: { clientId: { in: [...agentClients, "quantself-web"] } } }),
        prisma.authOwner.deleteMany({ where: { userId: owner.id } }),
        prisma.user.deleteMany({ where: { id: owner.id } }),
      ]);
      if (oldToken === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = oldToken;
      if (oldOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = oldOrigin;
    }
  },
  20_000,
);
