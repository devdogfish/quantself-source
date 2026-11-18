import { prisma } from "@quantself/db";
import { habitCatalog, habitChangeSchema } from "./habits-catalog";
import { localHabitDate } from "./habits-definition";
import { gateRule, shiftHabitDate, type Observation } from "./habits-insights-facts";
import { computeHabitSummary, type CatalogRevision } from "./habits-summary-core";
import { z } from "zod";

export function createHabitSummary(db: Pick<typeof prisma, "$queryRaw" | "habitDefinitionRevision" | "habitOccurrence"> = prisma,
  catalog: Pick<typeof habitCatalog, "current"> = habitCatalog) {
  return {
    async read(ownerId: string, now = new Date()) {
      const today = localHabitDate(now), from = shiftHabitDate(today, -363);
      const projectionRead = catalog.current(ownerId);
      const revisionsRead = db.habitDefinitionRevision.findMany({ where: { ownerId, createdAt: { lte: now } }, orderBy: { revision: "asc" }, select: { createdAt: true, changes: true } });
      const repsRead = db.habitOccurrence.groupBy({ by: ["habitId"], where: { ownerId, date: { lte: today }, status: { in: ["done", "minimum"] } }, _count: { _all: true } });
      const observationsRead = projectionRead.then(async ({ projection }) => {
        const maxWindow = Math.max(2, ...projection.habits.map(h => {
          const schedule = h.schedule ?? projection.stacks.find(s => s.id === h.stack)?.days;
          const weekly = Array.isArray(schedule) && schedule.length === 1;
          return (gateRule(projection, h, weekly).window + 1) * (weekly ? 7 : 1);
        }));
        // Return the visible year plus bounded older eligible gate context. Lifetime
        // totals are aggregated separately, so years of raw history do not cross the wire.
        return db.$queryRaw<Observation[]>`
          WITH ranked AS (
            SELECT "habitId", date, status,
              count(*) FILTER (WHERE status IN ('done', 'minimum') OR (status = 'open' AND date < ${today}))
                OVER (PARTITION BY "habitId" ORDER BY date DESC ROWS UNBOUNDED PRECEDING) AS eligible_rank
            FROM habit_occurrence WHERE "ownerId" = ${ownerId} AND date <= ${today}
          )
          SELECT "habitId", date, status FROM ranked
          WHERE date >= ${from} OR (eligible_rank <= ${maxWindow} AND (status IN ('done', 'minimum') OR status = 'open'))
          ORDER BY date, "habitId"`;
      });
      const [{ projection }, revisions, reps, occurrences] = await Promise.all([projectionRead, revisionsRead, repsRead, observationsRead]);
      const history: CatalogRevision[] = revisions.map(r => ({ at: r.createdAt.toISOString(), changes: z.array(habitChangeSchema).parse(r.changes) }));
      return computeHabitSummary({ projection, revisions: history, occurrences, today, lifetimeReps: Object.fromEntries(reps.map(r => [r.habitId, r._count._all])) });
    },
  };
}
export const habitSummary = createHabitSummary();
