import { useSyncExternalStore } from "react";
import type { Task } from "./todo-projection";

/** Includes portalled link menus, whose React events reach the event card. */
export function isTaskLinkControl(target: EventTarget | null) {
  return target instanceof Element && !!target.closest("[data-task-link-control]");
}

export const today = new Date().toISOString().slice(0, 10);
export const minute = (value: string) => Number(value.split(":")[0]) * 60 + Number(value.split(":")[1]);
export const time = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export const end = (task: Pick<Task, "start" | "minutes">) => time(minute(task.start) + task.minutes);
export const shiftDate = (date: string, amount: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + amount * 86400000).toISOString().slice(0, 10);
export const shiftMonth = (date: string, amount: number) => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const target = new Date(Date.UTC(year, month - 1 + amount, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
};
const dateLabelFormatter = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fullDateFormatter = new Intl.DateTimeFormat("en", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
export const monthFormatter = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
export const shortMonthFormatter = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
export const weekdayFormatter = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const clockFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const dateLabel = (date: string) => dateLabelFormatter.format(new Date(`${date}T12:00:00Z`));
export const dueLabel = (due: string, date: string) => due === date ? "Due today" : due === shiftDate(date, 1) ? "Due tomorrow" : `Due ${dateLabel(due)}`;
const eventTones = ["teal", "slate", "lavender", "ochre", "blue", "sage", "clay", "rose"];
export const toneFor = (task: Pick<Task, "id">) => eventTones[[...task.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % eventTones.length];
export const bounds = (task: Pick<Task, "start" | "minutes">) => ({ start: minute(task.start), end: minute(task.start) + task.minutes });
export const overlaps = (a: Task, b: Task) => bounds(a).start < bounds(b).end && bounds(b).start < bounds(a).end;
export const weekStart = (date: string) => shiftDate(date, -new Date(`${date}T12:00:00Z`).getUTCDay());
export const fullDateLabel = (date: string) => fullDateFormatter.format(new Date(`${date}T12:00:00Z`));
// A stable external clock snapshot avoids hydration mismatches and render-time clocks.
let clockSnapshot = 0;
const subscribeClock = (notify: () => void) => {
  const tick = () => { clockSnapshot = Date.now(); notify(); };
  tick();
  const interval = setInterval(tick, 15000);
  return () => clearInterval(interval);
};
export function useCalendarClock() {
  const timestamp = useSyncExternalStore(subscribeClock, () => clockSnapshot, () => 0);
  if (!timestamp) return { timestamp: 0, date: "", minutes: 0, label: "" };
  const parts = clockFormatter.formatToParts(new Date(timestamp));
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value || "00";
  return { timestamp, date: `${value("year")}-${value("month")}-${value("day")}`, minutes: Number(value("hour")) * 60 + Number(value("minute")), label: `${value("hour")}:${value("minute")}` };
}
export type Actions = {
  readOnly: boolean; canAdd?: boolean; deadlines?: Task[]; tasks: Task[]; priorities: string[]; date: string;
  copyEvent: (task: Task, cut: boolean) => void; pasteEvent: () => void; canPaste: boolean; removeEvent: (task: Task) => void;
  isEventSelected: (id: string) => boolean; selectEvent: (id: string) => void;
  makeAllDay: (task: Task) => void; makeTimed: (task: Task, start: number) => void;
  resize: (task: Task, edge: "start" | "end", minute: number) => void;
  priorityReadOnly?: boolean;
  trash?: (task: Task) => void; edit: (task: Task) => void; complete: (task: Task) => void; togglePriority: (id: string) => void;
  reschedule: (task: Task, start: number, fromDate?: string) => void; openAdd: (start?: string, allDay?: boolean) => void;
};

