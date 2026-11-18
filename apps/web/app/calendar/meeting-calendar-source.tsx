"use client";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import createClient from "openapi-fetch";
import { VideoIcon } from "lucide-react";
import type { operations, paths } from "@/lib/generated/quantself-api-schema";
import { toaster } from "@/components/chakra/toaster";
import { localDateTime } from "../todo/todo-timing";
import { dateLabel } from "../todo/task-workspace-context";
import s from "../todo/todo-workspace.module.css";
import type { CalendarRange, CalendarSource } from "./calendar-source";
import { CalendarEventHeadline } from "./task-calendar-source";

export type Meeting = operations["listBookedMeetings"]["responses"][200]["content"]["application/json"]["meetings"][number];
/** One meeting on one calendar day, in calendar wall time. */
export type MeetingItem = { date: string; start: string; minutes: number; finish: string; meeting: Meeting };
type MeetingBlock = { style: CSSProperties; week: boolean; compact: boolean; detailed: boolean; onOpen?: () => void };

const client = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "same-origin",
  // Resolve fetch per request so tests and instrumentation can replace it.
  fetch: request => globalThis.fetch(request),
});
const dayMs = 86_400_000;
const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Splits each meeting into per-day items in the calendar's wall time. */
export function meetingItems(meetings: Meeting[], { from, to }: CalendarRange): MeetingItem[] {
  return meetings.flatMap(meeting => {
    const start = localDateTime(meeting.start), end = localDateTime(meeting.end);
    const date = start.slice(0, 10);
    if (date < from || date > to) return [];
    const startMinute = minuteOf(start.slice(11));
    const endMinute = end.slice(0, 10) === date ? minuteOf(end.slice(11)) : 1440;
    return [{ date, start: start.slice(11), finish: end.slice(11), minutes: Math.max(1, endMinute - startMinute), meeting }];
  });
}

// Shared across every calendar view so a cancel in flight stays hidden after navigation or a refetch.
// Confirmed cancels stay hidden too, so a refetch that started before the cancel cannot bring one back.
const cancelling = new Set<string>();
const cancelled = new Set<string>();
const listeners = new Set<() => void>();
let cancelVersion = 0;
const notify = () => { cancelVersion++; listeners.forEach(listener => listener()); };
const subscribeCancels = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Hides the meeting immediately, then asks the API to cancel it; the API emails the guest.
 * A rejected cancel brings the meeting back with an error. There is no Undo: the guest is emailed.
 */
export async function cancelMeeting(meeting: Meeting) {
  if (cancelling.has(meeting.id) || cancelled.has(meeting.id)) return;
  cancelling.add(meeting.id);
  notify();
  try {
    const { error, response } = await client.POST("/api/v1/meetings/{id}/cancel", { params: { path: { id: meeting.id } } });
    if (!response.ok) throw new Error(error?.message ?? "Could not cancel the meeting.");
    cancelled.add(meeting.id);
    window.dispatchEvent(new Event("meetings-changed"));
  } catch (error) {
    toaster.create({
      type: "error",
      title: `Call with ${meeting.guestName} is still booked`,
      description: error instanceof Error ? error.message : "Could not cancel the meeting.",
      duration: Infinity,
      action: { label: "Retry", onClick: () => void cancelMeeting(meeting) },
    });
  } finally {
    cancelling.delete(meeting.id);
    notify();
  }
}

export function meetingCalendarSource(open: (item: MeetingItem) => void) {
  let warning = "";
  return {
    async load(range: CalendarRange) {
      // Pad by a day each side so any time zone offset is covered, then keep the range's wall dates.
      const { data, error } = await client.GET("/api/v1/meetings/booked", {
        params: { query: {
          from: new Date(Date.parse(`${range.from}T00:00:00Z`) - dayMs).toISOString(),
          to: new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * dayMs).toISOString(),
        } },
        cache: "no-store",
      });
      if (!data) throw new Error(error?.message ?? "Meetings unavailable.");
      warning = data.meetings.some(meeting => !meeting.jitsiUrl) ? "Meeting room links are not configured." : "";
      return meetingItems(data.meetings, range);
    },
    warning: () => warning,
    subscribe(onChange: () => void) {
      const timer = setInterval(onChange, 60_000);
      window.addEventListener("meetings-changed", onChange);
      return () => { clearInterval(timer); window.removeEventListener("meetings-changed", onChange); };
    },
    interact: (item: MeetingItem) => ({ draggable: false, resizable: false, onOpen: () => open(item) }),
    render(item: MeetingItem, { style, week, compact, detailed, onOpen }: MeetingBlock) {
      const { meeting } = item;
      return <div key={`meeting:${item.date}:${meeting.id}`} className={s.calendarEvent} data-kind="meeting" data-tone="teal" data-week={week} data-short={compact} data-meeting-id={meeting.id} style={style}>
        <div className={s.eventCore}>
          <button type="button" className={s.timelineBlock} data-detailed={detailed} draggable={false} style={{ cursor: "pointer" }}
            aria-label={`Meeting with ${meeting.guestName}, ${dateLabel(item.date)}, ${item.start} to ${item.finish}`}
            onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); onOpen?.(); }}>
            <CalendarEventHeadline title={meeting.guestName} start={item.start} finish={item.finish} />
            {detailed && <span className={s.eventContext}><VideoIcon aria-hidden="true" />Meeting{meeting.note ? ` · ${meeting.note}` : ""}</span>}
          </button>
        </div>
      </div>;
    },
  } satisfies CalendarSource<MeetingItem, MeetingBlock> & { warning(): string };
}

/** One request per visible range; refetches every minute and after a cancel. */
export function useMeetingCalendar(from: string, to: string, enabled: boolean) {
  const [selected, setSelected] = useState<MeetingItem | null>(null);
  const source = useMemo(() => meetingCalendarSource(setSelected), []);
  const [value, setValue] = useState<{ key: string; items: MeetingItem[]; error?: string; warning?: string }>();
  const [version, setVersion] = useState(0);
  const retry = useCallback(() => setVersion(current => current + 1), []);
  const key = `${from}:${to}`;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const items = await source.load({ from, to });
        if (!disposed) setValue({ key, items, warning: source.warning() });
      } catch (error) {
        if (!disposed) setValue(current => ({
          key, items: current?.key === key ? current.items : [], error: error instanceof Error ? error.message : "Meetings unavailable.",
        }));
      } finally {
        pending = false;
      }
    };
    void load();
    const unsubscribe = source.subscribe(() => void load());
    return () => { disposed = true; unsubscribe(); };
  }, [enabled, from, to, key, source, version]);
  useSyncExternalStore(subscribeCancels, () => cancelVersion, () => 0);
  const current = enabled && value?.key === key ? value : undefined;
  const byDate = new Map<string, MeetingItem[]>();
  for (const item of current?.items ?? []) {
    if (cancelling.has(item.meeting.id) || cancelled.has(item.meeting.id)) continue;
    byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
  }
  return {
    source, byDate, retry, selected, close: () => setSelected(null),
    error: current?.error, warning: current?.warning, loading: enabled && !current,
  };
}
