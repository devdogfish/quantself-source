"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";

type Registry = { setOpen(id: object, open: boolean): void };
export const NestedOverlayContext = createContext<Registry | null>(null);

export function useNestedOverlayRegistration(open: boolean) {
  const registry = useContext(NestedOverlayContext);
  const token = useRef({});
  useLayoutEffect(() => {
    const id = token.current;
    registry?.setOpen(id, open);
    return () => registry?.setOpen(id, false);
  }, [registry, open]);
}

// A gesture that closes a nested overlay can also send pointer and focus
// events to its parent's dismissable layer. Protect the parent for that gesture.
export function useNestedOverlayGuard() {
  const parent = useContext(NestedOverlayContext);
  const open = useRef(new Set<object>());
  const nestedGesture = useRef(false);
  const registry = useMemo<Registry>(() => ({ setOpen(id, value) {
    if (value) open.current.add(id); else open.current.delete(id);
    parent?.setOpen(id, value);
  } }), [parent]);
  useEffect(() => {
    const start = () => { nestedGesture.current = open.current.size > 0; };
    document.addEventListener("pointerdown", start, true);
    document.addEventListener("keydown", start, true);
    return () => { document.removeEventListener("pointerdown", start, true); document.removeEventListener("keydown", start, true); };
  }, []);
  return { registry, protect: () => open.current.size > 0 || nestedGesture.current };
}
