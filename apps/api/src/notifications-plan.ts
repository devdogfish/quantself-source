import { createHash } from "node:crypto";
import type { Todo } from "./todos-github";

type DeliveryAlert = { key: string; title: string; body: string; fireAt: number; expiresAt: number };
export type Alert = DeliveryAlert & { number: number };
export type NativeAppointmentAlert = DeliveryAlert & { appointmentId: string; revision: number; url: string };

export type NativeReminderAppointment = {
  source: "native";
  ownerId: string;
  id: string;
  applicationId: string;
  title: string;
  start: string;
  beforeMinutes: number;
  alertMinutes: number | null;
  revision: number;
  cancelledAt: string | null;
};

export const DEFAULT_ALERT_MINUTES = 10;
const minute = 60_000;

function displayTime(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
}

function appointmentStartAlert(start: string, beforeMinutes: number, minutes: number, timeZone: string) {
  const action = Date.parse(start) - beforeMinutes * minute;
  const fireAt = action - minutes * minute;
  if (!Number.isFinite(fireAt)) return;
  return {
    fireAt,
    expiresAt: action,
    text: `${beforeMinutes ? "prep/travel begins" : "starts"} at ${displayTime(action, timeZone)}`,
  };
}

export function planNativeAppointmentAlert(appointment: NativeReminderAppointment, timeZone: string): NativeAppointmentAlert | undefined {
  if (appointment.alertMinutes === null || appointment.cancelledAt) return;
  const candidate = appointmentStartAlert(
    appointment.start,
    appointment.beforeMinutes,
    appointment.alertMinutes,
    timeZone,
  );
  if (!candidate) return;
  return {
    key: createHash("sha256").update(`native-appointment:${appointment.id}:${candidate.fireAt}`).digest("hex"),
    appointmentId: appointment.id,
    revision: appointment.revision,
    url: `/todo?appointment=${encodeURIComponent(appointment.id)}`,
    title: appointment.title,
    body: candidate.text,
    fireAt: candidate.fireAt,
    expiresAt: candidate.expiresAt,
  };
}

// Convert a wall-clock date/time through DST without assuming the device's UTC offset.
export function wallTime(date: string, clock: string, timeZone: string): number {
  const target = Date.parse(`${date}T${clock}:00Z`);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let guess = target;
  const seen = new Set<number>();
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(guess);
    const get = (key: string) => parts.find(p => p.type === key)!.value;
    const actual = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`);
    const difference = target - actual;
    if (!difference) return guess;
    const next = guess + difference;
    // Spring-forward wall times do not exist: advance through the gap.
    if (seen.has(next)) return Math.max(guess, next);
    seen.add(guess);
    guess = next;
  }
  return guess;
}
export function planAlerts(todo: Todo, minutes: number | null, morning: string, timeZone: string): Alert[] {
  if (minutes === null || todo.state !== "open" || todo.trashed) return [];
  const candidates: { fireAt: number; expiresAt: number; text: string }[] = [];
  if (todo.start && !todo.allDay && !todo.scheduleError) {
    const candidate = appointmentStartAlert(todo.start, todo.beforeMinutes ?? 0, minutes, timeZone);
    if (candidate) candidates.push(candidate);
  }
  if (todo.fields.Due && !todo.deadlineError) {
    const at = todo.deadlineAt ? Date.parse(todo.deadlineAt) : wallTime(todo.fields.Due, morning, timeZone);
    const fireAt = todo.deadlineAt ? at - minutes * minute : at;
    candidates.push({ fireAt, expiresAt: fireAt + 3600000, text: todo.deadlineAt ? `due at ${displayTime(at, timeZone)}` : "due today" });
  }
  const grouped = new Map<number, typeof candidates>();
  for (const candidate of candidates) grouped.set(candidate.fireAt, [...(grouped.get(candidate.fireAt) ?? []), candidate]);
  return [...grouped].map(([fireAt, entries]) => ({
    key: createHash("sha256").update(`${todo.id}:${fireAt}`).digest("hex"),
    number: todo.number, title: todo.title, body: entries.map(entry => entry.text).join("; "),
    fireAt, expiresAt: Math.min(...entries.map(entry => entry.expiresAt)),
  }));
}
