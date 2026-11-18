import type { components } from "@/lib/generated/quantself-api-schema";
import { taskTiming, type TaskTiming } from "./todo-timing";
export type HistoryCommand = components["schemas"]["TodoEdit"];
type Result = components["schemas"]["TodoWriteResult"];
export type HistoryItem = { number: number; command: HistoryCommand; expectedTiming?: TaskTiming; execution?: HistoryCommand; prepared?: boolean };
type LocalAction = { key: string; apply(direction: HistoryDirection): void };
type Entry = { group: string; items: HistoryItem[]; local?: LocalAction };
export type HistoryDirection = "undo" | "redo";
const keys = (command: HistoryCommand) => [
  ...["title", "description", "closure", "trash", "deadlineAt"].filter(key => command[key as keyof HistoryCommand] !== undefined),
  ...Object.keys(command.fields ?? {}), ...(command.start !== undefined ? ["timing"] : []),
];
function inverse(number: number, command: HistoryCommand, result: Result, before?: TaskTiming, allowed = new Set(keys(command))): HistoryItem | null {
  const saved = (key: string) => allowed.has(key) && result.outcomes[key] === "saved";
  const next: HistoryCommand = { commandId: crypto.randomUUID() };
  if (command.title && saved("title")) next.title = { before: command.title.after, after: command.title.before };
  if (command.description && saved("description")) next.description = { before: command.description.after, after: command.description.before };
  if (command.closure && saved("closure")) next.closure = { before: command.closure.after, after: command.closure.before };
  if (command.deadlineAt && saved("deadlineAt")) { next.deadlineAt = { before: command.deadlineAt.after, after: command.deadlineAt.before }; next.revision = result.todo?.updatedAt ?? command.revision; }
  if (command.trash && saved("trash")) { next.trash = { before: command.trash.after, after: command.trash.before }; next.revision = result.todo?.updatedAt ?? command.revision; }
  const fields = Object.fromEntries(Object.entries(command.fields ?? {}).filter(([key]) => saved(key)).map(([key, value]) => [key, { before: value.after, after: value.before }]));
  if (Object.keys(fields).length) next.fields = fields;
  if (before && result.todo && saved("timing")) Object.assign(next, before, { beforeMinutes: before.beforeMinutes ?? 0, afterMinutes: before.afterMinutes ?? 0, revision: result.todo.updatedAt });
  return keys(next).length ? { number, command: next, ...(next.start !== undefined && result.todo ? { expectedTiming: taskTiming(result.todo) } : {}) } : null;
}
function remaining(item: HistoryItem, result: Result): HistoryItem | null {
  const command = { ...item.command };
  for (const key of ["title", "description", "closure", "trash", "deadlineAt"] as const) if (result.outcomes[key] === "saved") delete command[key];
  if (command.fields) command.fields = Object.fromEntries(Object.entries(command.fields).filter(([key]) => result.outcomes[key] !== "saved"));
  if (result.outcomes.timing === "saved") { delete command.start; delete command.end; delete command.fixed; delete command.allDay; delete command.revision; delete command.beforeMinutes; delete command.afterMinutes; }
  return keys(command).length ? { ...item, command } : null;
}

function reverseFacts(item: HistoryItem): HistoryItem {
  const command: HistoryCommand = { commandId: crypto.randomUUID() };
  const patch = item.command;
  if (patch.title) command.title = { before: patch.title.after, after: patch.title.before };
  if (patch.description) command.description = { before: patch.description.after, after: patch.description.before };
  if (patch.closure) command.closure = { before: patch.closure.after, after: patch.closure.before };
  if (patch.deadlineAt) { command.deadlineAt = { before: patch.deadlineAt.after, after: patch.deadlineAt.before }; command.revision = patch.revision; }
  if (patch.trash) command.trash = { before: patch.trash.after, after: patch.trash.before };
  if (patch.fields) command.fields = Object.fromEntries(Object.entries(patch.fields).map(([key, change]) => [key, { before: change.after, after: change.before }]));
  if (patch.start !== undefined && item.expectedTiming) Object.assign(command, item.expectedTiming, { beforeMinutes: item.expectedTiming.beforeMinutes ?? 0, afterMinutes: item.expectedTiming.afterMinutes ?? 0, revision: patch.revision });
  return { number: item.number, command, ...(command.start !== undefined ? { expectedTiming: { start: patch.start ?? null, end: patch.end ?? null, allDay: patch.allDay ?? false, fixed: patch.fixed ?? false, ...(patch.beforeMinutes ? { beforeMinutes: patch.beforeMinutes } : {}), ...(patch.afterMinutes ? { afterMinutes: patch.afterMinutes } : {}) } } : {}) };
}

