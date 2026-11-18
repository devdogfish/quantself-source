-- Link every Remedy Profile to one private HOMEOPATHY Substance.
ALTER TABLE "inventory_remedy_profile"
ADD COLUMN "substanceId" TEXT;

INSERT INTO "substance" (
    "id",
    "name",
    "category",
    "metadata",
    "isActive",
    "createdAt",
    "updatedAt"
)
SELECT
    'remedy_substance_' || md5("itemId"),
    '__remedy__:' || "itemId",
    'HOMEOPATHY',
    jsonb_build_object('linkedInventoryProductId', "itemId"),
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "inventory_remedy_profile";

UPDATE "inventory_remedy_profile" AS profile
SET "substanceId" = substance."id"
FROM "substance" AS substance
WHERE substance."name" = '__remedy__:' || profile."itemId";

ALTER TABLE "inventory_remedy_profile"
ALTER COLUMN "substanceId" SET NOT NULL;

ALTER TABLE "inventory_remedy_profile"
ADD CONSTRAINT "inventory_remedy_profile_substanceId_key" UNIQUE ("substanceId");

ALTER TABLE "inventory_remedy_profile"
ADD CONSTRAINT "inventory_remedy_profile_substanceId_fkey"
FOREIGN KEY ("substanceId") REFERENCES "substance"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
