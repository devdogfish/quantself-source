CREATE TYPE "JobVerdict" AS ENUM ('strong', 'review', 'weak');
CREATE TYPE "JobRevisionAuthor" AS ENUM ('owner', 'agent');
CREATE TYPE "JobWorkItemKind" AS ENUM ('enrich', 'tailor', 'revise', 'render', 'submit');
CREATE TYPE "JobWorkItemState" AS ENUM ('queued', 'claimed', 'done', 'failed');

ALTER TABLE "job_application"
  ADD COLUMN "workflowVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "brief" JSONB,
  ADD COLUMN "verdict" "JobVerdict",
  ADD COLUMN "receipt" JSONB;

CREATE TABLE "job_revision" (
  "ownerId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "summaryMarkdown" TEXT NOT NULL,
  "resumeMarkdown" TEXT,
  "author" "JobRevisionAuthor",
  "pdfReference" TEXT,
  "pdfSha256" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_revision_pkey" PRIMARY KEY ("ownerId", "applicationId", "revision"),
  CONSTRAINT "job_revision_pdf_binding" CHECK (
    ("pdfReference" IS NULL AND "pdfSha256" IS NULL) OR
    ("pdfReference" IS NOT NULL AND "pdfSha256" IS NOT NULL AND "pdfSha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "job_revision_ownerId_applicationId_fkey"
    FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "job_work_item" (
  "ownerId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "kind" "JobWorkItemKind" NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" "JobWorkItemState" NOT NULL DEFAULT 'queued',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseTokenHash" TEXT,
  "claimedBy" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "resultId" TEXT,
  "resultHash" TEXT,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_work_item_pkey" PRIMARY KEY ("ownerId", "id"),
  CONSTRAINT "job_work_item_ownerId_applicationId_fkey"
    FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "job_work_item_ownerId_applicationId_kind_revision_key"
  ON "job_work_item"("ownerId", "applicationId", "kind", "revision");
CREATE INDEX "job_work_item_claim_idx"
  ON "job_work_item"("ownerId", "kind", "state", "availableAt", "createdAt", "id");

CREATE TABLE "job_event" (
  "ownerId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "revision" INTEGER,
  "eventKey" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_event_pkey" PRIMARY KEY ("ownerId", "id"),
  CONSTRAINT "job_event_ownerId_applicationId_fkey"
    FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "job_event_ownerId_applicationId_eventKey_key"
  ON "job_event"("ownerId", "applicationId", "eventKey");
CREATE INDEX "job_event_ownerId_applicationId_occurredAt_id_idx"
  ON "job_event"("ownerId", "applicationId", "occurredAt", "id");
