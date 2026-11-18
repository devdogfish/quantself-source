import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { CaptureStore } from "./todos-captures";
import type { Todo, TodoReader } from "./todos-github";
import { registerJarvisCommands } from "./todos-jarvis-commands";
import { TodoWriteError } from "./todos-write";

const captureId = "7b49c451-4e67-4ba7-824d-727083831e65";
const access: AccessContext = { owner: { id: "owner", name: "Owner", email: "owner@example.com" }, client: { id: "voice", kind: "api-key", name: "Jarvis" }, permissions: ["todos:read", "todos:write"] };
const task = (number: number, extra: Partial<Todo> = {}): Todo => ({ number, id: `task${number}`, databaseId: number, title: `Task ${number}`, repository: "example/todos", url: `https://github.com/example/todos/issues/${number}`, body: "", fields: {}, fieldValues: [], state: "open", closureReason: null, start: null, end: null, allDay: false, fixed: false, updatedAt: "2026-10-27T12:00:00Z", labels: [], scheduleError: null, ...extra });
function setup() {
  const rows = new Map<string, { input: any; result: any }>();
  rows.set(`jarvis:${captureId}`, { input: { owner: "owner" }, result: {} });
  const store: CaptureStore = {
    async get(key) { return rows.get(key) ?? null; },
    async reserve(key, input) {
      const old = rows.get(key);
      if (old && JSON.stringify(old.input) !== JSON.stringify(input)) throw new TodoWriteError("CONFLICT", "Input changed");
      if (old) return old;
      const row = { input, result: null }; rows.set(key, row); return row;
    },
    async save(key, result) { rows.get(key)!.result = result; },
    async list(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row); },
  };
  const tasks = [task(1)]; const writes: any[] = [], reads: unknown[] = [];
  const reader: TodoReader = {
    async list(purpose) { reads.push(purpose); return tasks; },
    async detail(number) { return tasks.find(t => t.number === number)!; },
    async write(_client, command) { if (!writes.some(saved => saved.commandId === command.commandId)) writes.push(command); return { commandId: command.commandId, todo: tasks[0], outcomes: { timing: "saved" }, message: "Saved", retryable: false }; },
  };
  let done = false, permitted: AccessContext | null = access;
  const provider = { agentId: () => "agent", temporaryAccess: async () => "wss://example", audio: async () => ({ bytes: new Uint8Array(), mime: "audio/mpeg" }), finalConversation: async (id: string) => ({ agentId: "agent", userId: captureId, conversationId: id, done, capturedAt: "2026-10-27T12:00:00Z", conversation: [] }) };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => { c.set("accessContext", permitted); await next(); });
  registerJarvisCommands(app, reader, store, provider);
  const post = (suffix: string, input: unknown) => app.request(`/api/v1/todo-jarvis/${captureId}/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const command = () => ({ commandId: crypto.randomUUID(), number: 1, revision: tasks[0].updatedAt, start: "2026-10-29T10:00:00-03:00", end: "2026-10-29T10:30:00-03:00" });
  return { rows, store, tasks, writes, reads, post, command, deny: () => { permitted = null; }, endConversation: () => { done = true; } };
}

test("ordinary scheduling spans days without mode records and reconciles stable operations", async () => {
  const f = setup();
  for (const date of ["2026-10-29", "2026-11-05"]) {
    const input = { conversationId: "conv_test", intent: "requested", command: { ...f.command(), start: `${date}T10:00:00-03:00`, end: `${date}T10:30:00-03:00` } };
    expect((await f.post("commands", input)).status).toBe(200);
    expect((await f.post("commands", input)).status).toBe(200);
  }
  expect(f.writes).toHaveLength(2);
  expect([...f.rows.keys()].some(key => key.includes("planning"))).toBe(false);
});

test("retired mode intent and modeId are rejected; ordinary commands require credentials", async () => {
  const f = setup();
  const input = { conversationId: "conv_test", intent: "requested", command: f.command() };
  expect((await f.post("commands", { ...input, intent: "planning" })).status).toBe(400);
  expect((await f.post("commands", { ...input, modeId: crypto.randomUUID() })).status).toBe(400);
  f.deny(); expect((await f.post("commands", input)).status).toBe(401);
  expect(f.writes).toHaveLength(0);
});

test("ordinary scheduling requires overlap acceptance while ignored suggestions write nothing", async () => {
  const f = setup();
  f.tasks.push(task(2, { title: "Dentist", start: "2026-10-29T10:15:00-03:00", end: "2026-10-29T11:00:00-03:00" }));
  const input = { conversationId: "conv_test", intent: "requested", command: f.command() };
  const rejected = await f.post("commands", input);
  expect(rejected.status).toBe(409); expect(((await rejected.json()) as { message: string }).message).toContain("Dentist. Schedule anyway?");
  expect(f.writes).toHaveLength(0);
  expect((await f.post("commands", { ...input, overlapConfirmed: true })).status).toBe(200);
  expect(f.writes).toHaveLength(1);
  const before = f.rows.size;
  expect((await f.post("commands", { ...input, intent: "suggested", command: f.command() })).status).toBe(409);
  expect(f.rows.size).toBe(before);
});

test("headless ordinary commands support lifecycle, trash, category and priority without client hooks", async () => {
  const f = setup();
  const edits = [
    { closure: { before: { outcome: "open" }, after: { outcome: "completed" } } },
    { trash: { before: false, after: true } },
    { fields: { Category: { before: null, after: "Fitness" } } },
    { fields: { "Top priority": { before: null, after: "Yes" } } },
  ];
  for (const edit of edits) {
    const command = { commandId: crypto.randomUUID(), number: 1, revision: f.tasks[0].updatedAt, ...edit };
    expect((await f.post("commands", { conversationId: "conv_test", intent: "requested", command })).status).toBe(200);
  }
  expect(f.writes).toHaveLength(4);
});

test("ended conversations deny new mutations but retain exact receipt reconciliation", async () => {
  const f = setup();
  const input = { conversationId: "conv_test", intent: "requested", command: f.command() };
  expect((await f.post("commands", input)).status).toBe(200);
  f.endConversation();
  expect((await f.post("commands", input)).status).toBe(200);
  expect((await f.post("commands", { ...input, command: f.command() })).status).toBe(409);
  expect(f.writes).toHaveLength(1);
});
