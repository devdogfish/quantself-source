import { expect, test } from "bun:test";
import {
  applyChanges,
  importChanges,
  createHabitCatalog,
  habitChangeSchema,
  type HabitChange,
} from "./habits-catalog";
import { parseHabits } from "./habits-definition";
import { createHabitService } from "./habits-service";
import { prisma } from "@quantself/db";
const yaml = `version: 2
timezone: America/Halifax
stacks:
  - id: morning
    name: Morning
    cue: After waking
    anchor: '08:00'
    days: daily
habits:
  - id: move
    name: Move
    stack: morning
    tracked: true
    status: building
    minimum: Shoes on
    reward: Tea
`;
const base = parseHabits(yaml);
test("import preserves projection, including display-only details", () => {
  expect(
    applyChanges(
      {
        stacks: [],
        habits: [],
        gate: { window: 14, required: 10 },
        diagnostics: [],
      },
      importChanges(yaml),
    ),
  ).toEqual(base);
});
test("all change kinds and archive cascade leave input untouched", () => {
  const before = structuredClone(base);
  const changed = applyChanges(base, [
    { type: "setStatus", habitId: "move", status: "paused" },
    { type: "setGateDefaults", gate: { window: 7, required: 4 } },
  ]);
  expect(changed.habits[0].status).toBe("paused");
  expect(changed.gate.window).toBe(7);
  expect(
    applyChanges(changed, [{ type: "archive", target: "habit", id: "move" }])
      .habits,
  ).toEqual([]);
  expect(
    applyChanges(changed, [
      { type: "archive", target: "stack", id: "morning" },
    ]),
  ).toMatchObject({ stacks: [], habits: [] });
  expect(base).toEqual(before);
});
for (const changes of [
  [{ type: "setStatus", habitId: "absent", status: "paused" }],
  [{ type: "archive", target: "habit", id: "absent" }],
  [
    {
      type: "upsertStack",
      id: "morning",
      name: "Morning",
      anchor: "25:00",
      days: "daily",
    },
  ],
  [{ type: "upsertHabit", id: "x", name: "X", stack: "absent", details: {} }],
  [
    { type: "upsertStack", id: "x", name: "X", days: "daily" },
    { type: "upsertStack", id: "x", name: "X", days: "daily" },
  ],
  [
    {
      type: "upsertHabit",
      id: "move",
      name: "Move",
      stack: "morning",
      order: 0,
      kind: "build",
      tracked: true,
      status: "building",
      details: { status: "paused" },
    },
  ],
]) {
  test(`rejects invalid ${changes[0].type} command atomically`, () => {
    const snapshot = structuredClone(base);
    expect(() =>
      applyChanges(base, [
        { type: "setGateDefaults", gate: { window: 7, required: 4 } },
        ...(changes as HabitChange[]),
      ]),
    ).toThrow();
    expect(base).toEqual(snapshot);
  });
}
test("definition replacements require explicit values for fields with YAML defaults", () => {
  expect(
    habitChangeSchema.safeParse({
      type: "upsertStack",
      id: "morning",
      name: "Morning",
    }).success,
  ).toBe(false);
  expect(
    habitChangeSchema.safeParse({ type: "setStatus", habitId: "move" }).success,
  ).toBe(false);
  const habit = importChanges(yaml).find(
    (change) => change.type === "upsertHabit",
  )!;
  for (const field of [
    "order",
    "kind",
    "tracked",
    "status",
    "details",
  ] as const) {
    expect(
      habitChangeSchema.safeParse({ ...habit, [field]: undefined }).success,
    ).toBe(false);
  }
});

