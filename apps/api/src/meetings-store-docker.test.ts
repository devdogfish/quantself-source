import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { hashCancelToken, newCancelToken, newJitsiRoom, prismaMeetingStore, type BookCommand } from "./meetings-store";
import { createHabitCatalog } from "./habits-catalog";
import { deliveryLeaseMs, prismaMeetingOutbox } from "./meetings-email";

// Run against a disposable Docker database:
// QUANTSELF_MEETINGS_FIXTURE=1 DATABASE_URL=postgresql://dev:dev@127.0.0.1:<port>/meetings_fixture
test.skipIf(process.env.QUANTSELF_MEETINGS_FIXTURE !== "1")(
  "the Postgres store books one meeting per slot under concurrency, replays keys and cancels by token hash",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/meetings_fixture") {
      throw new Error("Use a disposable meetings fixture database.");
    }
    const { prisma } = await import("@quantself/db");
    const store = prismaMeetingStore(prisma);
    const ownerId = `fixture-${randomUUID()}`;
    const now = new Date("2026-11-16T12:00:00Z");
    const start = new Date("2026-11-17T13:00:00Z");
    const end = new Date("2026-11-17T13:30:00Z");
    const command = (email: string, key: string = randomUUID(), at = start): BookCommand => ({
      ownerId, clientId: `client-${ownerId}`, idempotencyKey: key,
      request: { start: at.toISOString(), name: "Fixture Guest", email },
      start: at, end: new Date(at.getTime() + 1_800_000), guestEmail: email, slotAllowed: true,
      maxFutureMeetingsPerEmail: 2, now, jitsiRoom: newJitsiRoom(), cancelToken: newCancelToken(),
    });

    try {
      const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.book(command(`guest${index}@example.test`))));
      expect(outcomes.filter(outcome => outcome.status === 201)).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 409).every(outcome => outcome.body.code === "SLOT_UNAVAILABLE")).toBe(true);
      expect(await prisma.meeting.count({ where: { ownerId } })).toBe(1);
      expect(await store.calendarBusyBetween(ownerId, { start: end.getTime(), end: end.getTime() + 1_800_000 })).toEqual([
        { start: start.getTime() - 900_000, end: end.getTime() + 900_000 },
      ]);
      expect(await store.book(command("adjacent@example.test", randomUUID(), end))).toMatchObject({ status: 409 });

      const later = new Date("2026-11-17T14:00:00Z");
      const retry = command("retry@example.test", "fixture-retry", later);
      const duplicate = { ...retry, jitsiRoom: newJitsiRoom(), cancelToken: newCancelToken() };
      const [first, replay] = await Promise.all([store.book(retry), store.book(duplicate)]);
      expect(first.status).toBe(201);
      expect(replay).toEqual(first);
      const reused = await store.book({ ...retry, request: { ...retry.request, name: "Someone Else" } });
      expect(reused).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
      expect(await prisma.meeting.count({ where: { ownerId } })).toBe(2);

      const row = await prisma.meeting.findFirstOrThrow({ where: { ownerId, start: later } });
      // Either concurrent duplicate may win; only the winner's token is stored.
      expect([retry, duplicate].map(entry => hashCancelToken(entry.cancelToken))).toContain(row.cancelTokenHash);
      const outbox = prismaMeetingOutbox(prisma);
      const confirmations = (await outbox.due(now)).filter(event => event.meeting.id === row.id);
      expect(confirmations.map(event => [event.kind, event.recipient])).toEqual([
        ["confirmation", "guest"], ["confirmation", "owner"],
      ]);
      const [guestConfirmation, ownerConfirmation] = confirmations;
      const originalLease = await outbox.claim(guestConfirmation!, now);
      expect(originalLease).not.toBeNull();
      expect(await outbox.claim(guestConfirmation!, now)).toBeNull();
      const retryAt = new Date(now.getTime() + deliveryLeaseMs);
      const retryLease = await outbox.claim(guestConfirmation!, retryAt);
      expect(retryLease).not.toBeNull();
      await outbox.sent(guestConfirmation!, originalLease!, retryAt);
      expect(await prisma.meeting.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        pendingCancelToken: row.pendingCancelToken, confirmationSentAt: null,
      });
      await outbox.sent(guestConfirmation!, retryLease!, retryAt);
      expect(await prisma.meeting.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        pendingCancelToken: null, confirmationSentAt: retryAt, ownerConfirmationSentAt: null,
      });

      expect(await store.cancel({ ownerId: "someone-else", cancelTokenHash: row.cancelTokenHash, now })).toMatchObject({ status: 404 });
      expect(await store.cancel({ ownerId, cancelTokenHash: row.cancelTokenHash, now })).toMatchObject({ status: 200 });
      expect(await store.cancel({ ownerId, cancelTokenHash: row.cancelTokenHash, now })).toMatchObject({ status: 200 });
      const cancelled = await prisma.meeting.findUniqueOrThrow({ where: { id: row.id } });
      expect(cancelled).toMatchObject({ status: "cancelled", pendingCancelToken: null });
      expect(await outbox.claim(ownerConfirmation!, now)).toBeNull();
      expect((await outbox.due(later)).filter(event => event.meeting.id === row.id)
        .map(event => [event.kind, event.recipient])).toEqual([
        ["cancellation", "guest"], ["cancellation", "owner"],
      ]);
      // The freed slot can be booked again despite the partial unique index.
      expect((await store.book(command("again@example.test", randomUUID(), later))).status).toBe(201);

      const application = await prisma.jobApplication.create({
        data: { ownerId, sourceKey: "fixture", sourceUrl: "https://example.test", company: "Fixture", role: "Tester", resumeTrack: "web" },
      });
      const appointmentStart = new Date("2026-11-17T16:00:00Z");
      const appointmentEnd = new Date("2026-11-17T16:30:00Z");
      const appointment = await prisma.jobInterview.create({
        data: {
          ownerId, applicationId: application.id, title: "Interview", applicationUrl: application.sourceUrl,
          source: "native", startAt: appointmentStart, endAt: appointmentEnd,
          appointment: { create: { startAt: appointmentStart, endAt: appointmentEnd, afterMinutes: 40 } },
        },
      });
      const before = new Date("2026-11-17T15:30:00Z");
      const after = new Date("2026-11-17T17:00:00Z");
      expect(await store.book(command("before@example.test", randomUUID(), before))).toMatchObject({ status: 409 });
      expect(await store.book(command("after@example.test", randomUUID(), after))).toMatchObject({ status: 409 });
      await prisma.jobInterviewAppointment.update({ where: { id: appointment.id }, data: { cancelledAt: now } });
      expect(await store.book(command("after@example.test", randomUUID(), after))).toMatchObject({ status: 201 });

      await createHabitCatalog(prisma).apply(ownerId, {
        commandId: randomUUID(), expectedRevision: 0, reason: "Booking fixture",
        changes: [
          { type: "upsertStack", id: "focus", name: "Focus", anchor: "11:35", durationMinutes: 20, days: "daily" },
          { type: "upsertHabit", id: "read", name: "Read", stack: "focus", order: 0, kind: "build", tracked: false, status: "building", details: {} },
        ],
      });
      const range = { start: before.getTime(), end: appointmentStart.getTime() };
      expect(await store.calendarBusyBetween(ownerId, range)).toEqual([
        { start: Date.parse("2026-11-17T15:20:00Z"), end: Date.parse("2026-11-17T16:10:00Z") },
      ]);
      expect(await store.book(command("habit@example.test", randomUUID(), before))).toMatchObject({ status: 409 });

      const adjacent = await Promise.all([
        store.book(command("race-one@example.test", randomUUID(), new Date("2026-11-17T18:00:00Z"))),
        store.book(command("race-two@example.test", randomUUID(), new Date("2026-11-17T18:30:00Z"))),
      ]);
      expect(adjacent.map(outcome => outcome.status).sort()).toEqual([201, 409]);
    } finally {
      await prisma.jobInterviewAppointment.deleteMany({ where: { interview: { ownerId } } });
      await prisma.jobApplication.deleteMany({ where: { ownerId } });
      await prisma.habitDefinitionRevision.deleteMany({ where: { ownerId } });
      await prisma.meeting.deleteMany({ where: { ownerId } });
      await prisma.apiIdempotencyKey.deleteMany({ where: { clientId: `client-${ownerId}` } });
      await prisma.$disconnect();
    }
  },
);
