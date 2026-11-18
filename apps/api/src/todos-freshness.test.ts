import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createTodoFreshness } from "./todos-freshness";
import { memoryTodoCache } from "./todos-freshness-store";
import { registerTodoFreshnessRoutes } from "./todos-freshness-route";
import { TodoReadError, type Todo, type TodoReader } from "./todos-github";
const todo = (number = 1, title = "Before") => ({ number, title, id: `I${number}`, fields: {}, state: "open", updatedAt: "2026-10-28T01:00:00Z" }) as Todo;
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => resolve = r), resolve }; };
function fixture(now?: () => number) {
  let rows = [todo()]; let listCalls = 0; let detailCalls = 0; let error: Error | undefined;
  const source: TodoReader = { list: async () => { listCalls++; if (error) throw error; return structuredClone(rows); }, detail: async number => { detailCalls++; if (error) throw error; const value = rows.find(row => row.number === number); if (!value) throw new TodoReadError("TODO_NOT_FOUND", "Gone"); return structuredClone(value); } };
  const store = memoryTodoCache(); const cache = createTodoFreshness(source, store, now);
  return { cache, store, source, set: (value: Todo[]) => rows = value, fail: (value: Error) => error = value, counts: () => ({ listCalls, detailCalls }) };
}
test("shutdown closes a live stream without waiting for its heartbeat", async () => {
  const f = fixture(), shutdown = new AbortController();
  const access = { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "web", name: "Web", kind: "web" as const }, permissions: ["todos:read"] };
  const app = new OpenAPIHono<any>();
  app.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  registerTodoFreshnessRoutes(app, f.cache, { heartbeatMs: 60_000, shutdownSignal: shutdown.signal, resolveAccessContext: async () => access });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const response = await fetch(new URL("/api/v1/todos/live", server.url));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("snapshot");
    shutdown.abort();
    while (!(await reader.read()).done) { /* Consume any already-written frame. */ }
    await server.stop();
  } finally { shutdown.abort(); await server.stop(true); await f.cache.stop(); }
}, 1500);

