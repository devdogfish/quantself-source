import { prisma } from "@quantself/db";
import { z } from "zod";
import {
  gateDefaultsSchema,
  habitSchema,
  stackSchema,
  parseHabits,
  type HabitProjection,
} from "./habits-definition";

export class HabitCatalogError extends Error {
  constructor(
    public status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
const details = z
  .record(z.string(), z.string())
  .describe(
    "Display-only text fields such as cue, minimum, full, identity, fallback, environment, replacement and reward. Include all existing details when replacing a habit.",
  );
const habitFields = Object.keys(habitSchema.shape);
export const habitChangeSchema = z.discriminatedUnion("type", [
  stackSchema
    .extend({
      type: z.literal("upsertStack"),
      days: stackSchema.shape.days.unwrap(),
    })
    .strict(),
  habitSchema
    .extend({
      type: z.literal("upsertHabit"),
      order: habitSchema.shape.order.unwrap(),
      kind: habitSchema.shape.kind.unwrap(),
      tracked: habitSchema.shape.tracked.unwrap(),
      status: habitSchema.shape.status.unwrap(),
      details,
    })
    .strict(),
  z
    .object({
      type: z.literal("setStatus"),
      habitId: habitSchema.shape.id,
      status: habitSchema.shape.status.unwrap(),
    })
    .strict(),
  z
    .object({
      type: z.literal("archive"),
      target: z.enum(["stack", "habit"]),
      id: habitSchema.shape.id,
    })
    .strict(),
  z
    .object({ type: z.literal("setGateDefaults"), gate: gateDefaultsSchema })
    .strict(),
]);
export type HabitChange = z.infer<typeof habitChangeSchema>;
export const catalogCommandSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(4000),
    changes: z
      .array(habitChangeSchema)
      .min(1)
      .max(1000)
      .describe(
        "Atomic ordered changes. Upserts replace the complete definition: read current, preserve structural fields and display details, then change intended fields. Omitted optional fields are cleared. Archiving a stack also archives its habits.",
      ),
  })
  .strict();
export const projectionSchema = z.object({
  stacks: z.array(stackSchema),
  habits: z.array(habitSchema),
  gate: gateDefaultsSchema,
  diagnostics: z.array(z.string()),
});
export const catalogResultSchema = z.object({
  projection: projectionSchema,
  revision: z.number().int(),
});
export const revisionEntrySchema = z.object({
  revision: z.number().int(),
  at: z.string(),
  reason: z.string(),
  changes: z.array(habitChangeSchema),
  actor: z.string(),
});
const empty = (): HabitProjection => ({
  stacks: [],
  habits: [],
  gate: { window: 14, required: 10 },
  diagnostics: [],
});

