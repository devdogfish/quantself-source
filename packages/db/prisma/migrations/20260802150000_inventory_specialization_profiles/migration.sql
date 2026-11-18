-- Extend the closed Inventory Category vocabulary for specialist views.
ALTER TYPE "InventoryCategory" ADD VALUE 'homeopathy';
ALTER TYPE "InventoryCategory" ADD VALUE 'supplement';

-- Clothing-specific state stays off the shared Inventory Product record.
CREATE TABLE "inventory_clothing_profile" (
    "itemId" TEXT NOT NULL,
    "isDirty" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_clothing_profile_pkey" PRIMARY KEY ("itemId")
);

-- Existing Clothing Products begin clean and require no profile upkeep.
INSERT INTO "inventory_clothing_profile" (
    "itemId",
    "isDirty",
    "attributes",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    false,
    '{}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "inventory_item"
WHERE "category" = 'clothing';

-- Remedy-specific owned-stock data keeps only locally valuable selection data.
CREATE TABLE "inventory_remedy_profile" (
    "itemId" TEXT NOT NULL,
    "potencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "selectionSummary" TEXT,
    "externalReferences" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "registeredByClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_remedy_profile_pkey" PRIMARY KEY ("itemId")
);

ALTER TABLE "inventory_clothing_profile"
ADD CONSTRAINT "inventory_clothing_profile_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_remedy_profile"
ADD CONSTRAINT "inventory_remedy_profile_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- A Placement can point directly to a Location without inventing a Container.
ALTER TABLE "inventory_item_placement"
ADD COLUMN "locationId" TEXT;

ALTER TABLE "inventory_item_placement"
ADD CONSTRAINT "inventory_item_placement_one_destination_check"
CHECK ("containerId" IS NULL OR "locationId" IS NULL);

CREATE UNIQUE INDEX "inventory_item_placement_itemId_locationId_key"
ON "inventory_item_placement"("itemId", "locationId");

CREATE INDEX "inventory_item_placement_locationId_idx"
ON "inventory_item_placement"("locationId");

-- Direct-location Placements are not unplaced Placements.
DROP INDEX "inventory_item_placement_one_unplaced_key";
CREATE UNIQUE INDEX "inventory_item_placement_one_unplaced_key"
ON "inventory_item_placement"("itemId")
WHERE "containerId" IS NULL AND "locationId" IS NULL;

ALTER TABLE "inventory_item_placement"
ADD CONSTRAINT "inventory_item_placement_locationId_fkey"
FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
