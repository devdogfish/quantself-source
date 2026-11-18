import { expect, test } from "bun:test";
import { createHabitReviewService, reviewHeadings } from "./habits-review";
import { parseHabits } from "./habits-definition";
import { createHabitDocuments } from "./habits-documents";
const projection = parseHabits(`stacks: [{id: routine, name: Routine}]
habits: [{id: stretch, name: Stretch, stack: routine, tracked: true, status: testing}]`);
const definition = { projection, sha: "a", stale: false, error: null };
test("weekly frontmatter counts source facts, Halifax urges/triggers, Gate and fixed prompts", async () => {
  const rows = [
    { habitId: "stretch", date: "2026-11-01", status: "done" },
    { habitId: "stretch", date: "2026-11-02", status: "open" },
    { habitId: "stretch", date: "2026-11-03", status: "minimum" },
    { habitId: "stretch", date: "2026-11-04", status: "skipped" },
  ];
  let text = "";
  const db = {
    habitOccurrence: { findMany: async () => rows },
    habitSlip: {
      findMany: async () => [
        {
          habitId: "pause",
          occurredAt: new Date("2026-11-02T03:59:00Z"),
          outcome: "slipped",
          trigger: "outside",
        },
        {
          habitId: "pause",
          occurredAt: new Date("2026-11-02T04:00:00Z"),
          outcome: "resisted",
          trigger: "__proto__",
        },
      ],
    },
  };
  const service = createHabitReviewService(
    db as any,
    { read: async () => definition },
    createHabitDocuments(),
    async (path, body) => {
      expect(path).toBe("reviews/2026-11-08.md");
      text = body;
    },
    () => new Date("2026-11-05T12:00:00Z"),
  );
  await service.start("owner", "2026-11-04");
  const front = JSON.parse(text.split("---")[1]!);
  expect(front.counts.stretch).toEqual({
    done: 0,
    minimum: 1,
    skipped: 1,
    missed: 1,
    open: 0,
  });
  expect(front.urges).toEqual({
    pause: JSON.parse('{"__proto__":{"resisted":1,"slipped":0}}'),
  });
  expect(front.gates[0].totalReps).toBe(2);
  for (const heading of reviewHeadings) expect(text).toContain(`## ${heading}`);
});
test("export pages beyond 1000 facts, keeps only 28 local days, latest four reviews, and flags unavailable inputs", async () => {
  const calls: any[] = [];
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    habitId: `h${i}`,
    date: "2026-11-04",
    status: "done",
    note: "",
  }));
  const events = Array.from({ length: 1000 }, (_, i) => ({
    id: `s${i}`,
    habitId: "pause",
    occurredAt: new Date("2026-11-04T12:00:00Z"),
    outcome: "resisted",
    trigger: "waiting",
  }));
  const db = {
    habitOccurrence: {
      findMany: async (q: any) => {
        calls.push(q);
        return q.cursor
          ? [{ habitId: "last", date: "2026-11-04", status: "minimum" }]
          : rows;
      },
    },
    habitSlip: {
      findMany: async (q: any) =>
        q.cursor
          ? [
              {
                id: "last-slip",
                habitId: "pause",
                occurredAt: new Date("2026-11-04T12:00:00Z"),
                outcome: "slipped",
              },
            ]
          : events,
    },
  };
  const paths = Array.from(
    { length: 45 },
    (_, i) => `reviews/2026-10-${String(31 - i).padStart(2, "0")}.md`,
  );
  let requests = 0;
  const docs = createHabitDocuments(async (_sha, path, tree) => {
    requests++;
    if (path === "playbook.md") throw Error();
    return {
      sha: "a",
      text: tree
        ? JSON.stringify(paths)
        : path === "habits.yaml"
          ? "habits: []\nextra: retained"
          : `Answers ${path}`,
    };
  });
  const service = createHabitReviewService(
    db as any,
    { read: async () => definition },
    docs,
    async () => {},
    () => new Date("2026-11-04T12:00:00Z"),
  );
  const start = performance.now();
  const exported = await service.context("owner");
  expect(exported.text).toContain('"habitId": "last"');
  expect(exported.text).toContain('"id": "last-slip"');
  expect(exported.text).toContain("## Habit Catalog");
  expect(exported.text).toContain(paths[3]!);
  expect(exported.text).not.toContain(paths[4]!);
  expect(exported.unavailable).toEqual(["playbook.md"]);
  expect(calls[0].where.date).toEqual({ gte: "2026-10-08", lte: "2026-11-04" });
  expect(requests).toBe(7); // two rules + bulk index + four bodies, independent of fact count
  console.info(
    `Export fixture cold: 7 document requests (catalog is local); 4 DB pages for 2002 facts; ${(performance.now() - start).toFixed(2)}ms`,
  );
  const warmStart = performance.now();
  await service.context("owner");
  expect(requests).toBe(7);
  console.info(
    `Export fixture warm: 0 document requests; 4 DB pages; ${(performance.now() - warmStart).toFixed(2)}ms`,
  );
  await service.context("owner", 14);
  expect(calls.at(-1).where.date).toEqual({ gte: "2026-10-22", lte: "2026-11-04" });
  expect(requests).toBe(7);
});
