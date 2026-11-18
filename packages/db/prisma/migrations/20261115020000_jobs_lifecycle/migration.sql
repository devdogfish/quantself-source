ALTER TYPE "JobApplicationStatus" ADD VALUE 'interviewing';
ALTER TYPE "JobApplicationStatus" ADD VALUE 'offer';
ALTER TYPE "JobApplicationStatus" ADD VALUE 'withdrawn';

ALTER TABLE "job_application"
  ADD COLUMN "lifecycleRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
  ADD COLUMN "sourceReply" JSONB;

CREATE TABLE "job_interview" (
  "id" UUID PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL,
  "applicationUrl" TEXT NOT NULL,
  "todoNumber" INTEGER,
  CONSTRAINT "job_interview_time_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "job_interview_application_fkey" FOREIGN KEY ("ownerId", "applicationId")
    REFERENCES "job_application" ("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "job_interview_ownerId_applicationId_startAt_key"
  ON "job_interview" ("ownerId", "applicationId", "startAt");