test("reading one revision and applying a bulk change use a constant number of database operations", async () => {
  for (const count of [1, 100]) {
    const queries: string[] = [];
    let stored: unknown;
    const db = {
      habitDefinitionRevision: {
        findUnique: async () => {
          queries.push("receipt");
          return null;
        },
        findFirst: async () => {
          queries.push("current");
          return stored ? { result: stored } : null;
        },
        create: async ({ data }: { data: { result: unknown } }) => {
          queries.push("revision");
          stored = data.result;
        },
      },
      $executeRaw: async () => {
        queries.push("bulk upsert");
      },
      habitStack: {
        updateMany: async () => {
          queries.push("archive stacks");
        },
      },
      habitDefinition: {
        updateMany: async () => {
          queries.push("archive habits");
        },
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    const catalog = createHabitCatalog(db as unknown as typeof prisma);
    const fixture = importChanges(yaml);
    const habit = fixture.find((change) => change.type === "upsertHabit")!;
    const start = performance.now();
    const result = await catalog.apply("owner", {
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      reason: "Bulk import",
      changes: [
        ...fixture.filter((change) => change.type !== "upsertHabit"),
        ...Array.from({ length: count }, (_, index) => ({
          ...habit,
          id: `move-${index}`,
        })),
      ],
    });
    const applyMs = performance.now() - start;
    expect(result.projection.habits).toHaveLength(count);
    expect(queries).toEqual([
      "receipt",
      "current",
      "bulk upsert",
      "bulk upsert",
      "archive stacks",
      "archive habits",
      "revision",
    ]);
    queries.length = 0;
    const readStart = performance.now();
    expect(await catalog.current("owner")).toEqual(result);
    const readMs = performance.now() - readStart;
    expect(queries).toEqual(["current"]);
    console.info(
      `Catalog fixture ${count} habits: apply ${applyMs.toFixed(2)}ms / 7 operations, warm read ${readMs.toFixed(2)}ms / 1 operation (mock database).`,
    );
  }
});
const dbTest =
  process.env.QUANTSELF_NOTIFICATION_DB_TEST === "1" ? test : test.skip;
dbTest(
  "catalog transactions: import, replay, conflicts, revision sequence, archive, tenant isolation",
  async () => {
    const ownerId = `catalog-test-${crypto.randomUUID()}`;
    const catalog = createHabitCatalog(prisma);
    try {
      expect((await catalog.current(ownerId)).revision).toBe(0);
      const command = {
        commandId: crypto.randomUUID(),
        expectedRevision: 0,
        reason: "Imported from habits.yaml",
        changes: importChanges(yaml),
      };
      const first = await catalog.apply(ownerId, command, "test key");
      expect(first).toEqual({ projection: base, revision: 1 });
      expect(await catalog.apply(ownerId, command)).toEqual(first);
      await expect(
        catalog.apply(ownerId, { ...command, reason: "Different" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        catalog.apply(ownerId, { ...command, commandId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ status: 409 });
      const second = await catalog.apply(ownerId, {
        commandId: crypto.randomUUID(),
        expectedRevision: 1,
        reason: "Pause",
        changes: [{ type: "setStatus", habitId: "move", status: "paused" }],
      });
      expect(second.revision).toBe(2);
      expect(await catalog.apply(ownerId, command)).toEqual(first);
      expect(await catalog.current(ownerId)).toEqual(second);
      expect(await catalog.current(ownerId + "other")).toMatchObject({
        revision: 0,
      });
      const history = await catalog.history(ownerId, { limit: 1 });
      expect(history[0].revision).toBe(2);
      expect(
        (await catalog.history(ownerId, { before: 2, limit: 5 }))[0],
      ).toMatchObject({ revision: 1, actor: "test key" });
      expect(
        await catalog.currentMany([ownerId, ownerId + "other", ownerId]),
      ).toEqual(new Map([[ownerId, second]]));
      await catalog.apply(ownerId, {
        commandId: crypto.randomUUID(),
        expectedRevision: 2,
        reason: "Archive",
        changes: [{ type: "archive", target: "stack", id: "morning" }],
      });
      expect(
        (
          await prisma.habitDefinition.findUniqueOrThrow({
            where: { ownerId_id: { ownerId, id: "move" } },
          })
        ).archivedAt,
      ).not.toBeNull();
      expect(
        (
          await prisma.habitStack.findUniqueOrThrow({
            where: { ownerId_id: { ownerId, id: "morning" } },
          })
        ).archivedAt,
      ).not.toBeNull();
      expect(
        await prisma.habitDefinitionRevision.count({ where: { ownerId } }),
      ).toBe(3);
    } finally {
      await prisma.habitDefinitionRevision.deleteMany({ where: { ownerId } });
      await prisma.habitDefinition.deleteMany({ where: { ownerId } });
      await prisma.habitStack.deleteMany({ where: { ownerId } });
    }
  },
);

dbTest(
  "concurrent identical commands replay and competing commands conflict without partial changes",
  async () => {
    const ownerId = `catalog-test-${crypto.randomUUID()}`;
    const catalog = createHabitCatalog(prisma);
    try {
      const importCommand = {
        commandId: crypto.randomUUID(),
        expectedRevision: 0,
        reason: "Imported from habits.yaml",
        changes: importChanges(yaml),
      };
      const [first, replay] = await Promise.all([
        catalog.apply(ownerId, importCommand),
        catalog.apply(ownerId, importCommand),
      ]);
      expect(first).toEqual({ projection: base, revision: 1 });
      expect(replay).toEqual(first);

      const results = await Promise.allSettled(
        (["paused", "established"] as const).map((status) =>
          catalog.apply(ownerId, {
            commandId: crypto.randomUUID(),
            expectedRevision: 1,
            reason: status,
            changes: [{ type: "setStatus", habitId: "move", status }],
          }),
        ),
      );
      const winners = results.filter((result) => result.status === "fulfilled");
      const conflicts = results.filter(
        (result) => result.status === "rejected",
      );
      expect(winners).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].reason).toMatchObject({ status: 409 });
      expect(await catalog.current(ownerId)).toEqual(winners[0].value);
      const stored = await prisma.habitDefinition.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: "move" } },
      });
      expect(stored.definition).toMatchObject({
        status: winners[0].value.projection.habits[0].status,
      });
      expect(
        (await catalog.history(ownerId, { limit: 5 })).map(
          (entry) => entry.revision,
        ),
      ).toEqual([2, 1]);
    } finally {
      await prisma.habitDefinitionRevision.deleteMany({ where: { ownerId } });
      await prisma.habitDefinition.deleteMany({ where: { ownerId } });
      await prisma.habitStack.deleteMany({ where: { ownerId } });
    }
  },
);

