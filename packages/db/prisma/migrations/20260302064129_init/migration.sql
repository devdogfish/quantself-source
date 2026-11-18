-- CreateEnum
CREATE TYPE "DayType" AS ENUM ('workday', 'free_day');

-- CreateEnum
CREATE TYPE "SleepSource" AS ENUM ('manual', 'wearable', 'import_');

-- CreateEnum
CREATE TYPE "SleepState" AS ENUM ('sleep', 'wake');

-- CreateEnum
CREATE TYPE "HrContext" AS ENUM ('overnight', 'resting', 'active', 'manual');

-- CreateEnum
CREATE TYPE "HrvContext" AS ENUM ('overnight', 'resting', 'manual');

-- CreateEnum
CREATE TYPE "WeightSource" AS ENUM ('manual', 'smart_scale');

-- CreateEnum
CREATE TYPE "VitalsSource" AS ENUM ('wearable', 'manual');

-- CreateEnum
CREATE TYPE "TagType" AS ENUM ('caffeine', 'alcohol', 'late_meal', 'supplements', 'intense_exercise', 'sick', 'travel', 'stress', 'meditation', 'nap_tag');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('coffee_cups', 'alcohol_units', 'water_liters', 'smoking', 'screen_time_hrs', 'meditation_min');

-- CreateEnum
CREATE TYPE "SpendingCategory" AS ENUM ('housing', 'food', 'transport', 'subscriptions', 'entertainment', 'healthcare', 'shopping', 'utilities', 'savings', 'investment', 'other');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('expense', 'income', 'transfer');

-- CreateEnum
CREATE TYPE "MuscleGroup" AS ENUM ('chest', 'back', 'shoulders', 'quads', 'hamstrings', 'arms', 'glutes', 'core');

-- CreateEnum
CREATE TYPE "ExerciseCategory" AS ENUM ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight');

-- CreateEnum
CREATE TYPE "PhotoPose" AS ENUM ('front', 'side', 'back');

