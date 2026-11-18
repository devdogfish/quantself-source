import { canonicalTodoCategory, TodoReadError, type Todo, type TodoReader } from "./todos-github";
import { CategoryPermissionError, type TodoCategories } from "./todos-categories";

export type FreshnessMeta = {
  complete: boolean; readAt: string | null; dirty: Record<string, number>;
  epoch: number; revoked: boolean; error: string | null; retryAt: number;
  categories?: TodoCategories;
};
export type CacheState = { revision: number; generation: number; meta: FreshnessMeta; todos: Todo[] };
export type CacheEvent = { generation: number; upserts?: Todo[]; removed?: number[]; categoriesChanged?: boolean; readAt: string | null; stale: boolean; revoked?: boolean; resync?: boolean };
export interface TodoCacheStore {
  load(): Promise<CacheState>;
  revision?(): Promise<number>;
  save(before: CacheState, after: CacheState, event?: CacheEvent, delivery?: string): Promise<boolean>;
  events(after: number): Promise<CacheEvent[]>;
}
export const emptyCache = (): CacheState => ({ revision: 0, generation: 0, todos: [], meta: { complete: false, readAt: null, dirty: { all: 1 }, epoch: 1, revoked: false, error: null, retryAt: 0 } });
const projectionMaxAgeMs = 60_000;

// Match the authoritative GitHub collection order after targeted writes and unordered DB loads.
function orderCacheRows(value: CacheState): CacheState {
  value.todos = value.todos.map(canonicalTodoCategory);
  value.todos.sort((a, b) =>
    (typeof a.fields.Rank === "number" ? a.fields.Rank : Infinity) -
    (typeof b.fields.Rank === "number" ? b.fields.Rank : Infinity) || a.id.localeCompare(b.id));
  return value;
}

