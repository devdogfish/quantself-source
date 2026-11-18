// Read-only API projections for the finalized Overview.
import { addDays, TODAY, type State } from "./stub-store";

export type Mode = "week" | "month";
export type Period = { mode: Mode; start: string; end: string; label: string; current: boolean };
export type Line = { date: string; label: string; cents: number; done: boolean; note?: string };

const fmt = (o: Intl.DateTimeFormatOptions) => (iso: string) => new Intl.DateTimeFormat("en-CA", { ...o, timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));
const md = fmt({ month: "short", day: "numeric" });
const my = fmt({ month: "long", year: "numeric" });

// offset 0 = the period containing TODAY, -1 = the one before, …
export function period(mode: Mode, offset: number): Period {
  if (mode === "week") {
    const monday = addDays(TODAY, -((new Date(TODAY + "T00:00:00Z").getUTCDay() + 6) % 7) + offset * 7);
    const end = addDays(monday, 6);
    return { mode, start: monday, end, label: `${md(monday)} – ${md(end)}`, current: offset === 0 };
  }
  const d = new Date(TODAY + "T00:00:00Z");
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const start = first.toISOString().slice(0, 10);
  return { mode, start, end: last.toISOString().slice(0, 10), label: my(start), current: offset === 0 };
}

export function statement(s: State, p: Period) {
  return s.overview?.statements.find(x => x.start === p.start && x.end === p.end) ?? {
    income: [], bills: [], savings: [], spending: [], cats: [], totals: { income: 0, bills: 0, savings: 0, spending: 0 },
    net: 0, allowance: 0, daysLeft: 0,
  };
}

// Daily balance: reconstructed backwards from today's cash, projected forwards with allowance pace.
export function balanceSeries(s: State, back: number, ahead: number) {
  return (s.overview?.context?.balance ?? []).filter(x => x.date >= addDays(TODAY, -back) && x.date <= addDays(TODAY, ahead));
}