/** All validation happens on a copy; callers never observe half a command. */
export function applyChanges(
  projection: HabitProjection,
  input: HabitChange[],
): HabitProjection {
  const parsed = z.array(habitChangeSchema).safeParse(input);
  if (!parsed.success) throw new HabitCatalogError(400, parsed.error.message);
  const next = structuredClone(projection);
  const upserts = new Set<string>();
  for (const change of parsed.data) {
    if (change.type === "upsertStack" || change.type === "upsertHabit") {
      const key = `${change.type}:${change.id}`;
      if (upserts.has(key))
        throw new HabitCatalogError(400, `Duplicate id: ${change.id}.`);
      upserts.add(key);
    }
    switch (change.type) {
      case "upsertStack": {
        const { type, ...value } = change;
        const index = next.stacks.findIndex((s) => s.id === value.id);
        if (index < 0) next.stacks.push(value);
        else next.stacks[index] = value;
        break;
      }
      case "upsertHabit": {
        const { type, details: display, ...value } = change;
        if (
          Object.keys(display).some(
            (key) =>
              habitFields.includes(key) ||
              key === "details" ||
              ["__proto__", "constructor", "prototype"].includes(key),
          )
        )
          throw new HabitCatalogError(
            400,
            "Display details cannot replace structural fields.",
          );
        const habit = { ...display, ...value };
        const index = next.habits.findIndex((h) => h.id === value.id);
        if (index < 0) next.habits.push(habit);
        else next.habits[index] = habit;
        break;
      }
      case "setStatus": {
        const habit = next.habits.find((h) => h.id === change.habitId);
        if (!habit)
          throw new HabitCatalogError(400, `Unknown habit: ${change.habitId}.`);
        habit.status = change.status;
        break;
      }
      case "archive": {
        const collection =
          change.target === "stack" ? next.stacks : next.habits;
        if (!collection.some((row) => row.id === change.id))
          throw new HabitCatalogError(
            400,
            `Unknown ${change.target}: ${change.id}.`,
          );
        if (change.target === "stack") {
          next.stacks = next.stacks.filter((s) => s.id !== change.id);
          next.habits = next.habits.filter((h) => h.stack !== change.id);
        } else next.habits = next.habits.filter((h) => h.id !== change.id);
        break;
      }
      case "setGateDefaults":
        next.gate = change.gate;
        break;
    }
  }
  for (const habit of next.habits)
    if (!next.stacks.some((s) => s.id === habit.stack))
      throw new HabitCatalogError(
        400,
        `${habit.id}: unknown stack ${habit.stack}.`,
      );
  next.habits.sort((a, b) => a.order - b.order);
  next.diagnostics = [];
  return next;
}
export function importChanges(text: string): HabitChange[] {
  const projection = parseHabits(text);
  if (projection.diagnostics.length)
    throw new HabitCatalogError(400, projection.diagnostics.join("\n"));
  return [
    { type: "setGateDefaults", gate: projection.gate },
    ...projection.stacks.map((stack) => ({
      ...stack,
      type: "upsertStack" as const,
    })),
    ...projection.habits.map((habit) => {
      const structural = Object.fromEntries(
        Object.entries(habit).filter(([key]) => habitFields.includes(key)),
      );
      const display = Object.fromEntries(
        Object.entries(habit).filter(([key]) => !habitFields.includes(key)),
      );
      return habitChangeSchema.parse({
        ...structural,
        type: "upsertHabit",
        details: display,
      });
    }),
  ];
}
// Stable JSON also makes reordered display fields safe to retry.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function readHabitCatalog(ownerId: string, db: Pick<typeof prisma, "habitDefinitionRevision"> = prisma) {
  const last = await db.habitDefinitionRevision.findFirst({
    where: { ownerId },
    orderBy: { revision: "desc" },
    select: { result: true },
  });
  return last
    ? catalogResultSchema.parse(last.result)
    : { projection: empty(), revision: 0 };
}

