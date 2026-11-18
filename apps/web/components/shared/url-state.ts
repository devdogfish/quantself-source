"use client";

// URL search-param state: string values with defaults; defaults are omitted from the URL, edits use router.replace.
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function readUrlState<S extends Record<string, string>>(defaults: S, params: URLSearchParams): S {
  const state: Record<string, string> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = params.get(key);
    if (value != null) state[key] = value;
  }
  return state as S;
}

export function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}

// Returns [state, set(patch), params.toString()]; the last is a stable key for resetting dependent state (e.g. page).
export function useUrlState<S extends Record<string, string>>(defaults: S) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state = readUrlState(defaults, params);
  const set = (patch: Partial<S>) => {
    const next: Record<string, string> = {};
    for (const key of Object.keys(defaults)) {
      const value = patch[key] ?? state[key];
      if (value !== defaults[key]) next[key] = value;
    }
    router.replace(`${pathname}${queryString(next)}` as Route, { scroll: false });
  };
  return [state, set, params.toString()] as const;
}
