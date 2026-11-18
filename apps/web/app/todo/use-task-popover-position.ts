"use client";

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { chooseTaskPopoverSide, positionTaskPopover, type Rect, type Side } from "./todo-popover-position";

function findAnchor(number: number | null) {
  const selector = number === null ? "[data-new-task-anchor]" : `[data-task-number="${number}"]`;
  const container = document.activeElement?.closest<HTMLElement>(selector)
    ?? document.querySelector<HTMLElement>(`${selector}[data-selected="true"]`)
    ?? document.querySelector<HTMLElement>(selector);
  return container?.querySelector<HTMLElement>("[data-task-anchor]") ?? container ?? null;
}
function visibleWithinScrollers(anchor: HTMLElement, rect: Rect, viewport: Rect) {
  let left = viewport.left, top = viewport.top, right = viewport.right, bottom = viewport.bottom;
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
}

export function useTaskPopoverPosition(number: number | null) {
  const anchor = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const contentRef = useCallback((node: HTMLDivElement | null) => { content.current = node; setElement(node); }, []);
  const [placement, setPlacement] = useState<{ x: number; y: number; side: Side; arrow: number; showArrow: boolean; ready: boolean; maxHeight: number; maxWidth: number }>({ x: 0, y: 0, side: "bottom", arrow: 0, showArrow: false, ready: false, maxHeight: 576, maxWidth: 380 });
  useLayoutEffect(() => {
    anchor.current = findAnchor(number);
    let side: Side | undefined, lastRect: Rect | undefined, frame = 0;
    const update = () => {
      frame = 0;
      if (!anchor.current?.isConnected) anchor.current = findAnchor(number);
      const viewport = window.visualViewport;
      const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth), bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) };
      const rect = anchor.current?.getBoundingClientRect() ?? lastRect ?? { left: bounds.right / 2, right: bounds.right / 2, top: bounds.bottom / 3, bottom: bounds.bottom / 3 };
      lastRect = rect;
      side ??= chooseTaskPopoverSide(rect, bounds.right, bounds.bottom);
      const maxHeight = Math.max(0, Math.min(window.innerHeight * .8, bounds.bottom - bounds.top - 24));
      const maxWidth = Math.max(0, bounds.right - bounds.left - 24);
      const measured = content.current ? { width: content.current.offsetWidth, height: content.current.offsetHeight } : undefined;
      const position = positionTaskPopover(rect, bounds, { width: measured?.width || 380, height: measured?.height || 240 }, side, !!anchor.current && visibleWithinScrollers(anchor.current, rect, bounds));
      const next = { x: position.x, y: position.y, side: side!, arrow: position.arrow, showArrow: position.showArrow, ready: true, maxHeight, maxWidth };
      setPlacement(previous => previous.x === next.x && previous.y === next.y && previous.side === next.side && previous.arrow === next.arrow && previous.showArrow === next.showArrow && previous.maxHeight === maxHeight && previous.maxWidth === maxWidth && previous.ready ? previous : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (content.current) resize?.observe(content.current);
    if (anchor.current) resize?.observe(anchor.current);
    // Reacquire a replaced task DOM node without resetting the placement or editor.
    const mutations = new MutationObserver(records => { if (records.some(record => !content.current?.contains(record.target))) schedule(); });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    viewportEvents("addEventListener");
    function viewportEvents(method: "addEventListener" | "removeEventListener") { window.visualViewport?.[method]("resize", schedule); window.visualViewport?.[method]("scroll", schedule); }
    return () => { window.cancelAnimationFrame(frame); resize?.disconnect(); mutations.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); viewportEvents("removeEventListener"); };
  }, [number, element]);
  const arrowStyle: CSSProperties = placement.side === "left" ? { right: -15, top: placement.arrow - 6, transform: "rotate(-90deg)", transformOrigin: "center" }
    : placement.side === "right" ? { left: -15, top: placement.arrow - 6, transform: "rotate(90deg)", transformOrigin: "center" }
    : placement.side === "top" ? { bottom: -11, left: placement.arrow - 10 }
    : { top: -11, left: placement.arrow - 10, transform: "rotate(180deg)" };
  return { anchor, content: contentRef, arrowStyle, ...placement };
}

/** Scrollbar gestures are navigation, not requests to dismiss the task. */
export function isTaskScrollbarInteraction(event: PointerEvent | FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-slot="scroll-area-scrollbar"], [data-scope="scroll-area"][data-part="scrollbar"]')) return true;
  if (!("clientX" in event)) return false;
  const rect = target.getBoundingClientRect();
  return (target.scrollHeight > target.clientHeight && target.offsetWidth > target.clientWidth && event.clientX >= rect.left + target.clientLeft + target.clientWidth)
    || (target.scrollWidth > target.clientWidth && target.offsetHeight > target.clientHeight && event.clientY >= rect.top + target.clientTop + target.clientHeight);
}
