"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback, type ReactNode, type CSSProperties } from "react";
import { useTabSelectAll } from "./use-tab-select-all";
import styles from "./task-popover.module.css";
import { Popover, Portal } from "@chakra-ui/react";
import { NestedOverlayContext, useNestedOverlayGuard } from "@/components/shared/nested-overlay-guard";
import { isTaskScrollbarInteraction, useTaskPopoverPosition } from "./use-task-popover-position";
import { usePresence } from "motion/react";

// The calendar's task-placement algorithm supplies fixed viewport coordinates.
const positioning = { strategy: "fixed", applyStyles: false, listeners: false } as const;

export function TaskPopover({ number, titleId, onClose, children, selectTitle = false }: { number: number | null; titleId: string; onClose(): void; children: ReactNode | ((requestClose: () => void) => ReactNode); selectTitle?: boolean }) {
  const position = useTaskPopoverPosition(number);
  const nested = useNestedOverlayGuard();
  const focusedTitle = useRef(false);
  const [open, setOpen] = useState(true);
  const [isPresent, safeToRemove] = usePresence();
  const completion = useRef({ isPresent, safeToRemove, onClose });
  completion.current = { isPresent, safeToRemove, onClose };
  const finished = useRef(false);
  const surface = useRef<HTMLDivElement | null>(null);
  const selectAllRef = useTabSelectAll();
  const contentRef = useCallback((node: HTMLDivElement | null) => { surface.current = node; position.content(node); selectAllRef(node); }, [position.content, selectAllRef]);
  const requestClose = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && surface.current?.contains(document.activeElement)) document.activeElement.blur();
    setOpen(false);
  }, []);
  useLayoutEffect(() => {
    if (!open || !selectTitle || !position.ready || focusedTitle.current) return;
    const input = surface.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="Title"]');
    if (!input || input.matches(":disabled")) return;
    focusedTitle.current = true;
    input.focus({ preventScroll: true });
    input.select();
  });
  const finishClose = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    const latest = completion.current;
    if (!latest.isPresent) latest.safeToRemove?.();
    else {
      const anchor = position.anchor.current;
      (anchor?.matches("button,[tabindex]") ? anchor : anchor?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
      latest.onClose();
    }
  }, [position.anchor]);
  useEffect(() => { if (!isPresent) { if (finished.current) safeToRemove?.(); else requestClose(); } }, [isPresent, safeToRemove, requestClose]);
  useEffect(() => {
    if (open) return;
    // Animation events normally finish the exit. The bound also covers a missing
    // surface, disabled animations, or a background tab that suppresses events.
    const timer = setTimeout(finishClose, 200);
    return () => clearTimeout(timer);
  }, [open, finishClose]);
  return <Popover.Root
    open={open}
    onOpenChange={({ open }) => { if (!open) requestClose(); }}
    positioning={positioning}
    autoFocus={!selectTitle}
    restoreFocus={false}
    onInteractOutside={event => {
      if (nested.protect() || isTaskScrollbarInteraction(event.detail.originalEvent)) event.preventDefault();
    }}
    onEscapeKeyDown={event => {
      if (nested.protect() || document.activeElement?.getAttribute("data-inline-dirty") === "true") event.preventDefault();
    }}>
    <Portal>
      <Popover.Positioner style={{ left: position.x, top: position.y, transform: "none", minWidth: 0, pointerEvents: open ? "auto" : "none" }}>
        <Popover.Content ref={contentRef} unstyled
          data-task-popover-side={position.side} data-position-ready={position.ready} aria-labelledby={titleId}
          style={{ visibility: position.ready ? "visible" : "hidden", maxWidth: position.maxWidth, "--task-popover-max-height": `${position.maxHeight}px` } as CSSProperties}
          className={styles.surface}
          onAnimationEnd={event => { if (!open && event.target === event.currentTarget && event.animationName === getComputedStyle(event.currentTarget).animationName) finishClose(); }}>
          {position.showArrow && <svg data-task-popover-arrow aria-hidden="true" width="20" height="12" viewBox="0 0 20 12" className={styles.arrow} style={position.arrowStyle}>
            <path d="M0 0H20L10 11Z" />
            <path d="M0 0L10 11L20 0" fill="none" className={styles.arrowStroke} strokeWidth="1" strokeLinejoin="round" />
          </svg>}
          <NestedOverlayContext.Provider value={nested.registry}>
            <div className={styles.scrollContent} style={{ maxHeight: Math.max(0, position.maxHeight - 2) }}>{typeof children === "function" ? children(requestClose) : children}</div>
          </NestedOverlayContext.Provider>
        </Popover.Content>
      </Popover.Positioner>
    </Portal>
  </Popover.Root>;
}
