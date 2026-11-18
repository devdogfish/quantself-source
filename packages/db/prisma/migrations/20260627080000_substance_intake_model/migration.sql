-- CreateEnum
CREATE TYPE "SubstanceCategory" AS ENUM ('BEVERAGE', 'SUPPLEMENT', 'MEDICATION', 'ALCOHOL', 'CANNABIS', 'TOBACCO', 'DRUG', 'HOMEOPATHY', 'OTHER');

-- CreateEnum
CREATE TYPE "IntakePrecision" AS ENUM ('MEASURED', 'ESTIMATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntakeRoute" AS ENUM ('DRINK', 'EAT', 'SWALLOW', 'SMOKE', 'VAPE', 'INHALE', 'SUBLINGUAL', 'TOPICAL', 'INJECTION', 'OTHER');

-- DropForeignKey
ALTER TABLE "heart_rate_reading" DROP CONSTRAINT "heart_rate_reading_sleepSessionId_fkey";

-- DropForeignKey
ALTER TABLE "hrv_reading" DROP CONSTRAINT "hrv_reading_sleepSessionId_fkey";

-- DropForeignKey
ALTER TABLE "lift_goal" DROP CONSTRAINT "lift_goal_exerciseId_fkey";

-- DropForeignKey
ALTER TABLE "sleep_epoch" DROP CONSTRAINT "sleep_epoch_sleepSessionId_fkey";

-- DropForeignKey
ALTER TABLE "workout_set" DROP CONSTRAINT "workout_set_workoutId_fkey";

-- DropForeignKey
ALTER TABLE "workout_set" DROP CONSTRAINT "workout_set_exerciseId_fkey";

-- DropTable
DROP TABLE "daily_log";

-- DropTable
DROP TABLE "daily_tag";

-- DropTable
DROP TABLE "daily_vitals";

-- DropTable
DROP TABLE "exercise";

-- DropTable
DROP TABLE "monthly_financial_snapshot";

-- DropTable
DROP TABLE "financial_health_snapshot";

-- DropTable
DROP TABLE "category_yearly_spend";

-- DropTable
DROP TABLE "heart_rate_reading";

-- DropTable
DROP TABLE "hrv_reading";

-- DropTable
DROP TABLE "lift_goal";

-- DropTable
DROP TABLE "mood_log";

-- DropTable
DROP TABLE "progress_photo";

-- DropTable
DROP TABLE "sleep_session";

-- DropTable
DROP TABLE "sleep_epoch";

-- DropTable
DROP TABLE "training_biofeedback";

-- DropTable
DROP TABLE "transaction";

-- DropTable
DROP TABLE "user_profile";

-- DropTable
DROP TABLE "weight_log";

-- DropTable
DROP TABLE "workout";

-- DropTable
DROP TABLE "workout_set";

-- DropEnum
DROP TYPE "DayType";

-- DropEnum
DROP TYPE "SleepSource";

-- DropEnum
DROP TYPE "SleepState";

-- DropEnum
DROP TYPE "HrContext";

-- DropEnum
DROP TYPE "HrvContext";

-- DropEnum
DROP TYPE "WeightSource";

-- DropEnum
DROP TYPE "VitalsSource";

-- DropEnum
DROP TYPE "TagType";

-- DropEnum
DROP TYPE "LogCategory";

-- DropEnum
DROP TYPE "SpendingCategory";

-- DropEnum
DROP TYPE "TransactionType";

-- DropEnum
DROP TYPE "MuscleGroup";

-- DropEnum
DROP TYPE "ExerciseCategory";

-- DropEnum
DROP TYPE "PhotoPose";

-- CreateTable
CREATE TABLE "substance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "SubstanceCategory" NOT NULL,
    "notes" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "substance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "substance_intake" (
    "id" TEXT NOT NULL,
    "substanceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION,
    "unit" TEXT,
    "precision" "IntakePrecision" NOT NULL DEFAULT 'ESTIMATED',
    "route" "IntakeRoute",
    "rawText" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "substance_intake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "substance_name_key" ON "substance"("name");

-- CreateIndex
CREATE INDEX "substance_category_idx" ON "substance"("category");

-- CreateIndex
CREATE INDEX "substance_intake_occurredAt_idx" ON "substance_intake"("occurredAt");

-- CreateIndex
CREATE INDEX "substance_intake_substanceId_occurredAt_idx" ON "substance_intake"("substanceId", "occurredAt");

-- CreateIndex
CREATE INDEX "substance_intake_route_idx" ON "substance_intake"("route");

-- AddForeignKey
ALTER TABLE "substance_intake" ADD CONSTRAINT "substance_intake_substanceId_fkey" FOREIGN KEY ("substanceId") REFERENCES "substance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
