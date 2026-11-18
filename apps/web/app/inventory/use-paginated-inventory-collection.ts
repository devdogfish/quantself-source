"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type InventoryPage<TItem> = {
  items: TItem[];
  pageInfo: { nextCursor: string | null };
  total: number;
};

type CollectionSnapshot<TItem> = {
  filterKey?: string;
  filtersKey?: string;
  items: TItem[];
  nextCursor: string | null;
  scrollY: number;
  total: number;
};

type UsePaginatedInventoryCollectionInput<TItem> = {
  filterKey: string;
  historyStateKey: string;
  initialFilterKey: string;
  initialItems: TItem[];
  initialNextCursor: string | null;
  initialTotal: number;
  loadPage: (cursor: string | null) => Promise<InventoryPage<TItem>>;
  snapshotFilterKey?: "filterKey" | "filtersKey";
};

/** Shared cursor continuation and navigation restoration for Item collections. */
export function usePaginatedInventoryCollection<TItem>({
  filterKey,
  historyStateKey,
  initialFilterKey,
  initialItems,
  initialNextCursor,
  initialTotal,
  loadPage,
  snapshotFilterKey = "filterKey",
}: UsePaginatedInventoryCollectionInput<TItem>) {
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [total, setTotal] = useState(initialTotal);
  const [error, setError] = useState<string | null>(null);
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [scrollToRestore, setScrollToRestore] = useState<number | null>(null);
  const pending = useRef(false);
  const requestSequence = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadNextRef = useRef(loadNext);
  const loadPageRef = useRef(loadPage);
  const initialPageRef = useRef({ initialFilterKey, initialItems, initialNextCursor, initialTotal });
  loadNextRef.current = loadNext;
  loadPageRef.current = loadPage;
  initialPageRef.current = { initialFilterKey, initialItems, initialNextCursor, initialTotal };

  const saveSnapshot = useCallback(() => {
    if (!isHistoryReady) return;
    const snapshot: CollectionSnapshot<TItem> = {
      [snapshotFilterKey]: filterKey,
      items,
      nextCursor,
      scrollY: window.scrollY,
      total,
    };
    window.history.replaceState(
      {
        ...(window.history.state as Record<string, unknown> | null),
        [historyStateKey]: snapshot,
      },
      "",
    );
  }, [filterKey, historyStateKey, isHistoryReady, items, nextCursor, snapshotFilterKey, total]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    pending.current = false;
    const snapshot = readSnapshot<TItem>(historyStateKey);
    const snapshotKey = snapshot?.[snapshotFilterKey];
    if (snapshot && snapshotKey === filterKey) {
      setItems(snapshot.items);
      setNextCursor(snapshot.nextCursor);
      setTotal(snapshot.total);
      setScrollToRestore(snapshot.scrollY);
      setError(null);
      setIsLoading(false);
    } else if (filterKey === initialPageRef.current.initialFilterKey) {
      setItems(initialPageRef.current.initialItems);
      setNextCursor(initialPageRef.current.initialNextCursor);
      setTotal(initialPageRef.current.initialTotal);
      setScrollToRestore(null);
      setError(null);
      setIsLoading(false);
    } else {
      pending.current = true;
      setItems([]);
      setNextCursor(null);
      setTotal(0);
      setScrollToRestore(null);
      setError(null);
      setIsLoading(true);
      void loadPageRef.current(null)
        .then((page) => {
          if (sequence !== requestSequence.current) return;
          setItems(page.items);
          setNextCursor(page.pageInfo.nextCursor);
          setTotal(page.total);
        })
        .catch((cause: unknown) => {
          if (sequence !== requestSequence.current) return;
          setError(cause instanceof Error ? cause.message : "Could not load inventory.");
        })
        .finally(() => {
          if (sequence === requestSequence.current) {
            pending.current = false;
            setIsLoading(false);
          }
        });
    }
    setIsHistoryReady(true);
  }, [filterKey, historyStateKey, snapshotFilterKey]);

  useLayoutEffect(() => {
    if (scrollToRestore === null) return;
    window.scrollTo({ behavior: "auto", top: scrollToRestore });
    setScrollToRestore(null);
  }, [scrollToRestore]);

  useEffect(() => {
    saveSnapshot();
    window.addEventListener("scroll", saveSnapshot, { passive: true });
    return () => window.removeEventListener("scroll", saveSnapshot);
  }, [saveSnapshot]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !isHistoryReady || !nextCursor || isLoading || error || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextRef.current();
    }, { rootMargin: "400px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, isHistoryReady, isLoading, nextCursor]);

  useEffect(() => () => {
    requestSequence.current += 1;
    pending.current = false;
  }, []);

  async function loadNext() {
    if (!nextCursor || pending.current) return;
    const sequence = ++requestSequence.current;
    pending.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const page = await loadPageRef.current(nextCursor);
      if (sequence !== requestSequence.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.pageInfo.nextCursor);
      setTotal(page.total);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load more inventory.");
    } finally {
      if (sequence === requestSequence.current) {
        pending.current = false;
        setIsLoading(false);
      }
    }
  }

  async function retry() {
    if (nextCursor) {
      await loadNext();
      return;
    }
    const sequence = ++requestSequence.current;
    pending.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const page = await loadPageRef.current(null);
      if (sequence !== requestSequence.current) return;
      setItems(page.items);
      setNextCursor(page.pageInfo.nextCursor);
      setTotal(page.total);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load inventory.");
    } finally {
      if (sequence === requestSequence.current) {
        pending.current = false;
        setIsLoading(false);
      }
    }
  }

  return { error, isHistoryReady, isLoading, items, loadNext, nextCursor, retry, saveSnapshot, sentinelRef, total };
}

function readSnapshot<TItem>(historyStateKey: string): CollectionSnapshot<TItem> | null {
  const snapshot = (window.history.state as Record<string, unknown> | null)?.[historyStateKey];
  if (!snapshot || typeof snapshot !== "object") return null;
  const candidate = snapshot as Partial<CollectionSnapshot<TItem>>;
  return (typeof candidate.filterKey === "string" || typeof candidate.filtersKey === "string") && Array.isArray(candidate.items) &&
    (candidate.nextCursor === null || typeof candidate.nextCursor === "string") &&
    typeof candidate.scrollY === "number" && typeof candidate.total === "number"
    ? (candidate as CollectionSnapshot<TItem>)
    : null;
}