// One shared coordinator per configured repository. Source writes never read this cache.
export function createTodoFreshness(source: TodoReader, store: TodoCacheStore, now = Date.now) {
  let stopped = false;
  let starting: Promise<unknown> | undefined;
  let state: CacheState | undefined;
  let initialized: Promise<CacheState> | undefined;
  let queue = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  let synchronizing: Promise<CacheState> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(event: CacheEvent) => void>();
  const listSnapshots = new WeakMap<Todo[], { generation: number; readAt: string | null; stale: boolean }>();
  const load = () => initialized ??= store.load().then(value => state = orderCacheRows(value));
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation); queue = run.then(() => {}, () => {}); return run;
  }
  function synchronize(): Promise<CacheState> {
    return synchronizing ??= (async () => {
      await load();
      const revision = await store.revision?.();
      if (revision !== undefined && revision <= state!.revision) return state!;
      return serial(async () => {
        // A local commit may have advanced while the cheap revision read was pending.
        if (revision !== undefined && revision <= state!.revision) return state!;
        const latest = await store.load();
        if (latest.revision > state!.revision) {
          state = orderCacheRows(latest); initialized = Promise.resolve(state);
        }
        return state!;
      });
    })().finally(() => { synchronizing = undefined; });
  }
  async function commit(change: (next: CacheState) => void | false, publish = false, delivery?: string, projectNumbers?: ReadonlySet<number>) {
    return serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
      const before = await load();
      const next = structuredClone(before); if (change(next) === false) return false; next.revision++; orderCacheRows(next);
      let event: CacheEvent | undefined;
      if (publish) {
        next.generation++;
        const prior = new Map(before.todos.map(todo => [todo.number, JSON.stringify(todo)]));
        const remaining = new Set(next.todos.map(todo => todo.number));
        event = { generation: next.generation, upserts: next.todos.filter(todo => projectNumbers?.has(todo.number) || prior.get(todo.number) !== JSON.stringify(todo)), removed: before.todos.filter(todo => !remaining.has(todo.number)).map(todo => todo.number), categoriesChanged: JSON.stringify(before.meta.categories) !== JSON.stringify(next.meta.categories), readAt: next.meta.readAt, stale: Boolean(next.meta.error), revoked: next.meta.revoked };
        // A burst must not overwhelm subscriber queues. Snapshot + cursor repairs it.
        if (JSON.stringify(event).length > 256000) event = { generation: next.generation, readAt: next.meta.readAt, stale: Boolean(next.meta.error), revoked: next.meta.revoked, resync: true };
      }
      if (!await store.save(before, next, event, delivery)) {
        const latest = orderCacheRows(await store.load()); state = latest; initialized = Promise.resolve(latest);
        if (latest.revision === before.revision) return false; // already accepted delivery
        continue; // concurrent coordinator: rebase against durable state
      }
      state = next; initialized = Promise.resolve(next);
      if (event) for (const listener of listeners) listener(event);
      return true;
      }
      throw Error("Concurrent task cache changes; retry operation.");
    });
  }
  async function invalidate(numbers?: number[], delivery?: string, revoke = false, restoreAccess = false) {
    const accepted = await commit(next => {
      next.meta.epoch++;
      if (restoreAccess) next.meta.revoked = false;
      if (revoke) { next.meta.revoked = true; next.todos = []; delete next.meta.categories; next.meta.complete = false; }
      if (!numbers?.length) next.meta.dirty.all = next.meta.epoch;
      else for (const number of numbers) next.meta.dirty[number] = next.meta.epoch;
    }, revoke, delivery);
    if (accepted && !revoke) schedule();
    return accepted;
  }
  function schedule(delay = 10) {
    if (stopped) return;
    clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(() => {}); }, delay); timer.unref?.();
  }
  const expired = ({ readAt }: FreshnessMeta) => !readAt || now() - Date.parse(readAt) >= projectionMaxAgeMs;
  const refresh = (refreshExpired = false): Promise<void> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const current = await synchronize();
      if (current.meta.revoked || now() < current.meta.retryAt) return;
      const epoch = current.meta.epoch;
      const dirty = { ...current.meta.dirty };
      const dirtyCount = Object.keys(dirty).length;
      const full = !current.meta.complete || dirty.all !== undefined || dirtyCount > 12 || (refreshExpired && expired(current.meta));
      if (!full && !dirtyCount) return;
      try {
        let todos: Todo[];
        let removed: number[] = [];
        if (full) todos = await source.list();
        else {
          const numbers = Object.keys(dirty).map(Number);
          // At most three independent GitHub detail reads at once.
          todos = [];
          for (let at = 0; at < numbers.length; at += 3) {
            const batch = await Promise.all(numbers.slice(at, at + 3).map(async number => {
              try { return await source.detail(number); }
              catch (error) { if (error instanceof TodoReadError && error.code === "TODO_NOT_FOUND") { removed.push(number); return null; } throw error; }
            }));
            todos.push(...batch.filter((todo): todo is Todo => todo !== null));
          }
        }
        const categories = full && source.categories ? await source.categories.list() : undefined;
        await commit(next => {
          // A write or another event arrived during this fetch. Never publish stale results.
          if (next.meta.epoch !== epoch) return false;
          if (full) next.todos = todos;
          else {
            const changed = new Set([...todos.map(todo => todo.number), ...removed]);
            next.todos = [...next.todos.filter(todo => !changed.has(todo.number)), ...todos];
          }
          if (categories) next.meta.categories = categories;
          for (const [key, version] of Object.entries(dirty)) if (next.meta.dirty[key] === version) delete next.meta.dirty[key];
          next.meta.complete = true; next.meta.readAt = new Date(now()).toISOString(); next.meta.error = null; next.meta.retryAt = 0;
        }, true);
      } catch (error) {
        if ((error instanceof TodoReadError && error.code === "TODO_ACCESS_DENIED") || error instanceof CategoryPermissionError) {
          await invalidate(undefined, undefined, true); return;
        }
        await commit(next => {
          next.meta.error = error instanceof Error ? error.message : "GitHub refresh failed";
          next.meta.retryAt = now() + Math.max(5000, error instanceof TodoReadError ? error.retryAfter * 1000 : 5000);
        }, true);
      }
    })().finally(() => {
      refreshing = undefined;
      if (state && Object.keys(state.meta.dirty).length && !state.meta.revoked) schedule(Math.max(10, state.meta.retryAt - now()));
    });
    return refreshing;
  };
  async function record(todo: Todo, expectedEpoch?: number) {
    let generation: number | undefined;
    await commit(next => {
      generation = undefined;
      const current = next.todos.find(row => row.number === todo.number);
      if (next.meta.revoked || (expectedEpoch !== undefined && next.meta.epoch !== expectedEpoch) || (current && Date.parse(current.updatedAt) > Date.parse(todo.updatedAt))) return false;
      generation = next.generation + 1;
      next.meta.epoch++;
      next.todos = [...next.todos.filter(row => row.number !== todo.number), todo];
      delete next.meta.dirty[todo.number];
      // Preserve full dirty work if an earlier snapshot is incomplete.
    }, true);
    return generation;
  }
  async function freshRead<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      if ((error instanceof TodoReadError && error.code === "TODO_ACCESS_DENIED") || error instanceof CategoryPermissionError) await invalidate(undefined, undefined, true);
      throw error;
    }
  }
  async function writeThrough<T extends { todo: Todo | null }>(write: () => Promise<T>): Promise<T & { cacheGeneration?: number }> {
    const initial = await synchronize();
    if (initial.meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
    let epoch = initial.meta.epoch;
    const result = await freshRead(write);
    if (!result.todo) return result;
    let candidate = result.todo;
    // A later write/webhook may have won while this writer was awaiting GitHub.
    // Only publish the response under the epoch in which it was read; same-second
    // GitHub timestamps cannot identify that race. Re-read only when contention occurs.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cacheGeneration = await record(candidate, epoch);
      if (cacheGeneration !== undefined) return { ...result, todo: candidate, cacheGeneration };
      const current = await load();
      if (current.meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      epoch = current.meta.epoch;
      candidate = await freshRead(() => source.detail(result.todo!.number));
    }
    await invalidate([result.todo.number]);
    // Outcomes still describe the verified mutation; omit an obsolete projection.
    return { ...result, todo: null };
  }
  const reader: TodoReader = {
    ...source,
    freshness: async rows => {
      if (rows) {
        const metadata = listSnapshots.get(rows);
        if (!metadata) throw new TodoReadError("TODO_UNAVAILABLE", "Snapshot metadata unavailable. Refresh and retry.");
        return metadata;
      }
      const value = await synchronize(); return { generation: value.generation, readAt: value.meta.readAt, stale: Boolean(value.meta.error) };
    },
    async listForBookingAvailability() {
      const needsRefresh = (meta: FreshnessMeta) => !meta.complete || expired(meta) || !!meta.error || Object.keys(meta.dirty).length > 0;
      let current = await synchronize();
      if (!current.meta.revoked && needsRefresh(current.meta)) {
        await refresh(true);
        current = await synchronize();
      }
      if (current.meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      if (needsRefresh(current.meta)) throw new TodoReadError("TODO_UNAVAILABLE", "Booking availability is waiting for current task timings.");
      return structuredClone(current.todos);
    },
    async list(purpose) {
      let current = await synchronize();
      if (current.meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      if (purpose) return freshRead(() => source.list(purpose)); // prerequisite/write scans remain fresh
      if (!current.meta.complete) { await refresh(); current = (await load()); }
      else if (expired(current.meta)) await invalidate();
      if (current.meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      if (!current.meta.complete) throw new TodoReadError("TODO_UNAVAILABLE", current.meta.error ?? "Tasks are loading.", Math.max(0, (current.meta.retryAt-now())/1000));
      const rows = structuredClone(current.todos);
      listSnapshots.set(rows, { generation: current.generation, readAt: current.meta.readAt, stale: Boolean(current.meta.error) });
      return rows;
    },
    detail: async number => { if ((await synchronize()).meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked."); return freshRead(() => source.detail(number)); },
    ...(source.assignedList && { assignedList: async ids => {
      if ((await synchronize()).meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      return freshRead(() => source.assignedList!(ids));
    } }),
    ...(source.assignedDetail && { assignedDetail: async (number, includeComments) => {
      if ((await synchronize()).meta.revoked) throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub installation access revoked.");
      return freshRead(() => source.assignedDetail!(number, includeComments));
    } }),
    ...(source.write ? { write: async (...args: Parameters<NonNullable<TodoReader["write"]>>) => {
      return writeThrough(() => source.write!(...args));
    } } : {}),
    ...(source.approve ? { approve: async (...args: Parameters<NonNullable<TodoReader["approve"]>>) => {
      return writeThrough(() => source.approve!(...args));
    } } : {}),
  };
  if (source.categories) reader.categories = {
    list: async () => { const current = await synchronize(); if (current.meta.revoked) throw new CategoryPermissionError("GitHub installation access revoked."); return current.meta.categories ?? freshRead(() => source.categories!.list()); },
    write: async (...args) => {
      if ((await synchronize()).meta.revoked) throw new CategoryPermissionError("GitHub installation access revoked.");
      const result = await freshRead(() => source.categories!.write(...args));
      const saved = await commit(next => { if (next.meta.revoked) return false; next.meta.categories = result; next.meta.epoch++; next.meta.dirty.all = next.meta.epoch; }, true);
      if (!saved) throw new CategoryPermissionError("GitHub installation access revoked.");
      schedule(); return result;
    },
  };
  return {
    reader, source, invalidate, refresh, record,
    projectChanged(numbers: number | readonly number[]) {
      const scope = new Set(typeof numbers === "number" ? [numbers] : numbers);
      return commit(next => next.meta.revoked || !next.todos.some(todo => scope.has(todo.number)) ? false : undefined, true, undefined, scope);
    },
    snapshot: async () => { await reader.list(); const value = await synchronize(); return { todos: structuredClone(value.todos), generation: value.generation, readAt: value.meta.readAt, stale: Boolean(value.meta.error), revoked: value.meta.revoked }; },
    status: async () => { const value = await synchronize(); return { generation: value.generation, ...value.meta }; },
    events: async (after: number) => (await store.events(after)).map(event => ({ ...event, ...(event.upserts ? { upserts: event.upserts.map(canonicalTodoCategory) } : {}) })),
    subscribe(listener: (event: CacheEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (!stopped) starting = invalidate(undefined, undefined, false, true).catch(() => {}); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await Promise.allSettled([starting, refreshing, synchronizing, initialized]);
      // Those operations may append to the serial queue while completing.
      await queue;
    },
  };
}
export type TodoFreshness = ReturnType<typeof createTodoFreshness>;
