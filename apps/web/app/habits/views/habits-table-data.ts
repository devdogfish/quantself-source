import { DAYS, counts, fmt, type Habit, type Stack, type State } from "./habit-metrics";
import type { projectCatalogFact } from "../../../../api/src/habits-catalog-facts";
export const statusLabel = { testing: "Testing", building: "Building", established: "Established", pending: "Not started", paused: "Paused" } as const;
export type HabitRow = { h: Habit; stack: string; status: string; tracked: boolean; rate: number | null; last: string | null; lastDate: string | null };
export function habitRows(habits: Habit[], stacks: Stack[], hist: Record<string, State[]>, dates: Date[], facts: Record<string, ReturnType<typeof projectCatalogFact>>): HabitRow[] {
  const names = new Map(stacks.map(s => [s.id, s.name]));
  return habits.map(h => {
    const hs = hist[h.id], fact = facts[h.id], t = dates.length - 1;
    const lastIdx = hs?.findLastIndex(counts) ?? -1;
    const lastDate = fact ? fact.lastDone : lastIdx < 0 ? null : fmt(dates[lastIdx]!, { year: "numeric", month: "2-digit", day: "2-digit" });
    const last = lastDate ? new Date(`${lastDate}T12:00:00`) : null;
    const window = hs?.slice(t - 28, t).filter(s => s !== "none" && s !== "skipped" && s !== "open");
    const eligible = fact?.recentEligible ?? window?.length ?? 0, reps = fact?.recentReps ?? window?.filter(counts).length ?? 0;
    return { h, stack: names.get(h.stack) ?? h.stack, tracked: Boolean(hs), status: h.kind === "break" ? "Breaking" : statusLabel[h.status],
      rate: eligible ? Math.round(reps / eligible * 100) : null, lastDate,
      last: !last ? null : last.toDateString() === dates[t]!.toDateString() ? "Today" : last.toDateString() === dates[t - 1]!.toDateString() ? "Yesterday" : fmt(last, { month: "short", day: "numeric" }) };
  });
}
export function filterHabitRows(all: HabitRow[], stacks: Stack[], { query, scope, stack, status, sort }: { query: string; scope: "all" | "tracked" | "untracked"; stack: string; status: string; sort: string }) {
  const q = query.trim().toLowerCase(), order = new Map(stacks.map((s, i) => [s.id, i]));
  const rows = all.filter(r => (!q || `${r.h.name} ${r.h.identity} ${r.stack}`.toLowerCase().includes(q)) &&
    (scope === "all" || (scope === "tracked") === r.tracked) && (stack === "all" || r.h.stack === stack) && (status === "all" || r.status === status));
  const by: Record<string, (a: HabitRow, b: HabitRow) => number> = {
    stack: (a, b) => (order.get(a.h.stack) ?? 0) - (order.get(b.h.stack) ?? 0),
    name: (a, b) => a.h.name.localeCompare(b.h.name),
    rate: (a, b) => (a.rate ?? 101) - (b.rate ?? 101),
    recent: (a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? ""),
  };
  return rows.sort(by[sort] ?? by.stack);
}
export function exportHabitRows(rows: HabitRow[], delimiter: "," | "\t") {
  const cells = [["Habit", "Stack", "Status", "Started", "Consistency 4 wks", "Last done"], ...rows.map(r => [r.h.name, r.stack, r.status, r.h.started, r.rate ?? "", r.last ?? ""])];
  return cells.map(row => row.map(v => { const s = String(v); return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }).join(delimiter)).join("\n");
}
