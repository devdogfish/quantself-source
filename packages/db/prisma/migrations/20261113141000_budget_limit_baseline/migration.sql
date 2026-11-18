-- A previous Plan may have had no limit configured. Keep that distinct from zero.
ALTER TABLE "budget_weekly_limit" ALTER COLUMN "cents" DROP NOT NULL;