export function createHabitCatalog(db = prisma) {
  const current = (ownerId: string) => readHabitCatalog(ownerId, db);
  return {
    current,
    async currentMany(ownerIds: string[]) {
      const rows = await db.$queryRaw<
        { ownerId: string; result: unknown }[]
      >`SELECT owners."ownerId", latest.result FROM jsonb_array_elements_text(${JSON.stringify(ownerIds)}::jsonb) AS owners("ownerId") CROSS JOIN LATERAL (SELECT result FROM habit_definition_revision WHERE "ownerId" = owners."ownerId" ORDER BY revision DESC LIMIT 1) latest`;
      return new Map(
        rows.map((row) => [row.ownerId, catalogResultSchema.parse(row.result)]),
      );
    },
    async history(
      ownerId: string,
      { before, limit }: { before?: number; limit: number },
    ) {
      const rows = await db.habitDefinitionRevision.findMany({
        where: { ownerId, ...(before ? { revision: { lt: before } } : {}) },
        orderBy: { revision: "desc" },
        take: Math.min(100, Math.max(1, limit)),
        select: {
          revision: true,
          createdAt: true,
          reason: true,
          changes: true,
          actor: true,
        },
      });
      return rows.map((row) =>
        revisionEntrySchema.parse({ ...row, at: row.createdAt.toISOString() }),
      );
    },
    async apply(
      ownerId: string,
      input: z.input<typeof catalogCommandSchema>,
      actor = "Owner Session",
    ) {
      const parsed = catalogCommandSchema.safeParse(input);
      if (!parsed.success)
        throw new HabitCatalogError(400, parsed.error.message);
      const command = parsed.data,
        payload = canonical(command);
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction(
            async (tx) => {
              const prior = await tx.habitDefinitionRevision.findUnique({
                where: {
                  ownerId_commandId: { ownerId, commandId: command.commandId },
                },
              });
              if (prior) {
                if (prior.payload !== payload)
                  throw new HabitCatalogError(
                    409,
                    "commandId already used with a different change.",
                  );
                return catalogResultSchema.parse(prior.result);
              }
              const last = await tx.habitDefinitionRevision.findFirst({
                where: { ownerId },
                orderBy: { revision: "desc" },
                select: { result: true },
              });
              const previous = last
                ? catalogResultSchema.parse(last.result)
                : { projection: empty(), revision: 0 };
              if (previous.revision !== command.expectedRevision)
                throw new HabitCatalogError(
                  409,
                  "Habit catalog changed. Read it again before saving.",
                );
              const projection = applyChanges(
                previous.projection,
                command.changes,
              );
              const result = { projection, revision: previous.revision + 1 };
              // Two bulk upserts, independent of the number of definitions. Archived identities remain.
              const stacks = JSON.stringify(
                projection.stacks.map((s) => ({ id: s.id, definition: s })),
              );
              const habits = JSON.stringify(
                projection.habits.map((h) => ({
                  id: h.id,
                  definition: Object.fromEntries(
                    Object.entries(h).filter(([k]) => habitFields.includes(k)),
                  ),
                  details: Object.fromEntries(
                    Object.entries(h).filter(([k]) => !habitFields.includes(k)),
                  ),
                })),
              );
              await tx.$executeRaw`INSERT INTO habit_stack ("ownerId", id, definition) SELECT ${ownerId}, id, definition FROM jsonb_to_recordset(${stacks}::jsonb) AS x(id text, definition jsonb) ON CONFLICT ("ownerId", id) DO UPDATE SET definition=EXCLUDED.definition, "archivedAt"=NULL`;
              await tx.$executeRaw`INSERT INTO habit_definition ("ownerId", id, definition, details) SELECT ${ownerId}, id, definition, details FROM jsonb_to_recordset(${habits}::jsonb) AS x(id text, definition jsonb, details jsonb) ON CONFLICT ("ownerId", id) DO UPDATE SET definition=EXCLUDED.definition, details=EXCLUDED.details, "archivedAt"=NULL`;
              await tx.habitStack.updateMany({
                where: {
                  ownerId,
                  archivedAt: null,
                  id: { notIn: projection.stacks.map((s) => s.id) },
                },
                data: { archivedAt: new Date() },
              });
              await tx.habitDefinition.updateMany({
                where: {
                  ownerId,
                  archivedAt: null,
                  id: { notIn: projection.habits.map((h) => h.id) },
                },
                data: { archivedAt: new Date() },
              });
              await tx.habitDefinitionRevision.create({
                data: {
                  ownerId,
                  revision: result.revision,
                  commandId: command.commandId,
                  payload,
                  reason: command.reason,
                  changes: JSON.parse(JSON.stringify(command.changes)),
                  actor,
                  result: JSON.parse(JSON.stringify(result)),
                },
              });
              return result;
            },
            { isolationLevel: "Serializable" },
          );
        } catch (error) {
          const { code, meta } = (error ?? {}) as {
            code?: string;
            meta?: {
              code?: string;
              driverAdapterError?: { cause?: { kind?: string } };
            };
          };
          const retryable =
            code === "P2034" ||
            code === "P2002" ||
            (code === "P2010" &&
              (meta?.code === "40001" ||
                meta?.code === "40P01" ||
                meta?.driverAdapterError?.cause?.kind ===
                  "TransactionWriteConflict"));
          if (attempt < 2 && retryable) continue;
          throw error;
        }
      }
    },
  };
}
export const habitCatalog = createHabitCatalog();
export const catalogSource = {
  async read(ownerId: string) {
    const { projection, revision } = await habitCatalog.current(ownerId);
    return {
      projection,
      revision,
      sha: `catalog:${revision}`,
      stale: false,
      error: null,
    };
  },
};