/** Session history: timing intent is immediate; other edits record saved subsets. */
export function createTodoHistory() {
  let undo: Entry[] = [], redo: Entry[] = [], busy = false, writes = 0;
  let snapshot = { canUndo: false, canRedo: false, busy: false, replaying: false };
  const listeners = new Set<() => void>();
  const seen = new Map<string, Set<string>>();
  const publish = () => { snapshot = { canUndo: undo.length > 0, canRedo: redo.length > 0, busy: busy || writes > 0, replaying: busy }; listeners.forEach(fn => fn()); };
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => snapshot,
    beginWrite(replay = false) { if (busy && !replay) throw Error("Wait for undo or redo to finish."); writes++; publish(); },
    endWrite() { writes--; publish(); },
    record(number: number, command: HistoryCommand, result: Result, before?: TaskTiming, group = command.commandId) {
      const recorded = seen.get(command.commandId) ?? new Set<string>();
      const available = new Set(keys(command).filter(key => !recorded.has(key)));
      const item = inverse(number, command, result, before, available);
      if (!item) return;
      keys(item.command).forEach(key => recorded.add(key));
      seen.set(command.commandId, recorded);
      if (seen.size > 1000) seen.delete(seen.keys().next().value!);
      const previous = undo.at(-1);
      if (previous?.group === group) previous.items.push(item);
      else undo = [...undo.slice(-49), { group, items: [item] }];
      redo = []; publish();
    },
    recordTiming(number: number, command: HistoryCommand, before: TaskTiming, after: TaskTiming) {
      // Timing history follows user intent immediately; delivery is handled by
      // the serial timing queue, not by moving history again on acknowledgement.
      undo = [...undo.slice(-49), { group: command.commandId, items: [{ number,
        command: { commandId: crypto.randomUUID(), ...before, beforeMinutes: before.beforeMinutes ?? 0, afterMinutes: before.afterMinutes ?? 0 }, expectedTiming: taskTiming(after) }] }];
      redo = [];
      publish();
    },
    recordLocal(action: LocalAction) {
      undo = [...undo.slice(-49), { group: crypto.randomUUID(), items: [], local: action }];
      redo = [];
      publish();
    },
    replayLocal(direction: HistoryDirection) {
      if (busy) return false;
      const source = direction === "undo" ? undo : redo;
      const target = direction === "undo" ? redo : undo;
      const entry = source.at(-1);
      if (!entry?.local) return false;
      entry.local.apply(direction);
      source.pop();
      target.push(entry);
      publish();
      return true;
    },
    discardLocal(key: string) {
      undo = undo.filter(entry => entry.local?.key !== key);
      redo = redo.filter(entry => entry.local?.key !== key);
      publish();
    },
    replayTiming(direction: HistoryDirection, enqueue: (items: HistoryItem[]) => void) {
      if (busy) return false;
      const source = direction === "undo" ? undo : redo;
      const target = direction === "undo" ? redo : undo;
      const entry = source.at(-1);
      if (!entry || entry.local || !entry.items.every(item => item.expectedTiming && keys(item.command).length === 1 && keys(item.command)[0] === "timing")) return false;
      const items = [...entry.items].reverse().map(item => ({ ...item, command: { ...item.command, commandId: crypto.randomUUID() } }));
      // Enqueue validates the current optimistic state before changing history.
      enqueue(items);
      source.pop();
      target.push({ group: entry.group, items: items.map(item => ({ number: item.number,
        command: { commandId: crypto.randomUUID(), ...item.expectedTiming!, beforeMinutes: item.expectedTiming!.beforeMinutes ?? 0, afterMinutes: item.expectedTiming!.afterMinutes ?? 0 },
        expectedTiming: taskTiming({ start: item.command.start ?? null, end: item.command.end ?? null, allDay: item.command.allDay ?? false, fixed: item.command.fixed ?? false, beforeMinutes: item.command.beforeMinutes, afterMinutes: item.command.afterMinutes }) })) });
      publish();
      return true;
    },
    discardTiming(number: number) {
      const retain = (entries: Entry[]) => entries.map(entry => ({ ...entry, items: entry.items.filter(item => item.number !== number || item.command.start === undefined) })).filter(entry => entry.local || entry.items.length);
      undo = retain(undo); redo = retain(redo); publish();
    },
    recordChanges(items: HistoryItem[]) {
      if (!items.length) return;
      undo = [...undo.slice(-49), { group: items[0].command.commandId, items: items.map(reverseFacts) }];
      redo = []; publish();
    },
    replayChanges(direction: HistoryDirection, enqueue: (items: HistoryItem[]) => void) {
      if (busy) return false;
      const source = direction === "undo" ? undo : redo;
      const target = direction === "undo" ? redo : undo;
      const entry = source.at(-1);
      if (!entry || entry.local || entry.items.every(item => item.command.start !== undefined && keys(item.command).length === 1)) return false;
      const items = [...entry.items].reverse().map(item => ({ ...item, command: { ...item.command, commandId: crypto.randomUUID() } }));
      enqueue(items);
      source.pop();
      target.push({ group: entry.group, items: items.map(reverseFacts) });
      publish(); return true;
    },
    discardChanges(number: number) {
      const retain = (entries: Entry[]) => entries.map(entry => ({ ...entry, items: entry.items.filter(item => item.number !== number || item.command.start !== undefined) })).filter(entry => entry.local || entry.items.length);
      undo = retain(undo); redo = retain(redo); publish();
    },
    clearRedo() { redo = []; publish(); },
    reset() { undo = []; redo = []; seen.clear(); publish(); },
    async replay(direction: HistoryDirection, execute: (item: HistoryItem) => Promise<Result>) {
      if (busy || writes) return;
      const source = direction === "undo" ? undo : redo;
      const target = direction === "undo" ? redo : undo;
      const entry = source.at(-1);
      if (!entry || entry.local) return;
      busy = true; publish();
      const reversed: HistoryItem[] = [], unresolved: HistoryItem[] = [];
      let failure: Error | undefined;
      try {
        while (entry.items.length) {
          const item = entry.items.at(-1)!;
          item.execution ??= { ...item.command, commandId: crypto.randomUUID() };
          const result = await execute(item);
          const reverse = inverse(item.number, item.command, result, item.expectedTiming);
          if (reverse) reversed.push(reverse);
          const rest = remaining(item, result);
          if (rest) { unresolved.unshift(rest); failure = Error(result.message || "Some changes could not be restored."); }
          entry.items.pop();
        }
        if (failure) throw failure;
      } finally {
        entry.items.push(...unresolved);
        if (!entry.items.length) source.pop();
        if (reversed.length) target.push({ group: crypto.randomUUID(), items: reversed });
        busy = false; publish();
      }
    },
  };
}
export const todoHistory = createTodoHistory();
