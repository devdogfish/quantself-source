import { emptyCache, type CacheState, type CacheEvent, type TodoCacheStore } from "./todos-freshness";
import type { Todo } from "./todos-github";
import type { Prisma } from "@quantself/db/generated/prisma/client";

class CacheRevisionConflict extends Error {}
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export function postgresTodoCache(repositoryScope: string): TodoCacheStore {
  let scope = repositoryScope;
  let initialized = false;
  const db = async () => {
    const prisma = (await import("@quantself/db")).prisma;
    if (!initialized) {
      const owner = await prisma.authOwner.findFirst({ select: { id: true } });
      if (!owner) throw Error("Task cache requires a configured Owner.");
      scope = `${owner.id}:${repositoryScope}`;
      initialized = true;
    }
    return prisma;
  };
  return {
    async revision() {
      const prisma = await db();
      const state = await prisma.todoCacheState.findUnique({ where: { scope }, select: { revision: true } });
      return state?.revision ?? 0;
    },
    async load() {
      const prisma = await db();
      const initial = emptyCache();
      await prisma.todoCacheState.upsert({ where: { scope }, create: { scope, metadata: json(initial.meta) }, update: {} });
      return prisma.$transaction(async tx => {
        const state = await tx.todoCacheState.findUniqueOrThrow({ where: { scope } });
        const records = await tx.todoCacheProjection.findMany({ where: { scope }, select: { data: true } });
        return { revision: state.revision, generation: state.generation, meta: state.metadata as unknown as CacheState["meta"], todos: records.map(row => row.data as unknown as Todo) };
      }, { isolationLevel: "RepeatableRead" });
    },
    async save(before, after, event, delivery) {
      const prisma = await db();
      return prisma.$transaction(async tx => {
        if (delivery) {
          const saved = await tx.todoWebhookDelivery.createMany({ data: [{ scope, delivery }], skipDuplicates: true });
          if (!saved.count) return false;
        }
        const changed = await tx.todoCacheState.updateMany({ where: { scope, revision: before.revision }, data: { revision: after.revision, generation: after.generation, metadata: json(after.meta) } });
        if (!changed.count) throw new CacheRevisionConflict();
        const previous = new Map(before.todos.map(todo => [todo.number, JSON.stringify(todo)]));
        const upserts = after.todos.filter(todo => previous.get(todo.number) !== JSON.stringify(todo)).map(todo => ({ number: todo.number, data: todo }));
        if (upserts.length) {
          const payload = JSON.stringify(upserts);
          await tx.$executeRaw`INSERT INTO "todo_cache_projection" ("scope", "number", "data")
            SELECT ${scope}, value.number, value.data
            FROM jsonb_to_recordset(${payload}::jsonb) AS value(number integer, data jsonb)
            ON CONFLICT ("scope", "number") DO UPDATE SET "data" = EXCLUDED."data"`;
        }
        const current = new Set(after.todos.map(todo => todo.number));
        const removed = before.todos.filter(todo => !current.has(todo.number)).map(todo => todo.number);
        if (removed.length) await tx.todoCacheProjection.deleteMany({ where: { scope, number: { in: removed } } });
        if (event) await tx.todoCacheEvent.create({ data: { scope, generation: event.generation, data: json(event) } });
        // Seven-day event replay; dedup receipts last thirty days. Gaps explicitly resync.
        if (event && event.generation % 100 === 0) {
          await tx.todoCacheEvent.deleteMany({ where: { scope, createdAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
          await tx.todoWebhookDelivery.deleteMany({ where: { scope, createdAt: { lt: new Date(Date.now() - 30 * 86400000) } } });
        }
        return true;
      }, { timeout: 30000 }).catch(error => { if (error instanceof CacheRevisionConflict) return false; throw error; });
    },
    async events(after) {
      const prisma = await db();
      const rows = await prisma.todoCacheEvent.findMany({ where: { scope, generation: { gt: after } }, orderBy: { generation: "asc" }, take: 101, select: { data: true } });
      return rows.map(row => row.data as unknown as CacheEvent);
    },
  };
}

// Test seam implements the same durable-state contract, including duplicate receipt behavior.
export function memoryTodoCache(): TodoCacheStore & { inspect(): CacheState } {
  let state = emptyCache();
  const events: CacheEvent[] = [];
  const deliveries = new Set<string>();
  return {
    load: async () => structuredClone(state),
    revision: async () => state.revision,
    async save(before, after, event, delivery) {
      if (delivery && deliveries.has(delivery)) return false;
      if (before.revision !== state.revision) return false;
      if (delivery) deliveries.add(delivery);
      state = structuredClone(after); if (event) events.push(structuredClone(event)); return true;
    },
    events: async after => events.filter(event => event.generation > after).slice(0,101),
    inspect: () => structuredClone(state),
  };
}
