import { expect, test } from "bun:test";
import { CategoryPermissionError, categorySnapshot, changedCategories, categoryCommandSchema } from "./todos-categories";
import { createApp } from "./app";
const snapshot = categorySnapshot({ id: 1, options: [{ id: 10, name: "Work", color: "blue", priority: 3, description: "Keep me" }, { id: 20, name: "Home", color: "green" }] });
const command = { commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", revision: snapshot.revision, action: "update" as const, id: 10, name: "Studio", color: "purple" as const };
test("category changes retain option IDs and metadata, support arbitrary names and reject stale revisions", () => {
  expect(changedCategories(snapshot, command)).toEqual([{ id: 10, name: "Studio", color: "purple", priority: 3, description: "Keep me" }, snapshot.categories[1]]);
  expect(changedCategories(snapshot, { ...command, action: "create", id: undefined, name: "Gardening" })).toHaveLength(3);
  expect(() => changedCategories(snapshot, { ...command, revision: "stale" })).toThrow("Categories changed");
  expect(() => changedCategories(snapshot, { ...command, name: "HOME" })).toThrow("already exists");
  expect(categoryCommandSchema.safeParse({ ...command, color: "#ff00ff" }).success).toBe(false);
  expect(categoryCommandSchema.safeParse({ ...command, name: " " }).success).toBe(false);
});
test("category APIs authorize before accessing GitHub and reject invalid commands", async () => {
  let reads = 0, writes = 0, denyGitHubWrite = false;
  for (const [permissions, getStatus, postStatus] of [[[], 403, 403], [["todos:read"], 200, 403], [["todos:read", "todos:write"], 200, 200]] as const) {
    const app = createApp({ emitAccessLog: () => {}, resolveAccessContext: async () => ({ owner: { id: "owner", name: "Owner", email: "owner@example.com" }, client: { id: "client", name: "Client", kind: "api-key" }, permissions: [...permissions] }), todos: { list: async () => [], detail: async () => { throw Error("unused"); }, categories: { list: async () => { reads++; return snapshot; }, write: async () => { if (denyGitHubWrite) throw new CategoryPermissionError("GitHub App needs Issue Fields write access."); writes++; return snapshot; } } } });
    expect((await app.request("/api/v1/todo-categories")).status).toBe(getStatus);
    expect((await app.request("/api/v1/todo-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) })).status).toBe(postStatus);
    expect((await app.request("/api/v1/todo-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...command, color: "invalid" }) })).status).toBe(400);
    if (postStatus === 200) {
      denyGitHubWrite = true;
      const refused = await app.request("/api/v1/todo-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      expect(refused.status).toBe(403);
      expect((await refused.json() as { code: string }).code).toBe("TODO_CATEGORY_PERMISSION");
      denyGitHubWrite = false;
    }
  }
  expect(reads).toBe(2); expect(writes).toBe(1);
});

test("task reads expose category options only on request, once without changing ordinary reads", async () => {
  let taskReads = 0, categoryReads = 0;
  let releaseTasks!: () => void;
  const heldTasks = new Promise<void>(resolve => { releaseTasks = resolve; });
  let permissions = ["todos:read"];
  const app = createApp({ emitAccessLog() {}, resolveAccessContext: async () => ({ owner: { id: "owner", name: "Owner", email: "owner@example.com" }, client: { id: "jarvis", name: "Jarvis", kind: "api-key" }, permissions }), todos: {
    list: async () => { taskReads++; if (taskReads === 1) await heldTasks; return []; }, detail: async () => { throw Error("Unused"); },
    categories: { list: async () => { categoryReads++; return snapshot; }, write: async () => { throw Error("Read only"); } },
  } });
  const pendingResponse = app.request("/api/v1/todos?includeCategories=true");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(categoryReads).toBe(1); // Metadata starts while the task read is still held.
  releaseTasks();
  const response = await pendingResponse;
  expect(response.status).toBe(200);
  expect((await response.json() as any).categories).toEqual(snapshot.categories);
  expect([taskReads, categoryReads]).toEqual([1, 1]);
  const ordinary = await app.request("/api/v1/todos");
  expect((await ordinary.json() as any).categories).toBeUndefined();
  expect([taskReads, categoryReads]).toEqual([2, 1]);
  permissions = [];
  expect((await app.request("/api/v1/todos?includeCategories=true")).status).toBe(403);
  expect([taskReads, categoryReads]).toEqual([2, 1]);
});
