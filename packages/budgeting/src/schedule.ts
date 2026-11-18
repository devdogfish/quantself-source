/** Calendar-only calculations shared by the API and optimistic Budgeting UI. */
export type Schedule = {
  id: string; date: string; cents: number;
  frequency: "once" | "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  subscription?: {
    cancelledOn: string | null;
    prices?: { date: string; cents: number }[];
    notes?: string;
  };
};

export function shiftDate(value: string, days: number) {
  const time = new Date(value + "T00:00:00Z");
  time.setUTCDate(time.getUTCDate() + days);
  return time.toISOString().slice(0, 10);
}

export function chargeAmount(entry: Schedule, date: string) {
  return (entry.subscription?.prices ?? []).filter(price => price.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.cents ?? entry.cents;
}

/** Anchored to the original day: Jan 31 -> Feb 28 -> Mar 31, never drifts. */
export function scheduleOccurrences<T extends Schedule>(entry: T, from: string, through: string): (T & { key: string })[] {
  const stop = entry.subscription?.cancelledOn;
  if (stop && stop <= through) through = shiftDate(stop, -1);
  const first = from > entry.date ? from : entry.date;
  if (first > through) return [];
  const occurrence = (date: string, period: string) => ({ ...entry, date, cents: chargeAmount(entry, date), key: `${entry.id}:${period}` });
  if (entry.frequency === "once") return entry.date >= first ? [occurrence(entry.date, "once")] : [];
  const interval = entry.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw Error("Invalid recurrence interval.");
  if (entry.frequency === "weekly" || entry.frequency === "daily") {
    const step = (entry.frequency === "weekly" ? 7 : 1) * interval;
    const offset = Math.max(0, Math.ceil((Date.parse(first) - Date.parse(entry.date)) / 86_400_000 / step));
    const result = [];
    for (let day = shiftDate(entry.date, offset * step); day <= through; day = shiftDate(day, step))
      result.push(occurrence(day, day));
    return result;
  }
  const [year, month, day] = entry.date.split("-").map(Number);
  const step = interval * (entry.frequency === "yearly" ? 12 : 1);
  const fromMonth = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7)) - 1;
  const anchor = year * 12 + month - 1;
  const lastMonth = Number(through.slice(0, 4)) * 12 + Number(through.slice(5, 7)) - 1;
  const result = [];
  for (let index = anchor + Math.max(0, Math.floor((fromMonth - anchor) / step)) * step; index <= lastMonth; index += step) {
    const y = Math.floor(index / 12), m = index % 12;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const period = `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}`;
    const due = `${period}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
    // Keep legacy monthly keys stable for already matched bills.
    if (due >= first && due <= through) result.push(occurrence(due, period));
  }
  return result;
}

export function recurrenceLabel(entry: Schedule) {
  if (entry.frequency === "once") return "Once";
  const interval = entry.interval ?? 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[entry.frequency];
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}
