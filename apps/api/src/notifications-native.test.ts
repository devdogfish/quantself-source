import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type webpush from "web-push";
import { DEFAULT_ALERT_MINUTES, type NativeReminderAppointment } from "./notifications-plan";
import type { NativeAppointmentReminderReader } from "./notifications";
import type { Todo, TodoReader } from "./todos-github";

const initialNow = Date.parse("2026-11-15T13:00:01Z");
const firstId = "ac8e143c-ebc9-4873-85af-3db9db044088";
const secondId = "e979d958-902a-4ded-93f3-62e29b46e243";
const ownerId = "owner";
const alertAt = initialNow - 1000;
const startAt = initialNow + 599_000;
const keyNames = ["QUANTSELF_PUSH_PUBLIC_KEY", "QUANTSELF_PUSH_PRIVATE_KEY", "QUANTSELF_PUSH_SUBJECT"] as const;
const previous = keyNames.map(key => process.env[key]);

function appointment(patch: Partial<NativeReminderAppointment> = {}): NativeReminderAppointment {
  return {
    source: "native",
    ownerId,
    id: firstId,
    applicationId: "application",
    title: "Interview",
    start: new Date(startAt).toISOString(),
    beforeMinutes: 0,
    alertMinutes: DEFAULT_ALERT_MINUTES,
    revision: 1,
    cancelledAt: null,
    ...patch,
  };
}

function legacyTodo(): Todo {
  return {
    id: firstId, number: 12, title: "Legacy task", state: "open",
    databaseId: 12, repository: "fixture/tasks", url: "https://example.test/12",
    body: "", closureReason: null, updatedAt: new Date(initialNow).toISOString(),
    labels: [], fields: {}, fieldValues: [], start: new Date(startAt).toISOString(),
    end: null, fixed: false, allDay: false, scheduleError: null,
  };
}

type Receipt = { claimedAt: Date; sentAt: Date | null };
type ReceiptIdentity = { deviceId: string; key: string };
const receiptKey = ({ deviceId, key }: ReceiptIdentity) => `${deviceId}:${key}`;
let fixture: ReturnType<typeof makeFixture>;

function makeFixture() {
  return {
    now: initialNow,
    enabled: true,
    enabledAt: new Date(initialNow - 30_000),
    enrolledAt: new Date(initialNow - 30_000),
    receipts: new Map<string, Receipt>(),
    due: [appointment()],
    current: () => fixture.due as readonly NativeReminderAppointment[],
    todos: [] as Todo[],
    stale: false,
    calls: { list: 0, freshness: 0, detail: 0, due: 0, current: 0 },
    sends: [] as { url: string; tag: string; navigate: string; title: string; ttl?: number }[],
  };
}

mock.module("./habits-catalog", () => ({
  habitCatalog: { currentMany: async () => new Map() },
}));
mock.module("@quantself/db", () => ({
  prisma: {
    notificationSettings: {
      findMany: async () => fixture.enabled
        ? [{ ownerId, enabledAt: fixture.enabledAt, morning: "09:00" }]
        : [],
    },
    notificationDevice: {
      findMany: async () => [1, 2].map(number => ({
        id: `device-${number}`, ownerId, timeZone: "UTC", createdAt: fixture.enrolledAt,
        endpoint: `https://fcm.googleapis.com/${number}`, p256dh: "fixture", auth: "fixture",
      })),
    },
    notificationTask: { findMany: async () => [] },
    notificationReceipt: {
      createMany: async ({ data }: { data: ReceiptIdentity[] }) => {
        const key = receiptKey(data[0]!);
        if (fixture.receipts.has(key)) return { count: 0 };
        fixture.receipts.set(key, { claimedAt: new Date(fixture.now), sentAt: null });
        return { count: 1 };
      },
      updateMany: async ({ where, data }: {
        where: ReceiptIdentity & { claimedAt?: { lt: Date } };
        data: { claimedAt: Date };
      }) => {
        const receipt = fixture.receipts.get(receiptKey(where));
        if (!receipt || receipt.sentAt || (where.claimedAt && receipt.claimedAt >= where.claimedAt.lt)) {
          return { count: 0 };
        }
        receipt.claimedAt = data.claimedAt;
        return { count: 1 };
      },
      update: async ({ where, data }: {
        where: { deviceId_key: ReceiptIdentity };
        data: { sentAt: Date };
      }) => {
        fixture.receipts.get(receiptKey(where.deviceId_key))!.sentAt = data.sentAt;
      },
      deleteMany: async () => ({}),
    },
  },
}));

const { createNotificationWorker } = await import("./notifications");

const reader: TodoReader = {
  async list() {
    fixture.calls.list++;
    return fixture.todos;
  },
  async freshness() {
    fixture.calls.freshness++;
    return { stale: fixture.stale, readAt: new Date().toISOString(), generation: 1 };
  },
  async detail(number) {
    fixture.calls.detail++;
    return fixture.todos.find(todo => todo.number === number)!;
  },
};
const nativeReader: NativeAppointmentReminderReader = {
  async listDue(input) {
    fixture.calls.due++;
    expect(input).toEqual({ ownerIds: [ownerId], now: new Date(fixture.now) });
    return fixture.due;
  },
  async readCurrent(targets) {
    fixture.calls.current++;
    expect([...fixture.receipts.values()].some(receipt => !receipt.sentAt)).toBe(true);
    expect(targets).toEqual(fixture.due
      .filter(row => row.ownerId === ownerId)
      .map(row => ({ ownerId, id: row.id })));
    return fixture.current();
  },
};

