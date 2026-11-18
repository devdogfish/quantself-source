import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import type webpush from "web-push";
import type { Todo, TodoReader } from "./todos-github";

test.skipIf(process.env.QUANTSELF_NATIVE_REMINDERS_FIXTURE !== "1")(
  "native and legacy reminders share real durable receipts and use bounded, Owner-scoped native queries",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.hostname !== "127.0.0.1" || !database.port || database.pathname !== "/native_reminders_fixture") {
      throw new Error("Use the disposable Docker database native_reminders_fixture.");
    }

    mock.module("./habits-catalog", () => ({ habitCatalog: { currentMany: async () => new Map() } }));
    const { prisma } = await import("@quantself/db");
    const { createNotificationWorker } = await import("./notifications");
    const { createNativeAppointmentReminderReader } = await import("./notifications-appointment-reader");

    const ownerId = crypto.randomUUID(), otherOwner = crypto.randomUUID();
    const keyNames = ["QUANTSELF_PUSH_PUBLIC_KEY", "QUANTSELF_PUSH_PRIVATE_KEY", "QUANTSELF_PUSH_SUBJECT"] as const;
    const previous = keyNames.map(key => process.env[key]);
    keyNames.forEach(key => { process.env[key] = "fixture"; });
    const now = Date.now();
    const timeAt = (minutes: number) => new Date(now + minutes * 60_000);
    const addJob = (owner: string) => prisma.jobApplication.create({
      data: {
        ownerId: owner, sourceKey: crypto.randomUUID(), sourceUrl: "https://example.test/fixture",
        company: "Fixture company", role: "Tester", resumeTrack: "web", status: "applied",
      },
    });

    try {
      const [job, otherJob] = await Promise.all([addJob(ownerId), addJob(otherOwner)]);
      const seed = (
        startInMinutes: number,
        { source = "native", relatedJob = job, beforeMinutes, alertMinutes, cancelledAt, withAppointment = true }: {
          source?: "native" | "github"; relatedJob?: typeof job; beforeMinutes?: number;
          alertMinutes?: number | null; cancelledAt?: Date; withAppointment?: boolean;
        } = {},
      ) => {
        const startAt = timeAt(startInMinutes), endAt = timeAt(startInMinutes + 30);
        return prisma.jobInterview.create({ data: {
          ownerId: relatedJob.ownerId, applicationId: relatedJob.id, title: `Fixture interview ${startInMinutes}`,
          startAt, endAt, source, applicationUrl: "https://example.test/fixture",
          ...(source === "github" && { todoNumber: 12 }),
          ...(withAppointment && { appointment: { create: { startAt, endAt, beforeMinutes, alertMinutes, cancelledAt } } }),
        } });
      };
      const [first, second, legacy, wrongSource, optedOut, cancelled, boundary, outside, foreign] = await Promise.all([
        seed(9), seed(39, { beforeMinutes: 30 }),
        seed(8, { source: "github", withAppointment: false }),
        seed(7, { source: "github" }),
        seed(6, { alertMinutes: null }),
        seed(5, { cancelledAt: timeAt(-1) }),
        seed(11520, { relatedJob: otherJob, beforeMinutes: 1440, alertMinutes: 10080 }),
        seed(11521, { relatedJob: otherJob, beforeMinutes: 1440, alertMinutes: 10080 }),
        seed(4, { relatedJob: otherJob }),
        seed(29, { beforeMinutes: 30 }), // Prep has already started.
        seed(11), // Default lead has not started.
      ]);

      await prisma.$executeRaw`
        WITH history AS (
          INSERT INTO "job_interview" ("id", "ownerId", "applicationId", "startAt", "endAt", "title", "applicationUrl", "source")
          SELECT gen_random_uuid(), ${ownerId}, ${job.id},
                 timestamp '2020-01-01' + n * interval '1 minute',
                 timestamp '2020-01-01' + (n + 30) * interval '1 minute',
                 'Historical interview', 'https://example.test/fixture', 'native'
          FROM generate_series(1, 12000) n
          RETURNING "id", "startAt", "endAt"
        )
        INSERT INTO "job_interview_appointment" ("id", "startAt", "endAt")
        SELECT "id", "startAt", "endAt" FROM history`;
      await prisma.$executeRaw`ANALYZE "job_interview_appointment", "job_interview"`;

      const queries: Prisma.Sql[] = [];
      const native = createNativeAppointmentReminderReader({
        $queryRaw<T>(query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) {
          if ("sql" in query) queries.push(query);
          return prisma.$queryRaw<T>(query, ...values);
        },
      });
      const due = await native.listDue({ ownerIds: [ownerId], now: new Date(now) });
      expect(due.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
      expect(due.find(row => row.id === first.id)).toMatchObject({
        applicationId: job.id, ownerId, source: "native", title: first.title, alertMinutes: 10,
      });
      const [plan] = await prisma.$queryRaw<{ "QUERY PLAN": [{ "Execution Time": number; Plan: unknown }] }[]>`
        EXPLAIN (ANALYZE, FORMAT JSON) ${queries[0]!}`;
      expect(JSON.stringify(plan)).toContain("job_interview_appointment_start_idx");
      console.info(`Native due SQL used the start index over 12,000 historical slots in ${plan!["QUERY PLAN"][0]["Execution Time"]}ms.`);
      const otherDue = await native.listDue({ ownerIds: [otherOwner], now: new Date(now) });
      expect(otherDue.map(row => row.id).sort()).toEqual([boundary.id, foreign.id].sort());
      expect(otherDue.some(row => row.id === outside.id)).toBe(false);

      const current = await native.readCurrent([
        { ownerId, id: first.id }, { ownerId: otherOwner, id: foreign.id },
        { ownerId: otherOwner, id: second.id }, { ownerId, id: boundary.id },
        { ownerId, id: optedOut.id }, { ownerId, id: cancelled.id },
        { ownerId, id: wrongSource.id }, { ownerId, id: legacy.id },
      ]);
      expect(current.map(row => row.id).sort()).toEqual([first.id, foreign.id, optedOut.id, cancelled.id].sort());
      expect(current.find(row => row.id === optedOut.id)?.alertMinutes).toBeNull();
      expect(current.find(row => row.id === cancelled.id)?.cancelledAt).toBe(timeAt(-1).toISOString());

      await prisma.notificationSettings.create({ data: { ownerId, enabled: true, enabledAt: timeAt(-30) } });
      const devices = await Promise.all([1, 2].map(index => prisma.notificationDevice.create({
        data: {
          ownerId, endpoint: `https://fcm.googleapis.com/${ownerId}/${index}`, timeZone: "UTC",
          p256dh: "fixture", auth: "fixture", createdAt: timeAt(-30),
        },
      })));
      const deviceIds = devices.map(device => device.id);
      const todo: Todo = {
        id: legacy.id, number: 12, title: legacy.title, state: "open",
        databaseId: 12, repository: "fixture/tasks", url: "https://example.test/12",
        body: "", closureReason: null, updatedAt: timeAt(-30).toISOString(),
        labels: [], fields: {}, fieldValues: [], start: legacy.startAt.toISOString(),
        end: legacy.endAt.toISOString(), fixed: true, allDay: false, scheduleError: null,
      };
      const calls = { list: 0, detail: 0, freshness: 0 };
      const reader: TodoReader = {
        async list() { calls.list++; return [todo]; },
        async detail() { calls.detail++; return todo; },
        async freshness() { calls.freshness++; return { stale: false, readAt: new Date().toISOString(), generation: 1 }; },
      };
      const fingerprints: Array<{ endpoint: string; url: string; tag: string; topic?: string }> = [];
      let loseAcknowledgement = true;
      const send: typeof webpush.sendNotification = async ({ endpoint }, body, options) => {
        const { notification } = JSON.parse(String(body));
        fingerprints.push({ endpoint, url: notification.data.url, tag: notification.tag, topic: options?.topic });
        if (loseAcknowledgement && notification.data.url === `/todo?appointment=${first.id}`) {
          loseAcknowledgement = false;
          throw new Error("Fixture lost an accepted push acknowledgement.");
        }
        return { statusCode: 201, headers: {}, body: "" };
      };

      let beforeVerify: (() => Promise<void>) | undefined;
      const appointments = {
        listDue: native.listDue,
        async readCurrent(targets: Parameters<typeof native.readCurrent>[0]) {
          await beforeVerify?.();
          return native.readCurrent(targets);
        },
      };
      const tick = async (expectedReads: ("due" | "verify")[]) => {
        queries.length = 0;
        await createNotificationWorker(reader, { appointments, now: () => now, ownerId, send }).tick();
        expect(queries.map(query => query.sql.includes("jsonb_to_recordset") ? "verify" : "due")).toEqual(expectedReads);
      };

      await tick(["due", "verify"]);
      expect(fingerprints).toHaveLength(6);
      expect(fingerprints.map(push => push.url).sort()).toEqual([
        `/todo?appointment=${first.id}`, `/todo?appointment=${first.id}`,
        `/todo?appointment=${second.id}`, `/todo?appointment=${second.id}`, "/todo?task=12", "/todo?task=12",
      ].sort());
      const legacyTag = createHash("sha256").update(`${todo.id}:${timeAt(-2).getTime()}`).digest("hex");
      expect(fingerprints.filter(push => push.url === "/todo?task=12").map(push => push.tag)).toEqual([legacyTag, legacyTag]);
      expect(calls).toEqual({ list: 1, detail: 1, freshness: 1 });

      const [ambiguous] = await prisma.notificationReceipt.findMany({ where: { deviceId: { in: deviceIds }, sentAt: null } });
      expect(ambiguous).toBeDefined();
      await tick(["due"]);
      expect(fingerprints).toHaveLength(6);
      await prisma.notificationReceipt.update({
        where: { deviceId_key: { deviceId: ambiguous!.deviceId, key: ambiguous!.key } },
        data: { claimedAt: timeAt(-2) },
      });
      await tick(["due", "verify"]);
      expect(fingerprints).toHaveLength(7);
      const retried = fingerprints.at(-1)!;
      expect(retried.tag).toBe(ambiguous!.key);
      expect(fingerprints.slice(0, -1)).toContainEqual(retried);
      expect(await prisma.notificationReceipt.count({ where: { deviceId: { in: deviceIds }, sentAt: null } })).toBe(0);

      await prisma.notificationReceipt.deleteMany({ where: { deviceId: { in: deviceIds }, key: { not: legacyTag } } });
      beforeVerify = async () => {
        expect(await prisma.notificationReceipt.count({ where: { deviceId: { in: deviceIds }, sentAt: null } })).toBeGreaterThan(0);
        await prisma.$transaction([
          prisma.jobInterviewAppointment.update({ where: { id: first.id }, data: { revision: { increment: 1 } } }),
          prisma.jobInterviewAppointment.update({ where: { id: second.id }, data: { cancelledAt: new Date(now), revision: { increment: 1 } } }),
        ]);
      };
      await tick(["due", "verify"]);
      expect(fingerprints).toHaveLength(7);
      expect(calls).toEqual({ list: 4, detail: 1, freshness: 4 });
    } finally {
      keyNames.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await prisma.$disconnect();
    }
  },
  30_000,
);

