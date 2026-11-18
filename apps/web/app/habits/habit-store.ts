import type { operations } from "@/lib/generated/quantself-api-schema";
export type HabitDay =
  operations["getHabitDay"]["responses"][200]["content"]["application/json"];
export type Occurrence = HabitDay["occurrences"][number];
export type Command =
  operations["applyHabitCommand"]["requestBody"]["content"]["application/json"];
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const habitToday = () => dateFormatter.format(new Date());
type Value = Command["after"];
type Intent = { key: string; before: Value; after: Value };
const keyFor = (row: Pick<Occurrence, "habitId" | "date">) =>
  `${row.date}/${row.habitId}`;
export class HabitSaveError extends Error {
  constructor(
    message: string,
    public rejected: boolean,
    public current?: Occurrence,
  ) {
    super(message);
  }
}
export function createHabitStore(
  save: (command: Command) => Promise<Occurrence>,
) {
  const confirmed = new Map<string, Occurrence>();
  const queues = new Map<
    string,
    { intents: Intent[]; active: boolean; command?: Command; error?: string }
  >();
  const listeners = new Set<() => void>();
  let version = 0;
  let undo: Intent[] = [],
    redo: Intent[] = [];
  const emit = () => {
    version++;
    for (const listener of listeners) listener();
  };
  function row(input: Occurrence) {
    const key = keyFor(input);
    const base = confirmed.get(key) ?? input;
    const pending = queues.get(key)?.intents;
    return pending?.length
      ? {
          ...base,
          ...pending[pending.length - 1].after,
          missed:
            pending[pending.length - 1].after.status === "open" &&
            base.date < habitToday(),
        }
      : base;
  }
  async function pump(key: string) {
    const queue = queues.get(key);
    const base = confirmed.get(key);
    if (!queue || queue.active || queue.error || !queue.intents.length || !base)
      return;
    const next = queue.intents[0];
    if (
      !queue.command &&
      (base.status !== next.before.status || base.note !== next.before.note)
    ) {
      queue.intents = [];
      queue.error = "Occurrence changed outside this edit. Refresh and review.";
      undo = undo.filter((i) => i.key !== key);
      redo = redo.filter((i) => i.key !== key);
      emit();
      return;
    }
    queue.active = true;
    queue.command ??= {
      commandId: crypto.randomUUID(),
      habitId: base.habitId,
      date: base.date,
      revision: base.revision,
      before: { status: base.status, note: base.note },
      after: queue.intents[0].after,
    };
    try {
      const result = await save(queue.command);
      confirmed.set(key, result);
      queue.intents.shift();
      queue.command = undefined;
    } catch (e) {
      queue.error = e instanceof Error ? e.message : "Save uncertain. Retry.";
      if (e instanceof HabitSaveError && e.rejected) {
        if (e.current && e.current.revision >= (confirmed.get(key)?.revision ?? 0)) confirmed.set(key, e.current);
        queue.intents = [];
        queue.command = undefined;
        undo = undo.filter((i) => i.key !== key);
        redo = redo.filter((i) => i.key !== key);
      }
    } finally {
      queue.active = false;
      emit();
    }
    if (!queue.error) void pump(key);
  }
  function enqueue(intent: Intent) {
    const queue = queues.get(intent.key) ?? { intents: [], active: false };
    queue.intents.push(intent);
    queues.set(intent.key, queue);
    emit();
    void pump(intent.key);
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => version,
    row,
    rowsForDate: (date: string) =>
      [...confirmed.values()].filter((r) => r.date === date),
    merge(rows: Occurrence[]) {
      for (const r of rows) {
        const key = keyFor(r);
        const previous = confirmed.get(key);
        if (
          !queues.get(key)?.intents.length &&
          (!previous || r.revision >= previous.revision)
        )
          confirmed.set(key, r);
      }
      emit();
    },
    edit(input: Occurrence, after: Value) {
      const current = row(input);
      const key = keyFor(input);
      if (!confirmed.has(key)) confirmed.set(key, input);
      if (current.status === after.status && current.note === after.note)
        return;
      const intent = {
        key,
        before: { status: current.status, note: current.note },
        after,
      };
      undo.push(intent);
      redo = [];
      enqueue(intent);
    },
    undo() {
      const intent = undo.pop();
      if (intent) {
        redo.push(intent);
        enqueue({ ...intent, before: intent.after, after: intent.before });
      }
    },
    redo() {
      const intent = redo.pop();
      if (intent) {
        undo.push(intent);
        enqueue(intent);
      }
    },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    pending: (input?: Pick<Occurrence, "habitId" | "date">) => input ? Boolean(queues.get(keyFor(input))?.intents.length) : [...queues.values()].some((q) => q.intents.length > 0),
    errors: () =>
      [...queues.entries()]
        .filter(([, q]) => q.error)
        .map(([key, q]) => `${key}: ${q.error}`),
    retry() {
      for (const [key, queue] of queues) {
        queue.error = undefined;
        void pump(key);
      }
      emit();
    },
  };
}
