"use client";

// @refresh reset
// Remount callers when this hook is edited instead of retaining an older hook
// layout/dependency list in an already-open development tab.

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ScrollArea } from "@chakra-ui/react";
import s from "../todo/todo-workspace.module.css";

/** Keep the browser's scrolling, momentum and snapping; only replace its scrollbar. */
export function CalendarScrollArea({ children, className, horizontal = false, ref, ...props }: ComponentProps<"div"> & { horizontal?: boolean }) {
  return <ScrollArea.Root className={s.calendarScrollRoot} variant="always" size="lg">
    {/* asChild keeps the consumer's ref and props on a plain div, which is the scrolling element. */}
    <ScrollArea.Viewport asChild>
      <div ref={ref} className={[s.calendarViewport, className].filter(Boolean).join(" ")} {...props}>
        {/* Chakra observes this element to keep the thumb sized as the calendar changes. */}
        <ScrollArea.Content>{children}</ScrollArea.Content>
      </div>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar className={s.calendarScrollbar} />
    {horizontal && <ScrollArea.Scrollbar orientation="horizontal" className={s.calendarHiddenScrollbar} />}
  </ScrollArea.Root>;
}

export const calendarDayIndex = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86400000);
export const calendarDateAt = (index: number) => new Date(index * 86400000).toISOString().slice(0, 10);
export const calendarWeekIndex = (date: string) => Math.floor((calendarDayIndex(date) + 4) / 7);
export const calendarWeekAt = (index: number) => calendarDateAt(index * 7 - 4);

const scrollPosition = (element: HTMLElement, axis: "x" | "y") => axis === "x" ? element.scrollLeft : element.scrollTop;
const moveScroll = (element: HTMLElement, axis: "x" | "y", value: number) => {
  if (axis === "x") element.scrollLeft = value;
  else element.scrollTop = value;
};

