import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import type { NativeReminderAppointment } from "./notifications-plan";
import type { NativeAppointmentReminderReader } from "./notifications";

type AppointmentRow = Omit<NativeReminderAppointment, "start" | "cancelledAt"> & {
  startAt: Date;
  cancelledAt: Date | null;
};

const appointmentRows = Prisma.sql`
  SELECT a."id", a."startAt", a."beforeMinutes", a."alertMinutes", a."revision", a."cancelledAt",
         i."ownerId", i."applicationId", i."title", i."source"::text AS "source"
  FROM "job_interview_appointment" a
  JOIN "job_interview" i ON i."id" = a."id"
  WHERE i."source" = 'native'`;

export function createNativeAppointmentReminderReader(
  db: Pick<PrismaClient, "$queryRaw">,
): NativeAppointmentReminderReader {
  async function read(query: Prisma.Sql): Promise<NativeReminderAppointment[]> {
    const rows = await db.$queryRaw<AppointmentRow[]>(query);
    return rows.map(({ startAt, cancelledAt, ...row }) => ({
      ...row,
      start: startAt.toISOString(),
      cancelledAt: cancelledAt?.toISOString() ?? null,
    }));
  }

  return {
    async listDue({ ownerIds, now }) {
      if (!ownerIds.length) return [];
      const at = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
      // The start index narrows the scan before the row-specific prep and lead checks.
      // Storage caps prep at 1440 minutes and alert lead at 10080 minutes.
      return read(Prisma.sql`${appointmentRows}
        AND i."ownerId" IN (${Prisma.join(ownerIds)})
        AND a."startAt" > ${at}
        AND a."startAt" <= ${at} + interval '11520 minutes'
        AND a."cancelledAt" IS NULL AND a."alertMinutes" IS NOT NULL
        AND a."startAt" - a."beforeMinutes" * interval '1 minute' > ${at}
        AND a."startAt" - (a."beforeMinutes" + a."alertMinutes") * interval '1 minute' <= ${at}`);
    },
    async readCurrent(appointments) {
      if (!appointments.length) return [];
      return read(Prisma.sql`${appointmentRows}
        AND (i."ownerId", a."id") IN (
          SELECT target."ownerId", target."id"
          FROM jsonb_to_recordset(${JSON.stringify(appointments)}::jsonb) AS target("ownerId" text, "id" uuid)
        )`);
    },
  };
}
