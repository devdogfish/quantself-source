-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM (
    'food',
    'drink',
    'medical',
    'entertainment',
    'office',
    'sports',
    'clothing',
    'technology',
    'cosmetics',
    'documents',
    'tools',
    'cleaning',
    'kitchen',
    'household',
    'other'
);

-- CreateEnum
CREATE TYPE "InventoryAcquisitionSource" AS ENUM (
    'online',
    'retail',
    'gift',
    'found',
    'work',
    'secondhand',
    'other'
);

-- DropForeignKey
ALTER TABLE "inventory_item" DROP CONSTRAINT "inventory_item_originLocationId_fkey";

-- DropForeignKey
ALTER TABLE "inventory_item" DROP CONSTRAINT "inventory_item_locationId_fkey";

-- DropIndex
DROP INDEX "inventory_item_locationId_capturedAt_idx";

-- AlterTable
ALTER TABLE "inventory_item"
DROP COLUMN "originLocationId",
DROP COLUMN "locationId",
ADD COLUMN "acquisitionSource" "InventoryAcquisitionSource",
ADD COLUMN "costCents" INTEGER,
ADD COLUMN "costCurrency" TEXT NOT NULL DEFAULT 'CAD';

-- Existing category values are mock data and may not match the new controlled enum.
ALTER TABLE "inventory_item" DROP COLUMN "category";
ALTER TABLE "inventory_item" ADD COLUMN "category" "InventoryCategory";

-- CreateIndex
CREATE INDEX "inventory_item_category_capturedAt_idx" ON "inventory_item"("category", "capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_acquisitionSource_capturedAt_idx" ON "inventory_item"("acquisitionSource", "capturedAt");
