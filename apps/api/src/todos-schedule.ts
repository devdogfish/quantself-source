import { z } from "@hono/zod-openapi";

const startMarker = "<!-- quantself:todo-schedule -->";
const endMarker = "<!-- /quantself:todo-schedule -->";
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const todoInstantSchema = z.string().datetime({ offset: true }).nullable();
export const prepMinutesSchema = z.number().int().min(0).max(1440);
export const todoTimingSchema = z.object({
  start: todoInstantSchema,
  end: todoInstantSchema,
  allDay: z.boolean().default(false),
  fixed: z.boolean().default(false),
  beforeMinutes: prepMinutesSchema.optional(),
  afterMinutes: prepMinutesSchema.optional(),
}).passthrough().superRefine((value, context) => {
  if ((!value.start || value.allDay) && ((value.beforeMinutes ?? 0) > 0 || (value.afterMinutes ?? 0) > 0))
    context.addIssue({ code: "custom", path: ["beforeMinutes"], message: "Prep time requires a timed event." });
  if ((value.start === null) !== (value.end === null))
    context.addIssue({ code: "custom", path: [value.start === null ? "start" : "end"], message: "Supply both start and end, or clear both." });
  if (value.start && value.end && Date.parse(value.end) <= Date.parse(value.start))
    context.addIssue({ code: "custom", path: ["end"], message: "End must be after start." });
  if (!value.start && (value.allDay || value.fixed))
    context.addIssue({ code: "custom", path: ["start"], message: "Scheduled flags require a start and end." });
});
export type TodoTiming = z.infer<typeof todoTimingSchema>;
export const emptyTiming = () => ({ start: null, end: null, allDay: false, fixed: false });
export const timingOf = (task: { start: string | null; end: string | null; allDay?: boolean; fixed?: boolean; beforeMinutes?: number; afterMinutes?: number }) => ({
  start: task.start, end: task.end, allDay: task.allDay ?? false, fixed: task.fixed ?? false,
  ...(task.beforeMinutes !== undefined ? { beforeMinutes: task.beforeMinutes } : {}), ...(task.afterMinutes !== undefined ? { afterMinutes: task.afterMinutes } : {}),
});
const scheduleSchema = todoTimingSchema.and(z.object({ version: z.literal(2) }).passthrough());
function rawSchedule(body: string) {
  if (body.split(startMarker).length !== 2 || body.split(endMarker).length !== 2) throw Error("Duplicate or incomplete timing blocks.");
  const match = /^```json\s*\n([\s\S]*?)\n```$/.exec(body.slice(body.indexOf(startMarker) + startMarker.length, body.indexOf(endMarker)).trim());
  if (!match) throw Error("Malformed timing block.");
  return JSON.parse(match[1]);
}
function localMidnight(date: string, timeZone: string) {
  localDate.parse(date);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateAt = (value: number) => { const parts = formatter.formatToParts(value); const get = (key: string) => parts.find(p => p.type === key)!.value; return `${get("year")}-${get("month")}-${get("day")}`; };
  const noon = Date.parse(`${date}T12:00:00Z`);
  let low = noon - 48 * 3600000, high = noon + 48 * 3600000;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (dateAt(mid) < date) low = mid; else high = mid; }
  return new Date(high).toISOString();
}
// Only this compatibility boundary knows the retired multi-session format.
function legacyTiming(value: any): TodoTiming {
  if (!Array.isArray(value.sessions)) throw Error("Invalid legacy timing.");
  if (!value.sessions.length) return emptyTiming();
  if (value.sessions.length !== 1) throw Error("Multiple legacy time ranges need review; no ranges were dropped or combined.");
  const session = value.sessions[0], placement = session.placement;
  if (Object.values(session.allowances ?? {}).some((value: any) => value?.minutes > 0)) throw Error("Legacy preparation/travel timing needs review; original data retained.");
  if (placement?.kind === "all-day") {
    const next = new Date(Date.parse(`${placement.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return { start: localMidnight(placement.date, placement.timeZone), end: localMidnight(next, placement.timeZone), allDay: true, fixed: !!session.fixed };
  }
  if (placement?.kind !== "timed" || !Number.isFinite(session.duration?.minutes) || session.duration.minutes <= 0)
    throw Error("Legacy timing has no complete start/end range; original data retained for review.");
  todoInstantSchema.parse(placement.start);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: placement.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(placement.start));
  const get = (key: string) => parts.find(p => p.type === key)?.value;
  if (`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}` !== placement.start.slice(0, 19)) throw Error("Legacy time zone/offset needs review.");
  return { start: placement.start, end: new Date(Date.parse(placement.start) + session.duration.minutes * 60000).toISOString(), allDay: false, fixed: !!session.fixed };
}
export function readTodoSchedule(body: string | null): TodoTiming & { scheduleError: string | null } {
  if (!body?.includes(startMarker) && !body?.includes(endMarker)) return { ...emptyTiming(), scheduleError: null };
  try {
    const value = rawSchedule(body!);
    const timing = value.version === 1 ? legacyTiming(value) : scheduleSchema.parse(value);
    return { ...timingOf(todoTimingSchema.parse(timing)), scheduleError: null };
  } catch (error) {
    return { ...emptyTiming(), scheduleError: `Review task timing. ${(error as Error).message} Original issue data is unchanged.` };
  }
}
export function editScheduleBody(original: string | null, timing: TodoTiming): string {
  const body = original ?? "";
  const next = todoTimingSchema.parse(timing);
  const parsed = readTodoSchedule(body);
  if (parsed.scheduleError) throw Error(parsed.scheduleError);
  const prior = body.includes(startMarker) ? rawSchedule(body) : {};
  // Preserve version-2 extension properties and all surrounding issue prose.
  delete prior.beforeMinutes; delete prior.afterMinutes;
  const value = { ...(prior.version === 2 ? prior : prior.version === 1 ? { legacySchedule: prior } : {}), version: 2, ...timingOf(next) };
  const block = `${startMarker}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${endMarker}`;
  const start = body.indexOf(startMarker), end = body.indexOf(endMarker);
  const result = start < 0 ? `${body}\n${block}` : body.slice(0, start) + block + body.slice(end + endMarker.length);
  if (result.length > 65536) throw Error("Issue body exceeds 65,536 characters; shorten description.");
  return result;
}
export function timingOverlapsDates(timing: TodoTiming, from: string, through: string, timeZone: string): boolean {
  if (!timing.start || !timing.end) return false;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateAt = (value: number) => { const parts = formatter.formatToParts(value); const get = (key: string) => parts.find(p => p.type === key)!.value; return `${get("year")}-${get("month")}-${get("day")}`; };
  return dateAt(Date.parse(timing.start) - (timing.beforeMinutes ?? 0) * 60000) <= through && dateAt(Date.parse(timing.end) + (timing.afterMinutes ?? 0) * 60000 - 1) >= from;
}

// Shift instants, never their displayed clock digits. Preserves elapsed duration across offsets/DST.
export function shiftTaskTiming(timing: TodoTiming, minutes: number): TodoTiming {
  if (!timing.start || !timing.end) throw Error("Cannot shift an unscheduled task. Set start and end first.");
  return todoTimingSchema.parse({ ...timingOf(timing),
    start: new Date(Date.parse(timing.start) + minutes * 60000).toISOString(),
    end: new Date(Date.parse(timing.end) + minutes * 60000).toISOString(),
  });
}

const ownerTimingFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
});
export function taskTimingSummary(timing: Pick<TodoTiming, "start" | "end" | "beforeMinutes" | "afterMinutes">): string {
  if (!timing.start || !timing.end) return "Unscheduled.";
  const local = (instant: string) => ownerTimingFormatter.format(new Date(instant));
  return `${local(timing.start)} to ${local(timing.end)} (America/Halifax); elapsed duration ${(Date.parse(timing.end) - Date.parse(timing.start)) / 60000} minutes. Prep before: ${timing.beforeMinutes ?? 0} minutes; after: ${timing.afterMinutes ?? 0} minutes.`;
}
