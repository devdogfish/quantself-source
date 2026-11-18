import { useEffect, useMemo, useState } from "react";
import type { components } from "@/lib/generated/quantself-api-schema";
import { shiftDate } from "./task-workspace-context";
import { TodoBrowserError, readTodoJson } from "./todo-live";
import { calendarTimingForDate } from "./todo-projection";
import { localDateTime, timingInstant } from "./todo-timing";
import { nativeAppointmentEndpoint, type NativeAppointment } from "./native-appointment-client";
import { appointmentChangeIsPending, projectNativeAppointment, useNativeAppointmentChanges, useNativeAppointmentQueue, type AppointmentChange } from "./native-appointment-queue";

export { readNativeAppointment, type NativeAppointment } from "./native-appointment-client";

type AppointmentPage = components["schemas"]["NativeJobInterviewAppointments"];
type DateRange = { from: string; to: string };
type AppointmentRange = { key: string; appointments: NativeAppointment[]; stamp: number; error?: string; denied?: boolean };
const empty: NativeAppointment[] = [];

export function appointmentId(value: string | null) {
  return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;
}

export function refreshNativeAppointments() {
  window.dispatchEvent(new Event("native-appointments-changed"));
}

function rangeInstants({ from, to }: DateRange) {
  return {
    from: timingInstant(`${from}T00:00`)!,
    to: timingInstant(`${shiftDate(to, 1)}T00:00`)!,
  };
}

export async function readNativeAppointments(range: DateRange, signal: AbortSignal) {
  const params = new URLSearchParams(rangeInstants(range));
  const appointments = new Map<string, NativeAppointment>();
  for (;;) {
    const page = await readTodoJson<AppointmentPage>(`${nativeAppointmentEndpoint}?${params}`, signal);
    for (const item of page.appointments) {
      if (!item.cancelledAt) appointments.set(item.id, item);
    }
    if (!page.nextCursor) return [...appointments.values()];
    const { afterStart, afterId } = page.nextCursor;
    if (params.get("afterStart") === afterStart && params.get("afterId") === afterId) {
      throw new Error("Appointment pagination did not advance.");
    }
    params.set("afterStart", afterStart);
    params.set("afterId", afterId);
  }
}

export function projectNativeAppointmentRange(rows: NativeAppointment[], changes: ReadonlyMap<string, AppointmentChange>, stamp: number, range: DateRange) {
  if (!changes.size) return rows;
  const projected = new Map(rows.map(row => [row.id, row]));
  for (const [id, change] of changes) {
    // A range read after a write is authoritative even when the row moved outside it.
    if (!appointmentChangeIsPending(change) && change.stamp <= stamp) continue;
    const visible = projectNativeAppointment(projected.get(id) ?? change.base, change);
    if (!visible || visible.cancelledAt) projected.delete(id);
    else projected.set(id, visible);
  }
  const rangeStart = rangeInstants(range);
  const from = Date.parse(rangeStart.from), to = Date.parse(rangeStart.to);
  return [...projected.values()].filter(appointment =>
    Date.parse(appointment.start) - appointment.beforeMinutes * 60000 < to &&
    Date.parse(appointment.end) + appointment.afterMinutes * 60000 > from);
}

export function useNativeAppointmentRefresh() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    function refresh() { setVersion(version => version + 1); }
    function visible() { if (document.visibilityState === "visible") refresh(); }
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", refresh);
    window.addEventListener("native-appointments-changed", refresh);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", refresh);
      window.removeEventListener("native-appointments-changed", refresh);
    };
  }, []);
  return [version, () => setVersion(version => version + 1)] as const;
}

export function useNativeAppointments(from: string, to: string, enabled: boolean) {
  const key = `${from}:${to}`;
  const [value, setValue] = useState<AppointmentRange>();
  const queue = useNativeAppointmentQueue();
  const changes = useNativeAppointmentChanges();
  const [version, retry] = useNativeAppointmentRefresh();
  useEffect(() => {
    if (!enabled) {
      setValue(undefined);
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      const stamp = queue?.getSnapshot().stamp ?? 0;
      void readNativeAppointments({ from, to }, controller.signal)
        .then(appointments => { if (!controller.signal.aborted) setValue({ key, appointments, stamp }); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const denied = error instanceof TodoBrowserError && (error.status === 401 || error.status === 403);
          setValue(current => ({
            key, denied, stamp: current?.key === key ? current.stamp : 0, error: "Could not load interview appointments.",
            appointments: !denied && current?.key === key ? current.appointments : empty,
          }));
        });
    });
    return () => controller.abort();
  }, [enabled, from, to, key, queue, version]);
  const appointments = useMemo(() => {
    if (!enabled || (value?.key === key && value.denied)) return empty;
    const current = value?.key === key ? value : undefined;
    // While loading a different range, only pending writes can be projected into it.
    return projectNativeAppointmentRange(current?.appointments ?? empty, changes.entries, current?.stamp ?? changes.stamp, { from, to });
  }, [changes, enabled, from, key, to, value]);
  return {
    appointments,
    error: enabled && value?.key === key ? value.error : undefined,
    loading: enabled && value?.key !== key,
    retry,
  };
}

export type NativeCalendarSegment = NonNullable<ReturnType<typeof calendarTimingForDate>> & {
  appointment: NativeAppointment;
};

export function appointmentsByDate(appointments: NativeAppointment[], from: string, to: string) {
  const days = new Map<string, NativeCalendarSegment[]>();
  for (const appointment of appointments) {
    const start = Date.parse(appointment.start), end = Date.parse(appointment.end);
    if (appointment.cancelledAt || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const first = localDateTime(start - appointment.beforeMinutes * 60000).slice(0, 10);
    const last = localDateTime(end + appointment.afterMinutes * 60000 - 1).slice(0, 10);
    for (let date = first < from ? from : first; date <= to && date <= last; date = shiftDate(date, 1)) {
      const timing = calendarTimingForDate(appointment, date);
      if (!timing) continue;
      const segment = { ...timing, appointment };
      const entries = days.get(date);
      if (entries) entries.push(segment);
      else days.set(date, [segment]);
    }
  }
  return days;
}
