import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { registerJarvisCommands } from "./todos-jarvis-commands";
import { TodoWriteError, todoCreateSchema, todoEditSchema, type TodoCommand } from "./todos-write";

const malformed = "f6a7b8c9-6666-4f06-9g06-000000000001";
function fixture(captureId = crypto.randomUUID()) {
  const rows = new Map<string, any>([[`jarvis:${captureId}`, { input: { owner: "owner" }, result: null }]]);
  const writes: TodoCommand[] = [];
  let source: string = captureId;
  let done = false;
  let clientId = "jarvis";
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner", name: "Owner", email: "owner@example.com" }, client: { id: clientId, kind: "api-key", name: "Jarvis" }, permissions: ["todos:read", "todos:write"] });
    await next();
  });
  registerJarvisCommands(app, {
    list: async () => [], detail: async () => { throw Error("unused"); },
    write: async (_, command) => {
      // The boundary must deliver canonical commands to the shared writer.
      expect(todoCreateSchema.safeParse(commandWithoutProvenance(command)).success).toBe(true);
      writes.push(command);
      return { commandId: command.commandId, todo: null, outcomes: { issue: "uncertain" }, message: "Retry identical input", retryable: true };
    },
  }, {
    get: async key => rows.get(key) ?? null,
    reserve: async (key, input) => {
      const prior = rows.get(key);
      if (prior && JSON.stringify(prior.input) !== JSON.stringify(input)) throw new TodoWriteError("IDEMPOTENCY_CONFLICT", "Changed retry");
      if (prior) return prior;
      const row = { input, result: null }; rows.set(key, row); return row;
    },
    save: async (key, result) => { rows.get(key).result = result; },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row),
  }, {
    agentId: () => "agent", temporaryAccess: async () => "unused", audio: async () => { throw Error("unused"); },
    finalConversation: async conversationId => ({ agentId: "agent", userId: source, conversationId, done, capturedAt: "2026-10-30T12:00:00Z", conversation: [] }),
  });
  return { app, rows, writes, captureId, source: (value: string) => { source = value; }, end: () => { done = true; }, client: (value: string) => { clientId = value; },
    post: (command: unknown, conversationId = "conv_test") => app.request(`/api/v1/todo-jarvis/${captureId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, intent: "requested", command }) }) };
}
function commandWithoutProvenance(command: TodoCommand) { const { provenance, ...rest } = command; return rest; }

test("Jarvis malformed operation token normalizes for object/string retries and canonical receipts", async () => {
  const f = fixture();
  const command = { commandId: malformed, title: "Repair leaking tap" };
  expect((await f.post(command)).status).toBe(200);
  f.end(); // Exact operations can reconcile after the conversation ends.
  expect((await f.post(JSON.stringify(command))).status).toBe(200);
  expect(f.writes).toHaveLength(2);
  const canonical = f.writes[0]!.commandId;
  expect(canonical).not.toBe(malformed);
  expect(f.writes[1]!.commandId).toBe(canonical);
  expect(f.writes[0]!.provenance?.operationId).toBe(canonical);
  expect([...f.rows.keys()].filter(key => key.startsWith("jarvis-command:"))).toEqual([`jarvis-command:${f.captureId}:${canonical}`]);
  expect((await f.post({ ...command, title: "Changed" })).status).toBe(409);
  f.client("other-client");
  expect((await f.post(command)).status).toBe(409);
  expect(f.writes).toHaveLength(2);
});

test("Jarvis preserves valid UUIDs and scopes opaque IDs to capture and conversation", async () => {
  const a = fixture(), b = fixture(), c = fixture(a.captureId);
  const command = { commandId: malformed, title: "Repair tap" };
  expect((await a.post(command)).status).toBe(200);
  expect((await b.post(command)).status).toBe(200);
  expect(a.writes[0]!.commandId).not.toBe(b.writes[0]!.commandId);
  expect((await c.post(command, "conv_other")).status).toBe(200);
  expect(a.writes[0]!.commandId).not.toBe(c.writes[0]!.commandId);
  const uuid = crypto.randomUUID();
  expect((await a.post({ ...command, commandId: uuid })).status).toBe(200);
  expect(a.writes[1]!.commandId).toBe(uuid);
  // A changed provider conversation still fails source binding before any write.
  expect((await a.post(command, "conv_other")).status).toBe(409);
  a.source(crypto.randomUUID());
  expect((await a.post(command)).status).toBe(409);
  expect(a.writes).toHaveLength(2);
});

test("Jarvis token adaptation leaves canonical schemas and unrelated validation strict", async () => {
  expect(todoCreateSchema.safeParse({ commandId: malformed, title: "Repair tap" }).success).toBe(false);
  expect(todoEditSchema.safeParse({ commandId: malformed, title: { before: "A", after: "B" } }).success).toBe(false);
  const f = fixture();
  for (const command of [
    { commandId: "", title: "Repair tap" }, { commandId: "a".repeat(257), title: "Repair tap" },
    { commandId: "has space", title: "Repair tap" }, { commandId: malformed, title: "" },
    { commandId: malformed, title: "Repair tap", arbitrary: true },
    { commandId: malformed, number: 3, start: "2026-10-30T15:00:00Z" },
    { commandId: malformed, title: "Repair tap", fields: { Due: "invalid" } },
  ]) {
    expect((await f.post(command)).status).toBe(400);
    expect((await f.post(JSON.stringify(command))).status).toBe(400);
  }
  expect(f.writes).toHaveLength(0);
});


test("Jarvis OpenAPI retains full typed transport commands and canonical UUID schemas", () => {
  const { app } = fixture();
  const document = app.getOpenAPI31Document({ openapi: "3.1.1", info: { title: "Test", version: "1" } });
  const schemas = document.components!.schemas! as Record<string, any>;
  const create = schemas.TodoJarvisCreateCommand;
  const edit = schemas.TodoJarvisEditCommand;
  expect(create.properties.title.type).toBe("string");
  expect(create.properties.fields).toBeDefined();
  expect(create.required).toEqual(expect.arrayContaining(["commandId", "title"]));
  expect(edit.properties.number.type).toBe("integer");
  expect(edit.properties.revision).toBeDefined();
  expect(edit.properties.trash).toBeDefined();
  expect(create.properties.commandId).toMatchObject({ type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" });
  expect(create.properties.commandId.format).toBeUndefined();
  expect(schemas.TodoCreate.properties.commandId.format).toBe("uuid");
  expect(schemas.TodoJarvisCommand.properties.command.anyOf).toEqual(expect.arrayContaining([
    { $ref: "#/components/schemas/TodoJarvisCreateCommand" },
    { $ref: "#/components/schemas/TodoJarvisEditCommand" },
  ]));
});
