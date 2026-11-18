import { test, expect } from "bun:test";
import { createNotificationWorker } from "./notifications";
import { prisma } from "@quantself/db";
import webpush from "web-push";
import type { Todo, TodoReader } from "./todos-github";
const enabled = process.env.QUANTSELF_NOTIFICATION_DB_TEST === "1";
test.skipIf(!enabled)("durable claims prevent duplicate sends across concurrent workers and restart; cache read shared per tick", async () => {
  const now = Date.now();
  const ownerId = `notification-test-${crypto.randomUUID()}`;
  const keyNames = ["QUANTSELF_PUSH_PUBLIC_KEY", "QUANTSELF_PUSH_PRIVATE_KEY", "QUANTSELF_PUSH_SUBJECT"] as const;
  const previous = keyNames.map(key => process.env[key]);
  const keys = webpush.generateVAPIDKeys();
  process.env.QUANTSELF_PUSH_PUBLIC_KEY = keys.publicKey;
  process.env.QUANTSELF_PUSH_PRIVATE_KEY = keys.privateKey;
  process.env.QUANTSELF_PUSH_SUBJECT = "mailto:test@example.com";
  const todo: Todo = { id: ownerId, databaseId: 1, repository: "test/tasks", number: 1, url: "https://example.com/1", title: "Test", body: "", state: "open", closureReason: null, updatedAt: new Date(now).toISOString(), labels: [], fields: {}, fieldValues: [], start: new Date(now + 600000).toISOString(), end: new Date(now + 1200000).toISOString(), allDay: false, fixed: false, scheduleError: null };
  let reads = 0, sends = 0, stale = false;
  let authoritative: Todo | undefined;
  let details = 0;
  const reader: TodoReader = { async list() { reads++; return [todo]; }, async detail() { details++; return authoritative ?? todo; }, async freshness() { return { stale, readAt: new Date().toISOString(), generation: 1 }; } };
  const options = { ownerId, now: () => now + 1000, send: (async () => { sends++; return { statusCode: 201, body: "", headers: {} }; }) as typeof webpush.sendNotification };
  try {
    await prisma.notificationSettings.create({ data: { ownerId, enabled: true, enabledAt: new Date(now - 10000) } });
    for (let n=0; n<2; n++) await prisma.notificationDevice.create({ data: { ownerId, endpoint: `https://fcm.googleapis.com/${ownerId}/${n}`, p256dh: "test", auth: "test", timeZone: "UTC", createdAt: new Date(now - 10000) } });
    await Promise.all([createNotificationWorker(reader, options).tick(), createNotificationWorker(reader, options).tick()]);
    expect(sends).toBe(2); expect(reads).toBe(2);
    const initialDetails = details; expect(initialDetails).toBeLessThanOrEqual(2);
    await createNotificationWorker(reader, options).tick();
    expect(sends).toBe(2); expect(details).toBe(initialDetails);
    // Recover a durable claim abandoned before provider delivery.
    const devices = await prisma.notificationDevice.findMany({ where: { ownerId } });
    await prisma.notificationReceipt.updateMany({ where: { deviceId: devices[0]!.id }, data: { sentAt: null, claimedAt: new Date(now - 120000) } });
    await createNotificationWorker(reader, options).tick(); expect(sends).toBe(3);
    // Completion cancels all derived candidates; rescheduling produces a distinct receipt.
    todo.state = "closed"; await createNotificationWorker(reader, options).tick(); expect(sends).toBe(3);
    todo.state = "open"; todo.start = new Date(now + 601000).toISOString();
    stale = true;
    await createNotificationWorker(reader, { ...options, now: () => now+2000 }).tick(); expect(sends).toBe(3);
    stale = false;
    await createNotificationWorker(reader, { ...options, now: () => now+2000 }).tick(); expect(sends).toBe(5);
    // Respect provider backoff across new scheduler instances.
    todo.start = new Date(now + 602000).toISOString();
    let attempts = 0;
    const throttled = { ...options, now: () => now+3000, send: (async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(Error("Throttled"), { statusCode: 429, headers: { "retry-after": "120" } });
      return { statusCode: 201, body: "", headers: {} };
    }) as typeof webpush.sendNotification };
    await createNotificationWorker(reader, throttled).tick(); expect(attempts).toBe(2);
    await createNotificationWorker(reader, { ...throttled, now: () => now+10000 }).tick(); expect(attempts).toBe(2);
    await createNotificationWorker(reader, { ...throttled, now: () => now+124000 }).tick(); expect(attempts).toBe(3);
    // Per-task disablement suppresses both devices without changing task facts.
    todo.start = new Date(now + 604000).toISOString();
    await prisma.notificationTask.create({ data: { ownerId, number: 1, minutes: null } });
    await createNotificationWorker(reader, { ...options, now: () => now+5000 }).tick(); expect(sends).toBe(5);
    await prisma.notificationTask.deleteMany({ where: { ownerId } });
    authoritative = { ...todo, state: "closed" };
    await createNotificationWorker(reader, { ...options, now: () => now+5000 }).tick(); expect(sends).toBe(5);


  } finally {
    const devices = await prisma.notificationDevice.findMany({ where: { ownerId }, select: { id: true } });
    await prisma.notificationReceipt.deleteMany({ where: { deviceId: { in: devices.map(d => d.id) } } });
    await prisma.notificationDevice.deleteMany({ where: { ownerId } });
    await prisma.notificationTask.deleteMany({ where: { ownerId } });
    await prisma.notificationSettings.deleteMany({ where: { ownerId } });
    keyNames.forEach((key,index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