dbTest(
  "materialized and explicitly logged occurrences preserve their catalog revision",
  async () => {
    const ownerId = `catalog-occurrence-test-${crypto.randomUUID()}`;
    const catalog = createHabitCatalog(prisma);
    const service = createHabitService(
      prisma,
      {
        async read(id) {
          const { projection, revision } = await catalog.current(id);
          return {
            projection,
            revision,
            sha: `catalog:${revision}`,
            stale: false,
            error: null,
          };
        },
      },
      () => new Date("2026-11-07T15:00:00Z"),
    );
    try {
      await catalog.apply(ownerId, {
        commandId: crypto.randomUUID(),
        expectedRevision: 0,
        reason: "Imported from habits.yaml",
        changes: importChanges(yaml),
      });
      await service.materialize(ownerId);
      await catalog.apply(ownerId, {
        commandId: crypto.randomUUID(),
        expectedRevision: 1,
        reason: "Established practice",
        changes: [
          { type: "setStatus", habitId: "move", status: "established" },
        ],
      });
      await service.materialize(ownerId);
      await service.command(ownerId, "test key", {
        commandId: crypto.randomUUID(),
        date: "2026-11-06",
        habitId: "move",
        revision: 0,
        before: { status: "open", note: "" },
        after: { status: "done", note: "" },
      });
      const rows = await prisma.habitOccurrence.findMany({
        where: { ownerId },
        orderBy: { date: "asc" },
        select: { date: true, definitionRevision: true },
      });
      expect(rows).toEqual([
        { date: "2026-11-06", definitionRevision: 2 },
        { date: "2026-11-07", definitionRevision: 1 },
      ]);
    } finally {
      await prisma.habitCommand.deleteMany({ where: { ownerId } });
      await prisma.habitOccurrence.deleteMany({ where: { ownerId } });
      await prisma.habitDefinitionRevision.deleteMany({ where: { ownerId } });
      await prisma.habitDefinition.deleteMany({ where: { ownerId } });
      await prisma.habitStack.deleteMany({ where: { ownerId } });
    }
  },
);
