ALTER TABLE "inventory_clothing_profile"
ADD COLUMN "dirtyQuantity" INTEGER NOT NULL DEFAULT 0;

UPDATE "inventory_clothing_profile" AS profile
SET "dirtyQuantity" = quantities."totalQuantity"
FROM (
  SELECT
    item."id" AS "itemId",
    COALESCE(SUM(placement."quantity"), 0)::INTEGER AS "totalQuantity"
  FROM "inventory_item" AS item
  LEFT JOIN "inventory_item_placement" AS placement
    ON placement."itemId" = item."id"
  GROUP BY item."id"
) AS quantities
WHERE profile."itemId" = quantities."itemId"
  AND profile."isDirty" = TRUE;

ALTER TABLE "inventory_clothing_profile"
ADD CONSTRAINT "inventory_clothing_profile_dirty_quantity_nonnegative"
CHECK ("dirtyQuantity" >= 0);
