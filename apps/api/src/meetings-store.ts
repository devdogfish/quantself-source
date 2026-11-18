import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { prisma } from "@quantself/db";
import { readHabitCatalog } from "./habits-catalog";
import { runIdempotentCommand } from "./idempotency";
import { bookingBufferMs, bufferedEvent, defaultMeetingSettings, habitBusyIntervals, overlaps, weeklyHoursSchema, type Interval, type MeetingSettingsValue } from "./meetings-availability";

export type BookingRequest = { start: string; name: string; email: string; note?: string };
export type BookingReceipt = { id: string; start: string; end: string };
export type BookCommand = {
  ownerId: string;
  clientId: string;
  idempotencyKey: string;
  request: BookingRequest;
  start: Date;
  end: Date;
  guestEmail: string;
  /** Hours, notice, horizon and tasks allow this slot. Database calendar sources are checked in the transaction. */
  slotAllowed: boolean;
  maxFutureMeetingsPerEmail: number;
  now: Date;
  jitsiRoom: string;
  /** Hashed for lookup; the plain token is kept only until the confirmation email is sent. */
  cancelToken: string;
};
export type BookOutcome =
  | { status: 201; body: BookingReceipt }
  | { status: 409; body: { code: "SLOT_UNAVAILABLE" | "IDEMPOTENCY_CONFLICT"; message: string } }
  | { status: 429; body: { code: "MEETING_LIMIT_REACHED"; message: string } };
export type CancelOutcome =
  | { status: 200; body: BookingReceipt }
  | { status: 404; body: { code: "MEETING_NOT_FOUND"; message: string } }
  | { status: 409; body: { code: "MEETING_STARTED"; message: string } };

export interface MeetingStore {
  settings(ownerId: string): Promise<MeetingSettingsValue>;
  calendarBusyBetween(ownerId: string, range: Interval): Promise<Interval[]>;
  book(command: BookCommand): Promise<BookOutcome>;
  cancel(input: { ownerId: string; cancelTokenHash: string; now: Date }): Promise<CancelOutcome>;
}

export const slotUnavailable = {
  status: 409, body: { code: "SLOT_UNAVAILABLE", message: "That time is no longer available." },
} as const satisfies BookOutcome;
export const meetingLimitReached = {
  status: 429, body: { code: "MEETING_LIMIT_REACHED", message: "This email already holds the maximum number of upcoming meetings." },
} as const satisfies BookOutcome;
export const meetingNotFound = {
  status: 404, body: { code: "MEETING_NOT_FOUND", message: "No meeting matches this cancel link." },
} as const satisfies CancelOutcome;
export const meetingStarted = {
  status: 409, body: { code: "MEETING_STARTED", message: "This meeting has already started." },
} as const satisfies CancelOutcome;

export function hashCancelToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
/** 256-bit, URL-safe guest cancel token. Only its hash is stored. */
export function newCancelToken() {
  return randomBytes(32).toString("base64url");
}
/** Jitsi lowercases room names, so use 128 random bits of lowercase hex. */
export function newJitsiRoom() {
  return `meet-${randomBytes(16).toString("hex")}`;
}

export function receipt(meeting: { id: string; start: Date; end: Date }): BookingReceipt {
  const iso = (date: Date) => date.toISOString().replace(".000Z", "Z");
  return { id: meeting.id, start: iso(meeting.start), end: iso(meeting.end) };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// Serializable conflicts can surface at commit as a raw driver error rather than P2034.
function isWriteConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  const cause = (error as { cause?: { kind?: string; originalCode?: string } } | null)?.cause;
  return cause?.kind === "TransactionWriteConflict" || cause?.originalCode === "40001";
}
const maxBookingAttempts = 6;

// The native appointment schema caps prep and travel at 24 hours. Use the indexed
// start time to bound the read, then apply each event's actual buffers.
const maxAppointmentBufferMs = 24 * 60 * 60_000;

function bufferedMeetingWhere(ownerId: string, range: Interval) {
  return {
    ownerId, status: "booked" as const,
    start: { lt: new Date(range.end + bookingBufferMs) },
    end: { gt: new Date(range.start - bookingBufferMs) },
  };
}

