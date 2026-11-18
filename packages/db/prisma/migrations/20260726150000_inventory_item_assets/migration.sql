-- CreateTable
CREATE TABLE "inventory_item_asset" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_item_asset_itemId_idx" ON "inventory_item_asset"("itemId");

-- AddForeignKey
ALTER TABLE "inventory_item_asset"
ADD CONSTRAINT "inventory_item_asset_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