test("cache shutdown waits for a refresh and prevents its dirty retry from rescheduling", async () => {
  const f = fixture(), entered = deferred<void>(), pending = deferred<Todo[]>();
  let calls = 0, stopped = false;
  f.source.list = async () => { calls++; entered.resolve(); return pending.promise; };
  const refreshing = f.cache.refresh();
  await entered.promise;
  await f.cache.invalidate(); // Makes the in-flight result stale, normally scheduling another fetch.
  const stopping = f.cache.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  pending.resolve([todo()]); await refreshing; await stopping;
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(calls).toBe(1); expect(stopped).toBe(true);
});
test("warm cached reads coalesce cold population and wait on zero GitHub calls", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 20 }, () => f.cache.reader.list()));
  expect(f.counts()).toEqual({ listCalls: 1, detailCalls: 0 });
  await f.cache.reader.list();
  expect(f.counts().listCalls).toBe(1);
  // Validation scans deliberately bypass the read cache.
  await f.cache.reader.list("relationships");
  expect(f.counts().listCalls).toBe(2);
  f.cache.stop();
});
test("booking availability coalesces cold and expired refreshes and waits for known timing changes", async () => {
  let now = Date.parse("2026-11-17T12:00:00Z");
  const f = fixture(() => now);
  const read = f.cache.reader.listForBookingAvailability!;
  try {
    await Promise.all([read(), read()]);
    await Promise.all([read(), read()]);
    expect(f.counts()).toEqual({ listCalls: 1, detailCalls: 0 });

    f.set([todo(1, "Moved")]);
    await f.cache.invalidate([1]);
    expect((await Promise.all([read(), read()])).map(rows => rows[0]?.title)).toEqual(["Moved", "Moved"]);
    expect(f.counts()).toEqual({ listCalls: 1, detailCalls: 1 });

    now += 60_000;
    f.set([todo(1, "Changed outside Quantself")]);
    expect((await Promise.all([read(), read()])).map(rows => rows[0]?.title)).toEqual(["Changed outside Quantself", "Changed outside Quantself"]);
    expect(f.counts()).toEqual({ listCalls: 2, detailCalls: 1 });

    f.fail(new Error("GitHub unavailable"));
    await f.cache.invalidate([1]);
    await expect(read()).rejects.toMatchObject({ code: "TODO_UNAVAILABLE" });
    await expect(read()).rejects.toMatchObject({ code: "TODO_UNAVAILABLE" });
    expect(f.counts()).toEqual({ listCalls: 2, detailCalls: 2 });
  } finally { await f.cache.stop(); }
});
test("a hand-back republishes just its cached task without a GitHub request", async () => {
  const f = fixture();
  try {
    f.set([todo(1), todo(2)]);
    await f.cache.reader.list();
    const { generation } = await f.cache.status();
    expect(await f.cache.projectChanged(1)).toBe(true);
    expect(await f.cache.events(generation)).toMatchObject([{ upserts: [{ number: 1 }], removed: [] }]);
    expect(f.counts()).toEqual({ listCalls: 1, detailCalls: 0 });
  } finally { await f.cache.stop(); }
});
test("older refresh cannot overwrite a verified write even with identical GitHub timestamp", async () => {
  const f = fixture(); await f.cache.reader.list();
  const pending = deferred<Todo[]>(); f.source.list = () => pending.promise;
  await f.cache.invalidate(); const refreshing = f.cache.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.cache.record(todo(1, "Owner's later edit"));
  pending.resolve([todo(1, "Old snapshot")]); await refreshing;
  expect((await f.cache.reader.list())[0].title).toBe("Owner's later edit");
  expect((await f.cache.status()).dirty.all).toBeDefined();
  f.cache.stop();
});
test("targeted refresh shares upstream read, tombstones missing issue and persists replay", async () => {
  const f = fixture(); await f.cache.reader.list();
  const baseline = (await f.cache.status()).generation;
  f.set([todo(1, "Changed")]);
  await f.cache.invalidate([1], "delivery-1");
  expect(await f.cache.invalidate([1], "delivery-1")).toBe(false);
  await Promise.all([f.cache.refresh(), f.cache.refresh()]);
  expect(f.counts()).toEqual({ listCalls: 1, detailCalls: 1 });
  expect((await f.cache.events(baseline)).at(-1)?.upserts?.[0].title).toBe("Changed");
  f.set([]); await f.cache.invalidate([1], "delivery-2"); await f.cache.refresh();
  expect(await f.cache.reader.list()).toEqual([]);
  expect((await f.cache.events(baseline)).at(-1)?.removed).toEqual([1]);
  f.cache.stop();
  const restarted = createTodoFreshness(f.source, f.store);
  expect(await restarted.reader.list()).toEqual([]);
  expect((await restarted.events(baseline)).length).toBeGreaterThan(0);
  restarted.stop();
});
test("outage retains stale complete data; cold failure never publishes partial empty success; revocation clears", async () => {
  const f = fixture(); await f.cache.reader.list();
  f.fail(new TodoReadError("TODO_UNAVAILABLE", "Rate limited", 30));
  await f.cache.invalidate(); await f.cache.refresh();
  expect((await f.cache.reader.list())[0].title).toBe("Before");
  expect((await f.cache.reader.freshness!()).stale).toBe(true);
  await f.cache.invalidate(undefined, "revoked", true);
  await expect(f.cache.reader.list()).rejects.toThrow("revoked");
  expect(f.store.inspect().todos).toEqual([]); f.cache.stop();
  const cold = fixture(); cold.fail(Error("Incomplete pagination"));
  await expect(cold.cache.reader.list()).rejects.toThrow("Incomplete pagination");
  expect(cold.store.inspect().meta.complete).toBe(false); cold.cache.stop();
});
test("webhook signature, scope, issue fields and durable duplicate receipts", async () => {
  const f = fixture(); await f.cache.reader.list();
  const app = new OpenAPIHono<any>();
  const env = { QUANTSELF_GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret", QUANTSELF_GITHUB_INSTALLATION_ID: "123", QUANTSELF_TODO_REPOSITORY: "fixture/todos" };
  registerTodoFreshnessRoutes(app, f.cache, { env, resolveAccessContext: async () => null });
  const send = (payload: unknown, delivery: string, signature?: string, event = "issues") => {
    const raw = JSON.stringify(payload);
    return app.request("/api/todo-webhooks/github", { method: "POST", body: raw, headers: { "x-github-delivery": delivery, "x-github-event": event, "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", env.QUANTSELF_GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}` } });
  };
  const initialRevision = f.store.inspect().revision;
  expect((await send({ zen: "Keep it simple", hook: { id: 7 } }, "ping", undefined, "ping")).status).toBe(200);
  expect(f.store.inspect().revision).toBe(initialRevision);
  expect((await send({}, "ping-bad", "invalid", "ping")).status).toBe(401);
  const payload = { installation: { id: 123 }, repository: { full_name: "fixture/todos" }, issue: { number: 1 }, action: "field_added" };
  expect((await send(payload, "one", "invalid")).status).toBe(401);
  expect((await send({ ...payload, repository: { full_name: "other/repo" } }, "one")).status).toBe(403);
  expect((await send(payload, "one")).status).toBe(202);
  expect(await (await send(payload, "one")).json()).toMatchObject({ duplicate: true });
  expect(f.store.inspect().meta.dirty[1]).toBeDefined();
  expect(f.counts().detailCalls).toBe(0); // acknowledgement never waits for refetch
  f.cache.stop();
});
test("SSE begins with a coherent snapshot and revocation ends protected delivery", async () => {
  const f = fixture();
  const access = { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "web", name: "Web", kind: "web" as const }, permissions: ["todos:read"] };
  let allowed = true;
  const app = new OpenAPIHono<any>(); app.use("*", async (c,next) => { c.set("accessContext", access); await next(); });
  registerTodoFreshnessRoutes(app, f.cache, { heartbeatMs: 1, resolveAccessContext: async () => allowed ? access : null });
  const response = await app.request("/api/v1/todos/live");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-transform");
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  expect(text).toContain("event: snapshot"); expect(text).toContain('"generation":1');
  allowed = false;
  while (!text.includes("access-denied")) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
  expect(text).toContain("access-denied");
  await reader.cancel(); f.cache.stop();
});

test("known revoked installation refuses HTTP reads and immediately clears a new stream", async () => {
  const f = fixture(); await f.cache.reader.list(); await f.cache.invalidate(undefined, "revoke-before-connect", true);
  const access = { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "web", name: "Web", kind: "web" as const }, permissions: ["todos:read"] };
  const app = new OpenAPIHono<any>(); app.use("*", async (c,next) => { c.set("accessContext", access); await next(); });
  const { registerTodoRoutes } = await import("./todos-route");
  registerTodoFreshnessRoutes(app, f.cache, { resolveAccessContext: async () => access });
  registerTodoRoutes(app, f.cache.reader);
  const denied = await app.request("/api/v1/todos");
  expect(denied.status).toBe(403);
  const stream = await app.request("/api/v1/todos/live");
  expect(await stream.text()).toContain("access-denied");
  f.cache.stop();
});

test("upstream access denial purges projected tasks and categories without a webhook", async () => {
  const f = fixture(); await f.cache.reader.list();
  f.fail(new TodoReadError("TODO_ACCESS_DENIED", "GitHub denied access"));
  await f.cache.invalidate(); await f.cache.refresh();
  await expect(f.cache.reader.list()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
  expect(f.store.inspect().todos).toEqual([]);
  expect(f.store.inspect().meta.categories).toBeUndefined();
  expect((await f.cache.events(0)).at(-1)?.revoked).toBe(true);
  f.cache.stop();
});

test("revision conflicts reload durable state and rebase invalidations", async () => {
  const f = fixture(); await f.cache.reader.list();
  const other = createTodoFreshness(f.source, f.store); await other.reader.list();
  await f.cache.record(todo(1, "Concurrent write"));
  await other.invalidate([1], "later-webhook");
  expect((await other.reader.list())[0].title).toBe("Concurrent write");
  expect(f.store.inspect().meta.dirty[1]).toBeDefined();
  expect(await other.invalidate([1], "later-webhook")).toBe(false);
  other.stop(); f.cache.stop();
});

test("late same-second writer responses reconcile before publishing over a newer write", async () => {
  const older = deferred<any>(), newer = deferred<any>();
  let authoritative = todo(1, "Original"), reads = 0;
  const result = (value: Todo) => ({ todo: value, commandId: "command", outcomes: { title: "saved" as const }, retryable: false, message: "Saved" });
  const source: TodoReader = { list: async () => [authoritative], detail: async () => { reads++; return structuredClone(authoritative); }, write: async (_client, command) => command.commandId === "older" ? older.promise : newer.promise };
  const cache = createTodoFreshness(source, memoryTodoCache()); await cache.reader.list();
  const first = cache.reader.write!("owner", { commandId: "older", title: "Older" });
  const second = cache.reader.write!("owner", { commandId: "newer", title: "Newer" });
  authoritative = todo(1, "Newer"); newer.resolve(result(authoritative)); await second;
  older.resolve(result(todo(1, "Older"))); const reconciled = await first;
  expect(reconciled.todo?.title).toBe("Newer"); expect(reads).toBe(1);
  expect((await cache.reader.list())[0].title).toBe("Newer");
  expect((await cache.events(0)).flatMap(event => event.upserts ?? []).map(row => row.title)).not.toContain("Older");
  cache.stop();
});

test("revocation during a pending write never repopulates protected records", async () => {
  const pending = deferred<any>();
  const source: TodoReader = { list: async () => [todo()], detail: async () => todo(), write: () => pending.promise };
  const store = memoryTodoCache(), cache = createTodoFreshness(source, store); await cache.reader.list();
  const write = cache.reader.write!("owner", { commandId: "pending", title: "Changed" });
  await cache.invalidate(undefined, "revoked-while-writing", true);
  pending.resolve({ todo: todo(1, "Changed"), outcomes: { title: "saved" }, message: "Saved", retryable: false });
  await expect(write).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
  expect(store.inspect().todos).toEqual([]); expect(store.inspect().meta.revoked).toBe(true);
  cache.stop();
});

test("revoking browser permission during a cold snapshot prevents its first protected event", async () => {
  const f = fixture(), pending = deferred<Todo[]>(), entered = deferred<void>();
  f.source.list = async () => { entered.resolve(); return pending.promise; };
  const access = { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "web", name: "Web", kind: "web" as const }, permissions: ["todos:read"] };
  let allowed = true;
  const app = new OpenAPIHono<any>(); app.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  registerTodoFreshnessRoutes(app, f.cache, { resolveAccessContext: async () => allowed ? access : null });
  const response = await app.request("/api/v1/todos/live"); await entered.promise;
  allowed = false; pending.resolve([todo()]);
  const text = await response.text();
  expect(text).toContain("access-denied"); expect(text).not.toContain("event: snapshot"); expect(text).not.toContain("Before");
  f.cache.stop();
});
