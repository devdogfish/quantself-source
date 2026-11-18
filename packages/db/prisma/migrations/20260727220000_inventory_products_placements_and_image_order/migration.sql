-- Add stable Item Image ordering before migrating container ownership.
ALTER TABLE "inventory_item_image"
ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH ordered_images AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "itemId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) - 1 AS "position"
  FROM "inventory_item_image"
)
UPDATE "inventory_item_image" AS image
SET "position" = ordered_images."position"
FROM ordered_images
WHERE image."id" = ordered_images."id";

DROP INDEX IF EXISTS "inventory_item_image_itemId_idx";
CREATE INDEX "inventory_item_image_itemId_position_idx"
ON "inventory_item_image"("itemId", "position");

-- Inventory Items become canonical Inventory Products. Placements own stock.
CREATE TABLE "inventory_item_placement" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "containerId" TEXT,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_placement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_item_placement_quantity_check" CHECK ("quantity" > 0)
);

INSERT INTO "inventory_item_placement" (
    "id",
    "itemId",
    "containerId",
    "quantity",
    "note",
    "createdAt",
    "updatedAt"
)
SELECT
    'placement_' || md5(item."id"),
    item."id",
    item."containerId",
    1,
    CASE
      WHEN item."containerId" IS NULL THEN item."containerLabel"
      ELSE NULL
    END,
    item."capturedAt",
    item."updatedAt"
FROM "inventory_item" AS item;

CREATE UNIQUE INDEX "inventory_item_placement_itemId_containerId_key"
ON "inventory_item_placement"("itemId", "containerId");

CREATE UNIQUE INDEX "inventory_item_placement_one_unplaced_key"
ON "inventory_item_placement"("itemId")
WHERE "containerId" IS NULL;

CREATE INDEX "inventory_item_placement_containerId_idx"
ON "inventory_item_placement"("containerId");

ALTER TABLE "inventory_item_placement"
ADD CONSTRAINT "inventory_item_placement_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_item_placement"
ADD CONSTRAINT "inventory_item_placement_containerId_fkey"
FOREIGN KEY ("containerId") REFERENCES "inventory_container"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Product records no longer own one container.
ALTER TABLE "inventory_item"
DROP CONSTRAINT IF EXISTS "inventory_item_containerId_fkey";

DROP INDEX IF EXISTS "inventory_item_containerId_capturedAt_idx";
DROP INDEX IF EXISTS "inventory_item_containerLabel_idx";

ALTER TABLE "inventory_item"
DROP COLUMN "containerId",
DROP COLUMN "containerLabel";
