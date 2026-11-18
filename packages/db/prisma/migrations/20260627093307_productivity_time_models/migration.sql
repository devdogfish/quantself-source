-- CreateEnum
CREATE TYPE "EntrySource" AS ENUM ('MANUAL', 'TIMER', 'IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "SessionLocation" AS ENUM ('DESK', 'STANDING', 'TV', 'OUTSIDE', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkSessionMode" AS ENUM ('UNSPECIFIED', 'DEEP_WORK', 'ADMIN', 'REVIEW', 'PLANNING', 'LEARNING', 'OTHER');

-- CreateEnum
CREATE TYPE "RecoverySessionMode" AS ENUM ('STILLNESS', 'BREATHING', 'MOVEMENT', 'FOOD_WATER', 'OUTSIDE_WALK', 'OTHER');

-- CreateEnum
CREATE TYPE "MealKind" AS ENUM ('UNSPECIFIED', 'BREAKFAST', 'LUNCH', 'DINNER', 'SNACK', 'OTHER');

-- CreateTable
CREATE TABLE "work_session" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "mode" "WorkSessionMode" NOT NULL DEFAULT 'UNSPECIFIED',
    "source" "EntrySource" NOT NULL DEFAULT 'MANUAL',
    "location" "SessionLocation",
    "outcome" TEXT,
    "productivityScore" INTEGER,
    "exhaustionScore" INTEGER,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_session_pkey" PRIMARY KEY ("id")
);

-- AddCheck
ALTER TABLE "work_session" ADD CONSTRAINT "work_session_productivityScore_range_check" CHECK ("productivityScore" IS NULL OR ("productivityScore" >= 1 AND "productivityScore" <= 100));

-- AddCheck
ALTER TABLE "work_session" ADD CONSTRAINT "work_session_exhaustionScore_range_check" CHECK ("exhaustionScore" IS NULL OR ("exhaustionScore" >= 1 AND "exhaustionScore" <= 100));

-- CreateTable
CREATE TABLE "recovery_session" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "mode" "RecoverySessionMode" NOT NULL,
    "source" "EntrySource" NOT NULL DEFAULT 'MANUAL',
    "location" "SessionLocation",
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "kind" "MealKind" NOT NULL DEFAULT 'UNSPECIFIED',
    "source" "EntrySource" NOT NULL DEFAULT 'MANUAL',
    "location" "SessionLocation",
    "title" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "substance_intake" ADD COLUMN "mealId" TEXT;

-- CreateIndex
CREATE INDEX "work_session_startedAt_idx" ON "work_session"("startedAt");

-- CreateIndex
CREATE INDEX "work_session_source_startedAt_idx" ON "work_session"("source", "startedAt");

-- CreateIndex
CREATE INDEX "work_session_mode_startedAt_idx" ON "work_session"("mode", "startedAt");

-- CreateIndex
CREATE INDEX "work_session_location_startedAt_idx" ON "work_session"("location", "startedAt");

-- CreateIndex
CREATE INDEX "recovery_session_startedAt_idx" ON "recovery_session"("startedAt");

-- CreateIndex
CREATE INDEX "recovery_session_source_startedAt_idx" ON "recovery_session"("source", "startedAt");

-- CreateIndex
CREATE INDEX "recovery_session_mode_startedAt_idx" ON "recovery_session"("mode", "startedAt");

-- CreateIndex
CREATE INDEX "recovery_session_location_startedAt_idx" ON "recovery_session"("location", "startedAt");

-- CreateIndex
CREATE INDEX "meal_startedAt_idx" ON "meal"("startedAt");

-- CreateIndex
CREATE INDEX "meal_source_startedAt_idx" ON "meal"("source", "startedAt");

-- CreateIndex
CREATE INDEX "meal_kind_startedAt_idx" ON "meal"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "meal_location_startedAt_idx" ON "meal"("location", "startedAt");

-- CreateIndex
CREATE INDEX "substance_intake_mealId_idx" ON "substance_intake"("mealId");

-- AddForeignKey
ALTER TABLE "substance_intake" ADD CONSTRAINT "substance_intake_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
