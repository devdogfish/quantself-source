CREATE TYPE "InventoryEnrichmentJobKind" AS ENUM ('INVENTORY_ITEM_ENRICHMENT', 'INVENTORY_ITEM_IMAGE_ENRICHMENT');

CREATE TYPE "InventoryEnrichmentJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'FAILED', 'CANCELLED');

CREATE TYPE "InventoryEnrichmentApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NOT_REQUIRED');

CREATE TABLE "inventory_enrichment_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "approvalsRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_enrichment_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_enrichment_job" (
    "id" TEXT NOT NULL,
    "kind" "InventoryEnrichmentJobKind" NOT NULL,
    "targetItemId" TEXT NOT NULL,
    "targetImageId" TEXT,
    "status" "InventoryEnrichmentJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "inputSnapshot" JSONB NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "resultPayload" JSONB,
    "resultId" TEXT,
    "failureDetail" JSONB,
    "approvalState" "InventoryEnrichmentApprovalState",
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_enrichment_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_enrichment_job_resultId_key" ON "inventory_enrichment_job"("resultId");

CREATE INDEX "inventory_enrichment_job_status_leaseExpiresAt_createdAt_idx" ON "inventory_enrichment_job"("status", "leaseExpiresAt", "createdAt");

CREATE INDEX "inventory_enrichment_job_targetItemId_createdAt_idx" ON "inventory_enrichment_job"("targetItemId", "createdAt");

CREATE INDEX "inventory_enrichment_job_targetImageId_createdAt_idx" ON "inventory_enrichment_job"("targetImageId", "createdAt");

ALTER TABLE "inventory_enrichment_job" ADD CONSTRAINT "inventory_enrichment_job_targetItemId_fkey" FOREIGN KEY ("targetItemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_enrichment_job" ADD CONSTRAINT "inventory_enrichment_job_targetImageId_fkey" FOREIGN KEY ("targetImageId") REFERENCES "inventory_item_image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