/** Recycle offscreen units during scrolling, preserving the visible position. */
export function useCalendarScroll({ date, resetKey, axis, buffer, getIndex, getDate, onNavigate, enabled = true, snap = false, snapOnIdle = false, headerHeight = 0, visibleDays = 7 }: {
  date: string;
  resetKey?: string | number;
  axis: "x" | "y";
  buffer: number;
  getIndex: (date: string) => number;
  getDate: (index: number) => string;
  onNavigate: (date: string) => void;
  enabled?: boolean;
  snap?: boolean;
  snapOnIdle?: boolean;
  headerHeight?: number;
  visibleDays?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(() => ({ date, resetKey, anchor: getIndex(date), reportedDate: date, revision: 0 }));
  const { anchor } = range;
  const pendingPosition = useRef<number | null>(buffer);
  const size = useRef(0);
  const idleSnapping = useRef(false);
  const appliedRevision = useRef(0);
  // A route change from this scroller acknowledges the current window. A toolbar
  // or keyboard jump selects a new window before React commits its DOM.
  if (range.date !== date || range.resetKey !== resetKey) {
    const reset = date !== range.reportedDate || range.resetKey !== resetKey;
    setRange({ date, resetKey, reportedDate: date, anchor: reset ? getIndex(date) : anchor, revision: range.revision + Number(reset) });
  }
  const settle = useEffectEvent(() => {
    const element = ref.current;
    if (!element || !size.current || pendingPosition.current !== null) return;
    const position = scrollPosition(element, axis);
    // Native snapping can be interrupted or lose its target during a window refill.
    // At rest, align horizontal pages before recycling so no fractional offset survives.
    const settledPosition = snap && axis === "x" ? Math.round(position / size.current) * size.current : position;
    if (Math.abs(settledPosition - position) >= 1) moveScroll(element, axis, settledPosition);
    const offset = settledPosition / size.current - buffer;
    // Fractional CSS pixels can round below the restored position. Don't recycle
    // a preceding week repeatedly in response to our own programmatic scroll.
    if (Math.abs(offset * size.current) < 1) return;
    const oversizedPage = axis === "y" && size.current > element.clientHeight + 1;
    const delta = snap && !oversizedPage ? Math.round(offset) : Math.floor(offset + 1 / size.current);
    if (!delta) return;
    pendingPosition.current = settledPosition / size.current - delta;
    const next = anchor + delta;
    const nextDate = getDate(next);
    setRange(current => ({ ...current, anchor: next, reportedDate: nextDate }));
    onNavigate(nextDate);
  });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    if (appliedRevision.current !== range.revision) {
      pendingPosition.current = buffer;
      appliedRevision.current = range.revision;
    }
    const measure = () => {
      const oldSize = size.current;
      const offset = oldSize ? scrollPosition(element, axis) / oldSize : buffer;
      element.style.setProperty("--calendar-day-width", `${Math.max(1, (element.clientWidth - 64) / visibleDays)}px`);
      element.style.setProperty("--calendar-row-height", `${Math.max(70, (element.clientHeight - headerHeight) / 6)}px`);
      element.style.setProperty("--calendar-viewport-height", `${element.clientHeight}px`);
      const unit = element.querySelector<HTMLElement>("[data-scroll-unit]")?.getBoundingClientRect();
      const nextSize = unit ? axis === "x" ? unit.width : unit.height : 0;
      if (!nextSize) return;
      size.current = nextSize;
      moveScroll(element, axis, (pendingPosition.current ?? offset) * nextSize);
      pendingPosition.current = null;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, axis, buffer, enabled, date, resetKey, range.revision, headerHeight, visibleDays]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let frame = 0;
    let pointerDown = false;
    const finish = () => {
      clearTimeout(timer);
      if (!pointerDown && !idleSnapping.current) settle();
    };
    // Keep an idle fallback even when scrollend is advertised: interrupted
    // gestures and pointer release do not reliably emit it in every browser.
    const scheduleFinish = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, 200);
    };
    const scroll = () => {
      // Replacing horizontal snap targets during momentum makes the browser
      // retarget its gesture. Snapped pages wait for scrollend; free horizontal
      // views refill near the buffer edges. Free vertical views refill continuously.
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        const position = size.current ? scrollPosition(element, axis) / size.current : buffer;
        if (!snap && axis === "y" && !idleSnapping.current) settle();
        else if (!snap && axis === "x" && (position <= 1 || position >= buffer * 2 - 1)) finish();
      });
      scheduleFinish();
    };
    const down = () => { pointerDown = true; clearTimeout(timer); };
    const up = () => { pointerDown = false; scroll(); };
    element.addEventListener("wheel", scheduleFinish, { passive: true });
    element.addEventListener("scrollend", finish);
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      element.removeEventListener("wheel", scheduleFinish);
      element.removeEventListener("scrollend", finish);
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [axis, buffer, enabled, snap, visibleDays]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled || !snapOnIdle) return;
    let timer: ReturnType<typeof setTimeout>;
    let held = false;
    const finishIdle = () => {
      if (held || !size.current || pendingPosition.current !== null) return;
      if (idleSnapping.current) {
        idleSnapping.current = false;
        settle();
        return;
      }
      const position = scrollPosition(element, axis);
      const target = Math.round(position / size.current) * size.current;
      const distance = Math.abs(target - position);
      // A tall year must remain readable between its boundaries on small screens.
      if (distance < 1 || (size.current > element.clientHeight && distance > element.clientHeight / 3)) return;
      idleSnapping.current = true;
      element.scrollTo({ [axis === "x" ? "left" : "top"]: target,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      timer = setTimeout(finishIdle, 180);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(finishIdle, 180);
    };
    const interrupt = () => {
      clearTimeout(timer);
      if (idleSnapping.current) {
        idleSnapping.current = false;
        element.scrollTo({ [axis === "x" ? "left" : "top"]: scrollPosition(element, axis), behavior: "instant" });
      }
    };
    const wheel = () => { interrupt(); schedule(); };
    const down = () => { held = true; interrupt(); };
    const up = () => { held = false; schedule(); };
    element.addEventListener("scroll", schedule, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("pointerdown", down);
    element.addEventListener("keydown", wheel);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      clearTimeout(timer);
      idleSnapping.current = false;
      element.removeEventListener("scroll", schedule);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("keydown", wheel);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [axis, enabled, snapOnIdle]);
  return { ref, anchor };
}
