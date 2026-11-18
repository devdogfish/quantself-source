"use client";
import { useEffect, useSyncExternalStore } from "react";
export async function notificationRequest<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/notifications/${path}`, { credentials: "same-origin", cache: "no-store", ...(value === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(path === "settings" ? { enabled: (value as { enabled: boolean }).enabled, morning: (value as { morning: string }).morning } : value) }) });
  const data = await response.json();
  if (!response.ok) throw Error(data.message ?? "Notification settings unavailable.");
  return data;
}
// Shared intent survives panel dismissal. Writes serialize and older replies never replace newer intent.
export function optimisticSetting<T>(path: string) {
  let state: { value?: T; loading: boolean; pending: boolean; error: string; undo: T[]; redo: T[] } = { loading: true, pending: false, error: "", undo: [], redo: [] };
  let loaded = false, active = false;
  const queue: T[] = [], listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  async function flush() {
    if (active) return;
    active = true;
    try {
      while (queue.length) { await notificationRequest(path, queue[0]); queue.shift(); }
      publish({ pending: false, error: "" });
    } catch (error) { publish({ pending: false, error: `${(error as Error).message} Your change is kept. Retry to save.` }); }
    finally { active = false; }
  }
  function apply(value: T) { queue.push(value); publish({ value, pending: true, error: "" }); void flush(); }
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => state,
    async load() { if (loaded) return; loaded = true; try { const value = await notificationRequest<T>(path); publish({ value, loading: false, error: "" }); } catch(error) { loaded = false; publish({ loading: false, error: (error as Error).message }); } },
    set(value: T) { publish({ undo: state.value ? [...state.undo, state.value] : state.undo, redo: [] }); apply(value); },
    undo() { const value = state.undo.at(-1); if (!value || !state.value) return; publish({ undo: state.undo.slice(0,-1), redo: [...state.redo, state.value] }); apply(value); },
    redo() { const value = state.redo.at(-1); if (!value || !state.value) return; publish({ redo: state.redo.slice(0,-1), undo: [...state.undo, state.value] }); apply(value); },
    retry() { if (queue.length) { publish({ pending: true }); void flush(); } else void this.load(); },
  };
}
export function useNotificationSetting<T>(resource: ReturnType<typeof optimisticSetting<T>>) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot);
  useEffect(() => { void resource.load(); }, [resource]);
  return state;
}
