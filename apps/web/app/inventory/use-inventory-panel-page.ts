"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

export const INVENTORY_PANEL_PAGE_SIZE = 24;
export type InventoryPanelPage<T> = {
  items: T[];
  pageInfo: { nextCursor: string | null };
  total: number;
};

export function inventoryPanelPosition(params: {
  get(name: string): string | null;
}) {
  const cursor = params.get("cursor") || null;
  const n = Number(params.get("page"));
  return {
    cursor,
    page: cursor ? (Number.isSafeInteger(n) && n > 1 ? n : 2) : 1,
  };
}

/** One bounded read per URL change. Cursor discovery never scans intermediate pages. */
export function useInventoryPanelPage<T>({
  pathname,
  initial,
  loadPage,
}: {
  pathname: string;
  initial: InventoryPanelPage<T>;
  loadPage: (
    params: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<InventoryPanelPage<T>>;
}) {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [localParams, setParams] = useState(() => new URLSearchParams(search));
  const [observedSearch, setObservedSearch] = useState(search);
  const params =
    search === observedSearch ? localParams : new URLSearchParams(search);
  const [data, setData] = useState(initial);
  const [dataKey, setDataKey] = useState(search);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [, restoredPosition] = useState(0);
  const initialKey = useRef(search);
  const hasNavigated = useRef(false);
  const loadRef = useRef(loadPage);
  useLayoutEffect(() => {
    loadRef.current = loadPage;
  });
  const cursors = useRef(new Map<string, Map<number, string | null>>());
  const key = params.toString();
  const filterParams = new URLSearchParams(params);
  filterParams.delete("page");
  filterParams.delete("cursor");
  const filterKey = filterParams.toString();
  const { page, cursor } = inventoryPanelPosition(params);
  const known = new Map(cursors.current.get(filterKey) ?? [[1, null]]);
  known.set(page, cursor);
  if (key === dataKey && !loading && !error && data.pageInfo.nextCursor)
    known.set(page + 1, data.pageInfo.nextCursor);
  useLayoutEffect(() => {
    cursors.current.set(filterKey, known);
  });

  const returnTo = `${pathname}${key ? `?${key}` : ""}`;
  function savePosition() {
    try {
      window.sessionStorage.setItem(
        `quantself:inventory-panel:${returnTo}`,
        JSON.stringify({
          scrollY: window.scrollY,
          cursors: [...known],
          filterKey,
        }),
      );
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  }
  useLayoutEffect(() => {
    if (key !== dataKey) return;
    try {
      const saved = JSON.parse(
        window.sessionStorage.getItem(
          `quantself:inventory-panel:${returnTo}`,
        ) ?? "null",
      );
      if (
        !saved ||
        saved.filterKey !== filterKey ||
        !Array.isArray(saved.cursors)
      )
        return;
      const positions = cursors.current.get(filterKey)!;
      for (const entry of saved.cursors) {
        if (
          Array.isArray(entry) &&
          Number.isSafeInteger(entry[0]) &&
          entry[0] > 1 &&
          typeof entry[1] === "string" &&
          !positions.has(entry[0])
        ) {
          positions.set(entry[0], entry[1]);
        }
      }
      if (Number.isFinite(saved.scrollY) && saved.scrollY >= 0)
        window.scrollTo({ top: saved.scrollY, behavior: "auto" });
      restoredPosition((n) => n + 1);
    } catch {
      /* Stored navigation metadata is optional and never replaces fresh API rows. */
    }
  }, [key, dataKey, returnTo, filterKey]);

  useEffect(() => {
    setObservedSearch(search);
    setParams(new URLSearchParams(search));
  }, [search]);
  useEffect(() => {
    const pop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    if (!hasNavigated.current && key === initialKey.current && retryKey === 0) {
      return;
    }
    hasNavigated.current = true;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void loadRef
      .current(new URLSearchParams(key), controller.signal)
      .then((result) => {
        if (active) {
          setData(result);
          setDataKey(key);
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load inventory.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, retryKey]);

  function navigate(next: URLSearchParams) {
    if (next.toString() === key) return;
    hasNavigated.current = true;
    window.history.pushState(
      window.history.state,
      "",
      `${pathname}${next.size ? `?${next}` : ""}`,
    );
    setLoading(true);
    setError("");
    setParams(next);
  }
  function changePage(nextPage: number) {
    if (!known.has(nextPage)) return;
    const next = new URLSearchParams(params);
    next.delete("page");
    next.delete("cursor");
    if (nextPage > 1) {
      next.set("page", String(nextPage));
      next.set("cursor", known.get(nextPage)!);
    }
    navigate(next);
  }
  function changeFilters(next: URLSearchParams) {
    next.delete("page");
    next.delete("cursor");
    // Cursor positions depend on the exact filter set and source ordering.
    cursors.current.delete(next.toString());
    navigate(next);
  }
  const ready = key === dataKey && !loading && !error;
  return {
    ...data,
    items: ready ? data.items : [],
    total: ready ? data.total : null,
    pageInfo: ready ? data.pageInfo : { nextCursor: null },
    ready,
    params,
    page,
    loading: !error && (loading || key !== dataKey),
    error,
    changePage,
    changeFilters,
    availablePages: [...known.keys()],
    returnTo,
    savePosition,
    retry: () => {
      setLoading(true);
      setError("");
      setRetryKey((n) => n + 1);
    },
  };
}
