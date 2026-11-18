import { expect, test } from "bun:test";
import {
  createHabitService,
  HabitError,
  validateHabitCommand,
  type HabitCommand,
} from "./habits-service";
import { parseHabits } from "./habits-definition";
const yaml = `stacks: [{ id: morning, name: Morning }]
habits: [{ id: stretch, name: Stretch, stack: morning, tracked: true, status: building }]
`;
function fixture(sourceText = yaml) {
  const rows = new Map<string, any>();
  const receipts = new Map<string, any>();
  let creates = 0,
    reads = 0;
  const key = (v: any) => `${v.ownerId}/${v.habitId}/${v.date}`;
  const receiptKey = (v: any) => `${v.ownerId}/${v.clientId}/${v.commandId}`;
  const db: any = {
    habitOccurrence: {
      async createMany({ data }: any) {
        creates++;
        for (const d of data)
          if (!rows.has(key(d)))
            rows.set(key(d), { status: "open", note: "", revision: 0, ...d });
      },
      async findMany({ where }: any) {
        reads++;
        return [...rows.values()].filter(
          (r) => r.ownerId === where.ownerId && r.date === where.date,
        );
      },
      async findUnique({ where }: any) {
        return rows.get(key(where.ownerId_habitId_date)) ?? null;
      },
      async create({ data }: any) {
        const row = { status: "open", note: "", revision: 0, ...data };
        rows.set(key(data), row);
        return row;
      },
      async updateMany({ where, data }: any) {
        const r = rows.get(key(where));
        if (!r || r.revision !== where.revision) return { count: 0 };
        rows.set(key(where), { ...r, ...data, revision: r.revision + 1 });
        return { count: 1 };
      },
    },
    habitCommand: {
      async findUnique({ where }: any) {
        return (
          receipts.get(receiptKey(where.ownerId_clientId_commandId)) ?? null
        );
      },
      async create({ data }: any) {
        receipts.set(receiptKey(data), data);
        return data;
      },
    },
    async $transaction(fn: any) {
      return fn(db);
    },
  };
  let sha = "first";
  let projection = parseHabits(sourceText);
  const source = {
    read: async () => ({ projection, sha, stale: false, error: null }),
  };
  let clock = new Date("2026-11-04T15:00:00Z");
  const service = createHabitService(db, source, () => clock);
  const command: HabitCommand = {
    commandId: crypto.randomUUID(),
    habitId: "stretch",
    date: "2026-11-04",
    revision: 0,
    before: { status: "open", note: "" },
    after: { status: "done", note: "Observed" },
  };
  return {
    service,
    command,
    rows,
    setTime: (value: string) => {
      clock = new Date(value);
    },
    counts: () => ({ creates, reads }),
    change: () => {
      sha = "second";
      projection = parseHabits(yaml.replace("building", "paused"));
    },
  };
}
test("daily reruns use one bulk insert and one range read; later rules preserve source facts and SHA", async () => {
  const f = fixture();
  await f.service.read("owner", "2026-11-04");
  await f.service.read("owner", "2026-11-04");
  expect(f.rows.size).toBe(1);
  expect(f.counts()).toEqual({ creates: 2, reads: 2 });
  f.change();
  const day = await f.service.read("owner", "2026-11-04");
  expect(day.occurrences[0].definitionSha).toBe("first");
  expect((await f.service.read("owner", "2026-11-03")).occurrences).toEqual([]);
});
test("command replays original receipt after a newer edit; conflicts preserve newer facts", async () => {
  const { service, command } = fixture();
  const result = await service.command("owner", "client", command);
  const second = {
    ...command,
    commandId: crypto.randomUUID(),
    revision: 1,
    before: command.after,
    after: { status: "minimum" as const, note: "Later" },
  };
  await service.command("owner", "client", second);
  expect(await service.command("owner", "client", command)).toEqual(result);
  await expect(
    service.command("owner", "client", {
      ...command,
      after: { status: "open", note: "" },
    }),
  ).rejects.toThrow("different command");
  await expect(
    service.command("owner", "client", {
      ...command,
      commandId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("Occurrence changed");
  expect(
    (await service.read("owner", command.date)).occurrences[0].status,
  ).toBe("minimum");
});
test("explicit future skips create only requested row; historical done corrections never backfill missed days", async () => {
  const { service, command, rows } = fixture();
  await service.command("owner", "client", {
    ...command,
    date: "2026-12-01",
    after: { status: "skipped", note: "Travel" },
  });
  expect(rows.size).toBe(1);
  await service.command("owner", "client", {
    ...command,
    commandId: crypto.randomUUID(),
    date: "2026-11-02",
  });
  expect(rows.size).toBe(2);
  expect((await service.read("other-owner", "2026-12-01")).occurrences).toEqual(
    [],
  );
});
test("reject retrospective skips and future completion; open becomes missed only after Halifax midnight", async () => {
  const f = fixture();
  expect(() =>
    validateHabitCommand(
      {
        ...f.command,
        date: "2026-11-03",
        after: { status: "skipped", note: "" },
      },
      "2026-11-04",
    ),
  ).toThrow(HabitError);
  expect(() =>
    validateHabitCommand({ ...f.command, date: "2026-11-05" }, "2026-11-04"),
  ).toThrow(HabitError);
  await f.service.read("owner", "2026-11-04");
  expect(
    (await f.service.read("owner", "2026-11-04")).occurrences[0].missed,
  ).toBe(false);
});

test("missed derives at Halifax midnight and never mutates stored open status", async () => {
  const f = fixture();
  await f.service.read("owner", "2026-11-04");
  f.setTime("2026-11-05T03:59:59Z");
  expect(
    (await f.service.read("owner", "2026-11-04")).occurrences[0].missed,
  ).toBe(false);
  f.setTime("2026-11-05T04:00:00Z");
  const row = (await f.service.read("owner", "2026-11-04")).occurrences[0];
  expect(row.missed).toBe(true);
  expect(row.status).toBe("open");
});

test("materializing many habits keeps storage requests constant instead of per-record fan-out", async () => {
  const habits = Array.from(
    { length: 200 },
    (_, i) =>
      `  - { id: practice-${i}, name: Practice ${i}, stack: morning, tracked: true, status: building }`,
  ).join("\n");
  const f = fixture(
    `stacks: [{ id: morning, name: Morning }]\nhabits:\n${habits}`,
  );
  const day = await f.service.read("owner", "2026-11-04");
  expect(day.occurrences).toHaveLength(200);
  expect(f.counts()).toEqual({ creates: 1, reads: 1 });
});

test("a previously declared skip can receive a later note without declaring a retrospective skip", async () => {
  const f = fixture();
  const skipped = { status: "skipped" as const, note: "Travel" };
  await f.service.command("owner", "client", { ...f.command, after: skipped });
  f.setTime("2026-11-05T15:00:00Z");
  const result = await f.service.command("owner", "client", {
    ...f.command,
    commandId: crypto.randomUUID(),
    revision: 1,
    before: skipped,
    after: { ...skipped, note: "Travel note corrected" },
  });
  expect(result.note).toBe("Travel note corrected");
  expect(result.status).toBe("skipped");
});
