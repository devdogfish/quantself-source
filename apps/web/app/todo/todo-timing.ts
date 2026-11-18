import type { LiveTodo } from "./todo-live";
export type TaskTiming = Pick<LiveTodo, "start" | "end" | "allDay" | "fixed" | "beforeMinutes" | "afterMinutes">;
export const taskTiming = (todo: TaskTiming): TaskTiming => ({ start: todo.start, end: todo.end, allDay: todo.allDay, fixed: todo.fixed, ...(todo.beforeMinutes ? { beforeMinutes: todo.beforeMinutes } : {}), ...(todo.afterMinutes ? { afterMinutes: todo.afterMinutes } : {}) });
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function localDateTime(value: string | number | null) {
  if (value === null) return "";
  const parts = formatter.formatToParts(new Date(value));
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
// Resolve calendar wall time explicitly. Reject DST gaps/folds rather than silently
// choosing the wrong instant; an existing offset can disambiguate an unchanged value.
export function timingInstant(wall: string, existing?: string | null) {
  if (!wall) return null;
  if (existing && localDateTime(existing) === wall) return existing;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(wall)) return new Date(wall).toISOString();
  const nominal = Date.parse(`${wall}:00Z`);
  const matches = [-240, -180].map(offset => nominal - offset * 60000).filter(value => Number.isFinite(value) && localDateTime(value) === wall);
  if (matches.length !== 1) throw Error("Clock change: supply an explicit ISO time with offset (for example 2026-11-01T01:30:00-03:00).");
  return new Date(matches[0]).toISOString();
}
export function moveTaskTiming(todo: TaskTiming, date: string, minute: number, source?: { date: string; start: string }): TaskTiming {
  if (!todo.start || !todo.end) throw Error("Task has no start/end range.");
  let wall = `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  if (source) {
    const delta = Date.parse(`${wall}:00Z`) - Date.parse(`${source.date}T${source.start}:00Z`);
    wall = new Date(Date.parse(`${localDateTime(todo.start)}:00Z`) + delta).toISOString().slice(0, 16);
  }
  const start = timingInstant(wall, todo.start)!;
  return { ...taskTiming(todo), start, end: new Date(Date.parse(start) + Date.parse(todo.end) - Date.parse(todo.start)).toISOString() };
}

export function timingRange(startInput: string, endInput: string, existing?: TaskTiming): TaskTiming {
  let start = timingInstant(startInput, existing?.start), end = timingInstant(endInput, existing?.end);
  if (start && !end) end = new Date(Date.parse(start) + 30 * 60000).toISOString();
  if (end && !start) start = new Date(Date.parse(end) - 30 * 60000).toISOString();
  if (start && end && Date.parse(end) <= Date.parse(start)) throw Error("End must be after start.");
  return { ...(existing ? taskTiming(existing) : {}), start, end, allDay: !!start && (existing?.allDay ?? false), fixed: !!start && (existing?.fixed ?? false) };
}

export function resizeTaskTiming(todo: TaskTiming, date: string, edge: "start" | "end", minute: number): TaskTiming {
  if (!todo.start || !todo.end) throw Error("Task has no start/end range.");
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) throw Error("Choose a time within this day.");
  // 1440 represents the following midnight, not the beginning of this day.
  const wall = new Date(Date.parse(`${date}T00:00:00Z`) + minute * 60000).toISOString().slice(0, 16);
  const moving = timingInstant(wall, todo[edge])!;
  const anchor = todo[edge === "start" ? "end" : "start"]!;
  const after = { ...taskTiming(todo),
    start: Date.parse(moving) < Date.parse(anchor) ? moving : anchor,
    end: Date.parse(moving) < Date.parse(anchor) ? anchor : moving,
  };
  if (Date.parse(after.end!) - Date.parse(after.start!) < 60000) throw Error("Events must be at least one minute long.");
  return after;
}

export function taskTime(todo: Pick<TaskTiming, "start" | "end" | "allDay">) {
  if (!todo.start || !todo.end) return "Not scheduled";
  const start = new Date(todo.start), end = new Date(todo.end);
  const date = new Intl.DateTimeFormat("en", { timeZone: "America/Halifax", dateStyle: "medium" });
  const time = new Intl.DateTimeFormat("en", { timeZone: "America/Halifax", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const sameDay = date.format(start) === date.format(end);
  if (todo.allDay) return `${date.format(start)}${sameDay ? "" : " – " + date.format(end)} · All day`;
  return `${date.format(start)}  ${time.format(start)} – ${sameDay ? "" : date.format(end) + "  "}${time.format(end)}`;
}
