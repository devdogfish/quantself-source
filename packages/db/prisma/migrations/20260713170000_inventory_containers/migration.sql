-- CreateTable
CREATE TABLE "inventory_container" (
    "id" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "locationId" TEXT,
    "sizeLiters" DOUBLE PRECISION,
    "photoFilePath" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_container_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "inventory_capture_session"
ADD COLUMN "defaultContainerId" TEXT;

-- AlterTable
ALTER TABLE "inventory_item"
ADD COLUMN "containerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_container_referenceId_key" ON "inventory_container"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_container_normalizedName_key" ON "inventory_container"("normalizedName");

-- CreateIndex
CREATE INDEX "inventory_container_locationId_name_idx" ON "inventory_container"("locationId", "name");

-- CreateIndex
CREATE INDEX "inventory_capture_session_defaultContainerId_idx" ON "inventory_capture_session"("defaultContainerId");

-- CreateIndex
CREATE INDEX "inventory_item_containerId_capturedAt_idx" ON "inventory_item"("containerId", "capturedAt");

-- AddForeignKey
ALTER TABLE "inventory_container"
ADD CONSTRAINT "inventory_container_locationId_fkey"
FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_capture_session"
ADD CONSTRAINT "inventory_capture_session_defaultContainerId_fkey"
FOREIGN KEY ("defaultContainerId") REFERENCES "inventory_container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item"
ADD CONSTRAINT "inventory_item_containerId_fkey"
FOREIGN KEY ("containerId") REFERENCES "inventory_container"("id") ON DELETE SET NULL ON UPDATE CASCADE;
