import { expect, test } from "bun:test";
import { createTodoFreshness, type TodoCacheStore } from "./todos-freshness";
import { memoryTodoCache } from "./todos-freshness-store";
import type { Todo, TodoReader } from "./todos-github";

const todo = (title = "Original") => ({ number: 1, id: "I1", title, fields: {}, state: "open", updatedAt: "2026-10-28T01:00:00Z" }) as Todo;
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => resolve = r), resolve }; };

test("warm coordinators observe durable updates and revocation with coalesced revision-only reads", async () => {
  const durable = memoryTodoCache();
  let loads = 0, revisionReads = 0, upstreamReads = 0;
  const store: TodoCacheStore = { ...durable,
    load: async () => { loads++; return durable.load(); },
    revision: async () => { revisionReads++; return durable.revision!(); },
  };
  const source: TodoReader = { list: async () => { upstreamReads++; return [todo()]; }, detail: async () => { upstreamReads++; return todo(); } };
  const first = createTodoFreshness(source, durable), second = createTodoFreshness(source, store);
  try {
    await first.reader.list(); await second.reader.list();
    loads = 0; revisionReads = 0;
    await Promise.all(Array.from({ length: 20 }, () => second.reader.list()));
    expect({ loads, revisionReads, upstreamReads }).toEqual({ loads: 0, revisionReads: 1, upstreamReads: 1 });
    await first.record(todo("Edited in another process"));
    expect((await second.reader.list())[0].title).toBe("Edited in another process");
    expect(loads).toBe(1);
    expect((await second.snapshot()).todos[0].title).toBe("Edited in another process");
    expect(loads).toBe(1); // snapshots do not reload unchanged projection rows
    await first.invalidate(undefined, "cross-process-revocation", true);
    expect((await second.status()).revoked).toBe(true);
    expect(loads).toBe(2);
    await expect(second.reader.list()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
    await expect(second.reader.list("relationships")).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
    await expect(second.reader.detail(1)).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
    await expect(second.snapshot()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
    expect(upstreamReads).toBe(1);
  } finally { first.stop(); second.stop(); }
});

test("a delayed durable revision probe cannot regress a newer local write", async () => {
  const durable = memoryTodoCache();
  const delayed = deferred<number>();
  let pause = false;
  const store: TodoCacheStore = { ...durable, revision: async () => pause ? delayed.promise : durable.revision!() };
  const source: TodoReader = { list: async () => [todo()], detail: async () => todo() };
  const cache = createTodoFreshness(source, store);
  try {
    await cache.reader.list();
    const oldRevision = await durable.revision!();
    pause = true;
    const pendingRead = cache.reader.list();
    await Promise.resolve();
    await cache.record(todo("Newer local write"));
    delayed.resolve(oldRevision);
    expect((await pendingRead)[0].title).toBe("Newer local write");
    expect((await cache.snapshot()).todos[0].title).toBe("Newer local write");
  } finally { delayed.resolve(0); cache.stop(); }
});


test("historical cache rows and replay expose Category without rereading GitHub", async () => {
  const legacy = { ...todo(), fields: { Area: "Work" } };
  const mixed = { ...todo(), number: 2, id: "I2", fields: { Area: "Work", Category: "Home" } };
  let reads = 0;
  const store: TodoCacheStore = {
    load: async () => ({ revision: 1, generation: 1, todos: [legacy, mixed], meta: { complete: true, readAt: "2026-10-28T01:00:00Z", dirty: {}, epoch: 1, revoked: false, error: null, retryAt: 0 } }),
    revision: async () => 1,
    save: async () => true,
    events: async () => [{ generation: 1, upserts: [legacy, mixed], readAt: "2026-10-28T01:00:00Z", stale: false }],
  };
  const source: TodoReader = { list: async () => { reads++; return []; }, detail: async () => { throw Error("unexpected detail"); } };
  const cache = createTodoFreshness(source, store);
  try {
    expect((await cache.reader.list()).map(t => t.fields)).toEqual([{ Category: "Work" }, { Category: "Home" }]);
    expect((await cache.events(0))[0].upserts!.map(t => t.fields)).toEqual([{ Category: "Work" }, { Category: "Home" }]);
    expect(reads).toBe(0);
  } finally { cache.stop(); }
});
