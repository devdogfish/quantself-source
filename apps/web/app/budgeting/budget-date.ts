const halifaxDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Small ICU builds can format en-CA dates as M/D/YYYY. Read the calendar
// parts since UI date inputs, URL queries, and the ledger need ISO keys.
export function budgetToday(now = new Date()): string {
  const parts = halifaxDate.formatToParts(now);
  const get = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
