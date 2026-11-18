ALTER TABLE "job_pilot_permit"
  ADD COLUMN "settledKeepResultId" UUID,
  ADD COLUMN "screenedPostingDigest" TEXT,
  ADD CONSTRAINT "job_pilot_permit_screen_result" CHECK (
    ("settledKeepResultId" IS NULL AND "screenedPostingDigest" IS NULL)
    OR ("settledKeepResultId" IS NOT NULL AND "screenedPostingDigest" IS NOT NULL
      AND "screenedPostingDigest" ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX "job_pilot_permit_settledKeepResultId_key" ON "job_pilot_permit" ("settledKeepResultId");
