"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CalendarDaysIcon, ClipboardCheckIcon, ClockIcon } from "lucide-react";
import s from "../todo/todo-workspace.module.css";
import { Button, HStack, VisuallyHidden } from "@chakra-ui/react";
import { CalendarScrollArea, calendarDayIndex, calendarDateAt, calendarWeekIndex, calendarWeekAt, useCalendarScroll } from "./calendar-scroll";
import { snapCalendarStart, snapCalendarEdge, type DragModifiers, type CalendarInterval } from "./calendar-drag";
import { calendarEventBounds, calendarEventLanes, calendarEventVerticalLayout } from "./calendar-event-layout";
import { BudgetCommitmentChips, BudgetCommitmentsStatus, useBudgetCommitments } from "./budget-commitments-calendar";
import { SubscriptionCalendarChips, SubscriptionCalendarStatus, useSubscriptionCalendar } from "./subscription-calendar";
import { HabitCalendarLayer } from "./habit-calendar-layer";
import { useMeetingCalendar } from "./meeting-calendar-source";
import { MeetingDetailsDialog } from "./meeting-details-dialog";
import { taskCalendarSource } from "./task-calendar-source";
import { appointmentsByDate, useNativeAppointments, type NativeAppointment } from "../todo/native-appointments";
import { NativeAppointmentsStatus, NativeCompactEvent, NativeTimelineEvent } from "./native-calendar-event";
import { EventLink } from "../todo/todo-event-link";
import { localDateTime } from "../todo/todo-timing";
import type { Task } from "../todo/todo-projection";
import { minute, time, end, shiftDate, shiftMonth, dateLabel, toneFor, bounds, overlaps, weekStart, fullDateLabel, useCalendarClock, type Actions, monthFormatter, shortMonthFormatter, weekdayFormatter } from "../todo/task-workspace-context";
import { CalendarContextMenu, unfinishedTask, DeadlineChip, EventContextMenu, PriorityReaction } from "../todo/task-workspace-menu";

const GUTTER = 64;

