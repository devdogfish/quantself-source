"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  patchNativeAppointment, readNativeAppointment, type AppointmentAction, type AppointmentEdit,
  type AppointmentRequest, type NativeAppointment,
} from "./native-appointment-client";
import { TodoBrowserError } from "./todo-live";

type Intent = { key: string; action: AppointmentAction; request?: AppointmentRequest };
type EditHistory = { before: AppointmentEdit; after: AppointmentEdit };
type History = { undo: readonly EditHistory[]; redo: readonly EditHistory[] };
const emptyHistory: History = { undo: [], redo: [] };
type Status = "saving" | "retry" | "checking" | "review" | "unavailable" | "settled";
export type AppointmentChange = {
  base: NativeAppointment;
  intents: readonly Intent[];
  status: Status;
  message?: string;
  refreshFailed?: boolean;
  writeDenied?: boolean;
  history?: History;
  stamp: number;
};
type Snapshot = { entries: ReadonlyMap<string, AppointmentChange>; stamp: number };
const empty: Snapshot = { entries: new Map(), stamp: 0 };
const noSub = () => () => {};
const getEmpty = () => empty;

export function appointmentChangeIsPending(change?: AppointmentChange) {
  return change?.status === "saving" || change?.status === "retry";
}

export function appointmentCancelIsPending(change?: AppointmentChange) {
  return !!change && appointmentChangeIsPending(change) && change.intents.some(({ action }) => action.action === "cancel");
}

export function appointmentEditToReview(change?: AppointmentChange): AppointmentEdit | undefined {
  if (!change || (change.status !== "checking" && change.status !== "review")) return;
  return change.intents.reduce<AppointmentEdit>((fields, { action }) =>
    action.action === "update" ? { ...fields, ...action.fields } : fields, {});
}

export function projectNativeAppointment(row: NativeAppointment, change?: AppointmentChange): NativeAppointment | undefined {
  if (change?.status === "unavailable") return undefined;
  if (!change) return row;
  if (!appointmentChangeIsPending(change)) return row.revision > change.base.revision ? row : change.base;
  return change.intents.reduce((visible, { action }) =>
    action.action === "update" ? { ...visible, ...action.fields } : visible, change.base);
}

