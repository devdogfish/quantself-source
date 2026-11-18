import { expect, test } from "bun:test";
import { createCaptureService, type CaptureStore } from "./todos-captures";

test("retains original evidence and reconciles interrupted one-to-many links", async () => {
  const rows = new Map<string, any>();
  const store: CaptureStore = {
    async reserve(key, input) {
      const old = rows.get(key);
      if (old && JSON.stringify(old.input) !== JSON.stringify(input))
        throw Error("conflict");
      if (!old) rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async save(key, result) {
      rows.get(key).result = result;
    },
    async list(prefix) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
  };
  let fail = true;
  const commands: any[] = [];
  const service = createCaptureService(store, {
    list: async () => [],
    detail: async () => {
      throw Error();
    },
    write: async (_, command) => {
      commands.push(command);
      if (command.title === "Second" && fail) throw Error("offline");
      return {
        commandId: command.commandId,
        todo: { number: command.title === "First" ? 1 : 2 } as any,
        outcomes: { issue: "saved" },
        message: "saved",
        retryable: false,
      };
    },
  });
  const id = crypto.randomUUID();
  const input = {
    id,
    source: "text",
    capturedAt: "2026-10-26T12:00:00Z",
    transcript: "First then second",
  };
  await service.create(input);
  await service.create(input);
  const plan = {
    confirmed: true as const,
    targets: [
      { commandId: crypto.randomUUID(), title: "First" },
      { commandId: crypto.randomUUID(), title: "Second" },
    ],
  };
  expect(
    (await service.link("client", id, plan)).links.map((l) => l.status),
  ).toEqual(["linked", "pending"]);
  fail = false;
  expect(
    (await service.link("client", id, plan)).links.map((l) => l.number),
  ).toEqual([1, 2]);
  expect((await service.read(id)).capture!.transcript).toBe(input.transcript);
  expect(commands[0].description).toContain(`Capture ID: ${id}`);
  expect(commands[0].description).toContain(input.transcript);
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./todos-captures-route";
test("capture HTTP denies access before storage and validates confirmed interpretations", async () => {
  let calls = 0;
  const rows = new Map<string, any>();
  const store: CaptureStore = {
    async reserve(key, input) {
      calls++;
      const old = rows.get(key);
      if (old && JSON.stringify(old.input) !== JSON.stringify(input)) {
        const { TodoWriteError } = await import("./todos-write");
        throw new TodoWriteError("CAPTURE_CONFLICT", "Conflict");
      }
      if (!old) rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async get(key) {
      calls++;
      return rows.get(key) ?? null;
    },
    async save(key, result) {
      rows.get(key).result = result;
    },
    async list(prefix) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
  };
  let permissions: string[] = [];
  const app = new OpenAPIHono<any>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner" },
      client: { id: "client", kind: "api-key" },
      permissions,
    });
    await next();
  });
  registerCaptureRoutes(
    app,
    {
      list: async () => [],
      detail: async () => {
        throw Error();
      },
    },
    store,
  );
  const id = crypto.randomUUID();
  const input = {
    id,
    source: "text",
    capturedAt: "2026-10-26T12:00:00Z",
    transcript: "original",
  };
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post("/api/v1/todo-captures", input)).status).toBe(403);
  expect(calls).toBe(0);
  permissions = ["todos:write"];
  expect((await post("/api/v1/todo-captures", input)).status).toBe(200);
  expect((await post("/api/v1/todo-captures", input)).status).toBe(200);
  expect(
    (await post("/api/v1/todo-captures", { ...input, transcript: "changed" }))
      .status,
  ).toBe(409);
  expect((await app.request(`/api/v1/todo-captures/${id}`)).status).toBe(403);
  expect(
    (
      await post(`/api/v1/todo-captures/${id}/links`, {
        confirmed: false,
        targets: [],
      })
    ).status,
  ).toBe(400);
  permissions = ["todos:read"];
  expect(
    await (await app.request(`/api/v1/todo-captures/${id}`)).json(),
  ).toMatchObject({ capture: input });
});

test("HTTP multiple-issue partial recovery keeps successful links and stable commands", async () => {
  const rows = new Map<string, any>();
  const store: CaptureStore = {
    async reserve(key, input) {
      if (!rows.has(key)) rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async save(key, result) {
      rows.get(key).result = result;
    },
    async list(prefix) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
  };
  let offline = true;
  const calls: string[] = [];
  const app = new OpenAPIHono<any>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner" },
      client: { id: "client", kind: "api-key" },
      permissions: ["todos:write", "todos:read"],
    });
    await next();
  });
  registerCaptureRoutes(
    app,
    {
      list: async () => [],
      detail: async () => {
        throw Error();
      },
      write: async (_, command) => {
        calls.push(command.commandId);
        if (calls.length > 1 && offline) throw Error("offline");
        return {
          commandId: command.commandId,
          todo: { number: calls.length === 1 ? 1 : 2 } as any,
          outcomes: { issue: "saved" },
          message: "saved",
          retryable: false,
        };
      },
    },
    store,
  );
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      links: { status: string; number: number | null }[];
    }>;
  };
  const id = crypto.randomUUID();
  await post("/api/v1/todo-captures", {
    id,
    source: "text",
    capturedAt: "2026-10-26T12:00:00Z",
    transcript: "Two tasks",
  });
  const plan = {
    confirmed: true,
    targets: [
      { commandId: crypto.randomUUID(), title: "One" },
      { commandId: crypto.randomUUID(), title: "Two" },
    ],
  };
  expect(
    (await post(`/api/v1/todo-captures/${id}/links`, plan)).links.map(
      (l: any) => l.status,
    ),
  ).toEqual(["linked", "pending"]);
  offline = false;
  expect(
    (await post(`/api/v1/todo-captures/${id}/links`, plan)).links.map(
      (l: any) => l.number,
    ),
  ).toEqual([1, 2]);
  expect(calls).toEqual([
    plan.targets[0].commandId,
    plan.targets[1].commandId,
    plan.targets[1].commandId,
  ]);
});

test("capture rejects execution traces containing authentication headers", async () => {
  const { captureSchema } = await import("./todos-captures");
  expect(
    captureSchema.safeParse({
      id: crypto.randomUUID(),
      source: "voice",
      capturedAt: "2026-10-26T12:00:00Z",
      transcript: "Tool request\nAuthorization: Bearer private",
    }).success,
  ).toBe(false);
});

test("conversation input normalizes displayed messages independently of provider execution traces", async () => {
  const rows = new Map<string, any>();
  const store: CaptureStore = {
    async reserve(key, input) {
      rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async save() {},
    async list() {
      return [];
    },
  };
  const service = createCaptureService(store, {
    list: async () => [],
    detail: async () => {
      throw Error();
    },
  });
  const input = {
    id: crypto.randomUUID(),
    source: "voice",
    capturedAt: "2026-10-26T12:00:00Z",
    conversation: [
      { role: "user" as const, text: "Call plumber" },
      { role: "assistant" as const, text: "Captured." },
    ],
  };
  expect((await service.create(input)).capture?.transcript).toBe(
    "user: Call plumber\n\nassistant: Captured.",
  );
  expect(rows.get(`capture:${input.id}`).input.conversation).toBeUndefined();
  const { captureSubmissionSchema } = await import("./todos-captures");
  expect(
    captureSubmissionSchema.safeParse({
      ...input,
      executionTrace: { headers: { Authorization: "private" } },
    }).success,
  ).toBe(false);
  expect(
    captureSubmissionSchema.safeParse({
      ...input,
      conversation: [{ role: "tool", text: "request headers" }],
    }).success,
  ).toBe(false);
});