test.skipIf(process.env.QUANTSELF_NATIVE_REMINDERS_FIXTURE !== "1")(
  "native Appointment alert recovers a crashed worker without resending a confirmed receipt",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" ||
        !database.port || database.pathname !== "/native_reminders_fixture") {
      throw new Error("Use the disposable Docker database native_reminders_fixture.");
    }
    const { prisma } = await import("@quantself/db");
    const ownerId = crypto.randomUUID();
    const now = Date.now();
    const enrolledAt = new Date(now - 120_000);
    const startAt = new Date(now + 540_000);
    const endAt = new Date(now + 2_340_000);
    const endpoint = "https://push.example.test/" + ownerId;
    const deliveries: Array<{ endpoint: string; tag: string; topic: string; url: string; renotify: boolean }> = [];
    const transport = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        deliveries.push(await request.json() as typeof deliveries[number]);
        return new Response(null, { status: 201 });
      },
    });

    async function runWorker(clock: number, crashAfterAcceptance = false) {
      const started = performance.now();
      let startupMs = 0;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
        import { prisma } from "./packages/db/index.ts";
        import { createNotificationWorker } from "./apps/api/src/notifications.ts";
        import { createNativeAppointmentReminderReader } from "./apps/api/src/notifications-appointment-reader.ts";
        const reader = {
          async list() { return []; },
          async freshness() { return { stale: false, readAt: new Date().toISOString(), generation: 1 }; },
          async detail() { throw new Error("Unexpected fixture task detail."); },
        };
        const worker = createNotificationWorker(reader, {
          ownerId: process.env.FIXTURE_OWNER_ID,
          now: () => Number(process.env.FIXTURE_NOW),
          appointments: createNativeAppointmentReminderReader(prisma),
          send: async ({ endpoint }, body, options) => {
            const { notification } = JSON.parse(body);
            const response = await fetch(process.env.FIXTURE_TRANSPORT_URL, {
              method: "POST", body: JSON.stringify({
                endpoint, tag: notification.tag, topic: options.topic, url: notification.data.url, renotify: notification.renotify,
              }),
              signal: AbortSignal.timeout(3000), redirect: "error",
            });
            if (!response.ok) throw new Error("Synthetic push rejected.");
            if (process.env.FIXTURE_CRASH === "1") {
              process.send("accepted");
              await new Promise(() => {});
            }
            return { statusCode: response.status, headers: {}, body: "" };
          },
        });
        process.send("ready");
        await worker.tick();
        await prisma.$disconnect();
      `], {
        env: {
          DATABASE_URL: database.href, FIXTURE_OWNER_ID: ownerId, FIXTURE_NOW: String(clock),
          FIXTURE_TRANSPORT_URL: transport.url.href, FIXTURE_CRASH: crashAfterAcceptance ? "1" : "0",
          QUANTSELF_PUSH_PUBLIC_KEY: "fixture", QUANTSELF_PUSH_PRIVATE_KEY: "fixture", QUANTSELF_PUSH_SUBJECT: "fixture",
        },
        ipc(message, process) {
          if (message === "ready") startupMs = Math.round(performance.now() - started);
          if (message === "accepted" && crashAfterAcceptance) process.kill("SIGKILL");
        },
        stdout: "ignore", stderr: "inherit",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const exitCode = await child.exited;
        expect(startupMs).toBeGreaterThan(0);
        expect(crashAfterAcceptance ? child.signalCode : exitCode).toBe(crashAfterAcceptance ? "SIGKILL" : 0);
        return { pid: child.pid, startupMs, elapsedMs: Math.round(performance.now() - started) };
      } finally {
        clearTimeout(timeout);
      }
    }

    try {
      await prisma.notificationSettings.create({ data: { ownerId, enabled: true, enabledAt: enrolledAt } });
      const device = await prisma.notificationDevice.create({ data: {
        ownerId, endpoint, p256dh: "fixture", auth: "fixture", timeZone: "UTC", createdAt: enrolledAt,
      } });
      const job = await prisma.jobApplication.create({ data: {
        ownerId, sourceKey: "fixture", sourceUrl: "https://example.test/jobs/fixture",
        company: "Fixture company", role: "Tester", resumeTrack: "web", status: "applied",
      } });
      const interview = await prisma.jobInterview.create({ data: {
        ownerId, applicationId: job.id, title: "Fixture interview", source: "native",
        applicationUrl: job.sourceUrl, startAt, endAt, appointment: { create: { startAt, endAt } },
      } });
      const key = createHash("sha256").update(`native-appointment:${interview.id}:${startAt.valueOf() - 600_000}`).digest("hex");
      const where = { deviceId_key: { deviceId: device.id, key } };
      const readReceipt = () => prisma.notificationReceipt.findUniqueOrThrow({ where });
      const before = await prisma.jobInterviewAppointment.findUniqueOrThrow({ where: { id: interview.id } });

      const crashed = await runWorker(now, true);
      expect(deliveries).toEqual([{ endpoint, tag: key, topic: key.slice(0, 32), url: `/todo?appointment=${interview.id}`, renotify: false }]);
      const pending = await readReceipt();
      expect(pending.sentAt).toBeNull();

      const liveLease = await runWorker(pending.claimedAt.valueOf() + 30_000);
      expect(deliveries).toHaveLength(1);
      expect(await readReceipt()).toEqual(pending);

      const leaseExpired = await runWorker(pending.claimedAt.valueOf() + 61_000);
      expect(deliveries).toEqual([deliveries[0]!, deliveries[0]!]);
      const delivered = await readReceipt();
      expect(delivered.sentAt).toBeInstanceOf(Date);

      const confirmed = await runWorker(pending.claimedAt.valueOf() + 122_000);
      expect(deliveries).toHaveLength(2);
      expect(await readReceipt()).toEqual(delivered);
      expect(await prisma.notificationReceipt.count({ where: { deviceId: device.id } })).toBe(1);
      expect(await prisma.jobInterviewAppointment.findUniqueOrThrow({ where: { id: interview.id } })).toEqual(before);
      const processes = [crashed, liveLease, leaseExpired, confirmed];
      expect(new Set(processes.map(process => process.pid)).size).toBe(4);
      console.info("Native Appointment alert across worker restarts", JSON.stringify({
        appointmentId: interview.id, processes, transportRequests: [1, 0, 1, 0], receiptRows: 1,
      }));
    } finally {
      transport.stop(true);
      await prisma.$disconnect();
    }
  },
  30_000,
);