-- CreateTable
CREATE TABLE "daily_log" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" "LogCategory" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_tag" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tag" "TagType" NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_vitals" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "restingHr" INTEGER,
    "steps" INTEGER,
    "recoveryScore" INTEGER,
    "source" "VitalsSource" NOT NULL DEFAULT 'wearable',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "muscleGroup" "MuscleGroup" NOT NULL,
    "category" "ExerciseCategory" NOT NULL,
    "isCompound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_financial_snapshot" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalIncome" DOUBLE PRECISION NOT NULL,
    "totalExpenses" DOUBLE PRECISION NOT NULL,
    "totalSavings" DOUBLE PRECISION NOT NULL,
    "savingsRate" DOUBLE PRECISION NOT NULL,
    "fixedExpenses" DOUBLE PRECISION NOT NULL,
    "variableExpenses" DOUBLE PRECISION NOT NULL,
    "netWorth" DOUBLE PRECISION NOT NULL,
    "passiveIncome" DOUBLE PRECISION NOT NULL,
    "spendHousing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendFood" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendTransport" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendSubscriptions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendEntertainment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendOther" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_financial_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_health_snapshot" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "creditScore" INTEGER NOT NULL,
    "creditScoreTarget" INTEGER NOT NULL,
    "fiNumber" DOUBLE PRECISION NOT NULL,
    "fiProgress" DOUBLE PRECISION NOT NULL,
    "investmentFees" DOUBLE PRECISION NOT NULL,
    "investmentFeesTarget" DOUBLE PRECISION NOT NULL,
    "emergencyFundMonths" DOUBLE PRECISION NOT NULL,
    "emergencyFundTarget" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_health_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_yearly_spend" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "category" "SpendingCategory" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "category_yearly_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heart_rate_reading" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "valueBpm" INTEGER NOT NULL,
    "context" "HrContext" NOT NULL,
    "sleepSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "heart_rate_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hrv_reading" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "valueMs" DOUBLE PRECISION NOT NULL,
    "context" "HrvContext" NOT NULL,
    "sleepSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hrv_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lift_goal" (
    "id" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "targetE1rmKg" DOUBLE PRECISION NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lift_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mood_log" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "energy" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_photo" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "pose" "PhotoPose" NOT NULL,
    "filePath" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_session" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sleepOnset" TIMESTAMP(3) NOT NULL,
    "sleepOffset" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "midsleepTime" TIMESTAMP(3) NOT NULL,
    "sleepLatencyMin" INTEGER,
    "qualityScore" INTEGER,
    "dayType" "DayType" NOT NULL DEFAULT 'workday',
    "wasoMin" INTEGER,
    "awakeningCount" INTEGER,
    "isNap" BOOLEAN NOT NULL DEFAULT false,
    "source" "SleepSource" NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sleep_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_epoch" (
    "id" TEXT NOT NULL,
    "sleepSessionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "state" "SleepState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sleep_epoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_biofeedback" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "soreness" INTEGER NOT NULL,
    "stress" INTEGER NOT NULL,
    "fatigue" INTEGER NOT NULL,
    "insight" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_biofeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "TransactionType" NOT NULL DEFAULT 'expense',
    "category" "SpendingCategory" NOT NULL,
    "merchant" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL,
    "heightCm" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_log" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "valueKg" DOUBLE PRECISION NOT NULL,
    "bodyFatPct" DOUBLE PRECISION,
    "source" "WeightSource" NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weight_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT,
    "durationMin" INTEGER,
    "isDeload" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_set" (
    "id" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "setOrder" INTEGER NOT NULL,
    "weightKg" DOUBLE PRECISION NOT NULL,
    "reps" INTEGER NOT NULL,
    "rpe" DOUBLE PRECISION,
    "isWarmup" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "workout_set_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_log_date_idx" ON "daily_log"("date");

-- CreateIndex
CREATE INDEX "daily_log_category_idx" ON "daily_log"("category");

-- CreateIndex
CREATE INDEX "daily_tag_date_idx" ON "daily_tag"("date");

-- CreateIndex
CREATE INDEX "daily_tag_tag_idx" ON "daily_tag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "daily_vitals_date_key" ON "daily_vitals"("date");

-- CreateIndex
CREATE INDEX "daily_vitals_date_idx" ON "daily_vitals"("date");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_name_key" ON "exercise"("name");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_financial_snapshot_month_key" ON "monthly_financial_snapshot"("month");

-- CreateIndex
CREATE UNIQUE INDEX "financial_health_snapshot_month_key" ON "financial_health_snapshot"("month");

-- CreateIndex
CREATE UNIQUE INDEX "category_yearly_spend_year_category_key" ON "category_yearly_spend"("year", "category");

-- CreateIndex
CREATE INDEX "heart_rate_reading_timestamp_idx" ON "heart_rate_reading"("timestamp");

-- CreateIndex
CREATE INDEX "heart_rate_reading_sleepSessionId_idx" ON "heart_rate_reading"("sleepSessionId");

-- CreateIndex
CREATE INDEX "heart_rate_reading_context_idx" ON "heart_rate_reading"("context");

-- CreateIndex
CREATE INDEX "hrv_reading_timestamp_idx" ON "hrv_reading"("timestamp");

-- CreateIndex
CREATE INDEX "hrv_reading_sleepSessionId_idx" ON "hrv_reading"("sleepSessionId");

-- CreateIndex
CREATE INDEX "hrv_reading_context_idx" ON "hrv_reading"("context");

-- CreateIndex
CREATE INDEX "lift_goal_exerciseId_idx" ON "lift_goal"("exerciseId");

-- CreateIndex
CREATE INDEX "mood_log_date_idx" ON "mood_log"("date");

-- CreateIndex
CREATE INDEX "mood_log_timestamp_idx" ON "mood_log"("timestamp");

-- CreateIndex
CREATE INDEX "progress_photo_date_idx" ON "progress_photo"("date");

-- CreateIndex
CREATE INDEX "sleep_session_date_idx" ON "sleep_session"("date");

-- CreateIndex
CREATE INDEX "sleep_epoch_sleepSessionId_idx" ON "sleep_epoch"("sleepSessionId");

-- CreateIndex
CREATE INDEX "sleep_epoch_timestamp_idx" ON "sleep_epoch"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "training_biofeedback_date_key" ON "training_biofeedback"("date");

-- CreateIndex
CREATE INDEX "training_biofeedback_date_idx" ON "training_biofeedback"("date");

-- CreateIndex
CREATE INDEX "transaction_date_idx" ON "transaction"("date");

-- CreateIndex
CREATE INDEX "transaction_category_idx" ON "transaction"("category");

-- CreateIndex
CREATE INDEX "weight_log_date_idx" ON "weight_log"("date");

-- CreateIndex
CREATE INDEX "workout_date_idx" ON "workout"("date");

-- CreateIndex
CREATE INDEX "workout_set_workoutId_idx" ON "workout_set"("workoutId");

-- CreateIndex
CREATE INDEX "workout_set_exerciseId_idx" ON "workout_set"("exerciseId");

-- AddForeignKey
ALTER TABLE "heart_rate_reading" ADD CONSTRAINT "heart_rate_reading_sleepSessionId_fkey" FOREIGN KEY ("sleepSessionId") REFERENCES "sleep_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hrv_reading" ADD CONSTRAINT "hrv_reading_sleepSessionId_fkey" FOREIGN KEY ("sleepSessionId") REFERENCES "sleep_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lift_goal" ADD CONSTRAINT "lift_goal_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_epoch" ADD CONSTRAINT "sleep_epoch_sleepSessionId_fkey" FOREIGN KEY ("sleepSessionId") REFERENCES "sleep_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;
