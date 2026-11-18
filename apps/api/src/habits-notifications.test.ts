import { expect, mock, test } from "bun:test";
import { parseHabits } from "./habits-definition";
const now = Date.parse("2026-11-04T12:00:01Z");
const projection = parseHabits(`stacks:
  - {id: routine, name: Routine, anchor: '08:00', alert: true}
habits:
  - {id: stretch, name: Stretch, stack: routine, tracked: true, status: building}
`);
let enabled = true,
  sourceUnavailable = false,
  logged = false,
  verifyLogged = false,
  reads = 0;
const claims = new Set<string>();
const sent: any[] = [];
mock.module("./habits-catalog", () => ({
  habitCatalog: {
    currentMany: async () => {
      if (sourceUnavailable) throw Error("Unavailable");
      return new Map([["owner", {projection,revision:1}]]);
    },
  },
}));
mock.module("@quantself/db", () => ({
  prisma: {
    notificationSettings: {
      findMany: async () =>
        enabled
          ? [
              {
                ownerId: "owner",
                enabledAt: new Date(now - 10000),
                morning: "08:00",
              },
            ]
          : [],
    },
    notificationDevice: {
      findMany: async () =>
        Array.from({ length: 2 }, (_, i) => ({
          id: `device${i}`,
          ownerId: "owner",
          createdAt: new Date(now - 10000),
          timeZone: "Asia/Tokyo",
          endpoint: "https://example.com",
          p256dh: "key",
          auth: "auth",
        })),
    },
    notificationTask: { findMany: async () => [] },
    habitOccurrence: {
      findMany: async (q: any) => {
        reads++;
        return logged || (verifyLogged && !q.where.ownerId.in)
          ? [{ ownerId: "owner", habitId: "stretch", status: "done" }]
          : [];
      },
    },
    notificationReceipt: {
      createMany: async ({ data }: any) => {
        const key = `${data[0].deviceId}:${data[0].key}`;
        if (claims.has(key)) return { count: 0 };
        claims.add(key);
        return { count: 1 };
      },
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
      deleteMany: async () => ({}),
    },
  },
}));
const { createNotificationWorker } = await import("./notifications");
test("habit reminders reuse atomic receipts across workers/devices, verify suppression, and navigate to quick-log", async () => {
  const names = [
    "QUANTSELF_PUSH_PUBLIC_KEY",
    "QUANTSELF_PUSH_PRIVATE_KEY",
    "QUANTSELF_PUSH_SUBJECT",
  ];
  const previous = names.map((n) => process.env[n]);
  names.forEach((n) => (process.env[n] = "fixture"));
  const reader = {
    list: async () => [],
    freshness: async () => ({ stale: false, readAt: new Date().toISOString() }),
  } as any;
  const options = {
    now: () => now,
    send: (async (_: unknown, payload: string) => {
      sent.push(JSON.parse(payload));
      return {};
    }) as any,
  };
  try {
    const started = performance.now();
    await Promise.all([
      createNotificationWorker(reader, options).tick(),
      createNotificationWorker(reader, options).tick(),
    ]);
    expect(sent).toHaveLength(2);
    expect(reads).toBeLessThanOrEqual(4);
    expect(sent[0].notification.data.url).toBe(
      "/habits",
    );
    expect(sent[0].notification.navigate).toEndWith(
      "/habits",
    );
    expect(sent[0].notification.actions).toBeUndefined();
    await createNotificationWorker(reader, options).tick();
    expect(sent).toHaveLength(2);
    console.info(
      `Habit worker fixture cold concurrent ticks ${(performance.now() - started).toFixed(2)}ms; ${reads} bulk observation reads, zero GitHub requests (source mocked).`,
    );
    claims.clear();
    logged = true;
    await createNotificationWorker(reader, options).tick();
    expect(sent).toHaveLength(2);
    logged = false;
    verifyLogged = true;
    await createNotificationWorker(reader, options).tick();
    expect(sent).toHaveLength(2);
    enabled = false;
    const before = reads;
    await createNotificationWorker(reader, options).tick();
    expect(reads).toBe(before);
    enabled = true;
    sourceUnavailable = true;
    const task = {
      id: "task",
      number: 1,
      title: "Task",
      state: "open",
      start: new Date(now + 599000).toISOString(),
      fields: {},
      allDay: false,
    };
    reader.list = async () => [task];
    reader.detail = async () => task;
    await createNotificationWorker(reader, options).tick();
    expect(sent).toHaveLength(4);
    expect(sent[2].notification.data.url).toBe("/todo?task=1");
    expect(reads).toBe(before);

    claims.clear();
    sourceUnavailable = false;
    verifyLogged = false;
    reader.freshness = async () => ({ stale: true });
    let taskVerifications = 0;
    reader.detail = async () => {
      taskVerifications++;
      return task;
    };
    await createNotificationWorker(reader, options).tick();
    expect(taskVerifications).toBe(0);
    expect(sent.slice(4).map((push) => push.notification.data.url)).toEqual([
      "/habits",
      "/habits",
    ]);
  } finally {
    names.forEach((n, i) => {
      if (previous[i] === undefined) delete process.env[n];
      else process.env[n] = previous[i];
    });
  }
});