async function otherCalendarBusy(
  db: Pick<Prisma.TransactionClient, "jobInterviewAppointment" | "habitDefinitionRevision">,
  ownerId: string,
  range: Interval,
): Promise<Interval[]> {
  const [appointments, habits] = await Promise.all([
    db.jobInterviewAppointment.findMany({
      where: {
        cancelledAt: null,
        interview: { ownerId, source: "native" },
        startAt: { lt: new Date(range.end + maxAppointmentBufferMs) },
        endAt: { gt: new Date(range.start - maxAppointmentBufferMs) },
      },
      select: { startAt: true, endAt: true, beforeMinutes: true, afterMinutes: true },
    }),
    readHabitCatalog(ownerId, db),
  ]);
  return [
    ...appointments.map(row => bufferedEvent(row.startAt.getTime(), row.endAt.getTime(), row.beforeMinutes, row.afterMinutes))
      .filter(event => overlaps(event, range)),
    ...habitBusyIntervals(habits.projection, range),
  ];
}

export function prismaMeetingStore(db: PrismaClient = prisma): MeetingStore {
  async function bookOnce(command: BookCommand): Promise<BookOutcome> {
    const result = await runIdempotentCommand<BookingRequest, BookOutcome["body"]>({
      clientId: command.clientId,
      operation: "meetings.book",
      idempotencyKey: command.idempotencyKey,
      request: command.request,
      execute: async tx => {
        if (!command.slotAllowed) return { kind: "success", ...slotUnavailable };
        const range = { start: command.start.getTime(), end: command.end.getTime() };
        const overlapping = await tx.meeting.findFirst({
          where: bufferedMeetingWhere(command.ownerId, range),
          select: { id: true },
        });
        if (overlapping || (await otherCalendarBusy(tx, command.ownerId, range)).length) {
          return { kind: "success", ...slotUnavailable };
        }
        const held = await tx.meeting.count({
          where: { guestEmail: command.guestEmail, status: "booked", start: { gt: command.now } },
        });
        if (held >= command.maxFutureMeetingsPerEmail) return { kind: "success", ...meetingLimitReached };
        const meeting = await tx.meeting.create({
          data: {
            ownerId: command.ownerId,
            start: command.start,
            end: command.end,
            guestName: command.request.name,
            guestEmail: command.guestEmail,
            note: command.request.note ?? null,
            jitsiRoom: command.jitsiRoom,
            cancelTokenHash: hashCancelToken(command.cancelToken),
            pendingCancelToken: command.cancelToken,
          },
          select: { id: true, start: true, end: true },
        });
        return { kind: "success", status: 201, body: receipt(meeting) };
      },
    }, db);
    if (result.kind === "conflict") {
      return { status: 409, body: { code: "IDEMPOTENCY_CONFLICT", message: result.message } };
    }
    return { status: result.status, body: result.body } as BookOutcome;
  }

  return {
    async settings(ownerId) {
      const row = await db.meetingSettings.findUnique({ where: { ownerId } });
      if (!row) return defaultMeetingSettings;
      const hours = weeklyHoursSchema.safeParse(row.weeklyHours);
      return {
        timeZone: row.timeZone,
        weeklyHours: hours.success ? hours.data : {},
        noticeMinutes: row.noticeMinutes,
        horizonDays: row.horizonDays,
      };
    },
    async calendarBusyBetween(ownerId, range) {
      const [meetings, other] = await Promise.all([
        db.meeting.findMany({
          where: bufferedMeetingWhere(ownerId, range),
          select: { start: true, end: true },
        }),
        otherCalendarBusy(db, ownerId, range),
      ]);
      return [...meetings.map(row => bufferedEvent(row.start.getTime(), row.end.getTime())), ...other];
    },
    async book(command) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await bookOnce(command);
        } catch (error) {
          // The partial unique index on booked starts caught a concurrent booking.
          if (isUniqueViolation(error)) return slotUnavailable;
          // A retry sees the winner's committed meeting (409) or this key's stored result.
          if (isWriteConflict(error) && attempt < maxBookingAttempts) {
            await Bun.sleep(Math.random() * 20 * attempt);
            continue;
          }
          throw error;
        }
      }
    },
    async cancel({ ownerId, cancelTokenHash, now }) {
      const meeting = await db.meeting.findUnique({
        where: { cancelTokenHash },
        select: { id: true, ownerId: true, start: true, end: true, status: true },
      });
      if (!meeting || meeting.ownerId !== ownerId) return meetingNotFound;
      if (meeting.status === "cancelled") return { status: 200, body: receipt(meeting) };
      if (meeting.start <= now) return meetingStarted;
      await db.meeting.updateMany({
        where: { id: meeting.id, status: "booked" },
        data: { status: "cancelled", cancelledAt: now, pendingCancelToken: null },
      });
      return { status: 200, body: receipt(meeting) };
    },
  };
}
