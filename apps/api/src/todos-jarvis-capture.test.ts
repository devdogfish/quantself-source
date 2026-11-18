import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerJarvisCommands } from "./todos-jarvis-commands";
import type { AccessContext } from "@quantself/auth";
import type { Todo } from "./todos-github";
import type { TodoCommand } from "./todos-write";

test("Jarvis commands capture rough wording and accept category/priority edits without a second approval", async () => {
  const captureId = crypto.randomUUID();
  const rows = new Map<string, any>([[`jarvis:${captureId}`, { input: { owner: "owner" }, result: null }]]);
  const writes: TodoCommand[] = [];
  let permission = true;
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner", name: "Owner", email: "owner@example.com" }, client: { id: "jarvis", kind: "api-key", name: "Jarvis" }, permissions: permission ? ["todos:read", "todos:write"] : ["todos:read"] });
    await next();
  });
  registerJarvisCommands(app, {
    list: async () => { throw Error("Unscheduled capture needs no calendar read"); },
    detail: async () => { throw Error("New capture needs no task detail read"); },
    write: async (_, command) => {
      writes.push(command);
      return { commandId: command.commandId, todo: { id: "I_1", databaseId: 1, number: 1, repository: "example/todos", url: "https://github.com/example/todos/issues/1", title: typeof command.title === "string" ? command.title : "", body: typeof command.description === "string" ? command.description : "", state: "open", closureReason: null, updatedAt: "r1", fields: {}, fieldValues: [], labels: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null } as Todo, outcomes: { issue: "saved" }, retryable: false, message: "Saved" };
    },
  }, {
    get: async key => rows.get(key) ?? null,
    reserve: async (key, input) => { const old = rows.get(key); if (old) { if (JSON.stringify(old.input) !== JSON.stringify(input)) throw Error("Changed retry"); return old; } const row = { input, result: null }; rows.set(key, row); return row; },
    save: async (key, result) => { rows.get(key).result = result; },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row),
  }, {
    agentId: () => "agent", temporaryAccess: async () => "wss://example", audio: async () => { throw Error("unused"); },
    finalConversation: async () => ({ agentId: "agent", userId: captureId, conversationId: "conv_capture", done: false, capturedAt: "2026-10-27T12:00:00Z", conversation: [] }),
  });
  const original = "remind me to sort out that leaking kitchen tap";
  const command = { commandId: crypto.randomUUID(), title: "Arrange repair for kitchen tap", description: original };
  const post = (intent: string, value: unknown = command) => app.request(`/api/v1/todo-jarvis/${captureId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conv_capture", intent, command: JSON.stringify(value) }) });
  const response = await post("requested");
  expect(response.status).toBe(200);
  expect((await response.json() as any).outcomes.issue).toBe("saved");
  expect(writes[0]).toMatchObject(command);
  expect(writes[0].fields).toBeUndefined(); expect(writes[0].start).toBeUndefined(); expect(writes[0].end).toBeUndefined();
  expect(writes[0].description).toContain(original);
  expect((await post("suggested", { ...command, commandId: crypto.randomUUID() })).status).toBe(409);
  expect(writes).toHaveLength(1);
  permission = false;
  expect((await post("requested", { ...command, commandId: crypto.randomUUID() })).status).toBe(403);
  expect(writes).toHaveLength(1);
  permission = true;
  const categorization = { commandId: crypto.randomUUID(), number: 1, fields: { Category: { before: null, after: "Work" } } };
  const categorized = await post("requested", categorization);
  expect(categorized.status).toBe(200);
  expect(writes.at(-1)).toMatchObject(categorization);
  expect((writes.at(-1) as any).fields.Commitment).toBeUndefined();
  const clearAndPrioritize = { commandId: crypto.randomUUID(), number: 1, fields: { Category: { before: "Work", after: null }, "Top priority": { before: "No", after: "Yes" } } };
  expect((await post("requested", clearAndPrioritize)).status).toBe(200);
  expect(writes.at(-1)).toMatchObject(clearAndPrioritize);
  const count = writes.length;
  const misclassified = { commandId: crypto.randomUUID(), number: 1, fields: { Commitment: { before: "Inbox", after: "Work" } } };
  expect((await post("requested", misclassified)).status).toBe(400);
  expect(writes).toHaveLength(count);
});
