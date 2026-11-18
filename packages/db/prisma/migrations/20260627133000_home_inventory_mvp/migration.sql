-- CreateEnum
CREATE TYPE "InventoryLocationKind" AS ENUM ('ROOM', 'STORAGE', 'SHELF', 'AREA', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryItemKind" AS ENUM ('ITEM', 'GROUP');

-- CreateEnum
CREATE TYPE "InventoryItemStatus" AS ENUM ('KEEP', 'DONATE', 'TRASH', 'UNSURE');

-- CreateEnum
CREATE TYPE "InventoryImportance" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "inventory_location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "kind" "InventoryLocationKind" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_capture_session" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "defaultOriginLocationId" TEXT,
    "defaultDestinationLocationId" TEXT,
    "defaultContainerLabel" TEXT,
    "note" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_capture_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item" (
    "id" TEXT NOT NULL,
    "captureSessionId" TEXT,
    "kind" "InventoryItemKind" NOT NULL DEFAULT 'GROUP',
    "title" TEXT,
    "note" TEXT,
    "status" "InventoryItemStatus" NOT NULL DEFAULT 'UNSURE',
    "importance" "InventoryImportance" NOT NULL DEFAULT 'MEDIUM',
    "originLocationId" TEXT,
    "locationId" TEXT,
    "containerLabel" TEXT,
    "category" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "searchText" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item_image" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "caption" TEXT,
    "ocrText" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_location_normalizedName_key" ON "inventory_location"("normalizedName");

-- CreateIndex
CREATE INDEX "inventory_location_kind_name_idx" ON "inventory_location"("kind", "name");

-- CreateIndex
CREATE INDEX "inventory_capture_session_startedAt_idx" ON "inventory_capture_session"("startedAt");

-- CreateIndex
CREATE INDEX "inventory_capture_session_defaultOriginLocationId_idx" ON "inventory_capture_session"("defaultOriginLocationId");

-- CreateIndex
CREATE INDEX "inventory_capture_session_defaultDestinationLocationId_idx" ON "inventory_capture_session"("defaultDestinationLocationId");

-- CreateIndex
CREATE INDEX "inventory_item_capturedAt_idx" ON "inventory_item"("capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_captureSessionId_capturedAt_idx" ON "inventory_item"("captureSessionId", "capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_status_capturedAt_idx" ON "inventory_item"("status", "capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_importance_capturedAt_idx" ON "inventory_item"("importance", "capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_locationId_capturedAt_idx" ON "inventory_item"("locationId", "capturedAt");

-- CreateIndex
CREATE INDEX "inventory_item_containerLabel_idx" ON "inventory_item"("containerLabel");

-- CreateIndex
CREATE INDEX "inventory_item_searchText_idx" ON "inventory_item"("searchText");

-- CreateIndex
CREATE INDEX "inventory_item_image_itemId_idx" ON "inventory_item_image"("itemId");

-- AddForeignKey
ALTER TABLE "inventory_capture_session" ADD CONSTRAINT "inventory_capture_session_defaultOriginLocationId_fkey" FOREIGN KEY ("defaultOriginLocationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_capture_session" ADD CONSTRAINT "inventory_capture_session_defaultDestinationLocationId_fkey" FOREIGN KEY ("defaultDestinationLocationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "inventory_capture_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_originLocationId_fkey" FOREIGN KEY ("originLocationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_image" ADD CONSTRAINT "inventory_item_image_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
