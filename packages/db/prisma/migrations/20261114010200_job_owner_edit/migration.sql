ALTER TABLE "job_application" ADD COLUMN "lastOwnerEditedAt" TIMESTAMP(3);

-- Treat recently touched applications as protected during rollout.
UPDATE "job_application"
SET "lastOwnerEditedAt" = "updatedAt"
WHERE "updatedAt" > CURRENT_TIMESTAMP - INTERVAL '3 minutes';
