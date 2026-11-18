-- CreateEnum
CREATE TYPE "JobApplicationStatus" AS ENUM ('draft', 'review', 'approved', 'queued', 'submitting', 'applied', 'skipped', 'rejected', 'needs_attention');

-- CreateEnum
CREATE TYPE "JobResumeTrack" AS ENUM ('engineering', 'web', 'admin');

-- CreateEnum
CREATE TYPE "JobWorkKind" AS ENUM ('revise', 'submit');

-- CreateEnum
CREATE TYPE "JobWorkState" AS ENUM ('queued', 'claimed', 'finished', 'superseded');

-- CreateEnum
CREATE TYPE "JobIssueCode" AS ENUM ('model_error', 'unsupported_portal', 'manual_required', 'runner_unavailable', 'submission_uncertain');

-- CreateEnum
CREATE TYPE "JobReceiptCode" AS ENUM ('confirmation_page', 'confirmation_message');

-- CreateTable
CREATE TABLE "job_application" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "sourceStatus" TEXT,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "location" TEXT,
    "salary" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "resumeTrack" "JobResumeTrack" NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" "JobApplicationStatus" NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "approvedRevision" INTEGER,
    "revisionPending" BOOLEAN NOT NULL DEFAULT false,
    "issueCode" "JobIssueCode",
    "receiptCode" "JobReceiptCode",
    "submitLeaseUntil" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_application_pkey" PRIMARY KEY ("ownerId","id")
);

-- CreateTable
CREATE TABLE "job_work" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "JobWorkKind" NOT NULL,
    "state" "JobWorkState" NOT NULL DEFAULT 'queued',
    "revision" INTEGER NOT NULL,
    "instructions" TEXT,
    "tokenHash" TEXT,
    "claimedBy" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "resultHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_work_pkey" PRIMARY KEY ("ownerId","id")
);

-- CreateIndex
CREATE INDEX "job_application_ownerId_createdAt_id_idx" ON "job_application"("ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "job_application_ownerId_status_submitLeaseUntil_idx" ON "job_application"("ownerId", "status", "submitLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "job_application_ownerId_sourceKey_key" ON "job_application"("ownerId", "sourceKey");

-- CreateIndex
CREATE INDEX "job_work_ownerId_kind_state_createdAt_id_idx" ON "job_work"("ownerId", "kind", "state", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_work_ownerId_applicationId_kind_revision_key" ON "job_work"("ownerId", "applicationId", "kind", "revision");

-- AddForeignKey
ALTER TABLE "job_work" ADD CONSTRAINT "job_work_ownerId_applicationId_fkey" FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

