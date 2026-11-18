-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('booked', 'cancelled');

-- CreateTable
CREATE TABLE "meeting" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "start" TIMESTAMPTZ(3) NOT NULL,
    "end" TIMESTAMPTZ(3) NOT NULL,
    "guestName" VARCHAR(100) NOT NULL,
    "guestEmail" VARCHAR(254) NOT NULL,
    "note" VARCHAR(1000),
    "jitsiRoom" VARCHAR(64) NOT NULL,
    "cancelTokenHash" CHAR(64) NOT NULL,
    "pendingCancelToken" VARCHAR(64),
    "status" "MeetingStatus" NOT NULL DEFAULT 'booked',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "confirmationSentAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "cancellationSentAt" TIMESTAMP(3),

    CONSTRAINT "meeting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meeting_end_after_start" CHECK ("end" > "start")
);

-- CreateTable
CREATE TABLE "meeting_settings" (
    "ownerId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'America/Halifax',
    "weeklyHours" JSONB NOT NULL,
    "noticeMinutes" INTEGER NOT NULL DEFAULT 720,
    "horizonDays" INTEGER NOT NULL DEFAULT 14,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_settings_pkey" PRIMARY KEY ("ownerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_jitsiRoom_key" ON "meeting"("jitsiRoom");
CREATE UNIQUE INDEX "meeting_cancelTokenHash_key" ON "meeting"("cancelTokenHash");
CREATE INDEX "meeting_ownerId_start_idx" ON "meeting"("ownerId", "start");
CREATE INDEX "meeting_guestEmail_start_idx" ON "meeting"("guestEmail", "start");

-- Slots are 30-minute aligned, so one booked meeting per start is the database's
-- last line of defence against double booking under concurrent requests.
CREATE UNIQUE INDEX "meeting_owner_booked_start_key" ON "meeting"("ownerId", "start") WHERE "status" = 'booked';
