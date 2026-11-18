import { z } from "@hono/zod-openapi";
import { localDate } from "./todos-schedule";

export const todoDeadlineAtSchema = z.string().datetime({ offset: true }).nullable();
const marker = /<!-- quantself:deadline\b([\s\S]*?)-->/g;
const metadata = z.object({ version: z.literal(1), date: localDate, at: z.string().datetime({ offset: true }) }).strict();
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit" });
export function deadlineDate(at: string) {
  const parts = formatter.formatToParts(new Date(at));
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function readStoredDeadline(body: string | null): { version: 1; date: string; at: string } | null {
  const raw = body ?? "";
  const matches = [...raw.matchAll(marker)];
  if (!matches.length && !raw.includes("<!-- quantself:deadline")) return null;
  if (matches.length !== 1 || raw.split("<!-- quantself:deadline").length !== 2) throw Error("Invalid deadline metadata.");
  return metadata.parse(JSON.parse(matches[0][1]!.trim()));
}
export function readTodoDeadline(body: string | null, due: string | null | undefined): { deadlineAt: string | null; deadlineError: string | null } {
  try {
    const value = readStoredDeadline(body);
    if (!value) return { deadlineAt: null, deadlineError: null };
    if (value.date !== due || deadlineDate(value.at) !== due) throw Error("Deadline date changed outside Quantself. Review its time; original metadata retained.");
    return { deadlineAt: value.at, deadlineError: null };
  } catch (error) { return { deadlineAt: null, deadlineError: (error as Error).message }; }
}
export function editDeadlineBody(body: string | null, due: string | null | undefined, at: string | null): string {
  todoDeadlineAtSchema.parse(at);
  const raw = body ?? "";
  const matches = [...raw.matchAll(marker)];
  if (matches.length > 1 || raw.split("<!-- quantself:deadline").length - 1 !== matches.length) throw Error("Invalid deadline metadata. Repair it before editing.");
  if (at && (!due || deadlineDate(at) !== due)) throw Error("Deadline time must fall on the Due date in America/Halifax.");
  // Explicit edits may replace a well-formed stale date/time association.
  if (matches.length) metadata.parse(JSON.parse(matches[0][1]!.trim()));
  const cleared = raw.replace(/(?:\n\n)?<!-- quantself:deadline\b[\s\S]*?-->/, "");
  const next = at ? `${cleared}${cleared ? "\n\n" : ""}<!-- quantself:deadline ${JSON.stringify({ version: 1, date: due, at })} -->` : cleared;
  if (next.length > 65536) throw Error("Issue body exceeds 65,536 characters.");
  return next;
}