export function createNativeAppointmentQueue({ patch = patchNativeAppointment, read = readNativeAppointment, newKey = () => crypto.randomUUID() }: {
  patch?: typeof patchNativeAppointment; read?: typeof readNativeAppointment; newKey?: () => string;
} = {}) {
  const listeners = new Set<() => void>();
  let snapshot = empty;
  function publish(change: Omit<AppointmentChange, "stamp">) {
    const stamp = snapshot.stamp + 1;
    const entries = new Map(snapshot.entries);
    const next = { ...change, stamp };
    entries.set(change.base.id, next);
    snapshot = { entries, stamp };
    listeners.forEach(listener => listener());
    return next;
  }
  async function checkLatest(change: AppointmentChange) {
    const checking = publish({ ...change, status: "checking", refreshFailed: false, history: undefined });
    try {
      const latest = await read(change.base.id);
      if (snapshot.entries.get(change.base.id) !== checking) return;
      if (latest.id !== checking.base.id || latest.revision < checking.base.revision) throw new Error("Appointment detail was stale.");
      publish({ ...checking, base: latest, status: "review" });
    } catch (error) {
      if (snapshot.entries.get(change.base.id) !== checking) return;
      if (inaccessible(error)) publish({ ...checking, intents: [], status: "unavailable", message: "Appointment unavailable." });
      else publish({ ...checking, status: "review", refreshFailed: true, message: "Could not check the current appointment. Reload it before saving." });
    }
  }
  function inaccessible(error: unknown) {
    return error instanceof TodoBrowserError && [401, 403, 404].includes(error.status);
  }
  async function flush(change: AppointmentChange) {
    const [first, ...rest] = change.intents;
    if (!first) return;
    const request = first.request ?? (first.action.action === "cancel"
      ? { action: "cancel" as const, expectedRevision: change.base.revision }
      : { ...first.action.fields, action: "update" as const, expectedRevision: change.base.revision });
    const command = { ...first, request };
    publish({ ...change, intents: [command, ...rest], status: "saving", message: undefined });
    try {
      const base = await patch(change.base.id, command.key, request);
      const now = snapshot.entries.get(change.base.id)!;
      const next = publish({
        base, intents: now.intents.slice(1), status: now.intents.length > 1 ? "saving" : "settled",
        history: base.cancelledAt ? undefined : now.history,
      });
      if (next.intents.length) void flush(next);
    } catch (error) {
      const now = snapshot.entries.get(change.base.id)!;
      if (error instanceof TodoBrowserError && error.status === 403) {
        await checkLatest({ ...now, writeDenied: true, message: "Appointment editing is unavailable." });
      } else if (inaccessible(error)) {
        publish({ ...now, intents: [], status: "unavailable", history: undefined, message: "Appointment unavailable." });
      } else if (error instanceof TodoBrowserError && error.status === 409) {
        await checkLatest({ ...now, message: error.message });
      } else if (error instanceof TodoBrowserError && error.status < 500 && error.status !== 429 && error.status !== 408) {
        publish({ ...now, status: "review", history: undefined, message: error.message });
      } else {
        publish({ ...now, status: "retry", message: "Save unconfirmed. Retry to check the same command." });
      }
    }
  }
  function submit(row: NativeAppointment, action: AppointmentAction, historyDirection?: "undo" | "redo") {
    const existing = snapshot.entries.get(row.id);
    if (existing?.status === "unavailable" || existing?.status === "checking" || existing?.refreshFailed || existing?.writeDenied || appointmentCancelIsPending(existing)) return false;
    const base = existing && existing.base.revision >= row.revision ? existing.base : row;
    if (base.cancelledAt) return false;
    const pending = existing && appointmentChangeIsPending(existing) ? existing : undefined;
    let history = existing?.base.revision === base.revision ? existing.history ?? emptyHistory : emptyHistory;
    if (historyDirection) {
      const record = history[historyDirection].at(-1);
      if (!record) return false;
      const other = historyDirection === "undo" ? "redo" : "undo";
      history = { ...history, [historyDirection]: history[historyDirection].slice(0, -1), [other]: [...history[other], record] };
    } else if (action.action === "update") {
      const visible = projectNativeAppointment(base, pending) ?? base;
      const before = Object.fromEntries(Object.keys(action.fields).map(field => [field, visible[field as keyof AppointmentEdit]]));
      history = { undo: [...history.undo, { before, after: action.fields }], redo: [] };
    }
    const next = publish({
      base: pending?.base ?? base, history,
      intents: [...(pending?.intents ?? []), { key: newKey(), action }],
      status: pending?.status ?? "saving", message: pending?.message,
    });
    if (!pending) void flush(next);
    return true;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enqueue: (row: NativeAppointment, action: AppointmentAction) => submit(row, action),
    replay(row: NativeAppointment, direction: "undo" | "redo") {
      const record = snapshot.entries.get(row.id)?.history?.[direction].at(-1);
      if (!record) return false;
      return submit(row, { action: "update", fields: direction === "undo" ? record.before : record.after }, direction);
    },
    retry(id: string) {
      const entry = snapshot.entries.get(id);
      if (entry?.status === "retry") void flush(entry);
      if (entry?.status === "review" && entry.refreshFailed) void checkLatest(entry);
    },
    discardDraft(id: string) {
      const entry = snapshot.entries.get(id);
      if (entry?.status === "review" && !entry.refreshFailed) publish({ base: entry.base, intents: [], status: "settled" });
    },
  };
}

const Workspace = createContext<ReturnType<typeof createNativeAppointmentQueue> | null>(null);

export function NativeAppointmentQueueProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createNativeAppointmentQueue);
  return <Workspace.Provider value={queue}>{children}</Workspace.Provider>;
}

export function useNativeAppointmentQueue() { return useContext(Workspace); }

export function useNativeAppointmentChanges() {
  const queue = useNativeAppointmentQueue();
  return useSyncExternalStore(queue?.subscribe ?? noSub, queue?.getSnapshot ?? getEmpty, getEmpty);
}
