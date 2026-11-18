// Home dashboard reads: five independent requests, each returning a small summary for one area.
import { readHabitDay } from "./habits/habits-api";
import { budgetRequest, money } from "./budgeting/budgeting-client";
import { readTodoJson } from "./todo/todo-live";
import type { components } from "@/lib/generated/quantself-api-schema";

export const timeZone = "America/Halifax";

const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function partsAt(instant: number) {
  const parts = dayFormatter.formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
export const localToday = (now = Date.now()) => partsAt(now).date;

export type HomeTask = { number: number; title: string; time: string | null; allDay: boolean; startMs: number | null; rank: number };
export type TasksToday = { open: HomeTask[]; done: number; total: number; next: HomeTask | null };
export type HabitsToday = { done: number; total: number; atRisk: number; left: { stack: string; habits: string[] }[] };
export type BudgetWeek = { value: string; note: string; over: boolean };
export type InboxCounts = { proposals: number; proposalsCapped: boolean };
export type JobCounts = { review: number; needsAttention: number };

const proposalLimit = 50;
type Todo = components["schemas"]["Todo"];

export async function loadTasks(now = Date.now()): Promise<TasksToday> {
  const today = localToday(now);
  const { todos } = await readTodoJson<components["schemas"]["TodosResponse"]>(
    `/api/v1/todos?from=${today}&through=${today}&timeZone=${encodeURIComponent(timeZone)}`,
  );
  const relevant = todos.filter((todo: Todo) => !todo.trashed && (todo.state === "open" || todo.closureReason === "completed"));
  const open = relevant.filter((todo) => todo.state === "open").map((todo): HomeTask => {
    const startMs = todo.start && !todo.allDay ? Date.parse(todo.start) : null;
    return { number: todo.number, title: todo.title, startMs, allDay: todo.allDay, time: startMs === null ? null : partsAt(startMs).time, rank: todo.fields.Rank ?? Number.MAX_SAFE_INTEGER };
  }).sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || a.rank - b.rank);
  const next = open.find((task) => task.startMs !== null && task.startMs >= now) ?? null;
  return { open, done: relevant.length - open.length, total: relevant.length, next };
}

export async function loadHabits(): Promise<HabitsToday> {
  const day = await readHabitDay();
  if (!day.projection) throw new Error(day.error ?? "Habits unavailable.");
  const habits = new Map(day.projection.habits.map((habit) => [habit.id, habit]));
  const stacks = new Map(day.projection.stacks.map((stack) => [stack.id, stack.name]));
  const today = day.occurrences.filter((row) => habits.has(row.habitId) && row.status !== "skipped");
  const open = today.filter((row) => row.status === "open");
  const groups = new Map<string, { order: number; habits: string[] }>();
  for (const row of open.sort((a, b) => habits.get(a.habitId)!.order - habits.get(b.habitId)!.order)) {
    const habit = habits.get(row.habitId)!;
    const stack = stacks.get(habit.stack) ?? "Other";
    const group = groups.get(stack) ?? { order: groups.size, habits: [] };
    group.habits.push(habit.name);
    groups.set(stack, group);
  }
  return {
    done: today.length - open.length, total: today.length, atRisk: open.filter((row) => row.missed).length,
    left: [...groups].map(([stack, group]) => ({ stack, habits: group.habits })),
  };
}

export async function loadBudget(): Promise<BudgetWeek> {
  const overview = await budgetRequest<"getBudgetOverview">("");
  const spent = overview.foodSpent + overview.otherSpent;
  const limits = [overview.foodLimit, overview.otherLimit].filter((limit): limit is number => limit !== null);
  if (!limits.length) return { value: money(spent), note: "Spent this week · no limit set", over: false };
  const limit = limits.reduce((sum, value) => sum + value, 0);
  return { value: money(Math.abs(limit - spent)), note: `${spent > limit ? "over" : "left"} this week · ${money(spent)} of ${money(limit)}`, over: spent > limit };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.message ?? `Request failed (${response.status}).`), { status: response.status });
  return body;
}

export async function loadInbox(): Promise<InboxCounts> {
  const { proposals } = await getJson<components["schemas"]["InventoryProposalsResponse"]>(`/api/v1/inventory-proposals?limit=${proposalLimit}`);
  return { proposals: proposals.length, proposalsCapped: proposals.length >= proposalLimit };
}

export async function loadJobs(): Promise<JobCounts> {
  const { counts } = await getJson<{ counts: { review?: number; needs_attention?: number } }>("/api/v1/jobs/applications?limit=1");
  return { review: counts.review ?? 0, needsAttention: counts.needs_attention ?? 0 };
}
