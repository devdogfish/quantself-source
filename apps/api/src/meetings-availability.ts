import { z } from "@hono/zod-openapi";
import { habitBlocks } from "./habits-calendar";
import { localHabitDate, type HabitProjection } from "./habits-definition";
import { wallTime } from "./notifications-plan";
import type { Todo } from "./todos-github";

export const meetingMinutes = 30;
export const meetingDurationMs = meetingMinutes * 60_000;
export const bookingBufferMs = 15 * 60_000;
const dayMs = 86_400_000;
export const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof weekdays)[number];

// Booking hours start and end on the hour or half hour so every slot is :00/:30 local.
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|30)$|^24:00$/);
const range = z.tuple([clock, clock]).refine(([start, end]) => start < end);
export const weeklyHoursSchema = z.partialRecord(z.enum(weekdays), z.array(range).max(6));
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export type MeetingSettingsValue = {
  timeZone: string;
  weeklyHours: WeeklyHours;
  noticeMinutes: number;
  horizonDays: number;
};

const weekdayHours: [string, string][] = [["09:00", "17:00"]];
export const defaultMeetingSettings: MeetingSettingsValue = {
  timeZone: "America/Halifax",
  weeklyHours: { mon: weekdayHours, tue: weekdayHours, wed: weekdayHours, thu: weekdayHours, fri: weekdayHours },
  noticeMinutes: 12 * 60,
  horizonDays: 14,
};

export type Interval = { start: number; end: number };

export function bufferedEvent(start: number, end: number, beforeMinutes = 0, afterMinutes = 0): Interval {
  return {
    start: start - Math.max(bookingBufferMs, beforeMinutes * 60_000),
    end: end + Math.max(bookingBufferMs, afterMinutes * 60_000),
  };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function taskBusyIntervals(todos: Todo[]): Interval[] {
  return todos.flatMap(todo => {
    if (todo.trashed || todo.fields?.Commitment === "Someday" ||
        (todo.state === "closed" && todo.closureReason !== "completed") || !todo.start || !todo.end) return [];
    const start = Date.parse(todo.start);
    const end = Date.parse(todo.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [bufferedEvent(start, end, todo.beforeMinutes, todo.afterMinutes)]
      : [];
  });
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + dayMs).toISOString().slice(0, 10);
}

const habitZone = "America/Halifax";
const habitClock = new Intl.DateTimeFormat("en-GB", { timeZone: habitZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function habitBusyIntervals(projection: HabitProjection, range: Interval): Interval[] {
  const from = localHabitDate(new Date(range.start - bookingBufferMs));
  const to = localHabitDate(new Date(range.end + bookingBufferMs));
  return habitBlocks(projection, from, to).flatMap(block => {
    const [hour, minute] = block.anchor.split(":").map(Number);
    const endMinute = Math.min(hour * 60 + minute + block.durationMinutes, 1440);
    const endClock = `${String(Math.floor(endMinute / 60) % 24).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
    const start = wallTime(block.date, block.anchor, habitZone);
    let end = wallTime(endMinute === 1440 ? nextDate(block.date) : block.date, endClock, habitZone);
    // Halifax repeats one hour in the fall. Reserve through the later end when
    // the routine's ending time occurs twice on the calendar.
    const repeatedEnd = end + 3_600_000;
    if (habitClock.format(repeatedEnd) === endClock) end = repeatedEnd;
    if (end <= start) end = start + block.durationMinutes * 60_000;
    const busy = bufferedEvent(start, end);
    return overlaps(busy, range) ? [busy] : [];
  });
}

function localDate(instant: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** The window a visitor may book in: notice period to horizon, clipped to the requested range. */
export function bookableWindow(settings: MeetingSettingsValue, now: number, from?: number, to?: number): Interval {
  const earliest = now + settings.noticeMinutes * 60_000;
  const latest = now + settings.horizonDays * dayMs;
  return { start: Math.max(earliest, from ?? earliest), end: Math.min(latest, to ?? latest) };
}

/**
 * Open slot starts (ms, ascending) inside the Owner's weekly hours, the notice period and
 * the horizon, that do not overlap any busy interval. Never reports why a slot is closed.
 */
export function openSlots(input: {
  settings: MeetingSettingsValue;
  now: number;
  busy: Interval[];
  from?: number;
  to?: number;
}): number[] {
  const { settings, busy } = input;
  const window = bookableWindow(settings, input.now, input.from, input.to);
  if (window.end <= window.start) return [];
  const slots = new Set<number>();
  // Walk calendar dates (not 24h steps, which skip 23-hour DST days); one day of padding covers any offset.
  const lastDate = localDate(window.end + dayMs, settings.timeZone);
  for (let date = localDate(window.start - dayMs, settings.timeZone); date <= lastDate; date = nextDate(date)) {
    const weekday = weekdays[new Date(`${date}T12:00:00Z`).getUTCDay()];
    for (const [open, close] of settings.weeklyHours[weekday] ?? []) {
      const rangeStart = wallTime(date, open, settings.timeZone);
      const rangeEnd = close === "24:00"
        ? wallTime(nextDate(date), "00:00", settings.timeZone)
        : wallTime(date, close, settings.timeZone);
      for (let start = rangeStart; start + meetingDurationMs <= rangeEnd; start += meetingDurationMs) {
        if (start < window.start || start >= window.end) continue;
        const call = { start, end: start + meetingDurationMs };
        if (busy.some(interval => overlaps(interval, call))) continue;
        slots.add(start);
      }
    }
  }
  return [...slots].sort((a, b) => a - b);
}

export function slotIso(instant: number) {
  return new Date(instant).toISOString().replace(".000Z", "Z");
}
