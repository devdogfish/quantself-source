ALTER TABLE "inventory_container"
ADD COLUMN "visualPresetKey" TEXT;

UPDATE "inventory_container" AS container
SET "visualPresetKey" = CASE
  WHEN preset."id" = 'inventory-container-visual-preset-standard-tote' THEN '39L'
  WHEN preset."name" = 'Standard tote' THEN '39L'
  ELSE '6L'
END
FROM "inventory_container_visual_preset" AS preset
WHERE preset."id" = container."visualPresetId";

DO $$
DECLARE
  fallback_container RECORD;
BEGIN
  FOR fallback_container IN
    SELECT
      container."id" AS container_id,
      preset."id" AS legacy_preset_id,
      preset."name" AS legacy_preset_name
    FROM "inventory_container" AS container
    LEFT JOIN "inventory_container_visual_preset" AS preset
      ON preset."id" = container."visualPresetId"
    WHERE container."visualPresetKey" = '6L'
      AND (
        preset."id" IS DISTINCT FROM 'inventory-container-visual-preset-standard-tote'
        AND preset."name" IS DISTINCT FROM 'Standard tote'
      )
  LOOP
    RAISE NOTICE
      'inventory_container % fallback to 6L from legacy preset id=% name=%',
      fallback_container.container_id,
      COALESCE(fallback_container.legacy_preset_id, '<null>'),
      COALESCE(fallback_container.legacy_preset_name, '<null>');
  END LOOP;
END $$;

ALTER TABLE "inventory_container"
ALTER COLUMN "visualPresetKey" SET NOT NULL;

DROP INDEX IF EXISTS "inventory_container_visualPresetId_idx";

ALTER TABLE "inventory_container"
DROP CONSTRAINT IF EXISTS "inventory_container_visualPresetId_fkey";

ALTER TABLE "inventory_container"
DROP COLUMN "visualPresetId";

CREATE INDEX "inventory_container_visualPresetKey_idx"
ON "inventory_container"("visualPresetKey");

DROP TABLE "inventory_container_visual_preset";
