import type { operations } from "@/lib/generated/quantself-api-schema";
import { habitClient, readHabitDay } from "../habits-api";
import type { HabitDay } from "../habit-store";
import { DAYS, fmt, type Habit, type Stack, type State } from "./habit-metrics";

type Body<K extends keyof operations> = operations[K] extends { responses: { 200: { content: { "application/json": infer T } } } } ? T : never;
export type LiveSnapshot = { started?: Record<string, string>; catalog: Body<"getHabitDefinitions">; overview: Body<"getHabitOverview">; day: HabitDay };
export async function readHabits(): Promise<LiveSnapshot> {
  // Three bounded requests regardless of catalog size. The day materializes today's
  // observations; overlay it on the independently fetched, read-only history.
  const catalogRead = habitClient.GET("/api/v1/habits/definitions", { cache: "no-store" });
  const startedRead = catalogRead.then(({ data, error }) => {
    if (!data) throw Error(error?.message ?? "Catalog unavailable.");
    return readStartedDates(data);
  });
  const [catalog, overview, day, started] = await Promise.all([
    catalogRead,
    habitClient.GET("/api/v1/habits/overview", { params: { query: { weeks: 52 } }, cache: "no-store" }),
    readHabitDay(),
    startedRead,
  ]);
  if (!catalog.data || !overview.data || !day.projection || day.stale || day.error)
    throw Error(catalog.error?.message ?? overview.error?.message ?? day.error ?? "Habits unavailable.");
  return { catalog: catalog.data, overview: overview.data, day, started };
}
// History is only needed for definitions without their own first-active date.
// Read complete cursor pages, never one request per missing habit.
async function readStartedDates(catalog: Body<"getHabitDefinitions">) {
  const missing = new Set(catalog.projection.habits.filter(h => !h.startDate).map(h => h.id));
  const started: Record<string, string> = {};
  if (!missing.size) return started;
  let before: number | undefined;
  for (;;) {
    const { data, error } = await habitClient.GET("/api/v1/habits/definitions/history", { params: { query: { before, limit: 100 } }, cache: "no-store" });
    if (!data) throw Error(error?.message ?? "Habit history unavailable.");
    for (const revision of data) for (const change of revision.changes) {
      const id = change.type === "upsertHabit" ? change.id : change.type === "setStatus" ? change.habitId : null;
      if (!id || !missing.has(id) || !("status" in change) || !["testing", "building", "established"].includes(change.status)) continue;
      const date = change.type === "upsertHabit" && change.startDate ? change.startDate : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(revision.at));
      if (!started[id] || date < started[id]) started[id] = date;
    }
    if (data.length < 100) return started;
    const cursor = data.at(-1)!.revision;
    if (before !== undefined && cursor >= before) throw Error("Habit history cursor did not advance.");
    before = cursor;
  }
}
export function habitDates(today: string) {
  const end = new Date(`${today}T12:00:00`);
  return Array.from({ length: DAYS }, (_, i) => new Date(end.getFullYear(), end.getMonth(), end.getDate() - (DAYS - 1 - i), 12));
}
const text = (v: unknown) => typeof v === "string" ? v : "";
export function projectHabits({ catalog, overview, day, started = {} }: LiveSnapshot) {
  const p = catalog.projection, dates = habitDates(day.today);
  const stacks: Stack[] = p.stacks.map(s => ({ id: s.id, name: s.name, cue: s.cue ?? "", anchor: s.anchor ?? "", minutes: s.durationMinutes ?? 0, place: text(s.place), scheduleLabel: s.days === "daily" ? "Not today" : s.days === "weekdays" ? "Weekdays" : s.days.map(d => d[0]!.toUpperCase() + d.slice(1) + "s").join(", ") }));
  const stackById = new Map(p.stacks.map(s => [s.id, s]));
  const overviewById = new Map(overview.habits.map(h => [h.id, h]));
  const dateKeys = dates.map(d => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }));
  const habits: Habit[] = p.habits.map(h => {
    const startedDate = h.startDate ?? started[h.id];
    const schedule = h.schedule ?? stackById.get(h.stack)?.days;
    const weekly = Array.isArray(schedule) && schedule.length === 1;
    const defaults = (weekly ? p.gate.weekly : p.gate.daily) as Habit["gate"] | undefined;
    return { id: h.id, name: h.name, stack: h.stack, kind: h.kind, status: h.status,
      identity: text(h.identity), minimum: text(h.minimum), full: text(h.full), fallback: text(h.fallback) || undefined,
      startedDate, cue: text(h.cue),
      started: startedDate ? fmt(new Date(`${startedDate}T12:00:00`), { month: "short", day: "numeric" }) : "Not started",
      gate: h.gate ?? defaults ?? (weekly && p.gate.window === 14 && p.gate.required === 10 ? { window: 4, required: 3 } : { window: Number(p.gate.window), required: Number(p.gate.required) }),
      weekly, untracked: !h.tracked, triggers: h.triggers,
      protocol: Array.isArray(h.protocol) ? h.protocol.filter((x): x is string => typeof x === "string") : undefined,
      substitution: text(h.substitution),
    };
  });
  const hist: Record<string, State[]> = {};
  for (const h of habits.filter(h => h.kind === "build" && !h.untracked)) {
    const history = new Map(overviewById.get(h.id)?.days.map(d => [d.date, d.state]));
    hist[h.id] = dateKeys.map(date => history.get(date) ?? "none");
  }
  return { habits, stacks, hist, dates, today: dates.at(-1)!, catalogFacts: overview.catalogFacts ?? [] };
}

export async function readHabitSummary() {
  const { data, error } = await habitClient.GET("/api/v1/habits/summary", { cache: "no-store" });
  if (!data) throw Error(error?.message ?? "Habit Summary unavailable.");
  return data;
}


export async function readHabitAsks() {
  const rows: import("../../../../api/src/habits-ask-schema").HabitAskListRecord[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const { data, error } = await habitClient.GET("/api/v1/habits/asks", { params: { query: { cursor } }, cache: "no-store" });
    if (!data) throw Error(error?.message ?? "Habit asks unavailable.");
    rows.push(...data.rows);
    cursor = data.next ?? undefined;
    if (cursor && seen.has(cursor)) throw Error("Habit ask pagination did not advance.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
export async function sendHabitAsk(input: { habitId: string; text: string }, id: string) {
  const { data, error } = await habitClient.POST("/api/v1/habits/ask", {
    body: input, params: { header: { "idempotency-key": id } }, signal: AbortSignal.timeout(25_000),
  });
  if (!data) throw Error(error?.message ?? "Ask delivery uncertain. Retry the same ask.");
  return data;
}