type CalendarDrag = {
  id: string; task: Task; fromDate: string; toDate: string; dates: string[]; pointerY: number;
  originScroll: number; minuteHeight: number; start: number; next: number; clientX: number; clientY: number;
  modifiers: DragModifiers; neighbors: Record<string, CalendarInterval[]>;
  kind: "move" | "start" | "end"; end: number; nextEnd: number; movingEdge?: number;
  moved: boolean; max: number; headerHeight: number; allDay?: boolean; fromAllDay?: boolean;
};
function dragPosition(current: CalendarDrag, clientX: number, clientY: number, area: DOMRect, scrollTop: number, viewportTop: number): CalendarDrag {
  const column = Math.max(0, Math.min(current.dates.length - 1, Math.floor((clientX - area.left - GUTTER) / ((area.width - GUTTER) / current.dates.length))));
  const delta = (clientY - current.pointerY + scrollTop - current.originScroll) / current.minuteHeight;
  if (current.kind !== "move") {
    // Calendar coordinates count wall minutes; resolving the destination date
    // on drop preserves DST validation instead of adding elapsed 24-hour days.
    const dayOffset = (Date.parse(current.dates[column]) - Date.parse(current.fromDate)) / 86400000 * 1440;
    const endpoint = current.kind === "start" ? current.start : current.end;
    const raw = dayOffset + Math.max(0, Math.min(1440, endpoint)) + delta;
    const neighbors = Object.entries(current.neighbors).flatMap(([date, intervals]) => {
      const offset = (Date.parse(date) - Date.parse(current.fromDate)) / 86400000 * 1440;
      return intervals.map(({ start, end }) => ({ start: start + offset, end: end + offset }));
    });
    const edge = snapCalendarEdge(raw, current.kind,
      current.kind === "start" ? current.end : current.start, neighbors, current.modifiers,
      { min: (Date.parse(current.dates[0]) - Date.parse(current.fromDate)) / 86400000 * 1440,
        max: (Date.parse(current.dates.at(-1)!) - Date.parse(current.fromDate)) / 86400000 * 1440 + 1440 });
    const anchor = current.kind === "start" ? current.end : current.start;
    return { ...current, clientX, clientY, next: Math.min(edge, anchor),
      nextEnd: Math.max(edge, anchor), movingEdge: edge, toDate: current.dates[column], moved: true };
  }
  const raw = current.fromAllDay ? (clientY - area.top) / current.minuteHeight : current.start + (clientY - current.pointerY + scrollTop - current.originScroll) / current.minuteHeight;
  const next = snapCalendarStart(raw, 1440 - current.max, current.neighbors[current.dates[column]] ?? [], current.modifiers);
  return { ...current, clientX, clientY, allDay: clientY < area.top + scrollTop && clientY >= viewportTop + current.headerHeight - 28, next, nextEnd: next + current.end - current.start, toDate: current.dates[column], moved: true };
}
function calendarDrop(event: ReactDragEvent, target: Actions, days: Actions[], allDay = false) {
  const raw = event.dataTransfer.getData("application/x-quantself-event");
  if (!raw) return;
  const source = JSON.parse(raw) as { id: string; date: string };
  const task = days.find((day) => day.date === source.date)?.tasks.find((item) => item.id === source.id);
  if (task) { if (allDay && !task.allDay) target.makeAllDay(task); else target.reschedule(task, task.allDay ? 0 : minute(task.start), source.date); }
}
export function CalendarTimeGrid({ hasSubscriptions = false, hasNativeAppointments = false, hasMeetings = false, canCancelMeetings = false, openAppointment, hasHabits, subscribeTasks, date, mode, todayScrollRequest, onCurrentTimeVisibilityChange, actionsForDate, openDay, navigateDate }: { hasSubscriptions?: boolean; hasNativeAppointments?: boolean; hasMeetings?: boolean; canCancelMeetings?: boolean; openAppointment?: (appointment: NativeAppointment) => void; hasHabits: boolean; subscribeTasks: (listener: () => void) => () => void; date: string; navigateDate: (date: string) => void; mode: "calendar" | "week"; todayScrollRequest: number; onCurrentTimeVisibilityChange: (state: { rangeKey: string; visible: boolean }) => void; actionsForDate: (date: string) => Actions; openDay: (date: string) => void }) {
  const [habitDates, setHabitDates] = useState<string[]>([]);
  const hourHeight = mode === "calendar" ? 72 : 64;
  const minuteHeight = hourHeight / 60;
  const visibleDays = mode === "week" ? 7 : 1;
  const { ref: scrollRef, anchor } = useCalendarScroll({ date, resetKey: `${mode}:${todayScrollRequest}`, axis: "x", buffer: visibleDays, visibleDays, snap: true,
    getIndex: (value) => calendarDayIndex(mode === "week" ? weekStart(value) : value), getDate: calendarDateAt, onNavigate: navigateDate });
  const dates = Array.from({ length: visibleDays * 3 }, (_, index) => calendarDateAt(anchor - visibleDays + index));
  const days = dates.map(actionsForDate);
  const from = dates[0], to = dates.at(-1)!;
  const native = useNativeAppointments(from, to, hasNativeAppointments);
  const nativeByDate = useMemo(() => appointmentsByDate(native.appointments, from, to), [native.appointments, from, to]);
  const meetings = useMeetingCalendar(from, to, hasMeetings);
  // Read-only lanes that task drags and resizes snap to.
  const nativeIntervals = (day: string) => [...(nativeByDate.get(day) ?? []).filter(segment => !segment.unplaced).map(bounds),
    ...(meetings.byDate.get(day) ?? []).map(item => ({ start: minute(item.start), end: minute(item.start) + item.minutes }))];
  const subscriptionCalendar = useSubscriptionCalendar(dates[0], dates.at(-1)!, hasSubscriptions);
  const budgetCommitments = useBudgetCommitments(dates[0], dates.at(-1)!, hasSubscriptions);
  // The workspace already subscribes to this store and passes optimistic actions.
  const tasksSource = taskCalendarSource(days, subscribeTasks);
  const tasksByDate = new Map<string, Task[]>();
  for (const { date, task } of tasksSource.load({ from: dates[0], to: dates[dates.length - 1] })) {
    const tasks = tasksByDate.get(date);
    if (tasks) tasks.push(task);
    else tasksByDate.set(date, [task]);
  }
  const rangeKey = `${mode}:${date}`;
  const areaRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef("");
  const timeScrollPositions = useRef<Partial<Record<"calendar" | "week", number>>>({});
  const lastVisibleMinute = useRef<number | null>(null);
  const handledTodayScroll = useRef(0);
  const dragRef = useRef<CalendarDrag | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<CalendarDrag | null>(null);
  const [hover, setHover] = useState<{ id: string; date: string } | null>(null);
  const clock = useCalendarClock();
  const todayColumn = dates.indexOf(clock.date);
  const showToday = todayColumn >= 0 && (mode === "week" || date === clock.date);
  const columnLeft = (fraction: number) => `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${fraction})`;
  const events = days.flatMap((a, column) => {
    const resizing = drag?.moved && drag.kind !== "move" ? drag : null;
    const offset = resizing ? (Date.parse(a.date) - Date.parse(resizing.fromDate)) / 86400000 * 1440 : 0;
    const segmentStart = resizing ? Math.max(0, resizing.next - offset) : 0;
    const segmentEnd = resizing ? Math.min(1440, resizing.nextEnd - offset) : 0;
    const resizeSegment = resizing && segmentEnd > segmentStart ? { ...resizing.task, start: time(segmentStart), minutes: segmentEnd - segmentStart,
      continuesBefore: resizing.next < offset, continuesAfter: resizing.nextEnd > offset + 1440 } : null;
    // Keep the captured source mounted even if shortening removes its day.
    const sourceTasks = tasksByDate.get(a.date) ?? [];
    const dayTasks = resizing ? sourceTasks.filter(task => task.id !== resizing.id || a.date === resizing.fromDate) : sourceTasks;
    if (resizeSegment && a.date !== resizing!.fromDate) dayTasks.push(resizeSegment);
    const projected = dayTasks.map(task => task.allDay && drag?.fromAllDay && drag.id === task.id && drag.fromDate === a.date
      ? { ...task, allDay: false, start: time(drag.next), minutes: 30, unknownDuration: false } : task);
    const tasks = projected.filter(task => task.state !== "someday" && task.start && !task.allDay && !task.unknownDuration && !task.unplaced)
      .map(task => ({ id: task.id, source: "github" as const, task, timing: task }));
    const appointments = (nativeByDate.get(a.date) ?? []).filter(timing => !timing.unplaced)
      .map(timing => ({ id: timing.appointment.id, source: "native" as const, timing }));
    const dayMeetings = (meetings.byDate.get(a.date) ?? []).map(item => ({ id: `meeting:${item.meeting.id}`, source: "meeting" as const, item, timing: item }));
    return calendarEventLanes([...tasks, ...appointments, ...dayMeetings], minuteHeight).map(event => ({ ...event, a, column }));
  });
  const taskEvents = events.filter(event => event.source === "github");
  function eventStyle(vertical: {top: number; height: number}, column: number, lane: number, lanes: number): CSSProperties {
    const taskWidth = hasHabits && habitDates.includes(dates[column]) ? .72 : 1;
    const widthFraction = taskWidth / (dates.length * lanes);
    return {
      top: `${vertical.top}px`, height: `${vertical.height}px`,
      left: `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${(column + taskWidth * lane / lanes) / dates.length} + 1.5px)`,
      width: `calc(${100 * widthFraction}% - ${GUTTER * widthFraction + 4}px)`,
    };
  }
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const saved = timeScrollPositions.current[mode];
    if (saved !== undefined || lastVisibleMinute.current !== null) {
      scroll.scrollTop = saved ?? lastVisibleMinute.current! * minuteHeight;
      initialScroll.current = `${mode}:time`;
    }
    const remember = () => {
      timeScrollPositions.current[mode] = scroll.scrollTop;
      lastVisibleMinute.current = scroll.scrollTop / minuteHeight;
    };
    scroll.addEventListener("scroll", remember, { passive: true });
    return () => {
      if (initialScroll.current === `${mode}:time` || timeScrollPositions.current[mode] !== undefined) remember();
      scroll.removeEventListener("scroll", remember);
    };
  }, [mode, minuteHeight]);
  useLayoutEffect(() => {
    if (!clock.timestamp || !scrollRef.current || initialScroll.current === `${mode}:time` || scrollRef.current.scrollHeight <= scrollRef.current.clientHeight) return;
    initialScroll.current = `${mode}:time`;
    const start = showToday ? Math.max(0, clock.minutes - 180) : 8 * 60;
    scrollRef.current.scrollTop = start * minuteHeight;
  }, [clock.timestamp, clock.minutes, mode, date, showToday, minuteHeight]);
  useEffect(() => {
    const scroll = scrollRef.current;
    const area = areaRef.current;
    if (handledTodayScroll.current === todayScrollRequest || !clock.timestamp || date !== clock.date || todayColumn < 0 || !scroll || !area) return;
    // A nearby date can already contain today's buffered column. Wait for the
    // requested date and horizontal layout before positioning the time.
    // Instant scrolling avoids horizontal snap adjustments cancelling the jump.
    const frame = window.requestAnimationFrame(() => {
      const headerHeight = area.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      const visibleHoursHeight = Math.max(0, scroll.clientHeight - headerHeight);
      if (!visibleHoursHeight) return;
      handledTodayScroll.current = todayScrollRequest;
      initialScroll.current = `${mode}:time`;
      scroll.scrollTo({ top: Math.max(0, clock.minutes * minuteHeight - visibleHoursHeight * .35), behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [todayScrollRequest, date, anchor, clock.date, clock.timestamp, clock.minutes, todayColumn, minuteHeight, mode]);
  useEffect(() => {
    const scroll = scrollRef.current;
    const area = areaRef.current;
    if (!scroll || !area) return;
    let previous: boolean | undefined;
    const update = () => {
      area.style.setProperty("--calendar-scroll-left", `${scroll.scrollLeft}px`);
      const viewport = scroll.getBoundingClientRect();
      const areaTop = area.getBoundingClientRect().top;
      const headerHeight = areaTop - viewport.top + scroll.scrollTop;
      const markerTop = areaTop + clock.minutes * minuteHeight;
      const columnWidth = (area.getBoundingClientRect().width - GUTTER) / dates.length;
      const todayLeft = area.getBoundingClientRect().left + GUTTER + todayColumn * columnWidth;
      const visible = !!clock.timestamp && todayColumn >= 0 && todayLeft >= viewport.left + GUTTER - 1 && todayLeft + columnWidth <= viewport.right + 1 && markerTop >= viewport.top + headerHeight + 8 && markerTop <= viewport.bottom - 8;
      if (visible !== previous) { previous = visible; onCurrentTimeVisibilityChange({ rangeKey, visible }); }
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    observer.observe(area.parentElement!);
    return () => { scroll.removeEventListener("scroll", update); observer.disconnect(); };
  }, [clock.timestamp, clock.minutes, todayColumn, minuteHeight, rangeKey, onCurrentTimeVisibilityChange]);
  useEffect(() => {
    const cancel = () => { dragRef.current = null; suppressClick.current = true; setDrag(null); };
    const keyboard = (event: KeyboardEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (event.key === "Escape") { cancel(); return; }
      current.modifiers = { shiftKey: event.shiftKey, metaKey: event.metaKey };
      if (!current.moved || !areaRef.current || !scrollRef.current) return;
      const next = dragPosition(current, current.clientX, current.clientY, areaRef.current.getBoundingClientRect(), scrollRef.current.scrollTop, scrollRef.current.getBoundingClientRect().top);
      dragRef.current = next;
      setDrag(next);
    };
    window.addEventListener("keydown", keyboard);
    window.addEventListener("keyup", keyboard);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", keyboard); window.removeEventListener("keyup", keyboard); window.removeEventListener("blur", cancel); };
  }, []);
  const moving = !!drag?.moved;
  useEffect(() => {
    if (!moving) return;
    let frame = 0;
    let bottomSince: number | null = null;
    const tick = () => {
      const current = dragRef.current;
      const scroll = scrollRef.current;
      const area = areaRef.current;
      if (!current || !scroll || !area) return;
      const rect = scroll.getBoundingClientRect();
      const atBottom = current.clientY > rect.bottom - 44 && current.clientY <= rect.bottom;
      bottomSince = atBottom ? bottomSince ?? performance.now() : null;
      const dy = bottomSince !== null && performance.now() - bottomSince >= 500 ? 12 : 0;
      const dx = current.dates.length > 1 && scroll.scrollWidth > scroll.clientWidth ? current.clientX > rect.right - 36 ? 12 : current.clientX < rect.left + GUTTER + 20 ? -12 : 0 : 0;
      if (dy || dx) scroll.scrollBy(dx, dy);
      // Recompute even without auto-scroll so wheel/trackpad scrolling works during a drag.
      const next = dragPosition(current, current.clientX, current.clientY, area.getBoundingClientRect(), scroll.scrollTop, rect.top);
      if (next.next !== current.next || next.nextEnd !== current.nextEnd || next.toDate !== current.toDate || next.allDay !== current.allDay) { dragRef.current = next; setDrag(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving]);
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>, task: Task, sourceDate: string, kind: CalendarDrag["kind"] = "move") => {
    const interaction = tasksSource.interact({ date: sourceDate, task });
    if (!(kind === "move" ? interaction.draggable : interaction.resizable) || event.button !== 0 || !scrollRef.current) return;
    suppressClick.current = false;
    // Avoid the browser scrolling a newly focused event after the drag origin
    // has been recorded. Selection and capture belong to this same gesture.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    actionsForDate(sourceDate).selectEvent(task.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const duration = task.allDay ? 30 : task.minutes;
    const wallMinute = (instant: string) => (Date.parse(`${localDateTime(instant)}:00Z`) - Date.parse(`${sourceDate}T00:00:00Z`)) / 60000;
    const resizeStart = kind !== "move" && task.startsAt ? wallMinute(task.startsAt) : minute(task.start);
    const resizeEnd = kind !== "move" && task.endsAt ? wallMinute(task.endsAt) : minute(task.start) + duration;
    dragRef.current = { task, kind, fromAllDay: task.allDay, allDay: task.allDay, end: resizeEnd, nextEnd: resizeEnd, modifiers: { shiftKey: event.shiftKey, metaKey: event.metaKey },
      neighbors: Object.fromEntries(days.map(day => [day.date, [...day.tasks.filter(other => other.number !== task.number && other.start && !other.allDay && !other.unplaced && !other.unknownDuration && other.state !== "someday").map(bounds), ...nativeIntervals(day.date)]])), id: task.id, fromDate: sourceDate, toDate: sourceDate, dates, pointerY: event.clientY, originScroll: scrollRef.current.scrollTop, minuteHeight, start: resizeStart, next: resizeStart, clientX: event.clientX, clientY: event.clientY, moved: false, max: 1440 - duration, headerHeight: mode === "week" ? 68 : 28 };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || !areaRef.current || !scrollRef.current) return;
    if (!current.moved && Math.abs(event.clientY - current.pointerY) < 4 && Math.abs(event.clientX - current.clientX) < 4) return;
    const next = dragPosition({ ...current, modifiers: { shiftKey: event.shiftKey, metaKey: event.metaKey } }, event.clientX, event.clientY, areaRef.current.getBoundingClientRect(), scrollRef.current.scrollTop, scrollRef.current.getBoundingClientRect().top);
    dragRef.current = next;
    setDrag(next);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLButtonElement>, task: Task) => {
    const current = dragRef.current;
    dragRef.current = null;
    if (current?.moved) {
      suppressClick.current = true;
      if (current.kind !== "move") {
        if (current.next !== current.start || current.nextEnd !== current.end)
          actionsForDate(shiftDate(current.fromDate, Math.floor(current.movingEdge! / 1440))).resize(task, current.kind, ((current.movingEdge! % 1440) + 1440) % 1440);
      } else if (current.allDay) {
        if (!current.fromAllDay) actionsForDate(current.toDate).makeAllDay(task);
        else if (current.toDate !== current.fromDate) actionsForDate(current.toDate).reschedule(task, 0, current.fromDate);
      } else if (current.fromAllDay) actionsForDate(current.toDate).makeTimed(task, current.next);
      else if (current.next !== current.start || current.toDate !== current.fromDate) actionsForDate(current.toDate).reschedule(task, current.next, current.fromDate);
    }
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const focusTarget = drag ? { id: drag.id, date: drag.fromDate } : hover;
  const focusedEvent = focusTarget ? taskEvents.find((entry) => entry.task.id === focusTarget.id && entry.a.date === focusTarget.date) : taskEvents.find((entry) => entry.a.isEventSelected(entry.task.id));
  const focusedOffset = drag && drag.kind !== "move" ? (Date.parse(drag.toDate) - Date.parse(drag.fromDate)) / 86400000 * 1440 : 0;
  const focusedStart = drag ? Math.max(0, Math.min(1439, drag.next - focusedOffset)) : 0;
  const focusedEnd = drag ? Math.max(focusedStart + 1, Math.min(1440, drag.nextEnd - focusedOffset)) : 0;
  const focusedTask = focusedEvent ? { ...focusedEvent.task, start: drag ? time(focusedStart) : focusedEvent.task.start, minutes: drag ? focusedEnd - focusedStart : focusedEvent.task.minutes } : null;
  const boundaryTimes = focusedTask ? [...new Set([bounds(focusedTask).start, minute(focusedTask.start), minute(focusedTask.start) + focusedTask.minutes, bounds(focusedTask).end])].sort((x, y) => x - y) : [];
  const boundaryLabelOffset = (value: number) => {
    if (!focusedTask) return 0;
    const start = minute(focusedTask.start);
    const finish = start + focusedTask.minutes;
    const coreOffset = Math.max(0, (22 - focusedTask.minutes * minuteHeight) / 2);
    if (value < start) return Math.min(0, (start - value) * minuteHeight - 22 - coreOffset);
    if (value > finish) return Math.max(0, 22 + coreOffset - (value - finish) * minuteHeight);
    return value === start ? -coreOffset : coreOffset;
  };
  const draggingConflicts = drag && focusedTask ? actionsForDate(drag.toDate).tasks.filter((task) => task.id !== focusedTask.id && task.state === "active" && task.start && !task.allDay && overlaps(focusedTask, task)) : [];
  const gridStyle: CSSProperties = { gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` };
  return <CalendarScrollArea horizontal role="region" className={s.calendarScroll} data-calendar-grid tabIndex={0} ref={scrollRef} data-mode={mode} aria-label={mode === "week" ? "Scrollable week calendar" : "Scrollable 24-hour calendar"}>
    <div className={s.calendarFrame}>
      {mode === "week" && <div className={s.dateHeaders}><div className={s.headerGutter} /><div className={s.headerDays} style={gridStyle}>{days.map((day) => <button data-scroll-unit key={day.date} className={s.dateHeader} data-weekend={[0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay())} onClick={() => openDay(day.date)} aria-label={`Open ${fullDateLabel(day.date)}`}><span>{weekdayFormatter.format(new Date(`${day.date}T12:00:00Z`))}</span><strong data-today={day.date === clock.date}>{Number(day.date.slice(8))}</strong></button>)}</div></div>}
      <div className={s.allDayRow} style={{ top: mode === "week" ? "40px" : "0px" }}><span>all-day<SubscriptionCalendarStatus value={subscriptionCalendar} /><BudgetCommitmentsStatus value={budgetCommitments} /><NativeAppointmentsStatus error={native.error} retry={native.retry} />{hasMeetings && meetings.error && <HStack as="span"><span role="status">Meetings unavailable.</span><Button size="xs" variant="outline" onClick={meetings.retry}>Retry meetings</Button></HStack>}</span><div className={s.allDayColumns} style={gridStyle}>{days.map((day) => <CalendarContextMenu key={day.date} target={{ a: day, start: "00:00", allDay: true }}><div className={s.allDayCell} data-calendar-day={day.date} data-scroll-unit={mode === "calendar" ? "" : undefined} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button,a")) day.openAdd("00:00", true); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); calendarDrop(event, day, days, true); }}>{(nativeByDate.get(day.date) ?? []).filter(segment => segment.unplaced).map(segment => <NativeCompactEvent key={segment.appointment.id} segment={segment} onOpen={openAppointment} unplaced />)}{<SubscriptionCalendarChips payments={subscriptionCalendar.days.get(day.date)} />}<BudgetCommitmentChips events={budgetCommitments.days.get(day.date)} />{day.deadlines?.map(task => <DeadlineChip key={`due:${task.id}`} task={task} a={day} />)}{drag?.allDay && drag.toDate === day.date && focusedEvent && <span className={s.allDayEvent} data-tone={toneFor(focusedEvent.task)} aria-label="Move to all-day"><span className={s.compactEventIcon} aria-hidden="true"><CalendarDaysIcon /></span><span className={s.compactEventTitle}>{focusedEvent.task.title}</span></span>}{day.tasks.filter((task) => (task.allDay || task.unplaced) && task.start && task.state !== "someday").map((task) => <div key={task.id} className={s.compactEvent} data-selected={day.isEventSelected(task.id)} data-unfinished={unfinishedTask(task, clock.timestamp)}><EventContextMenu task={task} a={day}><button aria-label={`${task.title}${unfinishedTask(task, clock.timestamp) ? ", unfinished" : ""}`} className={s.allDayEvent} style={{ opacity: drag?.fromAllDay && drag.id === task.id && drag.fromDate === day.date ? 0 : undefined, touchAction: "none" }} data-tone={toneFor(task)} onPointerDown={event => { if (!task.unplaced) pointerDown(event, task, day.date); }} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event, task)} onPointerCancel={() => { dragRef.current = null; setDrag(null); suppressClick.current = true; }} onLostPointerCapture={() => { if (dragRef.current) { dragRef.current = null; setDrag(null); } }} aria-pressed={day.isEventSelected(task.id)} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } day.selectEvent(task.id); }} onDoubleClick={(event) => { event.stopPropagation(); day.edit(task); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); day.edit(task); } }} title={task.timingWarning} draggable={false}><span className={s.compactEventIcon} aria-hidden="true"><CalendarDaysIcon /></span><span className={s.compactEventTitle}>{task.unplaced ? "Review time · " : ""}{task.title}</span>{day.priorities.includes(task.id) && <span className={s.compactPriorityReaction} aria-label="Top priority">!!</span>}</button></EventContextMenu> <EventLink task={task} compact /></div>)}</div></CalendarContextMenu>)}</div></div>
      <CalendarContextMenu target={{ a: actionsForDate(date) }} resolve={(event) => {
        const area = event.currentTarget.getBoundingClientRect();
        const column = Math.max(0, Math.min(dates.length - 1, Math.floor((event.clientX - area.left - GUTTER) / ((area.width - GUTTER) / dates.length))));
        const start = Math.max(0, Math.min(1410, Math.round((event.clientY - area.top) / minuteHeight / 5) * 5));
        return { a: actionsForDate(dates[column]), start: time(start) };
      }}><div data-calendar-time-area className={s.calendarTimeArea} style={{ height: `${hourHeight * 24}px` }} ref={areaRef} onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,a")) return; const area = event.currentTarget.getBoundingClientRect(); const column = Math.max(0, Math.min(dates.length - 1, Math.floor((event.clientX - area.left - GUTTER) / ((area.width - GUTTER) / dates.length)))); const start = Math.max(0, Math.min(1410, Math.round((event.clientY - area.top) / minuteHeight / 5) * 5)); actionsForDate(dates[column]).openAdd(time(start)); }} onPointerLeave={() => { if (!dragRef.current) setHover(null); }}>
        <VisuallyHidden as="span" id="calendar-keyboard-help">Drag an event to move it; drag its top or bottom edge to resize. Use arrow keys on an edge to resize. Drag in 15-minute steps. Hold ⌘ for 5-minute steps or Shift for minute precision. ⌘Z: Undo. ⌘⇧Z: Redo. Click to select. Double-click or Enter for task details. Scroll for all twenty-four hours. ⌘C / X / V: Copy / move / paste task on the selected date. Delete: Unschedule. Alt↑ / ↓: Move five minutes.</VisuallyHidden>
        <div className={s.timeRuler}>
          <div className={s.axisRail} />
          {Array.from({ length: 25 }, (_, index) => <span className={s.rulerHour} key={index} style={{ top: `${index * hourHeight}px`, transform: index === 0 ? "none" : index === 24 ? "translateY(-100%)" : undefined }}>{String(index % 24).padStart(2, "0")}:00</span>)}
          {focusedTask && <div className={s.boundaries} aria-hidden="true"><div className={s.axisMask} style={{ top: `${bounds(focusedTask).start * minuteHeight - 40}px`, height: `${(bounds(focusedTask).end - bounds(focusedTask).start) * minuteHeight + 80}px` }} />{boundaryTimes.map((value) => <div key={value} className={[s.boundary, (value === minute(focusedTask.start) || value === minute(focusedTask.start) + focusedTask.minutes) && s.coreBoundary].filter(Boolean).join(" ")} style={{ top: `${value * minuteHeight}px` }}><span style={{ marginTop: `${boundaryLabelOffset(value)}px` }}>{time(value)}</span></div>)}</div>}
          {showToday && <span className={s.rulerNow} style={{ top: `${clock.minutes * minuteHeight}px` }}>{clock.label}</span>}
        </div>
        <div className={s.dayColumnBackgrounds} style={gridStyle}>{dates.map((value) => <div key={value} data-weekend={[0, 6].includes(new Date(`${value}T12:00:00Z`).getUTCDay())} />)}</div>
        <div className={s.calendarHours}>{Array.from({ length: 25 }, (_, index) => <div className={s.hourBand} style={{ top: `${index * hourHeight}px`, height: index === 24 ? 0 : hourHeight }} key={index}><i /></div>)}</div>
        {hasHabits && <HabitCalendarLayer dates={dates} minuteHeight={minuteHeight} gutter={GUTTER} onDatesChange={setHabitDates} />}
        {events.map(event => {
          const { a, column, lane, lanes } = event;
          if (event.source === "meeting") {
            const vertical = calendarEventVerticalLayout(minute(event.item.start), event.coreMinutes, minuteHeight);
            const compact = vertical.height < (mode === "week" ? 42 : 26);
            return meetings.source.render(event.item, { style: eventStyle(vertical, column, lane, lanes), week: mode === "week", compact,
              detailed: !compact && vertical.height >= 54, ...meetings.source.interact(event.item) });
          }
          if (event.source === "native") {
            const segment = event.timing;
            const heightMinutes = segment.prepOnly ? segment.minutes : event.coreMinutes;
            const vertical = calendarEventVerticalLayout(minute(segment.start), heightMinutes, minuteHeight);
            const compact = vertical.height < (mode === "week" ? 42 : 26);
            return <NativeTimelineEvent key={`native:${a.date}:${event.id}`} segment={segment}
              onOpen={openAppointment} date={a.date} week={mode === "week"} minuteHeight={minuteHeight}
              compact={compact} detailed={!compact && vertical.height >= 54} style={eventStyle(vertical, column, lane, lanes)} />;
          }
          const { task } = event;
          const { onOpen, resizable } = tasksSource.interact({ date: a.date, task });
          const isDragging = drag?.id === task.id && drag.fromDate === a.date;
          const resizeEdgesCrossed = isDragging && drag.kind !== "move" && drag.movingEdge !== undefined
            && (drag.kind === "start" ? drag.movingEdge > drag.end : drag.movingEdge < drag.start);
          const resizeOffset = drag ? (Date.parse(a.date) - Date.parse(drag.fromDate)) / 86400000 * 1440 : 0;
          const shownTask = isDragging && drag.kind !== "move" ? { ...task, start: time(Math.max(0, Math.min(1439, drag.next - resizeOffset))),
            minutes: Math.max(1, Math.min(1440, drag.nextEnd - resizeOffset) - Math.max(0, drag.next - resizeOffset)) }
            : isDragging ? { ...task, start: time(drag.next), minutes: drag.nextEnd - drag.next } : task;
          const total = task.prepOnly ? task.minutes : calendarEventBounds(shownTask, minuteHeight).coreMinutes;
          const isBlocked = task.readiness ? task.readiness === "blocked" : task.prerequisites.some((id) => a.tasks.find((item) => item.id === id)?.state !== "completed");
          const shownColumn = isDragging && drag.kind === "move" ? dates.indexOf(drag.toDate) : column;
          const shownLane = isDragging ? 0 : lane;
          const shownLanes = isDragging ? 1 : lanes;
          const shownStart = minute(shownTask.start);
          const vertical = calendarEventVerticalLayout(shownStart, total, minuteHeight);
          // Fit the rendered card, including clipped multi-day segments and resize previews.
          const compact = vertical.height < (mode === "week" ? 42 : 26);
          const detailed = !compact && vertical.height >= 54;
          const style: CSSProperties = {
            ...eventStyle(vertical, shownColumn, shownLane, shownLanes),
            opacity: isDragging && (drag.allDay || (drag.kind !== "move" && (drag.nextEnd <= resizeOffset || drag.next >= resizeOffset + 1440))) ? 0 : undefined,
          };
          if (task.prepOnly) return <EventContextMenu key={`${a.date}:${task.id}`} task={task} a={a}><div className={s.calendarEvent} data-tone={toneFor(task)} data-week={mode === "week"} style={style}><button className={s.prepExtension} data-side={task.prepOnly} style={{ height: "100%" }} onClick={onOpen} title={`${task.title}: ${task.minutes} minutes prep ${task.prepOnly}`} aria-label={`${task.title}: prep ${task.prepOnly}`}>{task.prepOnly === "before" ? <ClipboardCheckIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}<span className={s.prepFullLabel}>{task.minutes} minutes {task.prepOnly === "before" ? "prep time" : "after event"} · {task.title}</span><span className={s.prepCompactLabel}>{task.prepOnly === "before" ? "Prep" : "After"} · {task.minutes}m</span></button></div></EventContextMenu>;
          return <EventContextMenu key={`${a.date}:${task.id}`} task={task} a={a}><div className={[s.calendarEvent, isDragging && s.dragging, task.state === "completed" && s.completedEvent].filter(Boolean).join(" ")} data-kind="task" data-unfinished={unfinishedTask(task, clock.timestamp)} data-tone={toneFor(task)} data-highlighted={a.isEventSelected(task.id) || (focusedEvent?.task.id === task.id && focusedEvent.a.date === a.date)} data-week={mode === "week"} data-short={compact} style={style} onPointerEnter={() => setHover({ id: task.id, date: a.date })} onPointerLeave={() => { if (!dragRef.current) setHover((current) => current?.id === task.id && current.date === a.date ? null : current); }}>
            {(shownTask.beforeMinutes ?? 0) > 0 && <button className={s.prepExtension} data-side="before" style={{ bottom: "100%", height: `${shownTask.beforeMinutes! * minuteHeight}px` }} title={`${shownTask.title}: ${shownTask.beforeMinutes} minutes prep before`} aria-label={`${shownTask.title}: ${shownTask.beforeMinutes} minutes prep before`} onClick={onOpen}><ClipboardCheckIcon aria-hidden="true" /><span className={s.prepFullLabel}>{shownTask.beforeMinutes} minutes prep time</span><span className={s.prepCompactLabel}>Prep · {shownTask.beforeMinutes}m</span></button>}
            {(shownTask.afterMinutes ?? 0) > 0 && <button className={s.prepExtension} data-side="after" style={{ top: "100%", height: `${shownTask.afterMinutes! * minuteHeight}px` }} title={`${shownTask.title}: ${shownTask.afterMinutes} minutes prep after`} aria-label={`${shownTask.title}: ${shownTask.afterMinutes} minutes prep after`} onClick={onOpen}><ClockIcon aria-hidden="true" /><span className={s.prepFullLabel}>{shownTask.afterMinutes} minutes after event</span><span className={s.prepCompactLabel}>After · {shownTask.afterMinutes}m</span></button>}
            <div className={s.eventCore}><PriorityReaction task={task} a={a} /><button data-task-anchor className={s.timelineBlock} data-detailed={detailed} aria-pressed={a.isEventSelected(task.id)} aria-label={`Event ${task.title}, ${dateLabel(isDragging ? drag.toDate : a.date)}, ${shownTask.start} to ${end(shownTask)}${task.fixed ? ", fixed appointment" : ""}${unfinishedTask(task, clock.timestamp) ? ", unfinished" : ""}`} title={task.timingWarning} aria-describedby="calendar-keyboard-help" onPointerDown={(event) => pointerDown(event, task, a.date)} onPointerMove={pointerMove} onPointerUp={(event) => pointerUp(event, task)} onPointerCancel={() => { dragRef.current = null; setDrag(null); suppressClick.current = true; }} onLostPointerCapture={() => { if (dragRef.current) { dragRef.current = null; setDrag(null); } }} onFocus={() => setHover({ id: task.id, date: a.date })} onBlur={() => { if (!dragRef.current) setHover(null); }} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } a.selectEvent(task.id); }} onDoubleClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen(); } if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); a.reschedule(task, Math.max(0, Math.min(1440 - task.minutes, minute(task.start) + (event.key === "ArrowUp" ? -5 : 5)))); } }}>
              {tasksSource.render({ date: a.date, task, actions: a }, { shownTask, detailed, blocked: isBlocked, showPerson: mode === "calendar" })}
            </button><EventLink task={task} /></div>
            {(["start", "end"] as const).filter(edge => edge === "start" ? !task.continuesBefore : !task.continuesAfter).map(edge => <button
              key={edge} className={s.resizeHandle} data-edge={resizeEdgesCrossed ? (edge === "start" ? "end" : "start") : edge} disabled={!resizable}
              aria-label={`Resize ${edge} of ${task.title}`} title={`Drag to change ${edge} time`}
              onPointerDown={event => pointerDown(event, task, a.date, edge)} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event, task)}
              onPointerCancel={() => { dragRef.current = null; setDrag(null); }} onLostPointerCapture={() => { if (dragRef.current) { dragRef.current = null; setDrag(null); } }}
              onClick={event => { event.stopPropagation(); suppressClick.current = false; }}
              onKeyDown={event => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const step = event.shiftKey ? 1 : event.metaKey ? 5 : 15;
                const anchor = edge === "start" ? minute(task.start) + task.minutes : minute(task.start);
                const raw = (edge === "start" ? minute(task.start) : minute(task.start) + task.minutes) + (event.key === "ArrowUp" ? -step : step);
                a.resize(task, edge, snapCalendarEdge(raw, edge, anchor, [...a.tasks.filter(other => other.number !== task.number && other.start && !other.allDay && !other.unplaced && !other.unknownDuration && other.state !== "someday").map(bounds), ...nativeIntervals(a.date)], event));
              }} />)}
          </div></EventContextMenu>;
        })}

        {showToday && <div className={s.nowLine} style={{ top: `${clock.minutes * minuteHeight}px` }} aria-label={`Current time ${clock.label} Halifax`}><i /><b style={{ left: columnLeft(todayColumn / dates.length), width: `calc((100% - ${GUTTER}px) / ${dates.length})` }} /></div>}
        {drag?.moved && focusedTask && <div className={s.dragHint} style={{ top: `${bounds(focusedTask).end * minuteHeight}px` }}>{dateLabel(drag.toDate)} · {focusedTask.start}–{end(focusedTask)}{draggingConflicts.length ? " · overlap; drop keeps both" : " · release to place"}</div>}
      </div></CalendarContextMenu>
    </div>
    <MeetingDetailsDialog item={meetings.selected} canCancel={canCancelMeetings} onClose={meetings.close} />
  </CalendarScrollArea>;
}
export function MonthCalendar({ hasSubscriptions = false, hasNativeAppointments = false, openAppointment, date, todayScrollRequest, actionsForDate, openDay, navigateMonth }: { hasSubscriptions?: boolean; hasNativeAppointments?: boolean; openAppointment?: (appointment: NativeAppointment) => void; date: string; todayScrollRequest: number; actionsForDate: (date: string) => Actions; openDay: (date: string) => void; navigateMonth: (date: string) => void }) {
  const clock = useCalendarClock();
  const { ref: containerRef, anchor } = useCalendarScroll({ date, resetKey: todayScrollRequest, axis: "y", buffer: 6, snap: false, snapOnIdle: true, headerHeight: 28,
    getIndex: (value) => calendarWeekIndex(`${value.slice(0, 7)}-01`),
    getDate: (index) => shiftDate(calendarWeekAt(index), 14), onNavigate: navigateMonth });
  const [visibleCount, setVisibleCount] = useState(2);
  const scope = `${date}:${todayScrollRequest}`;
  const [cursor, setCursor] = useState<{ scope: string; date: string }>({ scope, date });
  const activeDate = cursor.scope === scope ? cursor.date : date;
  const pendingFocus = useRef<string | null>(null);
  const handledTodayScroll = useRef(todayScrollRequest);
  useEffect(() => {
    if (pendingFocus.current) {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      containerRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date-kind="month"][data-date="${target}"]`)?.focus();
    }
  }, [date]);
  useEffect(() => {
    if (handledTodayScroll.current === todayScrollRequest || date.slice(0, 7) !== clock.date.slice(0, 7)) return;
    const target = containerRef.current?.querySelector<HTMLButtonElement>('button[data-today-first-event="true"]')
      || containerRef.current?.querySelector<HTMLButtonElement>('button[data-today="true"]');
    if (!target) return;
    handledTodayScroll.current = todayScrollRequest;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [todayScrollRequest, date, clock.date]);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setVisibleCount(Math.max(1, Math.floor(((element.clientHeight - 28) / 6 - 44) / 19)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const start = calendarWeekAt(anchor - 6);
  const days = Array.from({ length: 126 }, (_, index) => actionsForDate(shiftDate(start, index)));
  const lastDay = days.at(-1)!.date;
  const native = useNativeAppointments(start, lastDay, hasNativeAppointments);
  const nativeByDate = useMemo(() => appointmentsByDate(native.appointments, start, lastDay), [native.appointments, start, lastDay]);
  const subscriptionCalendar = useSubscriptionCalendar(start, days.at(-1)!.date, hasSubscriptions);
  const budgetCommitments = useBudgetCommitments(start, days.at(-1)!.date, hasSubscriptions);
  const handleDateKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-calendar-date-kind="month"]');
    if (!button) return;
    const current = button.dataset.date || activeDate;
    let target: string | null = null;
    if (event.key === "ArrowLeft") target = shiftDate(current, -1);
    else if (event.key === "ArrowRight") target = shiftDate(current, 1);
    else if (event.key === "ArrowUp") target = shiftDate(current, -7);
    else if (event.key === "ArrowDown") target = shiftDate(current, 7);
    else if (event.key === "Home") target = shiftDate(current, -new Date(`${current}T12:00:00Z`).getUTCDay());
    else if (event.key === "End") target = shiftDate(current, 6 - new Date(`${current}T12:00:00Z`).getUTCDay());
    else if (event.key === "PageUp" || event.key === "PageDown") {
      target = shiftMonth(current, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
      pendingFocus.current = target;
      event.preventDefault();
      navigateMonth(target);
      return;
    }
    if (!target) return;
    event.preventDefault();
    if (!days.some((day) => day.date === target)) {
      pendingFocus.current = target;
      navigateMonth(target);
      return;
    }
    setCursor({ scope, date: target });
    containerRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date-kind="month"][data-date="${target}"]`)?.focus();
  };
  return <CalendarScrollArea ref={containerRef} className={s.monthCalendar} data-calendar-grid role="group" aria-label="Month dates and events" aria-describedby="month-keyboard-help" onKeyDown={handleDateKeyDown}>
    <SubscriptionCalendarStatus value={subscriptionCalendar} /><BudgetCommitmentsStatus value={budgetCommitments} /><NativeAppointmentsStatus error={native.error} retry={native.retry} />
    <VisuallyHidden id="month-keyboard-help">Use arrow keys to move between dates, Home and End within a week, and Page Up or Page Down to change months. Add Shift to change years. Tab moves through events and leaves the calendar. Enter or Space on a date opens Day view.</VisuallyHidden>
    <div className={s.monthWeekdays}>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div key={day}>{day}</div>)}</div>
    <div className={s.monthCells}>{days.map((day, index) => {
      const tasks = day.tasks.filter(task => task.start && !task.prepOnly && task.state !== "someday")
        .map(task => ({ source: "github" as const, task, start: task.start, allDay: task.allDay }));
      const appointments = (nativeByDate.get(day.date) ?? []).filter(segment => !segment.prepOnly)
        .map(segment => ({ source: "native" as const, segment, start: segment.start, allDay: false }));
      const events = [...tasks, ...appointments].sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || minute(a.start) - minute(b.start));
      const adjacent = day.date.slice(0, 7) !== date.slice(0, 7);
      return <CalendarContextMenu key={day.date} target={{ a: day }}><div className={s.monthCell} data-scroll-unit={index === 0 ? "" : undefined} key={day.date} data-weekend={index % 7 === 0 || index % 7 === 6} data-adjacent={adjacent} onDoubleClick={() => openDay(day.date)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); calendarDrop(event, day, days); }}>
        <button className={s.monthDate} data-calendar-date-kind="month" data-date={day.date} data-today={day.date === clock.date} tabIndex={day.date === activeDate ? 0 : -1} aria-current={day.date === clock.date ? "date" : undefined} onClick={() => openDay(day.date)} aria-label={`Open ${fullDateLabel(day.date)}`}>{adjacent && day.date.endsWith("01") ? `${shortMonthFormatter.format(new Date(`${day.date}T12:00:00Z`))} ` : ""}{Number(day.date.slice(8))}</button>
        <div className={s.monthEvents}>{<SubscriptionCalendarChips payments={subscriptionCalendar.days.get(day.date)} />}<BudgetCommitmentChips events={budgetCommitments.days.get(day.date)} />{day.deadlines?.map(task => <DeadlineChip key={`due:${task.id}`} task={task} a={day} />)}{events.slice(0, visibleCount).map((event, eventIndex) => {
          if (event.source === "native") return <NativeCompactEvent key={`native:${event.segment.appointment.id}`} segment={event.segment} onOpen={openAppointment} />;
          const { task } = event;
          return <div key={task.id} className={s.compactEvent} data-selected={day.isEventSelected(task.id)} data-unfinished={unfinishedTask(task, clock.timestamp)}><EventContextMenu task={task} a={day}><button aria-label={`${task.title}${unfinishedTask(task, clock.timestamp) ? ", unfinished" : ""}`} className={[s.monthEvent, task.allDay && s.monthAllDay, task.state === "completed" && s.completedRow].filter(Boolean).join(" ")} data-today-first-event={day.date === clock.date && eventIndex === 0 ? "true" : undefined} data-tone={toneFor(task)} aria-pressed={day.isEventSelected(task.id)} onClick={() => day.selectEvent(task.id)} onDoubleClick={(event) => { event.stopPropagation(); day.edit(task); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); day.edit(task); } }} title={task.timingWarning} draggable={!day.readOnly && !task.unplaced} onDragStart={(event) => { event.dataTransfer.setData("application/x-quantself-event", JSON.stringify({ id: task.id, date: day.date })); }}>{task.allDay && <span className={s.compactEventIcon} aria-hidden="true"><CalendarDaysIcon /></span>}<span className={s.compactEventTitle}>{task.title}</span>{day.priorities.includes(task.id) && <span className={s.compactPriorityReaction} aria-label="Top priority">!!</span>}{!task.allDay && <time>{task.start}</time>}</button></EventContextMenu> <EventLink task={task} compact /></div>;
        })}{events.length > visibleCount && <button className={s.moreEvents} onClick={() => openDay(day.date)}>+{events.length - visibleCount} more</button>}</div>
      </div></CalendarContextMenu>;
    })}</div>
  </CalendarScrollArea>;
}

export function YearCalendar({ date, todayScrollRequest, openDay, openMonth, navigateYear }: { date: string; todayScrollRequest: number; openDay: (date: string) => void; openMonth: (date: string) => void; navigateYear: (date: string) => void }) {
  const clock = useCalendarClock();
  const { ref: containerRef, anchor } = useCalendarScroll({ date, resetKey: todayScrollRequest, axis: "y", buffer: 1, snap: false, snapOnIdle: true,
    getIndex: (value) => Number(value.slice(0, 4)), getDate: (index) => `${index}-01-01`, onNavigate: navigateYear });
  const scope = `${date}:${todayScrollRequest}`;
  const [cursor, setCursor] = useState<{ scope: string; date: string }>({ scope, date });
  const activeDate = cursor.scope === scope ? cursor.date : date;
  const pendingFocus = useRef<string | null>(null);
  const handledTodayScroll = useRef(todayScrollRequest);
  useEffect(() => {
    if (pendingFocus.current) {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      containerRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date-kind="year"][data-date="${target}"]:not([data-adjacent="true"])`)?.focus();
    }
  }, [date]);
  useEffect(() => {
    if (handledTodayScroll.current === todayScrollRequest || date.slice(0, 4) !== clock.date.slice(0, 4)) return;
    const target = containerRef.current?.querySelector<HTMLButtonElement>('button[data-today="true"]');
    if (!target) return;
    handledTodayScroll.current = todayScrollRequest;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [todayScrollRequest, date, clock.date]);
  const handleDateKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-calendar-date-kind="year"]');
    if (!button) return;
    const current = button.dataset.date || activeDate;
    let target: string | null = null;
    if (event.key === "ArrowLeft") target = shiftDate(current, -1);
    else if (event.key === "ArrowRight") target = shiftDate(current, 1);
    else if (event.key === "ArrowUp") target = shiftDate(current, -7);
    else if (event.key === "ArrowDown") target = shiftDate(current, 7);
    else if (event.key === "Home") target = shiftDate(current, -new Date(`${current}T12:00:00Z`).getUTCDay());
    else if (event.key === "End") target = shiftDate(current, 6 - new Date(`${current}T12:00:00Z`).getUTCDay());
    else if (event.key === "PageUp" || event.key === "PageDown") target = shiftMonth(current, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
    if (!target) return;
    event.preventDefault();
    if (target.slice(0, 4) !== date.slice(0, 4)) {
      pendingFocus.current = target;
      navigateYear(target);
      return;
    }
    setCursor({ scope, date: target });
    containerRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date-kind="year"][data-date="${target}"]:not([data-adjacent="true"])`)?.focus();
  };
  return <CalendarScrollArea ref={containerRef} className={s.yearScroll} data-calendar-grid role="group" aria-label="Year dates" aria-describedby="year-keyboard-help" onKeyDown={handleDateKeyDown}>
    <VisuallyHidden id="year-keyboard-help">Tab moves through month headings and the active date. Use arrow keys to move between dates, Home and End within a week, and Page Up or Page Down to change months. Add Shift to change years. Enter or Space opens the focused month or day.</VisuallyHidden>
    {[anchor - 1, anchor, anchor + 1].map((year) => <YearPage key={year} year={year} active={year === anchor} activeDate={activeDate} today={clock.date} openDay={openDay} openMonth={openMonth} />)}
  </CalendarScrollArea>;
}

function YearPage({ year, active, activeDate, today, openDay, openMonth }: {
  year: number; active: boolean; activeDate: string; today: string;
  openDay: (date: string) => void; openMonth: (date: string) => void;
}) {
  // Each keyed page owns its model. Retained years reuse labels; recycled years
  // release theirs, so neither date formatting nor memory grows with distance.
  const months = useMemo(() => Array.from({ length: 12 }, (_, month) => {
    const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const start = weekStart(first);
    return {
      first,
      name: monthFormatter.format(new Date(`${first}T12:00:00Z`)),
      days: Array.from({ length: 42 }, (_, index) => {
        const date = shiftDate(start, index);
        return { date, label: fullDateLabel(date), adjacent: date.slice(0, 7) !== first.slice(0, 7), weekend: index % 7 === 0 || index % 7 === 6 };
      }),
    };
  }), [year]);
  return <div className={s.yearCalendar} data-scroll-unit data-active-year={active} inert={!active} aria-label={`${year}`}>
    {months.map((month) => <section className={s.yearMonth} key={month.first} aria-label={`${month.name} ${year}`}>
      <button className={s.yearMonthTitle} aria-label={`Open ${month.name} ${year}`} onClick={() => openMonth(month.first)}>{month.name}</button>
      <div className={s.yearDates}>
        {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => <span className={s.yearWeekday} key={index}>{label}</span>)}
        {month.days.map((day) => <button key={day.date} className={s.yearDate} data-calendar-date-kind="year" data-date={day.date} data-adjacent={day.adjacent} data-weekend={day.weekend} data-today={!day.adjacent && day.date === today} tabIndex={!day.adjacent && day.date === activeDate ? 0 : -1} aria-current={!day.adjacent && day.date === today ? "date" : undefined} aria-label={`Open ${day.label}`} onClick={() => openDay(day.date)}>{Number(day.date.slice(8))}</button>)}
      </div>
    </section>)}
  </div>;
}