const send: typeof webpush.sendNotification = async (_, body, options) => {
  const { notification } = JSON.parse(String(body));
  fixture.sends.push({
    url: notification.data.url, tag: notification.tag, navigate: notification.navigate,
    title: notification.title, ttl: options?.TTL,
  });
  return { statusCode: 201, headers: {}, body: "" };
};

beforeEach(() => {
  fixture = makeFixture();
  keyNames.forEach(key => { process.env[key] = "fixture"; });
});
afterEach(() => {
  keyNames.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
});

function worker(sender = send) {
  return createNotificationWorker(reader, { appointments: nativeReader, now: () => fixture.now, send: sender });
}

test("bulk native reads are shared across appointments and devices with no added GitHub calls", async () => {
  fixture.due.push(appointment({ id: secondId }), appointment({ ownerId: "other-owner" }));
  fixture.todos.push(legacyTodo());
  await worker().tick();

  expect(fixture.sends).toHaveLength(6);
  for (const id of [firstId, secondId]) {
    const matching = fixture.sends.filter(push => push.url === `/todo?appointment=${id}`);
    expect(matching).toHaveLength(2);
    expect(matching[0]!.navigate).toEndWith(`/todo?appointment=${id}`);
    expect(matching[0]!.tag).toBe(createHash("sha256").update(`native-appointment:${id}:${alertAt}`).digest("hex"));
  }
  const legacy = fixture.sends.filter(push => push.url === "/todo?task=12");
  expect(legacy).toHaveLength(2);
  expect(legacy[0]!.tag).toBe(createHash("sha256").update(`${firstId}:${alertAt}`).digest("hex"));
  expect(fixture.calls).toEqual({ list: 1, freshness: 1, detail: 1, due: 1, current: 1 });

  await worker().tick();
  expect(fixture.sends).toHaveLength(6);
  expect(fixture.calls).toEqual({ list: 2, freshness: 2, detail: 1, due: 2, current: 1 });
});

test("native reminders deliver independently of stale GitHub tasks", async () => {
  fixture.stale = true;
  fixture.todos.push(legacyTodo());
  await Promise.all([worker().tick(), worker().tick()]);
  expect(fixture.sends.map(push => push.url)).toEqual([
    `/todo?appointment=${firstId}`, `/todo?appointment=${firstId}`,
  ]);
  expect(fixture.calls.detail).toBe(0);
  expect(fixture.calls.due).toBe(2);
  expect(fixture.calls.current).toBeLessThanOrEqual(2);
});

test.each([
  ["new revision with the same fire time", () => [appointment({ revision: 2 })]],
  ["cancellation", () => [appointment({ cancelledAt: new Date(initialNow).toISOString() })]],
  ["opt-out", () => [appointment({ alertMinutes: null })]],
  ["reschedule", () => [appointment({ start: new Date(startAt + 60_000).toISOString() })]],
  ["another Owner", () => [appointment({ ownerId: "other-owner" })]],
  ["a missing row", () => []],
  ["expiry after the claim", () => {
    fixture.now = startAt;
    return [appointment()];
  }],
] as const)("pre-send native verification suppresses %s", async (_, current) => {
  fixture.current = current;
  await worker().tick();
  expect(fixture.calls.current).toBe(1);
  expect(fixture.calls.detail).toBe(0);
  expect(fixture.sends).toEqual([]);
  expect([...fixture.receipts.values()].every(receipt => receipt.sentAt === null)).toBe(true);
});

test("disabled Owners, new devices and elapsed prep windows do not claim native alerts", async () => {
  fixture.enabled = false;
  await worker().tick();
  expect(fixture.calls.due).toBe(0);
  fixture.enabled = true;
  fixture.enabledAt = new Date(initialNow);
  await worker().tick();
  fixture.enabledAt = new Date(initialNow - 30_000);
  fixture.enrolledAt = new Date(initialNow);
  await worker().tick();
  fixture.enrolledAt = new Date(initialNow - 30_000);
  fixture.due = [appointment({ beforeMinutes: 10 }), appointment({ id: secondId, alertMinutes: null })];
  await worker().tick();
  expect(fixture.calls.current).toBe(0);
  expect(fixture.receipts.size).toBe(0);
});

test("native alerts reuse provider backoff and recover only the unsent receipt", async () => {
  let attempted = 0;
  const throttled: typeof send = async (...args) => {
    if (++attempted === 1) {
      throw Object.assign(new Error("Throttle fixture"), { statusCode: 429, headers: { "retry-after": "120" } });
    }
    return send(...args);
  };
  await worker(throttled).tick();
  expect(attempted).toBe(2);
  expect(fixture.sends).toHaveLength(1);
  fixture.now += 60_000;
  await worker(throttled).tick();
  expect(attempted).toBe(2);
  expect(fixture.calls.current).toBe(1);
  fixture.now += 61_000;
  await worker(throttled).tick();
  expect(attempted).toBe(3);
  expect(fixture.sends).toHaveLength(2);
  expect(fixture.calls.current).toBe(2);
  expect(fixture.sends[1]).toMatchObject({ url: `/todo?appointment=${firstId}`, ttl: 478 });
});
