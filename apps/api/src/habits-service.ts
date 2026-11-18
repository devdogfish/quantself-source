import { createTaskDrain } from "./task-drain";
import { prisma } from "@quantself/db";
import { z } from "zod";
import { eligible, habitDate, localHabitDate } from "./habits-definition";
import { catalogSource } from "./habits-catalog";
import type { HabitDefinitions } from "./habits-source";
export const occurrenceSchema = z.object({
  habitId: z.string(),
  date: habitDate,
  definitionSha: z.string(),
  definitionRevision: z.number().int().nullable().optional(),
  status: z.enum(["open", "done", "minimum", "skipped"]),
  note: z.string(),
  revision: z.number().int(),
  missed: z.boolean(),
});
export const commandSchema = z
  .object({
    commandId: z.uuid(),
    habitId: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(100),
    date: habitDate,
    revision: z.number().int().nonnegative(),
    before: z
      .object({
        status: occurrenceSchema.shape.status,
        note: z.string().max(4000),
      })
      .strict(),
    after: z
      .object({
        status: occurrenceSchema.shape.status,
        note: z.string().max(4000),
      })
      .strict(),
  })
  .strict();
export type HabitCommand = z.infer<typeof commandSchema>;
export class HabitError extends Error {
  constructor(
    public status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export function validateHabitCommand(command: HabitCommand, today: string) {
  if (
    command.after.status === "skipped" &&
    command.before.status !== "skipped" &&
    command.date < today
  )
    throw new HabitError(
      400,
      "Skips must be declared on or before the habit day.",
    );
  if (
    command.date > today &&
    command.after.status !== "skipped" &&
    !(command.before.status === "skipped" && command.after.status === "open")
  )
    throw new HabitError(
      400,
      "Only explicit skips may be recorded for future days.",
    );
}
export function createHabitService(
  db = prisma,
  source: { read(ownerId: string): Promise<HabitDefinitions> } = catalogSource,
  now = () => new Date(),
) {
  const serialize = (r: {
    habitId: string;
    date: string;
    definitionSha: string;
    definitionRevision?: number | null;
    status: string;
    note: string;
    revision: number;
  }) => ({
    habitId: r.habitId,
    date: r.date,
    definitionSha: r.definitionSha,
    definitionRevision: r.definitionRevision ?? null,
    status: r.status as z.infer<typeof occurrenceSchema>["status"],
    note: r.note,
    revision: r.revision,
    missed: r.status === "open" && r.date < localHabitDate(now()),
  });
  async function materialize(ownerId: string) {
    const definition = await source.read(ownerId);
    if (!definition.stale && definition.projection && definition.sha) {
      const date = localHabitDate(now());
      const rows = eligible(definition.projection, date).map((h) => ({
        ownerId,
        habitId: h.id,
        date,
        definitionSha: definition.sha!,
        definitionRevision: definition.revision ?? null,
      }));
      if (rows.length)
        await db.habitOccurrence.createMany({
          data: rows,
          skipDuplicates: true,
        });
    }
    return definition;
  }
  return {
    materialize,
    async read(ownerId: string, date: string) {
      const definition = await materialize(ownerId);
      const rows = await db.habitOccurrence.findMany({
        where: { ownerId, date },
        orderBy: { habitId: "asc" },
        select: {
          habitId: true,
          date: true,
          definitionSha: true,
          definitionRevision: true,
          status: true,
          note: true,
          revision: true,
        },
      });
      return {
        date,
        today: localHabitDate(now()),
        ...definition,
        occurrences: rows.map(serialize),
      };
    },
    async command(ownerId: string, clientId: string, command: HabitCommand) {
      const receiptKey = { ownerId, clientId, commandId: command.commandId };
      // Canonical schema order, independent of incoming JSON property order.
      const payload = JSON.stringify(commandSchema.parse(command));
      const replay = (receipt: { payload: string; result: unknown }) => {
        if (receipt.payload !== payload)
          throw new HabitError(
            409,
            "commandId already used with a different command.",
          );
        return occurrenceSchema.parse(receipt.result);
      };
      const prior = await db.habitCommand.findUnique({
        where: { ownerId_clientId_commandId: receiptKey },
      });
      if (prior) return replay(prior);
      validateHabitCommand(command, localHabitDate(now()));
      const definition = await source.read(ownerId);
      if (!definition.projection || definition.stale || !definition.sha)
        throw new HabitError(
          503,
          "Refresh valid habit definitions before saving.",
        );
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction(
            async (tx) => {
              const receipt = await tx.habitCommand.findUnique({
                where: { ownerId_clientId_commandId: receiptKey },
              });
              if (receipt) return replay(receipt);
              validateHabitCommand(command, localHabitDate(now()));
              const key = {
                ownerId,
                habitId: command.habitId,
                date: command.date,
              };
              let row = await tx.habitOccurrence.findUnique({
                where: { ownerId_habitId_date: key },
              });
              if (!row) {
                if (
                  !eligible(definition.projection!, command.date).some(
                    (h) => h.id === command.habitId,
                  )
                )
                  throw new HabitError(
                    400,
                    "Habit is not eligible on this date.",
                  );
                if (
                  command.date > localHabitDate(now()) &&
                  command.after.status !== "skipped"
                )
                  throw new HabitError(
                    400,
                    "Only explicit future skips create occurrences.",
                  );
                row = await tx.habitOccurrence.create({
                  data: {
                    ...key,
                    definitionSha: definition.sha!,
                    definitionRevision: definition.revision ?? null,
                  },
                });
              }
              if (
                row.revision !== command.revision ||
                row.status !== command.before.status ||
                row.note !== command.before.note
              )
                throw new HabitError(
                  409,
                  "Occurrence changed. Refresh and review before saving.",
                );
              const updated = await tx.habitOccurrence.updateMany({
                where: { ...key, revision: command.revision },
                data: { ...command.after, revision: { increment: 1 } },
              });
              if (updated.count !== 1)
                throw new HabitError(409, "Occurrence changed.");
              const result = serialize({
                ...row,
                ...command.after,
                revision: row.revision + 1,
              });
              await tx.habitCommand.create({
                data: { ...receiptKey, payload, result },
              });
              return result;
            },
            { isolationLevel: "Serializable" },
          );
        } catch (e) {
          if (
            attempt < 2 &&
            ["P2034", "P2002"].includes((e as { code?: string }).code ?? "")
          )
            continue;
          throw e;
        }
      }
    },
  };
}
export const habitService = createHabitService();
export function startHabitWorker(service = habitService, db = prisma) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const owners = await db.authOwner.findMany({ select: { userId: true } });
      for (const owner of owners) await service.materialize(owner.userId);
    } catch {
      console.error(
        "Habit daily materialization unavailable; retrying next tick.",
      );
    } finally {
      running = false;
    }
  };
  const drain = createTaskDrain();
  const run = () => void drain.run(tick);
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return () => { clearInterval(timer); return drain.stop(); };
}
