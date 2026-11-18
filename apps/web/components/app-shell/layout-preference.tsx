"use client";

import { LAYOUTS, LAYOUT_KEY, applyLayoutAttribute, type Layout } from "./layout";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export { LAYOUTS, LAYOUT_KEY, type Layout } from "./layout";

function savedLayout(): Layout {
  try {
    const value = localStorage.getItem(LAYOUT_KEY);
    return LAYOUTS.some((layout) => layout.value === value) ? (value as Layout) : "compact";
  } catch {
    return "compact";
  }
}

const LayoutPreferenceContext = createContext<{ layout: Layout; setLayout: (value: Layout) => void }>({
  layout: "compact",
  setLayout: () => {},
});

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => { applyLayoutAttribute(savedLayout()); listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function LayoutPreferenceProvider({ children }: { children: ReactNode }) {
  // The saved choice is only known in the browser; the server render and hydration use the default.
  const layout = useSyncExternalStore(subscribe, savedLayout, () => "compact" as Layout);
  const setLayout = useCallback((value: Layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, value);
    } catch {
      /* storage unavailable */
    }
    applyLayoutAttribute(value);
    listeners.forEach((listener) => listener());
  }, []);
  const value = useMemo(() => ({ layout, setLayout }), [layout, setLayout]);
  return <LayoutPreferenceContext value={value}>{children}</LayoutPreferenceContext>;
}

export const useLayoutPreference = () => useContext(LayoutPreferenceContext);
