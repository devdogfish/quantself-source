import { z } from "zod";
import { prisma } from "@quantself/db";
import { catalogSource } from "./habits-catalog";
import type { HabitDefinitions } from "./habits-source";
import { HabitError } from "./habits-service";
export const slipInputSchema = z
  .object({
    commandId: z.uuid(),
    habitId: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(100),
    occurredAt: z.iso.datetime({ offset: true }),
    outcome: z.enum(["resisted", "slipped"]),
    trigger: z.string().max(500).default(""),
    note: z.string().max(4000).default(""),
  })
  .strict();
export const slipSchema = slipInputSchema
  .omit({ commandId: true })
  .extend({ id: z.uuid(), definitionSha: z.string() });
export const deleteSlipSchema = z
  .object({ commandId: z.uuid(), id: z.uuid() })
  .strict();
export function validateSlipTime(value: string, now: Date) {
  if (Date.parse(value) > +now)
    throw new HabitError(400, "Urges cannot be recorded in the future.");
}
export function createSlipService(
  db = prisma,
  source: { read(ownerId: string): Promise<HabitDefinitions> } = catalogSource,
  now = () => new Date(),
) {
  async function command(
    ownerId: string,
    clientId: string,
    input: z.infer<typeof slipInputSchema> | z.infer<typeof deleteSlipSchema>,
    remove = false,
  ) {
    input = remove
      ? deleteSlipSchema.parse(input)
      : slipInputSchema.parse(input);
    const payload = JSON.stringify({
      operation: remove ? "delete-slip" : "create-slip",
      input,
    });
    const key = { ownerId, clientId, commandId: input.commandId };
    const replay = (r: { payload: string; result: unknown }) => {
      if (r.payload !== payload)
        throw new HabitError(409, "commandId already used.");
      return r.result as Record<string, unknown>;
    };
    const prior = await db.habitCommand.findUnique({
      where: { ownerId_clientId_commandId: key },
    });
    if (prior) return replay(prior);
    let sha = "";
    if (!remove) {
      const value = input as z.infer<typeof slipInputSchema>;
      validateSlipTime(value.occurredAt, now());
      const definitions = await source.read(ownerId);
      if (definitions.stale || !definitions.projection || !definitions.sha)
        throw new HabitError(
          503,
          "Refresh valid habit definitions before saving.",
        );
      if (
        !definitions.projection.habits.some(
          (h) => h.id === value.habitId && h.kind === "break",
        )
      )
        throw new HabitError(400, "Choose a break habit.");
      sha = definitions.sha;
    }
    for (let attempt = 0; ; attempt++)
      try {
        return await db.$transaction(
          async (tx) => {
            const receipt = await tx.habitCommand.findUnique({
              where: { ownerId_clientId_commandId: key },
            });
            if (receipt) return replay(receipt);
            let result: Record<string, string>;
            if (remove) {
              const { id } = input as z.infer<typeof deleteSlipSchema>;
              await tx.habitSlip.deleteMany({ where: { ownerId, id } });
              result = { id };
            } else {
              const { commandId, ...value } = input as z.infer<
                typeof slipInputSchema
              >;
              const row = await tx.habitSlip.create({
                data: {
                  ...value,
                  ownerId,
                  id: Bun.randomUUIDv7(),
                  definitionSha: sha,
                  occurredAt: new Date(value.occurredAt),
                },
              });
              result = {
                ...value,
                id: row.id,
                definitionSha: sha,
                occurredAt: row.occurredAt.toISOString(),
              };
            }
            await tx.habitCommand.create({
              data: { ...key, payload, result },
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
  return {
    command,
    async list(ownerId: string, before?: string) {
      const rows = await db.habitSlip.findMany({
        where: { ownerId, ...(before ? { id: { lt: before } } : {}) },
        orderBy: { id: "desc" },
        take: 51,
        select: {
          id: true,
          habitId: true,
          definitionSha: true,
          occurredAt: true,
          outcome: true,
          trigger: true,
          note: true,
        },
      });
      return {
        slips: rows
          .slice(0, 50)
          .map((r) =>
            slipSchema.parse({ ...r, occurredAt: r.occurredAt.toISOString() }),
          ),
        next: rows.length > 50 ? rows[49].id : null,
      };
    },
  };
}
export const slipService = createSlipService();
