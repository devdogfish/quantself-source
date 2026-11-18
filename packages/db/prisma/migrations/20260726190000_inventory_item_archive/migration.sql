-- AlterTable
ALTER TABLE "inventory_item"
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "inventory_item_archivedAt_capturedAt_idx"
ON "inventory_item"("archivedAt", "capturedAt");
