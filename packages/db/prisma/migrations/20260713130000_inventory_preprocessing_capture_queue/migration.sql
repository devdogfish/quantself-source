-- CreateEnum
CREATE TYPE "InventoryPreprocessingState" AS ENUM (
    'QUEUED',
    'PROCESSING',
    'READY_FOR_ENRICHMENT',
    'PARTIAL',
    'NEEDS_REVIEW',
    'FAILED'
);

-- AlterTable
ALTER TABLE "inventory_item"
ADD COLUMN "captureText" TEXT;

-- CreateTable
CREATE TABLE "inventory_item_audio" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_audio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_preprocessing_job" (
    "id" TEXT NOT NULL,
    "targetItemId" TEXT NOT NULL,
    "state" "InventoryPreprocessingState" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "sourceRefs" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_preprocessing_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_item_audio_itemId_idx" ON "inventory_item_audio"("itemId");

-- CreateIndex
CREATE INDEX "inventory_preprocessing_job_state_leaseExpiresAt_createdAt_idx" ON "inventory_preprocessing_job"("state", "leaseExpiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_preprocessing_job_targetItemId_createdAt_idx" ON "inventory_preprocessing_job"("targetItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "inventory_item_audio"
ADD CONSTRAINT "inventory_item_audio_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_preprocessing_job"
ADD CONSTRAINT "inventory_preprocessing_job_targetItemId_fkey"
FOREIGN KEY ("targetItemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
