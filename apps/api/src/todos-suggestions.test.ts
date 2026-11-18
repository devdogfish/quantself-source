import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { registerSuggestionRoutes } from "./todos-suggestions";
import type { CaptureStore } from "./todos-captures";
import type { Todo } from "./todos-github";
import { TodoWriteError } from "./todos-write";

test("review receipts retain dismissal across publication retries and isolate Owner/review", async () => {
  const rows = new Map<string, Awaited<ReturnType<CaptureStore["reserve"]>>>();
  const store: CaptureStore = {
    reserve: async (key, input) => {
      const existing = rows.get(key);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input))
          throw new TodoWriteError("IDEMPOTENCY_CONFLICT", "Changed proposal");
        return existing;
      }
      const row = { input, result: null };
      rows.set(key, row);
      return row;
    },
    get: async (key) => rows.get(key) ?? null,
    save: async (key, result) => {
      const row = rows.get(key);
      if (!row) throw Error("Suggestion not reserved");
      row.result = result;
    },
    list: async (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value),
  };
  let permissions = ["todos:read", "todos:write"],
    owner = "owner";
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: owner, email: "owner@example.com", name: "Owner" },
      client: { id: "ai", name: "AI", kind: "api-key" },
      permissions,
    });
    await next();
  });
  const todo = {
    number: 1,
    updatedAt: "r1",
    fields: { Estimate: 30 },
    start: null, end: null, allDay: false, fixed: false,
  } as unknown as Todo;
  registerSuggestionRoutes(
    app,
    { list: async () => [todo], detail: async () => todo },
    store,
  );
  const id = crypto.randomUUID(),
    commandId = crypto.randomUUID();
  const path = `/api/v1/todo-suggestions/${id}`;
  const proposal = {
    number: 1,
    revision: "r1",
    reason: "Allow preparation",
    command: { commandId, fields: { Estimate: { before: 30, after: 45 } } },
  };
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(path, proposal)).status).toBe(200);
  expect((await post(`${path}/dismiss`, { commandId })).status).toBe(200);
  expect(await (await post(path, proposal)).json()).toMatchObject({
    suggestions: [{ dismissed: true }],
  });
  expect(await (await app.request(path)).json()).toMatchObject({
    suggestions: [{ dismissed: true }],
  });
  expect((await post(path, { ...proposal, reason: "Changed" })).status).toBe(
    409,
  );
  expect(
    await (
      await app.request(`/api/v1/todo-suggestions/${crypto.randomUUID()}`)
    ).json(),
  ).toEqual({ suggestions: [] });
  const repeated = await post(path, {
    ...proposal,
    reason: "Rephrased",
    command: { ...proposal.command, commandId: crypto.randomUUID() },
  });
  expect(await repeated.json()).toMatchObject({
    suggestions: [{ dismissed: true }, { dismissed: true }],
  });
  owner = "another";
  expect(await (await app.request(path)).json()).toEqual({ suggestions: [] });
  permissions = ["todos:read"];
  expect((await post(path, proposal)).status).toBe(403);
  expect((await post(`${path}/dismiss`, { commandId })).status).toBe(403);
  permissions = [];
  expect((await app.request(path)).status).toBe(403);
});
