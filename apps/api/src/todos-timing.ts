import type { Todo } from "./todos-github";

export function withTimingWarnings(todos: Todo[], timeZone: string): Todo[] {
  const result = todos.map(todo => ({ ...todo, timingWarnings: [] as string[] }));
  const entries = result.flatMap(todo => todo.state !== "closed" && !todo.allDay && todo.start && todo.end
    ? [{ todo, start: Date.parse(todo.start), end: Date.parse(todo.end) }] : []);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (a.start < b.end && b.start < a.end) {
      a.todo.timingWarnings.push(`Overlap with #${b.todo.number}; both tasks retained.`);
      b.todo.timingWarnings.push(`Overlap with #${a.todo.number}; both tasks retained.`);
    }
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateAt = (instant: number) => { const parts = formatter.formatToParts(instant); const get = (key: string) => parts.find(p => p.type === key)!.value; return `${get("year")}-${get("month")}-${get("day")}`; };
  const dayStart = (date: string) => {
    const noon = Date.parse(`${date}T12:00:00Z`);
    let low = noon - 48 * 3600000, high = noon + 48 * 3600000;
    while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (dateAt(mid) < date) low = mid; else high = mid; }
    return high;
  };
  const dates = new Set(entries.flatMap(e => [dateAt(e.start), dateAt(e.end - 1)]));
  for (const date of dates) {
    const start = dayStart(date);
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const end = dayStart(next);
    const portions = entries.map(entry => ({ entry, milliseconds: Math.max(0, Math.min(end, entry.end) - Math.max(start, entry.start)) }));
    if (portions.reduce((sum, p) => sum + p.milliseconds, 0) > end - start)
      for (const { entry, milliseconds } of portions) if (milliseconds > 0)
        entry.todo.timingWarnings.push(`Overfull day ${date}: scheduled time exceeds the day's elapsed capacity.`);
  }
  return result;
}
