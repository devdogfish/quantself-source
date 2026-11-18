CREATE TYPE "JobInterviewSource" AS ENUM ('github', 'native');

ALTER TABLE "job_interview"
  ADD COLUMN "source" "JobInterviewSource" NOT NULL DEFAULT 'github',
  ADD CONSTRAINT "job_interview_native_has_no_issue_number" CHECK ("source" = 'github' OR "todoNumber" IS NULL);

CREATE TABLE "job_interview_appointment" (
  "id" UUID PRIMARY KEY,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "cancelledAt" TIMESTAMP(3),
  "beforeMinutes" INTEGER NOT NULL DEFAULT 0,
  "afterMinutes" INTEGER NOT NULL DEFAULT 0,
  "alertMinutes" INTEGER DEFAULT 10,
  "creationAuditId" TEXT CONSTRAINT "job_interview_appointment_creationAuditId_key" UNIQUE,
  CONSTRAINT "job_interview_appointment_buffers_check" CHECK ("beforeMinutes" BETWEEN 0 AND 1440 AND "afterMinutes" BETWEEN 0 AND 1440),
  CONSTRAINT "job_interview_appointment_alert_check" CHECK ("alertMinutes" BETWEEN 1 AND 10080),
  CONSTRAINT "job_interview_appointment_time_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "job_interview_appointment_interview_fkey" FOREIGN KEY ("id")
    REFERENCES "job_interview" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "job_interview_appointment_audit_fkey" FOREIGN KEY ("creationAuditId")
    REFERENCES "agent_write_audit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "job_interview_appointment_start_idx" ON "job_interview_appointment" ("startAt", "id");
