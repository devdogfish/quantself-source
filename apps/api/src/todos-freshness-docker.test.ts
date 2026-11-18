import { expect, test } from "bun:test";
import { createTodoFreshness } from "./todos-freshness";
import { postgresTodoCache } from "./todos-freshness-store";
import type { Todo, TodoReader } from "./todos-github";

const enabled = process.env.TODO_CACHE_DOCKER_TEST === "1";
test.skipIf(!enabled)("Docker cache projection, invalidation receipts and replay survive coordinator restart", async () => {
  const { prisma } = await import("@quantself/db");
  const scope = `integration:${crypto.randomUUID()}`;
  const owner = await prisma.authOwner.findFirstOrThrow({ select: { id: true } });
  const storedScope = `${owner.id}:${scope}`;
  let listCalls = 0, detailCalls = 0;
  let rows = Array.from({ length: 64 }, (_, index) => ({ number: index + 1, id: `fixture:${index}`, title: `Task ${index}`, fields: {}, state: "open", updatedAt: "2026-10-28T00:00:00Z" } as Todo));
  const source: TodoReader = { list: async () => { listCalls++; return rows; }, detail: async number => { detailCalls++; return rows.find(todo => todo.number === number)!; } };
  const first = createTodoFreshness(source, postgresTodoCache(scope));
  let second: ReturnType<typeof createTodoFreshness> | undefined;
  try {
    const coldStart = performance.now(); await first.reader.list(); const coldMs = performance.now() - coldStart;
    const warmStart = performance.now(); await Promise.all(Array.from({ length: 20 }, () => first.reader.list())); const warmMs = performance.now() - warmStart;
    expect(listCalls).toBe(1);
    const cursor = (await first.status()).generation;
    await first.invalidate([1], "durable-fixture-delivery"); first.stop();
    second = createTodoFreshness(source, postgresTodoCache(scope));
    expect((await second.status()).dirty[1]).toBeDefined();
    expect(await second.invalidate([1], "durable-fixture-delivery")).toBe(false);
    rows = [{ ...rows[0], title: "Changed after restart" }, ...rows.slice(1)];
    await second.refresh();
    expect((await second.reader.list()).find(todo => todo.number === 1)?.title).toBe("Changed after restart");
    // The original warm process must observe another process's durable projection update.
    const synchronized = await first.reader.list();
    expect(synchronized.find(todo => todo.number === 1)?.title).toBe("Changed after restart");
    expect(synchronized.map(todo => todo.id)).toEqual(rows.map(todo => todo.id).sort((a, b) => a.localeCompare(b)));
    expect(detailCalls).toBe(1); expect(listCalls).toBe(1);
    expect((await second.events(cursor)).at(-1)?.upserts?.[0].title).toBe("Changed after restart");
    expect(await prisma.todoCacheProjection.count({ where: { scope: storedScope } })).toBe(64);
    await second.invalidate(undefined, "cross-process-revoke", true);
    expect((await first.status()).revoked).toBe(true);
    await expect(first.reader.list()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
    expect(listCalls).toBe(1);
    console.log(JSON.stringify({ cacheFixtureRecords: 64, coldMs: +coldMs.toFixed(2), twentyWarmReadsMs: +warmMs.toFixed(2), upstreamListReads: listCalls, upstreamTargetedReads: detailCalls }));
  } finally {
    first.stop(); second?.stop();
    await prisma.$transaction([
      prisma.todoCacheProjection.deleteMany({ where: { scope: storedScope } }),
      prisma.todoCacheEvent.deleteMany({ where: { scope: storedScope } }),
      prisma.todoWebhookDelivery.deleteMany({ where: { scope: storedScope } }),
      prisma.todoCacheState.deleteMany({ where: { scope: storedScope } }),
    ]);
    await prisma.$disconnect();
  }
});
