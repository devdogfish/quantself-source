import { readTodoJson, TodoBrowserError, type LiveTodo } from "./todo-live";

export type Delegate = { id: string; name: string };
type Delegation = NonNullable<LiveTodo["delegation"]>;
type Task = Pick<LiveTodo, "id" | "number" | "title"> & { delegation?: Delegation };
type Command = { commandId: string; todoId: string; delegateId: string | null; expectedRevision: number };
type Intent = { delegate: Delegate | null; command?: Command };
type Entry = {
  task: Task;
  confirmed: Delegation;
  pending: Intent[];
  saving: boolean;
  message?: string;
  reconcile?: () => void;
};
type Snapshot = {
  entries: Map<string, { delegation: Delegation; pending: boolean; retryable: boolean; message?: string }>;
  agents: Delegate[] | null;
  loadingAgents: boolean;
  directoryError: string | null;
};

const initial = { delegate: null, revision: 0, state: null } satisfies Delegation;

async function saveDelegate(number: number, command: Command) {
  const response = await fetch(`/api/v1/todos/${number}/delegation`, {
    method: "PATCH", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new TodoBrowserError(error?.message ?? "Could not save the delegate.", response.status, 0);
  }
  return await response.json() as { delegation: Delegation };
}

function projected(entry: Entry): Delegation {
  const intent = entry.pending.at(-1);
  return intent ? { revision: entry.confirmed.revision, delegate: intent.delegate, state: intent.delegate ? "working" : null } : entry.confirmed;
}

export function createTodoDelegateQueue(
  onRejected: (id: string) => void,
  save = saveDelegate,
  loadAgents = () => readTodoJson<{ agents: Delegate[] }>("/api/v1/todo-delegates"),
) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = { entries: new Map(), agents: null, loadingAgents: false, directoryError: null };

  function publish(patch: Partial<Snapshot> = {}) {
    snapshot = { ...snapshot, ...patch, entries: new Map([...entries].map(([id, entry]) => [id, {
      delegation: projected(entry), pending: entry.pending.length > 0,
      retryable: !!entry.message && entry.pending.length > 0, message: entry.message,
    }])) };
    for (const listener of listeners) listener();
  }

  async function persist(entry: Entry) {
    if (entry.saving) return;
    entry.saving = true;
    entry.message = undefined;
    publish();
    try {
      while (entry.pending.length > 0) {
        const intent = entry.pending[0];
        intent.command ??= {
          commandId: crypto.randomUUID(), todoId: entry.task.id,
          delegateId: intent.delegate?.id ?? null, expectedRevision: entry.confirmed.revision,
        };
        const { delegation } = await save(entry.task.number, intent.command);
        entry.confirmed = delegation;
        entry.pending.shift();
        publish();
      }
    } catch (error) {
      if (error instanceof TodoBrowserError && [400, 401, 403, 404, 409].includes(error.status)) {
        entry.pending = [];
        entry.message = error.message;
        onRejected(entry.task.id);
        entry.reconcile?.();
      } else {
        entry.message = "Delegate save unconfirmed. Retry the change.";
      }
    } finally {
      entry.saving = false;
      publish();
    }
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    async loadAgents() {
      if (snapshot.agents || snapshot.loadingAgents) return;
      publish({ loadingAgents: true, directoryError: null });
      try { publish({ agents: (await loadAgents()).agents }); }
      catch { publish({ directoryError: "Agents are temporarily unavailable." }); }
      finally { publish({ loadingAgents: false }); }
    },
    change(task: Task, before: Delegate | null, after: Delegate | null, reconcile?: () => void) {
      let entry = entries.get(task.id);
      if (!entry) {
        entry = { task, confirmed: task.delegation ?? initial, pending: [], saving: false };
        entries.set(task.id, entry);
      } else if (!entry.pending.length && task.delegation && task.delegation.revision > entry.confirmed.revision) {
        entry.confirmed = task.delegation;
      }
      if (projected(entry).delegate?.id !== before?.id) throw Error("This delegate changed. Review the current assignment before editing.");
      if (before?.id === after?.id) return false;
      entry.reconcile = reconcile;
      entry.pending.push({ delegate: after });
      if (!entry.saving && (entry.pending.length === 1 || !entry.message)) void persist(entry);
      else publish();
      return true;
    },
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.pending.length) return persist(entry);
    },
  };
}

export type TodoDelegateQueue = ReturnType<typeof createTodoDelegateQueue>;

export function projectTodoDelegate<T extends Task>(todo: T, snapshot: Snapshot): T {
  const local = snapshot.entries.get(todo.id);
  if (!local || (!local.pending && todo.delegation && todo.delegation.revision >= local.delegation.revision)) return todo;
  return { ...todo, delegation: local.delegation };
}
