"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TaskTiming } from "./todo-timing";
import type { components } from "@/lib/generated/quantself-api-schema";

export type LiveTodo = components["schemas"]["Todo"] & { optimistic?: boolean };
function preserveDelegation(todo: LiveTodo, previous?: LiveTodo): LiveTodo {
  const delegation = previous?.delegation;
  return delegation && (!todo.delegation || delegation.revision > todo.delegation.revision)
    ? { ...todo, delegation }
    : todo;
}
type Edit = components["schemas"]["TodoEdit"];
type Create = components["schemas"]["TodoCreate"];
type WriteResult = components["schemas"]["TodoWriteResult"];
export function previewTodoEdit(source: LiveTodo, command: Edit): LiveTodo {
  const todo = { ...source, fields: { ...source.fields, ...Object.fromEntries(Object.entries(command.fields ?? {}).map(([name, change]) => [name, change.after])) } };
  if (command.fields?.Category) todo.categoryId = null;
  if (command.title) todo.title = command.title.after;
  if (command.description) todo.description = command.description.after;
  if (command.start !== undefined || command.end !== undefined) {
    let start = command.start === undefined ? todo.start : command.start;
    let end = command.end === undefined ? todo.end : command.end;
    if (typeof start === "string" && !end) end = new Date(Date.parse(start) + 30 * 60000).toISOString();
    if (typeof end === "string" && !start) start = new Date(Date.parse(end) - 30 * 60000).toISOString();
    Object.assign(todo, { start: start ?? null, end: end ?? null, fixed: command.fixed ?? todo.fixed, allDay: command.allDay ?? todo.allDay, beforeMinutes: start === null || command.allDay ? 0 : command.beforeMinutes ?? todo.beforeMinutes, afterMinutes: start === null || command.allDay ? 0 : command.afterMinutes ?? todo.afterMinutes, scheduleError: null });
  }
  if (command.beforeMinutes !== undefined) todo.beforeMinutes = command.beforeMinutes;
  if (command.afterMinutes !== undefined) todo.afterMinutes = command.afterMinutes;
  if (command.closure) { todo.state = command.closure.after.outcome === "open" ? "open" : "closed"; todo.closureReason = command.closure.after.outcome === "open" ? null : command.closure.after.outcome; }
  if (command.trash) todo.trashed = command.trash.after;
  if (command.deadlineAt) { todo.deadlineAt = command.deadlineAt.after; todo.deadlineError = null; }
  return todo;
}
export type TodoCreationHandlers = {
  start(command: Create): void;
  finish(id: string, result: WriteResult): void;
  fail(id: string, message: string): void;
};
export type TodoSnapshot = {
  todos: LiveTodo[];
  trashTodos?: LiveTodo[];
  writeError?: string | null;
  status: "loading" | "ready" | "empty" | "denied" | "unavailable" | "stale";
  message: string;
  readAt: string | null;
  retryAt: number;
};
export class TodoBrowserError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter: number,
  ) {
    super(message);
  }
}
export async function readTodoJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const retry = response.headers.get("retry-after");
    const seconds = retry
      ? /^\d+$/.test(retry)
        ? Number(retry)
        : Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
      : Number(body?.retryAfter || 0);
    throw new TodoBrowserError(
      body?.message || "To-Dos are temporarily unavailable.",
      response.status,
      Number.isFinite(seconds) ? seconds : 0,
    );
  }
  return response.json();
}
export function createTodoReadStore(
  load = () =>
    readTodoJson<components["schemas"]["TodosResponse"]>("/api/v1/todos?trash=include"),
) {
  let snapshot: TodoSnapshot = {
    todos: [],
    status: "loading",
    message: "Loading To-Dos…",
    readAt: null,
    retryAt: 0,
  };
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  let revision = 0;
  let confirmed: LiveTodo[] = [];
  let eventGeneration = -1;
  const writeGenerations = new Map<number, number>();
  const optimistic = new Map<string, LiveTodo>();
  const pendingEdits = new Map<string, { number: number; command: Edit }>();
  const confirmedCreates = new Set<string>();
  const voicePrepStates = new Map<string, string>();
  const settledVoicePrep = new Set<string>();
  const appliedTrashReceipts = new Set<string>();
  const publish = (next = snapshot) => {
    for (const [id, pending] of optimistic) {
      if (
        confirmed.some(
          (todo) =>
            (pending.number > 0 && todo.number === pending.number) ||
            todo.body?.includes(`Command ID: ${id}`),
        )
      ) {
        optimistic.delete(id);
        confirmedCreates.add(id);
      }
    }
    const todos = [...confirmed, ...optimistic.values()].map(source => {
      let todo = source;
      for (const { number, command } of pendingEdits.values()) {
        if (number !== todo.number) continue;
        todo = previewTodoEdit(todo, command);
      }
      return todo;
    }).sort((a, b) =>
      (typeof a.fields?.Rank === "number" ? a.fields.Rank : Infinity) -
      (typeof b.fields?.Rank === "number" ? b.fields.Rank : Infinity) || (a.id ?? "").localeCompare(b.id ?? ""));
    snapshot = {
      ...next,
      message: ["ready", "empty"].includes(next.status)
        ? confirmed.some(todo => !todo.trashed)
          ? "Live from GitHub"
          : optimistic.size
            ? "Saving new tasks…"
            : "No To-Dos in the dedicated repository."
        : next.message,
      todos: todos.filter(todo => !todo.trashed),
      trashTodos: todos.filter(todo => todo.trashed),
      status:
        ["ready", "empty"].includes(next.status) ||
        (next.status === "loading" && todos.length > 0)
          ? todos.some(todo => !todo.trashed)
            ? "ready"
            : "empty"
          : next.status,
    };
    listeners.forEach((listener) => listener());
  };
  const update = (next: TodoSnapshot) => {
    if (next.status === "ready" || next.status === "empty") { for (const id of settledVoicePrep) pendingEdits.delete(id); settledVoicePrep.clear(); }
    const previous = new Map(confirmed.map(todo => [todo.id, todo]));
    confirmed = next.todos.filter((todo) => !todo.optimistic).map(todo => preserveDelegation(todo, previous.get(todo.id)));
    if (next.status === "denied") { revision++; optimistic.clear(); pendingEdits.clear(); writeGenerations.clear(); settledVoicePrep.clear(); }
    publish({ ...next, writeError: next.writeError ?? snapshot.writeError });
  };
  const creation: TodoCreationHandlers = {
    start(command) {
      if (snapshot.status === "denied") return;
      if (
        optimistic.has(command.commandId) || confirmedCreates.has(command.commandId) ||
        confirmed.some((todo) =>
          todo.body?.includes(`Command ID: ${command.commandId}`),
        )
      )
        return;
      revision++;
      optimistic.set(command.commandId, {
        id: `pending:${command.commandId}`,
        databaseId: 0,
        number: 0,
        repository: "",
        url: "",
        title: command.title,
        body: command.description ?? null,
        description: command.description ?? "",
        state: "open",
        closureReason: null,
        updatedAt: new Date().toISOString(),
        labels: [],
        fields: { Commitment: "Inbox", ...command.fields },
        fieldValues: [],
        start: command.start ?? (command.end ? new Date(Date.parse(command.end) - 30 * 60000).toISOString() : null), end: command.end ?? (command.start ? new Date(Date.parse(command.start) + 30 * 60000).toISOString() : null), deadlineAt: command.deadlineAt ?? null, deadlineError: null, allDay: command.allDay ?? false, fixed: command.fixed ?? false, beforeMinutes: command.beforeMinutes, afterMinutes: command.afterMinutes,
        scheduleError: null,
        optimistic: true,
      });
      publish({ ...snapshot, writeError: null });
    },
    finish(id, result) {
      if (snapshot.status === "denied") return;
      revision++;
      const obsolete = result.cacheGeneration !== undefined && result.cacheGeneration < eventGeneration;
      if (!obsolete && result.todo && result.cacheGeneration !== undefined) writeGenerations.set(result.todo.number, result.cacheGeneration);
      optimistic.delete(id);
      if (result.todo) confirmedCreates.add(id);
      if (!obsolete && result.todo)
        confirmed = [
          ...confirmed.filter((todo) => todo.id !== result.todo!.id),
          result.todo,
        ];
      publish({
        ...snapshot,
        writeError: Object.values(result.outcomes).some(
          (value) => value !== "saved",
        )
          ? result.message
          : null,
      });
    },
    fail(id, message) {
      if (optimistic.delete(id)) revision++;
      publish({ ...snapshot, writeError: message });
    },
  };
  const edits = {
    start(id: string, number: number, command: Edit) {
      if (snapshot.status === "denied") return;
      if (pendingEdits.has(id)) return;
      revision++;
      pendingEdits.set(id, { number, command });
      publish({ ...snapshot, writeError: null });
    },
    finish(id: string, result: WriteResult) {
      if (snapshot.status === "denied") return;
      revision++;
      const obsolete = result.cacheGeneration !== undefined && result.cacheGeneration < eventGeneration;
      if (!obsolete && result.todo && result.cacheGeneration !== undefined) writeGenerations.set(result.todo.number, result.cacheGeneration);
      if (!obsolete && result.todo) confirmed = confirmed.map(todo => todo.number === result.todo!.number ? preserveDelegation(result.todo!, todo.id === result.todo!.id ? todo : undefined) : todo);
      const pending = pendingEdits.get(id);
      if (!result.retryable) pendingEdits.delete(id);
      else if (pending) {
        const command = { ...pending.command, fields: { ...pending.command.fields } };
        for (const key of ["title", "description", "closure", "trash", "deadlineAt"] as const)
          if (result.outcomes[key] === "saved") delete command[key];
        for (const key of Object.keys(command.fields)) if (result.outcomes[key] === "saved") delete command.fields[key as keyof typeof command.fields];
        if (result.outcomes.timing === "saved") { delete command.start; delete command.end; delete command.allDay; delete command.fixed; delete command.beforeMinutes; delete command.afterMinutes; }
        pendingEdits.set(id, { ...pending, command });
      }
      const failed = Object.values(result.outcomes).some(value => value !== "saved");
      publish({ ...snapshot, writeError: failed ? result.message : null });
    },
    fail(id: string, message: string, rejected = false) {
      revision++;
      if (rejected) pendingEdits.delete(id);
      publish({ ...snapshot, writeError: message });
    },
  };
  const timing = {
    start(id: string, number: number, after: TaskTiming) { edits.start(id, number, { commandId: id, ...after }); },
    finish: edits.finish,
    fail: edits.fail,
  };
  const syncVoiceCreates = (
    commands: components["schemas"]["TodoJarvisOutcomes"]["commands"],
  ) => {
    if (snapshot.status === "denied") return;
    for (const row of commands) {
      if (!row.prep || !row.number) continue;
      const fingerprint = JSON.stringify([row.state, row.outcomes, row.retryable]);
      const previous = voicePrepStates.get(row.commandId);
      if (previous === fingerprint) continue;
      if (!previous && row.state !== "pending") { voicePrepStates.set(row.commandId, fingerprint); continue; }
      voicePrepStates.set(row.commandId, fingerprint);
      const rejected = row.outcomes.timing === "conflict" || row.outcomes.timing === "failed" || row.outcomes.timing === "not-attempted";
      if (rejected) { edits.fail(row.commandId, row.message || "Prep change rejected", true); continue; }
      edits.start(row.commandId, row.number, { commandId: row.commandId, ...row.prep });
      if (row.outcomes.timing === "saved") { revision++; settledVoicePrep.add(row.commandId); }
      else if (row.state === "failed") edits.fail(row.commandId, row.message || "Prep delivery uncertain; retry the same command.");
    }
    // Apply each verified transition once. Historical receipts must not hide a
    // task that another conversation or GitHub subsequently restored.
    for (const row of commands) {
      if (row.trash === undefined || row.outcomes.trash !== "saved" || appliedTrashReceipts.has(row.commandId)) continue;
      appliedTrashReceipts.add(row.commandId);
      revision++;
      if (row.trash) confirmed = confirmed.map(todo => todo.number === row.number ? { ...todo, trashed: true, state: "closed", closureReason: todo.state === "open" ? "not_planned" : todo.closureReason } : todo);
    }
    const trashed = new Set(commands.filter(row => row.trash === true && row.outcomes.trash === "saved").map(row => row.number));
    for (const [id, todo] of optimistic) if (trashed.has(todo.number)) { optimistic.delete(id); confirmedCreates.add(id); }
    for (const row of commands) {
      if (!row.create) continue;
      if (trashed.has(row.number)) { confirmedCreates.add(row.commandId); optimistic.delete(row.commandId); continue; }
      if (row.state === "failed")
        creation.fail(
          row.commandId,
          row.message || `Could not create ${row.create.title}.`,
        );
      else {
        creation.start(row.create);
        const pending = optimistic.get(row.commandId);
        if (pending && row.number && pending.number !== row.number) {
          pending.number = row.number;
          revision++;
        }
        if (
          row.state === "saved" &&
          Object.values(row.outcomes).some((value) => value !== "saved")
        )
          publish({
            ...snapshot,
            writeError:
              row.message || "Task saved with some changes unsuccessful.",
          });
      }
    }
    publish();
  };
  const refresh = () => {
    if (pending) return pending;
    if (Date.now() < snapshot.retryAt) return Promise.resolve();
    const startedRevision = revision;
    pending = load()
      .then((result) => {
        if (startedRevision !== revision) return;
        if (result.generation !== undefined) {
          if (result.generation < eventGeneration || [...writeGenerations.values()].some(generation => generation > result.generation!)) return;
          eventGeneration = result.generation;
        }
        update({
          todos: result.todos,
          status: result.stale ? "stale" : result.todos.length ? "ready" : "empty",
          readAt: result.readAt,
          message: result.stale ? "Stale To-Dos. GitHub refresh unavailable. Edits paused." : result.todos.length
            ? "Live from GitHub"
            : "No To-Dos in the dedicated repository.",
          retryAt: 0,
        });
      })
      .catch((error: unknown) => {
        const denied =
          error instanceof TodoBrowserError &&
          [401, 403].includes(error.status);
        const retryAt =
          error instanceof TodoBrowserError && error.retryAfter > 0
            ? Date.now() + error.retryAfter * 1000
            : 0;
        update({
          ...snapshot,
          todos: denied ? [] : confirmed,
          readAt: denied ? null : snapshot.readAt,
          status: denied ? "denied" : snapshot.readAt ? "stale" : "unavailable",
          message: denied
            ? "To-Do access denied. Ask the Owner for To-Do Read permission."
            : `${snapshot.readAt ? "Stale To-Dos. " : ""}${error instanceof Error ? error.message : "To-Dos unavailable."} Edits paused.`,
          retryAt,
        });
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const applyRemote = (event: { generation: number; todos?: LiveTodo[]; upserts?: LiveTodo[]; removed?: number[]; readAt: string | null; stale?: boolean; revoked?: boolean }) => {
    if (snapshot.status === "denied" || event.generation <= eventGeneration) return;
    eventGeneration = event.generation;
    revision++;
    if (event.revoked) { update({ ...snapshot, todos: [], status: "denied", readAt: null, message: "To-Do access denied.", retryAt: 0 }); return; }
    const previous = new Map(confirmed.map(todo => [todo.id, todo]));
    const mayReplace = (number: number) => event.generation >= (writeGenerations.get(number) ?? -1);
    if (event.todos) {
      const incoming = event.todos.filter(todo => mayReplace(todo.number)).map(todo => preserveDelegation(todo, previous.get(todo.id)));
      confirmed = [...confirmed.filter(todo => !mayReplace(todo.number)), ...incoming];
    } else {
      const removed = new Set((event.removed ?? []).filter(mayReplace));
      const upserts = (event.upserts ?? []).filter(todo => mayReplace(todo.number)).map(todo => preserveDelegation(todo, previous.get(todo.id)));
      const changed = new Set(upserts.map(todo => todo.number));
      confirmed = [...confirmed.filter(todo => !removed.has(todo.number) && !changed.has(todo.number)), ...upserts];
    }
    for (const [number, generation] of writeGenerations) if (generation <= event.generation) writeGenerations.delete(number);
    publish({ ...snapshot, status: event.stale ? "stale" : confirmed.length ? "ready" : "empty", readAt: event.readAt, message: event.stale ? "Stale To-Dos. GitHub refresh unavailable. Edits paused." : "Live from GitHub", retryAt: 0 });
  };
  return {
    applyRemote,
    denyAccess() { update({ ...snapshot, todos: [], status: "denied", readAt: null, message: "To-Do access denied.", retryAt: 0 }); },
    creation,
    edits,
    timing,
    syncVoiceCreates,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    async refreshAfterWrite() {
      // An older request may contain state fetched before the tool committed.
      if (pending) await pending;
      await refresh();
    },
  };
}
const TodoStoreContext = createContext<ReturnType<
  typeof createTodoReadStore
> | null>(null);
export function TodoStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createTodoReadStore());
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let source: EventSource | undefined;
    let denied = false;
    const connect = () => {
      source?.close();
      if (denied || document.visibilityState === "hidden") return;
      source = new EventSource("/api/v1/todos/live", { withCredentials: true });
      const apply = (message: MessageEvent) => {
        try {
          const event = JSON.parse(message.data);
          store.applyRemote(event);
          if (event.categoriesChanged) document.dispatchEvent(new Event("quantself:categories-changed"));
        } catch { void store.refresh(); }
      };
      source.addEventListener("snapshot", apply as EventListener);
      source.addEventListener("changes", apply as EventListener);
      source.addEventListener("resync-required", () => { connect(); });
      source.addEventListener("access-denied", () => { denied = true; source?.close(); store.denyAccess(); document.dispatchEvent(new Event("quantself:todos-access-denied")); });
      source.onerror = () => { void store.refresh().then(() => { if (store.getSnapshot().status === "denied") { denied = true; source?.close(); document.dispatchEvent(new Event("quantself:todos-access-denied")); } }); };
    };
    const visible = () => { connect(); if (!denied && document.visibilityState !== "hidden") void store.refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    connect();
    return () => { source?.close(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [store]);
  return createElement(TodoStoreContext.Provider, { value: store }, children);
}
export function useTodoStore() {
  const shared = useContext(TodoStoreContext);
  const [local] = useState(() => shared ?? createTodoReadStore());
  return shared ?? local;
}
const noTodoSubscription = () => () => {};

export function useLiveTodos(enabled = true) {
  const store = useTodoStore();
  const snapshot = useSyncExternalStore(
    enabled ? store.subscribe : noTodoSubscription,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      await store.refresh();
      if (!stopped && (document.visibilityState as string) !== "hidden") {
        clearTimeout(timer);
        timer = setTimeout(
          refresh,
          Math.max(60000, store.getSnapshot().retryAt - Date.now()),
        );
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    // Populate the shared snapshot once even when this tab starts in the background.
    void store.refresh();
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [store, enabled]);
  return {
    ...snapshot,
    subscribe: store.subscribe,
    refresh: store.refresh,
    refreshAfterWrite: store.refreshAfterWrite,
    creation: store.creation,
    timing: store.timing,
    edits: store.edits,
    syncVoiceCreates: store.syncVoiceCreates,
  };
}
