import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { prisma } from "@quantself/db";
import type { MeetingSettingsValue } from "./meetings-availability";
import { meetingNotFound, meetingStarted, prismaMeetingStore, receipt, type CancelOutcome } from "./meetings-store";

export type OwnerMeeting = {
  id: string;
  start: Date;
  end: Date;
  guestName: string;
  guestEmail: string;
  note: string | null;
  jitsiRoom: string;
};

/** Owner-facing reads and writes. Guest cancel tokens never leave the booking store. */
export interface OwnerMeetingStore {
  settings(ownerId: string): Promise<MeetingSettingsValue>;
  saveSettings(ownerId: string, value: MeetingSettingsValue): Promise<MeetingSettingsValue>;
  /** Booked meetings overlapping [from, to), oldest first. */
  booked(ownerId: string, from: Date, to: Date): Promise<OwnerMeeting[]>;
  cancel(input: { ownerId: string; id: string; now: Date }): Promise<CancelOutcome>;
}

export function prismaOwnerMeetingStore(db: PrismaClient = prisma): OwnerMeetingStore {
  const booking = prismaMeetingStore(db);
  return {
    settings: ownerId => booking.settings(ownerId),
    async saveSettings(ownerId, value) {
      const data = {
        timeZone: value.timeZone,
        weeklyHours: value.weeklyHours,
        noticeMinutes: value.noticeMinutes,
        horizonDays: value.horizonDays,
      };
      await db.meetingSettings.upsert({ where: { ownerId }, create: { ownerId, ...data }, update: data });
      return value;
    },
    booked: (ownerId, from, to) => db.meeting.findMany({
      where: { ownerId, status: "booked", start: { lt: to }, end: { gt: from } },
      orderBy: { start: "asc" },
      select: { id: true, start: true, end: true, guestName: true, guestEmail: true, note: true, jitsiRoom: true },
      take: 500,
    }),
    async cancel({ ownerId, id, now }) {
      const meeting = await db.meeting.findFirst({
        where: { id, ownerId },
        select: { id: true, start: true, end: true, status: true },
      });
      if (!meeting) return meetingNotFound;
      if (meeting.status === "cancelled") return { status: 200, body: receipt(meeting) };
      if (meeting.start <= now) return meetingStarted;
      // The email worker sends the guest and Owner cancellation once the status changes.
      await db.meeting.updateMany({
        where: { id, ownerId, status: "booked" },
        data: { status: "cancelled", cancelledAt: now, pendingCancelToken: null },
      });
      return { status: 200, body: receipt(meeting) };
    },
  };
}
