import { taskUrlHrefs } from "./task-urls";
import type { LiveTodo } from "./todo-live";
import type { TaskTiming } from "./todo-timing";
export type TaskState =
  "inbox" | "active" | "someday" | "completed" | "closed" | "unknown";
export type Task = {
  id: string;
  pending?: boolean;
  issueId: string;
  number: number;
  title: string;
  state: TaskState;
  minutes: number;
  start: string;
  prepOnly?: "before" | "after";
  beforeMinutes?: number;
  afterMinutes?: number;
  fixed?: boolean;
  allDay?: boolean;
  plannedDate?: string;
  due?: string;
  deadlineAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  eventUrls?: string[];
  eventLocation?: string;
  who?: string;
  kind: string;
  note: string;
  prerequisites: string[];
  readiness?: "ready" | "blocked";
  timingWarning?: string;
  unknownDuration?: boolean;
  unplaced?: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
};
function taskState(todo: LiveTodo): TaskState {
  if (todo.state === "closed") {
    return todo.closureReason === "completed" ? "completed" : "closed";
  }
  switch (todo.fields.Commitment) {
    case "Active":
      return "active";
    case "Someday":
      return "someday";
    case "Inbox":
      return "inbox";
    default:
      return "unknown";
  }
}
export function todoTask(todo: LiveTodo): Task {
  return {
    id: todo.id,
    pending: todo.optimistic,
    issueId: todo.id,
    number: todo.number,
    title: todo.title,
    state: taskState(todo),
    minutes:
      todo.start && todo.end ? (Date.parse(todo.end) - Date.parse(todo.start)) / 60000 : typeof todo.fields.Estimate === "number" ? todo.fields.Estimate : 0,
    unknownDuration: !todo.start && typeof todo.fields.Estimate !== "number",
    start: todo.start ? partsAt(Date.parse(todo.start)).time : "",
    beforeMinutes: todo.beforeMinutes, afterMinutes: todo.afterMinutes,
    fixed: todo.fixed, allDay: todo.allDay,
    plannedDate: todo.start ? partsAt(Date.parse(todo.start)).date : undefined,
    kind: typeof todo.fields.Category === "string" ? todo.fields.Category : "Task",
    note: todo.description ?? todo.body ?? "",
    readiness: todo.readiness,
    prerequisites: (todo.blockedBy ?? []).map((t) => t.id),
    deadlineAt: todo.deadlineAt, startsAt: todo.start, endsAt: todo.end,
    eventLocation: typeof todo.fields.Location === "string" ? todo.fields.Location.trim() || undefined : undefined,
    eventUrls: typeof todo.fields.URL === "string" ? taskUrlHrefs(todo.fields.URL) : [],
    due: typeof todo.fields.Due === "string" ? todo.fields.Due : undefined,
    who:
      typeof todo.fields.Client === "string" ? todo.fields.Client : undefined,
    timingWarning:
      [
        todo.scheduleError, todo.deadlineError,
        todo.readiness === "blocked"
          ? "Blocked by prerequisites (or unavailable relationships)"
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
  };
}

const calendarFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
function partsAt(instant: number) {
  const parts = calendarFormatter.formatToParts(instant);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, minute: Number(get("hour")) * 60 + Number(get("minute")), offset: get("timeZoneName") };
}
type CalendarTimingSegment = Pick<Task, "start" | "minutes" | "plannedDate" | "prepOnly" | "beforeMinutes" | "afterMinutes" |
  "continuesBefore" | "continuesAfter" | "unplaced" | "timingWarning">;

export function calendarTimingForDate(timing: TaskTiming, date: string): CalendarTimingSegment | null {
  if (!timing.start || !timing.end) return null;
  const startAt = Date.parse(timing.start), endAt = Date.parse(timing.end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return null;
  const start = partsAt(startAt), finish = partsAt(endAt), last = partsAt(endAt - 1);
  const beforeMinutes = timing.beforeMinutes ?? 0, afterMinutes = timing.afterMinutes ?? 0;
  if (date < start.date || date > last.date) {
    if (timing.allDay || (!beforeMinutes && !afterMinutes)) return null;
    const prepStart = partsAt(startAt - beforeMinutes * 60000);
    const prepEnd = partsAt(endAt + afterMinutes * 60000);
    const before = beforeMinutes > 0 && date >= prepStart.date && date < start.date;
    const after = afterMinutes > 0 && date >= finish.date && (date < prepEnd.date || date === prepEnd.date && prepEnd.minute > 0);
    if (!before && !after) return null;
    const from = before ? (date === prepStart.date ? prepStart.minute : 0) : (date === finish.date ? finish.minute : 0);
    const to = before ? 1440 : date === prepEnd.date ? prepEnd.minute : 1440;
    return { prepOnly: before ? "before" : "after", start: timeOfMinute(from), minutes: to - from,
      beforeMinutes: 0, afterMinutes: 0, plannedDate: date };
  }
  const clipped = date !== start.date || date !== finish.date;
  const clockChange = start.offset !== finish.offset;
  return {
    plannedDate: date,
    beforeMinutes: date === start.date && !timing.allDay ? Math.min(beforeMinutes, start.minute) : 0,
    afterMinutes: date === finish.date && !timing.allDay ? Math.min(afterMinutes, 1440 - finish.minute) : 0,
    continuesBefore: date > start.date, continuesAfter: date < last.date,
    start: date === start.date ? start.time : "00:00",
    minutes: clockChange ? (endAt - startAt) / 60000 : (date === finish.date ? finish.minute : 1440) - (date === start.date ? start.minute : 0),
    unplaced: !timing.allDay && clockChange,
    timingWarning: clockChange ? "Clock changes during this task; see details for exact start/end." : clipped ? "Continues across midnight" : undefined,
  };
}

function timeOfMinute(from: number) {
  return String(Math.floor(from / 60)).padStart(2, "0") + ":" + String(from % 60).padStart(2, "0");
}

export function todosForDate(todos: LiveTodo[], date: string): Task[] {
  return todos.flatMap((todo): Task[] => {
    if (todo.scheduleError) return [];
    const timing = calendarTimingForDate(todo, date);
    if (!timing) return [];
    const task = todoTask(todo);
    return [{ ...task, ...timing, timingWarning: timing.prepOnly ? task.timingWarning :
      [task.timingWarning, ...(todo.timingWarnings ?? []), timing.timingWarning].filter(Boolean).join(" · ") || undefined }];
  });
}
