import { prisma } from "@quantself/db";
import { habitCatalog } from "./habits-catalog";
import { habitDocuments } from "./habits-documents";
import { HabitError } from "./habits-service";
import { localHabitDate } from "./habits-definition";
import { shiftHabitDate } from "./habits-insights-facts";
import { askAnswerSchema, askInputSchema, type HabitAskRecord, type HabitAskAnswer } from "./habits-ask-schema";
import { habitAskModel, HABIT_ASK_TIMEOUT_MS, HABIT_ASK_CONTEXT_BYTES } from "./habits-ask-model";
import { z } from "zod";

type Stored = Awaited<ReturnType<typeof prisma.habitAsk.findUnique>> & {};
const outcome = (status?: string): HabitAskRecord["outcome"] => status === "done" ? "did full" : status === "minimum" ? "did minimum" : status === "skipped" ? "skipped" : "open";
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
export function askCursor(cursor?: string) {
  if (!cursor) return null;
  try { return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString())); }
  catch { throw new HabitError(400, "Invalid ask cursor."); }
}
export function createHabitAsks(db = prisma, catalog = habitCatalog, documents = habitDocuments,
  model: (context: string, signal: AbortSignal) => Promise<HabitAskAnswer> = habitAskModel, now = () => new Date(), timeoutMs = HABIT_ASK_TIMEOUT_MS) {
  const record = (row: Stored, status?: string, revision?: number): HabitAskRecord => ({ id: row.id, habitId: row.habitId, text: row.text, feeling: askAnswerSchema.shape.feeling.parse(row.feeling), at: row.createdAt.toISOString(), date: row.date, outcome: outcome(status), outcomeRevision: revision ?? null, answer: row.answer ? askAnswerSchema.parse(row.answer) : null });
  const withOutcome = async (row: Stored) => {
    const check = await db.habitOccurrence.findUnique({ where: { ownerId_habitId_date: { ownerId: row.ownerId, habitId: row.habitId, date: row.date } }, select: { status: true, revision: true } });
    return record(row, check?.status, check?.revision);
  };
  return {
    async read(ownerId: string, cursor?: string) {
      const end = localHabitDate(now()), start = shiftHabitDate(end, -13), after = askCursor(cursor);
      const at = after ? new Date(after.at) : new Date("9999-01-01T00:00:00Z"), id = after?.id ?? "";
      // One owner-scoped join per page; no per-ask outcome reads or truncation.
      const rows = await db.$queryRaw<(Stored & { status: string | null; outcomeRevision: number | null })[]>`
        SELECT a.id, a."habitId", a.feeling, a."createdAt", a.date, o.status, o.revision AS "outcomeRevision" FROM habit_ask a
        LEFT JOIN habit_occurrence o ON o."ownerId" = a."ownerId" AND o."habitId" = a."habitId" AND o.date = a.date
        WHERE a."ownerId" = ${ownerId} AND a.date >= ${start} AND a.date <= ${end}
          AND (a."createdAt" < ${at} OR (a."createdAt" = ${at} AND a.id < ${id}))
        ORDER BY a."createdAt" DESC, a.id DESC LIMIT 101`;
      const page = rows.slice(0, 100), last = page.at(-1);
      return { rows: page.map(r => ({ id: r.id, habitId: r.habitId, feeling: askAnswerSchema.shape.feeling.parse(r.feeling), at: r.createdAt.toISOString(), date: r.date, outcome: outcome(r.status ?? undefined), outcomeRevision: r.outcomeRevision })), next: rows.length > 100 && last ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null };
    },
    async ask(ownerId: string, clientId: string, input: z.infer<typeof askInputSchema>, id: string = crypto.randomUUID()) {
      const body = askInputSchema.parse(input), key = { ownerId_id: { ownerId, id } };
      let row = await db.habitAsk.findUnique({ where: key });
      const validateReplay = (existing: Stored) => {
        if (existing.clientId !== clientId || existing.habitId !== body.habitId || existing.text !== body.text) throw new HabitError(409, "This ask ID belongs to different input.");
      };
      if (row) { validateReplay(row); if (row.state === "complete") return withOutcome(row); }
      const { projection } = await catalog.current(ownerId), habit = projection.habits.find(h => h.id === body.habitId);
      if (!habit) throw new HabitError(400, "Habit not found.");
      const claimAt = now(), date = localHabitDate(claimAt);
      if (!row) {
        try { row = await db.habitAsk.create({ data: { ownerId, clientId, id, habitId: body.habitId, text: body.text, date, createdAt: claimAt, updatedAt: claimAt } }); }
        catch (e) {
          if (!(typeof e === "object" && e && "code" in e && e.code === "P2002")) throw e;
          const existing = await db.habitAsk.findUniqueOrThrow({ where: key }); validateReplay(existing);
          if (existing.state === "complete") return withOutcome(existing);
          throw new HabitError(409, "This ask is still processing. Retry shortly with the same input.");
        }
      } else {
        const claimed = await db.habitAsk.updateMany({ where: { ownerId, id, OR: [{ state: "failed" }, { state: "pending", updatedAt: { lt: new Date(claimAt.getTime() - 60_000) } }] }, data: { state: "pending", updatedAt: claimAt } });
        if (!claimed.count) throw new HabitError(409, "This ask is still processing. Retry shortly with the same input.");
      }
      const signal = AbortSignal.timeout(timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Reuse the same Catalog/document sources as /habits/context, narrowed to
        // the selected habit. No unrelated reviews/slips or full-catalog rereads.
        const work = async () => {
          const [history, system, playbook] = await Promise.all([
            db.habitOccurrence.findMany({ where: { ownerId, habitId: habit.id, date: { gte: shiftHabitDate(row.date, -27), lte: row.date } }, orderBy: { date: "asc" }, select: { date: true, status: true, note: true }, take: 28 }),
            documents.document("SYSTEM.md"), documents.document("playbook.md"),
          ]);
          if ([system, playbook].some(d => d.stale || d.error)) throw new HabitError(503, "Habit System/playbook unavailable. Retry shortly.");
          // Bound each document while retaining the complete catalog entry and all
          // recent daily observations. Make truncation explicit in model context.
          const doc = (text: string) => text.length > 6000 ? `${text.slice(0, 6000)}\n[truncated]` : text;
          const context = JSON.stringify({ habit, stack: projection.stacks.find(s => s.id === habit.stack), date: row.date, moment: body.text,
            history: history.map(h => ({ ...h, note: h.note.slice(0, 300) })), system: doc(system.text), playbook: doc(playbook.text) });
          if (new TextEncoder().encode(context).length > HABIT_ASK_CONTEXT_BYTES) throw new HabitError(400, "Habit context exceeds the supported size.");
          signal.throwIfAborted();
          return askAnswerSchema.parse(await model(context, signal));
        };
        const answer = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HabitError(503, "Jarvis timed out. Retry the same ask.")), timeoutMs); })]);
        signal.throwIfAborted();
        const saved = await db.habitAsk.updateMany({ where: { ownerId, id, state: "pending", updatedAt: claimAt }, data: { state: "complete", feeling: answer.feeling, answer } });
        if (!saved.count) throw new HabitError(409, "Ask changed while saving. Retry the same ask.");
        return withOutcome({ ...row, answer, feeling: answer.feeling, state: "complete" });
      } catch (e) {
        // Never replace another process's newer claim or an already saved answer.
        await db.habitAsk.updateMany({ where: { ownerId, id, state: "pending", updatedAt: claimAt }, data: { state: "failed" } });
        if (e instanceof HabitError) throw e;
        throw new HabitError(503, "Jarvis unavailable. Retry the same ask.");
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
export const habitAsks = createHabitAsks();
