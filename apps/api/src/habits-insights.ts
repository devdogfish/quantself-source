import { prisma } from "@quantself/db";
import { habitCatalog } from "./habits-catalog";
import { localHabitDate } from "./habits-definition";
import { habitDocuments } from "./habits-documents";
import type { ReviewStatus } from "./habits-insights-schema";
import { computeOverview } from "./habits-insights-core";
import {
  habitWeek,
  shiftHabitDate,
  type Observation,
} from "./habits-insights-facts";

const PAGE_SIZE = 1000;

export function createHabitInsights(
  db: Pick<
    typeof prisma,
    "habitOccurrence" | "habitDefinitionRevision" | "habitSlip"
  > = prisma,
  catalog: Pick<typeof habitCatalog, "current"> = habitCatalog,
  documents: Pick<typeof habitDocuments, "hasReview"> = habitDocuments,
) {
  async function observations(ownerId: string, to: string) {
    const result: Observation[] = [];
    let cursor: { ownerId: string; habitId: string; date: string } | undefined;
    for (;;) {
      const page = await db.habitOccurrence.findMany({
        where: { ownerId, date: { lte: to } },
        orderBy: [{ date: "asc" }, { habitId: "asc" }],
        select: { habitId: true, date: true, status: true },
        take: PAGE_SIZE,
        ...(cursor
          ? { cursor: { ownerId_habitId_date: cursor }, skip: 1 }
          : {}),
      });
      result.push(...page);
      if (page.length < PAGE_SIZE) return result;
      const { habitId, date } = page.at(-1)!;
      cursor = { ownerId, habitId, date };
    }
  }

  return {
    async overview(
      ownerId: string,
      { asOf, weeks = 4 }: { asOf: Date; weeks?: number },
    ) {
      const to = localHabitDate(asOf);
      const from = shiftHabitDate(to, 1 - weeks * 7);
      const patternStart = shiftHabitDate(to, -27);
      // UTC date bounds include Halifax dates on both sides of a DST transition.
      // The core applies the exact Halifax bounds to timestamps.
      const gte = new Date(`${patternStart}T00:00:00Z`);
      const [{ projection }, revisions, occurrences, slips, reviewStatus] =
        await Promise.all([
          catalog.current(ownerId),
          db.habitDefinitionRevision.findMany({
            where: { ownerId, createdAt: { gte, lte: asOf } },
            select: { createdAt: true },
          }),
          observations(ownerId, to),
          db.habitSlip.findMany({
            where: { ownerId, occurredAt: { gte, lte: asOf } },
            select: { occurredAt: true },
          }),
          documents.hasReview(`reviews/${habitWeek(to).end}.md`).then<ReviewStatus, ReviewStatus>(
            (exists) => exists ? "exists" : "missing",
            () => "unavailable",
          ),
        ]);
      return computeOverview({
        projection,
        revisions: revisions.map(({ createdAt }) => ({ at: createdAt })),
        occurrences,
        slips,
        asOf,
        range: { from, to },
        reviewStatus,
      });
    },
  };
}

export const habitInsights = createHabitInsights();
