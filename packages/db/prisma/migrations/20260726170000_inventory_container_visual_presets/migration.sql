-- CreateTable
CREATE TABLE "inventory_container_visual_preset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageFilePath" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT NOT NULL,
    "bounds" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_container_visual_preset_pkey" PRIMARY KEY ("id")
);

-- Seed the required default before making the container relation non-nullable.
INSERT INTO "inventory_container_visual_preset" (
    "id",
    "name",
    "imageFilePath",
    "originalName",
    "mimeType",
    "bounds",
    "isDefault",
    "updatedAt"
) VALUES (
    'inventory-container-visual-preset-standard-tote',
    'Standard tote',
    'builtin:default-container',
    'default-container.png',
    'image/png',
    '[{"x":0.08,"y":0.20},{"x":0.92,"y":0.20},{"x":0.83,"y":0.94},{"x":0.17,"y":0.94}]'::jsonb,
    true,
    CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "inventory_container"
ADD COLUMN "visualPresetId" TEXT;

UPDATE "inventory_container"
SET "visualPresetId" = 'inventory-container-visual-preset-standard-tote';

ALTER TABLE "inventory_container"
ALTER COLUMN "visualPresetId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "inventory_container_visual_preset_name_idx"
ON "inventory_container_visual_preset"("name");

-- The service changes defaults transactionally; this index is the final
-- database guard against two defaults.
CREATE UNIQUE INDEX "inventory_container_visual_preset_single_default_key"
ON "inventory_container_visual_preset"("isDefault")
WHERE "isDefault" = true;

CREATE INDEX "inventory_container_visualPresetId_idx"
ON "inventory_container"("visualPresetId");

-- AddForeignKey
ALTER TABLE "inventory_container"
ADD CONSTRAINT "inventory_container_visualPresetId_fkey"
FOREIGN KEY ("visualPresetId")
REFERENCES "inventory_container_visual_preset"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
