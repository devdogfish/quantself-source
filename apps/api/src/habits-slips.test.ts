import { expect, test } from "bun:test";
import { slipInputSchema, validateSlipTime } from "./habits-slips";
test("urge requires an offset timestamp, rejects impossible and future moments", () => {
  const input = {
    commandId: crypto.randomUUID(),
    habitId: "pause",
    occurredAt: "2026-11-04T12:00:00Z",
    outcome: "resisted",
    trigger: "waiting",
    note: "",
  };
  expect(slipInputSchema.safeParse(input).success).toBe(true);
  for (const occurredAt of [
    "2026-02-30T12:00:00Z",
    "2026-11-04T12:00:00",
    "bad",
  ])
    expect(slipInputSchema.safeParse({ ...input, occurredAt }).success).toBe(
      false,
    );
  expect(() =>
    validateSlipTime(input.occurredAt, new Date("2026-11-04T11:00:00Z")),
  ).toThrow();
});
import { createSlipService } from "./habits-slips";
import { parseHabits } from "./habits-definition";
test("append is durable and scoped; replay after deletion cannot resurrect; build habits rejected", async () => {
  const receipts = new Map<string, any>(),
    rows = new Map<string, any>();
  const key = (k: any) => JSON.stringify(k);
  const db: any = {
    habitCommand: {
      findUnique: async ({ where }: any) =>
        receipts.get(key(where.ownerId_clientId_commandId)),
      create: async ({ data }: any) => {
        receipts.set(
          key({
            ownerId: data.ownerId,
            clientId: data.clientId,
            commandId: data.commandId,
          }),
          data,
        );
      },
    },
    habitSlip: {
      create: async ({ data }: any) => {
        rows.set(data.id, data);
        return data;
      },
      deleteMany: async ({ where }: any) => {
        if (rows.get(where.id)?.ownerId === where.ownerId)
          rows.delete(where.id);
      },
    },
    $transaction: async (fn: any) => fn(db),
  };
  const projection = parseHabits(
    "stacks: [{id: routine, name: Routine}]\nhabits: [{id: pause, name: Pause, kind: break, stack: routine}, {id: stretch, name: Stretch, stack: routine}]",
  );
  const source = {
    read: async () => ({ projection, sha: "abc", stale: false, error: null }),
  };
  const service = createSlipService(
    db,
    source,
    () => new Date("2026-11-04T15:00:00Z"),
  );
  const input = slipInputSchema.parse({
    commandId: crypto.randomUUID(),
    habitId: "pause",
    occurredAt: "2026-11-04T12:00:00Z",
    outcome: "slipped",
    trigger: "free text",
  });
  const first = await service.command("owner", "client", input);
  expect(await service.command("owner", "client", input)).toEqual(first);
  expect(rows.size).toBe(1);
  await expect(
    service.command("owner", "client", { ...input, note: "changed" }),
  ).rejects.toThrow("commandId");
  await expect(
    service.command("owner", "client", {
      ...input,
      commandId: crypto.randomUUID(),
      habitId: "stretch",
    }),
  ).rejects.toThrow("break habit");
  await service.command(
    "other",
    "client",
    { commandId: crypto.randomUUID(), id: String(first.id) },
    true,
  );
  expect(rows.size).toBe(1);
  const deletion = { commandId: crypto.randomUUID(), id: String(first.id) };
  await service.command("owner", "client", deletion, true);
  await service.command("owner", "client", deletion, true);
  expect(rows.size).toBe(0);
  expect(await service.command("owner", "client", input)).toEqual(first);
  expect(rows.size).toBe(0);
});
test("urge pages use one bounded selected-field query regardless of record count", async () => {
  let calls = 0;
  const ids = Array.from({ length: 51 }, () => crypto.randomUUID())
    .sort()
    .reverse();
  const db: any = {
    habitSlip: {
      findMany: async (query: any) => {
        calls++;
        expect(query.take).toBe(51);
        expect(query.where.ownerId).toBe("owner");
        expect(query.select.ownerId).toBeUndefined();
        expect(query.select.note).toBe(true);
        return ids.map((id) => ({
          id,
          habitId: "pause",
          definitionSha: "a",
          occurredAt: new Date("2026-11-04T12:00:00Z"),
          outcome: "resisted",
          trigger: "waiting",
          note: "",
        }));
      },
    },
  };
  const service = createSlipService(db);
  const page = await service.list("owner");
  expect(calls).toBe(1);
  expect(page.slips).toHaveLength(50);
  expect(page.next).toBe(ids[49]);
});
