CREATE TYPE "JobReviewLane" AS ENUM ('quick', 'tailored');

ALTER TABLE "job_application"
  ADD COLUMN "resumeMarkdown" TEXT,
  ADD COLUMN "hasResumeMarkdown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvedPreviewDigest" TEXT,
  ADD COLUMN "reviewLane" "JobReviewLane" NOT NULL DEFAULT 'quick',
  ADD CONSTRAINT "job_application_resume_markdown_presence"
    CHECK ("hasResumeMarkdown" = ("resumeMarkdown" IS NOT NULL));

UPDATE "job_application"
SET "reviewLane" = 'tailored'
WHERE "resumeTrack" = 'engineering' OR "company" ~*
  '^[[:space:]]*(deloitte|rbc|royal[[:space:]]*bank|bell|nova[[:space:]]+scotia[[:space:]]+power|ibm)($|[[:space:],./(&-])';

CREATE INDEX "job_application_owner_lane_status_idx" ON "job_application" ("ownerId", "reviewLane", "status");
