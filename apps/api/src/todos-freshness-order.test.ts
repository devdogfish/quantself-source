import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createTodoFreshness, type TodoCacheStore } from "./todos-freshness";
import { memoryTodoCache } from "./todos-freshness-store";
import { registerTodoRoutes } from "./todos-route";
import type { Todo, TodoReader } from "./todos-github";

test("cached API, snapshots and restarted projections retain Rank then identity order after single-task changes", async () => {
  const todo = (number: number, rank?: number) => ({ number, id: `I${number}`, title: `Task ${number}`, fields: rank === undefined ? {} : { Rank: rank }, state: "open", updatedAt: "2026-10-28T01:00:00Z" }) as Todo;
  let rows = [todo(1, 1), todo(2, 2), todo(3, 2), todo(4), todo(5)];
  let listReads = 0, detailReads = 0;
  const source: TodoReader = { list: async () => { listReads++; return structuredClone(rows); }, detail: async number => { detailReads++; return structuredClone(rows.find(row => row.number === number)!); } };
  const store = memoryTodoCache();
  const cache = createTodoFreshness(source, store);
  const app = new OpenAPIHono<any>();
  app.use("*", async (context, next) => {
    context.set("accessContext", { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "web", name: "Web", kind: "web" }, permissions: ["todos:read"] });
    await next();
  });
  registerTodoRoutes(app, cache.reader);
  let restarted: ReturnType<typeof createTodoFreshness> | undefined;
  const numbers = (todos: Todo[]) => todos.map(todo => todo.number);
  const expectOrder = async (expected: number[]) => {
    const response = await app.request("/api/v1/todos");
    expect(response.status).toBe(200);
    expect(numbers((await response.json() as { todos: Todo[] }).todos)).toEqual(expected);
    expect(numbers((await cache.snapshot()).todos)).toEqual(expected);
  };
  try {
    await expectOrder([1, 2, 3, 4, 5]);
    await cache.record({ ...rows[0], title: "First remains first" });
    await cache.record({ ...rows[1], title: "Equal rank retains stable identity" });
    await cache.record({ ...rows[3], title: "Unranked stable identity" });
    await expectOrder([1, 2, 3, 4, 5]);
    rows = rows.map(row => row.number === 3 ? { ...row, fields: { Rank: 0 } } : row);
    await cache.invalidate([3]); await cache.refresh();
    await expectOrder([3, 1, 2, 4, 5]);
    // PostgreSQL findMany has no ordering guarantee; a restarted coordinator must normalize it.
    const unorderedStore: TodoCacheStore = { ...store, load: async () => { const value = await store.load(); value.todos.reverse(); return value; } };
    restarted = createTodoFreshness(source, unorderedStore);
    expect(numbers(await restarted.reader.list())).toEqual([3, 1, 2, 4, 5]);
    expect(numbers((await restarted.snapshot()).todos)).toEqual([3, 1, 2, 4, 5]);
    expect({ listReads, detailReads }).toEqual({ listReads: 1, detailReads: 1 });
  } finally { cache.stop(); restarted?.stop(); }
});
