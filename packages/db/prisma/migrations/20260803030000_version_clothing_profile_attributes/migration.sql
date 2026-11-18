-- Clothing Profile attributes use the versioned public API shape.
UPDATE "inventory_clothing_profile"
SET "attributes" = jsonb_set("attributes", '{version}', '1'::jsonb, true)
WHERE NOT ("attributes" ? 'version');

ALTER TABLE "inventory_clothing_profile"
ALTER COLUMN "attributes" SET DEFAULT '{"version":1}'::jsonb;
