"use client";

// Guarded localStorage: JSON values validated on read, falls back to memory when storage is unavailable.
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export function readBrowserState<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null"); return valid(value) ? value : fallback; } catch { return fallback; }
}
export function writeBrowserState(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage unavailable: keep working in memory. */ }
}
export function removeBrowserState(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage unavailable. */ }
}
// Reads once on mount (client only; render a loading/neutral state if the first paint must match the server).
export function useBrowserState<T>(key: string | undefined, fallback: T, valid: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => key && typeof window !== "undefined" ? readBrowserState(key, fallback, valid) : fallback);
  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setValue((previous) => {
      const next = typeof update === "function" ? (update as (value: T) => T)(previous) : update;
      if (key) writeBrowserState(key, next);
      return next;
    });
  }, [key]);
  return [value, set];
}
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isString = (value: unknown): value is string => typeof value === "string";
