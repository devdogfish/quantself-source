import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { registerTodoRoutes } from "./todos-route";
import { registerJarvisCommands } from "./todos-jarvis-commands";
import { createTodoWriter, type CommandJournal, type TodoCommand } from "./todos-write";
import { TodoReadError, type Todo, type TodoReader } from "./todos-github";
import { readTodoSchedule } from "./todos-schedule";
import { readTodoTrash } from "./todos-trash";

async function json(response: Response) {
  return await response.json() as { todo: Todo; todos: Todo[]; outcomes: Record<string, string>; commands: { trash?: boolean; outcomes: Record<string, string> }[] };
}

function fixture() {
  const tasks: Todo[] = [];
  const writes: unknown[] = [];
  const receipts = new Map<string, any>();
  let lost = false, dropped = false, serial = 0;
  const journal: CommandJournal = {
    async reserve(key, hash) {
      if (receipts.has(key)) return { fresh: false, ...structuredClone(receipts.get(key)) };
      const row = { hash, state: { done: {} } };
      receipts.set(key, row);
      return { fresh: true, ...structuredClone(row) };
    },
    async save(key, state) { receipts.get(key).state = structuredClone(state); },
  };
  const reader: TodoReader = {
    list: async () => structuredClone(tasks),
    detail: async number => {
      const task = tasks.find(task => task.number === number);
      if (!task) throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
      return structuredClone(task);
    },
  };
  const connect = async () => ({
    repository: "example/tasks",
    definitions: [{ id: 2, name: "Location", data_type: "text" }, { id: 1, name: "Commitment", data_type: "single_select", options: [{ name: "Inbox" }] }],
    async request(path: string, method: string, body: any) {
      writes.push({ path, method, body });
      if (dropped) { dropped = false; throw Error("Delivery uncertain"); }
      if (path.endsWith("/issues")) {
        const number = tasks.length + 1;
        tasks.push({ id: `I_${number}`, databaseId: number, number, repository: "example/tasks", url: `https://github.com/example/tasks/issues/${number}`, title: body.title, body: body.body, issueType: "Task", state: "open", closureReason: null, updatedAt: `revision-${++serial}`, labels: body.labels, fields: {}, fieldValues: [], ...readTodoSchedule(body.body) });
        return { number, type: { name: "Task" } };
      }
      const task = tasks.find(task => task.number === Number(path.match(/issues\/(\d+)/)?.[1]))!;
      if (path.endsWith("/comments")) {
        (task.comments ??= []).push({ id: serial, body: body.body, url: "https://github.com/comment", updatedAt: `revision-${serial}` });
      } else if (method === "PATCH") {
        Object.assign(task, body, { updatedAt: `revision-${++serial}` });
        if (body.state) task.closureReason = body.state === "open" ? null : body.state_reason;
        Object.assign(task, readTodoSchedule(task.body));
        const trash = readTodoTrash(task.body, task);
        Object.assign(task, { trashed: trash.trashed, trashError: trash.trashError });
      } else if (path.endsWith("/issue-field-values")) { for (const field of body.issue_field_values) task.fields[field.field_id === 2 ? "Location" : "Commitment"] = field.value; }
      else if (method === "DELETE" && path.endsWith("/issue-field-values/2")) delete task.fields.Location;
      if (lost) { lost = false; throw Error("Response lost after mutation"); }
      return {};
    },
    async syncProject() {},
  });
  reader.write = createTodoWriter({ reader, journal, connect });
  let permissions = ["todos:read", "todos:write"];
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (context, next) => {
    context.set("accessContext", { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "jarvis", name: "Jarvis", kind: "web" }, permissions });
    await next();
  });
  registerTodoRoutes(app, reader);
  const captureId = crypto.randomUUID();
  const rows = new Map<string, any>([[`jarvis:${captureId}`, { input: { owner: "owner" }, result: null }]]);
  registerJarvisCommands(app, reader, {
    async get(key) { return rows.get(key) ?? null; },
    async reserve(key, input) {
      if (rows.has(key)) {
        if (JSON.stringify(rows.get(key).input) !== JSON.stringify(input)) throw Error("Receipt conflict");
        return rows.get(key);
      }
      const row = { input, result: null }; rows.set(key, row); return row;
    },
    async save(key, result) { rows.get(key).result = result; },
    async list(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row); },
  }, {
    agentId: () => "agent",
    temporaryAccess: async () => "wss://example",
    audio: async () => { throw Error("Not used"); },
    finalConversation: async () => ({ agentId: "agent", userId: captureId, conversationId: "conv_crud", done: false, capturedAt: "2026-10-26T12:00:00Z", conversation: [] }),
  });
  const voice = async (command: TodoCommand) => app.request(`/api/v1/todo-jarvis/${captureId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conv_crud", intent: "requested", command: JSON.stringify(command) }) });
  const trash = (after: boolean) => ({ commandId: crypto.randomUUID(), number: 1, revision: tasks[0]!.updatedAt, trash: { before: !after, after } });
  return { app, tasks, writes, voice, trash, reader, captureId, permissions: (next: string[]) => { permissions = next; }, loseResponse: () => { lost = true; }, dropWrite: () => { dropped = true; }, restart: () => { reader.write = createTodoWriter({ reader, journal, connect }); } };
}

test("voice CRUD: create, read, edit, trash and restore preserve task identity, history and timing", async () => {
  const f = fixture();
  const created = await f.voice({ commandId: crypto.randomUUID(), title: "Call plumber", description: "Keep this description", start: "2026-11-02T09:00:00-04:00", end: "2026-11-02T10:30:00-04:00", fixed: true });
  expect(created.status).toBe(200);
  expect((await json(created)).outcomes.issue).toBe("saved");
  expect((await json(await f.app.request("/api/v1/todos/1"))).todo.title).toBe("Call plumber");
  const edit = await f.voice({ commandId: crypto.randomUUID(), number: 1, title: { before: "Call plumber", after: "Call plumber about sink" } });
  expect((await json(edit)).outcomes.title).toBe("saved");
  const original = structuredClone(f.tasks[0]!);
  expect(original.start).toBe("2026-11-02T09:00:00-04:00");
  const moved = await f.voice(f.trash(true));
  expect((await json(moved)).outcomes.trash).toBe("saved");
  expect(f.tasks[0]).toMatchObject({ id: original.id, state: "closed", closureReason: "not_planned", trashed: true, start: original.start, end: original.end });
  expect((await json(await f.app.request("/api/v1/todos"))).todos).toEqual([]);
  const listed = (await json(await f.app.request("/api/v1/todos?trash=only"))).todos;
  expect(listed).toHaveLength(1);
  expect(listed[0].title).toBe("Call plumber about sink");
  expect((await f.voice(f.trash(false))).status).toBe(200);
  expect(f.tasks[0]).toMatchObject({ state: "open", trashed: false, body: original.body });
  expect(f.tasks[0]).toMatchObject({ start: original.start, end: original.end, fixed: true });
  expect(f.tasks[0]!.comments?.length).toBeGreaterThanOrEqual(original.comments!.length);
  expect((await json(await f.app.request("/api/v1/todos"))).todos).toHaveLength(1);
  const outcomes = await json(await f.app.request(`/api/v1/todo-jarvis/${f.captureId}/commands`));
  expect(outcomes.commands.some((row: any) => row.trash === true && row.outcomes.trash === "saved")).toBe(true);
});

test("trash handles lost responses, survives restart and never re-trashes a restored task on replay", async () => {
  const f = fixture();
  await f.voice({ commandId: crypto.randomUUID(), title: "Keep history" });
  const command = f.trash(true);
  f.loseResponse();
  expect((await json(await f.voice(command))).outcomes.trash).toBe("saved");
  await f.voice(f.trash(false));
  const writes = f.writes.length;
  f.restart();
  expect((await json(await f.voice(command))).outcomes.trash).toBe("conflict");
  expect(f.writes).toHaveLength(writes);
  expect(f.tasks[0]!.trashed).toBe(false);
});

test("stale or malformed trash commands do not mutate; uncertain attempts are not blindly resent", async () => {
  const f = fixture();
  await f.voice({ commandId: crypto.randomUUID(), title: "Review first" });
  const writes = f.writes.length;
  expect((await json(await f.voice({ ...f.trash(true), revision: "old" }))).outcomes.trash).toBe("conflict");
  // Source comments may be added, but no task PATCH is sent for a rejected target revision.
  expect(f.writes.slice(writes).some((row: any) => row.method === "PATCH")).toBe(false);
  const invalid = await f.voice({ ...f.trash(true), title: { before: "Review first", after: "Mixed edit" } });
  expect(invalid.status).toBe(400);
  const command = f.trash(true);
  f.dropWrite();
  expect((await json(await f.voice(command))).outcomes.trash).toBe("uncertain");
  const count = f.writes.length;
  f.restart();
  expect((await json(await f.voice(command))).outcomes.trash).toBe("uncertain");
  expect(f.writes).toHaveLength(count);
  expect(f.tasks[0]!.trashed).not.toBe(true);
  f.permissions(["todos:read"]);
  expect((await f.voice(f.trash(true))).status).toBe(403);
});

test("trash preserves prior completion and retains malformed metadata for explicit repair", async () => {
  const f = fixture();
  await f.voice({ commandId: crypto.randomUUID(), title: "Completed task" });
  Object.assign(f.tasks[0]!, { state: "closed", closureReason: "completed" });
  await f.voice(f.trash(true));
  await f.voice(f.trash(false));
  expect(f.tasks[0]).toMatchObject({ state: "closed", closureReason: "completed", trashed: false });
  expect(readTodoTrash("Note\n<!-- quantself:trash broken -->")).toMatchObject({ trashed: true, trashError: expect.any(String) });
  expect(readTodoTrash("<!-- quantself:trash {\"version\":1,\"reopen\":true} -->\n<!-- quantself:trash {\"version\":1,\"reopen\":false} -->").trashError).toBeTruthy();
  const malformed = `${f.tasks[0]!.body}\n<!-- quantself:trash broken -->`;
  Object.assign(f.tasks[0]!, { body: malformed, trashed: true, trashError: readTodoTrash(malformed).trashError });
  expect((await json(await f.voice(f.trash(false)))).outcomes.trash).toBe("conflict");
  expect(f.tasks[0]!.body).toBe(malformed);
});

test("restore preserves a later completion made outside Quantself", async () => {
  const f = fixture();
  await f.voice({ commandId: crypto.randomUUID(), title: "Completed elsewhere" });
  await f.voice(f.trash(true));
  Object.assign(f.tasks[0]!, { state: "closed", closureReason: "completed", updatedAt: "external-revision" });
  expect((await json(await f.voice(f.trash(false)))).outcomes.trash).toBe("saved");
  expect(f.tasks[0]).toMatchObject({ state: "closed", closureReason: "completed", trashed: false });
});

test("Jarvis JSON commands create, edit and clear description and location", async () => {
  const f = fixture();
  const create = await f.voice({ commandId: crypto.randomUUID(), title: "Visit", description: "Bring documents", fields: { Location: "Office" } });
  expect(create.status).toBe(200);
  expect((await json(create)).todo).toMatchObject({ description: "Bring documents", fields: { Location: "Office" } });
  const edit = await f.voice({ commandId: crypto.randomUUID(), number: 1, description: { before: "Bring documents", after: "Bring originals" }, fields: { Location: { before: "Office", after: "Home" } } });
  expect(edit.status).toBe(200);
  const edited = await json(edit);
  expect(edited.outcomes).toMatchObject({ description: "saved", Location: "saved" });
  expect(edited.todo).toMatchObject({ description: "Bring originals", fields: { Location: "Home" } });
  const clear = await f.voice({ commandId: crypto.randomUUID(), number: 1, description: { before: "Bring originals", after: "" }, fields: { Location: { before: "Home", after: null } } });
  expect((await json(clear)).todo).toMatchObject({ description: "", fields: { Commitment: "Inbox" } });
});

test("native not-planned closure can be restored without a custom marker; duplicates stay distinct", async () => {
  const f = fixture();
  await f.voice({ commandId: crypto.randomUUID(), title: "Native trash" });
  const task = f.tasks[0]!;
  Object.assign(task, { state: "closed", closureReason: "not_planned", updatedAt: "external-close" });
  Object.assign(task, readTodoTrash(task.body, task));
  expect(task.trashed).toBe(true);
  const originalBody = task.body;
  expect((await json(await f.app.request("/api/v1/todos?trash=only"))).todos).toHaveLength(1);
  expect((await json(await f.voice(f.trash(false)))).outcomes.trash).toBe("saved");
  expect(task).toMatchObject({ state: "open", trashed: false, body: originalBody });
  expect(readTodoTrash(null, { state: "closed", closureReason: "not_planned", duplicateOf: { number: 2 } }).trashed).toBe(false);
});
