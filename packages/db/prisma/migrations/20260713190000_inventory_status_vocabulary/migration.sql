-- Rename preprocessing workflow vocabulary from state to status.
ALTER TABLE "inventory_preprocessing_job"
RENAME COLUMN "state" TO "status";

ALTER TYPE "InventoryPreprocessingState"
RENAME TO "InventoryPreprocessingStatus";

ALTER INDEX "inventory_preprocessing_job_state_leaseExpiresAt_createdAt_idx"
RENAME TO "inventory_preprocessing_job_status_leaseExpiresAt_createdAt_idx";

-- Enrichment status already represents pending approval, applied, and rejected.
ALTER TABLE "inventory_enrichment_job"
DROP COLUMN "approvalState";

DROP TYPE "InventoryEnrichmentApprovalState";
