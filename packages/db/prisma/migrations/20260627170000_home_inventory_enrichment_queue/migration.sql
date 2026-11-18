-- CreateEnum
CREATE TYPE "HomeInventoryEnrichmentTargetRecordType" AS ENUM ('INVENTORY_ITEM');

-- CreateEnum
CREATE TYPE "HomeInventoryEnrichmentJobKind" AS ENUM ('HOME_INVENTORY_ITEM_CAPTURED');

-- CreateEnum
CREATE TYPE "EnrichmentQueueJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PENDING_APPROVAL', 'APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "home_inventory_enrichment_queue_job" (
    "id" TEXT NOT NULL,
    "targetRecordType" "HomeInventoryEnrichmentTargetRecordType" NOT NULL,
    "targetRecordId" TEXT NOT NULL,
    "jobKind" "HomeInventoryEnrichmentJobKind" NOT NULL,
    "status" "EnrichmentQueueJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "inputVersion" INTEGER NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "resultPayload" JSONB,
    "failureDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_inventory_enrichment_queue_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "home_inventory_enrichment_queue_job_status_createdAt_idx" ON "home_inventory_enrichment_queue_job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "home_inventory_enrichment_queue_job_targetRecordType_targetRecordId_idx" ON "home_inventory_enrichment_queue_job"("targetRecordType", "targetRecordId");

-- CreateIndex
CREATE INDEX "home_inventory_enrichment_queue_job_jobKind_status_createdAt_idx" ON "home_inventory_enrichment_queue_job"("jobKind", "status", "createdAt");
