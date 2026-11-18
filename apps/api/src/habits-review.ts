import { prisma } from "@quantself/db";
import { z } from "zod";
import { githubHabitLoader, type HabitDefinitions } from "./habits-source";
import { catalogSource } from "./habits-catalog";
import { habitDocuments } from "./habits-documents";
import { HabitError } from "./habits-service";
import { localHabitDate } from "./habits-definition";
import { deriveHabitStats, habitWeek, shiftHabitDate } from "./habits-stats";
export const contextSchema = z.object({
  text: z.string(),
  unavailable: z.array(z.string()),
});
export const reviewHeadings = [
  "What went well",
  "What didn’t",
  "What happened right before each miss or slip",
  "Which law failed (obvious / attractive / easy / satisfying)",
  "What I learned",
  "The one change",
  "Gate and ramp decisions",
];
const writer = githubHabitLoader(process.env, fetch, Date.now, "write");
export function createHabitReviewService(
  db = prisma,
  source: { read(ownerId: string): Promise<HabitDefinitions> } = catalogSource,
  documents = habitDocuments,
  create = writer.createReview,
  now = () => new Date(),
) {
  async function observations(ownerId: string, end: string, start?: string) {
    const result: {
      habitId: string;
      date: string;
      status: string;
      note?: string;
      definitionSha?: string;
    }[] = [];
    let cursor: { ownerId: string; habitId: string; date: string } | undefined;
    for (;;) {
      const page = await db.habitOccurrence.findMany({
        where: {
          ownerId,
          date: { lte: end, ...(start ? { gte: start } : {}) },
        },
        orderBy: [{ date: "asc" }, { habitId: "asc" }],
        take: 1000,
        ...(cursor
          ? { cursor: { ownerId_habitId_date: cursor }, skip: 1 }
          : {}),
        select: {
          habitId: true,
          date: true,
          status: true,
          ...(start ? { note: true, definitionSha: true } : {}),
        },
      });
      result.push(...page);
      if (page.length < 1000) break;
      const last = page.at(-1)!;
      cursor = { ownerId, habitId: last.habitId, date: last.date };
    }
    return result;
  }
  async function slips(ownerId: string, start: string, end: string) {
    // UTC range is a superset of Halifax local dates, including DST; filter exactly afterwards.
    const result: {
      id: string;
      habitId: string;
      occurredAt: Date;
      outcome: string;
      trigger: string;
      note: string;
      definitionSha: string;
    }[] = [];
    let cursor: { ownerId: string; id: string } | undefined;
    for (;;) {
      const page = await db.habitSlip.findMany({
        where: {
          ownerId,
          occurredAt: {
            gte: new Date(`${start}T00:00:00Z`),
            lt: new Date(`${shiftHabitDate(end, 2)}T00:00:00Z`),
          },
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: 1000,
        ...(cursor ? { cursor: { ownerId_id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          habitId: true,
          occurredAt: true,
          outcome: true,
          trigger: true,
          note: true,
          definitionSha: true,
        },
      });
      result.push(
        ...page.filter((r) => {
          const date = localHabitDate(r.occurredAt);
          return date >= start && date <= end;
        }),
      );
      if (page.length < 1000) break;
      cursor = { ownerId, id: page.at(-1)!.id };
    }
    return result;
  }
  async function stats(ownerId: string) {
    const definition = await source.read(ownerId);
    if (!definition.projection || definition.stale)
      throw new HabitError(503, "Valid definitions unavailable.");
    const today = localHabitDate(now());
    return deriveHabitStats(
      definition.projection,
      await observations(ownerId, today),
      today,
    );
  }
  return {
    stats,
    async start(ownerId: string, date = localHabitDate(now())) {
      const week = habitWeek(date);
      const [definition, rows, events] = await Promise.all([
        source.read(ownerId),
        observations(ownerId, week.end),
        slips(ownerId, week.start, week.end),
      ]);
      if (!definition.projection || definition.stale)
        throw new HabitError(503, "Valid definitions unavailable.");
      const today = localHabitDate(now());
      const counts: Record<string, Record<string, number>> = Object.create(
        null,
      );
      for (const h of definition.projection.habits.filter(
        (h) => h.tracked && h.kind === "build",
      ))
        counts[h.id] = { done: 0, minimum: 0, skipped: 0, missed: 0, open: 0 };
      for (const r of rows.filter((r) => r.date >= week.start)) {
        const status =
          r.status === "open" && r.date < today ? "missed" : r.status;
        const count = (counts[r.habitId] ??= {
          done: 0,
          minimum: 0,
          skipped: 0,
          missed: 0,
          open: 0,
        });
        count[status] = (count[status] ?? 0) + 1;
      }
      const outcomes: Record<
        string,
        Record<string, Record<string, number>>
      > = Object.create(null);
      for (const event of events) {
        const triggers = (outcomes[event.habitId] ??= Object.create(null));
        const count = (triggers[event.trigger || "(unspecified)"] ??= {
          resisted: 0,
          slipped: 0,
        });
        count[event.outcome] = (count[event.outcome] ?? 0) + 1;
      }
      const frontmatter = {
        week,
        definitionSha: definition.sha,
        counts,
        urges: outcomes,
        gates: deriveHabitStats(
          definition.projection,
          rows,
          today < week.end ? today : week.end,
        ),
      };
      const path = `reviews/${week.end}.md`;
      await create(
        path,
        `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n# Weekly review ${week.end}\n\n${reviewHeadings.map((h) => `## ${h}\n\n`).join("")}`,
        undefined,
      );
      documents.invalidate(path);
      // A failed read before creation must not hide the new file.
      return { path };
    },
    async context(ownerId: string, days: 14 | 28 = 28) {
      const end = localHabitDate(now()),
        start = shiftHabitDate(end, 1 - days);
      const unavailable: string[] = [];
      const [system, playbook, raw, index, rows, events] = await Promise.all([
        documents.document("SYSTEM.md"),
        documents.document("playbook.md"),
        source.read(ownerId),
        documents.reviews(),
        observations(ownerId, end, start),
        slips(ownerId, start, end),
      ]);
      const paths = index.paths.slice(0, 4); // descending complete tree; first page contains the latest four
      const reviews = await Promise.all(
        paths.map((path) => documents.document(path)),
      );
      for (const doc of [system, playbook, ...reviews])
        if (doc.stale || doc.error) unavailable.push(doc.path);
      if (index.stale || index.error) unavailable.push("review index");
      if (raw.stale || raw.error) unavailable.push("Habit Catalog");
      return {
        unavailable,
        text: [
          `# Habit context ${start}–${end}`,
          unavailable.length
            ? `Unavailable inputs: ${unavailable.join(", ")}`
            : "",
          ...[system, playbook, ...reviews].map(
            (d) => `## ${d.path}\n\n${d.text}`,
          ),
          `## Habit Catalog\n\n${JSON.stringify({ projection: raw.projection, revision: raw.revision }, null, 2)}`,
          `## Occurrences\n\n${JSON.stringify(rows, null, 2)}`,
          `## Slips\n\n${JSON.stringify(events, null, 2)}`,
        ].join("\n\n"),
      };
    },
  };
}
export const habitReviewService = createHabitReviewService();
