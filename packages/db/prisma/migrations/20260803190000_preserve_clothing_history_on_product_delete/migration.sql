-- Preserve immutable Product identity while allowing permanent Product deletion.
ALTER TABLE "inventory_clothing_recommendation_option_item"
ADD COLUMN "productId" TEXT,
ADD COLUMN "productTitle" TEXT;

UPDATE "inventory_clothing_recommendation_option_item" AS history
SET
  "productId" = history."itemId",
  "productTitle" = COALESCE(item."title", item."captureText", 'Untitled Clothing Product')
FROM "inventory_item" AS item
WHERE item."id" = history."itemId";

ALTER TABLE "inventory_clothing_recommendation_option_item"
ALTER COLUMN "productId" SET NOT NULL,
ALTER COLUMN "productTitle" SET NOT NULL,
ALTER COLUMN "itemId" DROP NOT NULL;

DROP INDEX "inventory_clothing_recommendation_option_item_optionId_itemId_key";
CREATE UNIQUE INDEX "inventory_clothing_recommendation_option_item_optionId_productId_key"
ON "inventory_clothing_recommendation_option_item"("optionId", "productId");

ALTER TABLE "inventory_clothing_recommendation_option_item"
DROP CONSTRAINT "inventory_clothing_recommendation_option_item_itemId_fkey",
ADD CONSTRAINT "inventory_clothing_recommendation_option_item_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_clothing_wear_confirmation_item"
ADD COLUMN "id" TEXT,
ADD COLUMN "productId" TEXT,
ADD COLUMN "productTitle" TEXT;

UPDATE "inventory_clothing_wear_confirmation_item" AS history
SET
  "id" = 'wear_item_' || md5(history."confirmationId" || ':' || history."itemId"),
  "productId" = history."itemId",
  "productTitle" = COALESCE(item."title", item."captureText", 'Untitled Clothing Product')
FROM "inventory_item" AS item
WHERE item."id" = history."itemId";

ALTER TABLE "inventory_clothing_wear_confirmation_item"
ALTER COLUMN "id" SET NOT NULL,
ALTER COLUMN "productId" SET NOT NULL,
ALTER COLUMN "productTitle" SET NOT NULL;

ALTER TABLE "inventory_clothing_wear_confirmation_item"
DROP CONSTRAINT "inventory_clothing_wear_confirmation_item_pkey";

ALTER TABLE "inventory_clothing_wear_confirmation_item"
ALTER COLUMN "itemId" DROP NOT NULL,
ADD CONSTRAINT "inventory_clothing_wear_confirmation_item_pkey" PRIMARY KEY ("id"),
ADD CONSTRAINT "inventory_clothing_wear_confirmation_item_confirmationId_productId_key"
UNIQUE ("confirmationId", "productId");

ALTER TABLE "inventory_clothing_wear_confirmation_item"
DROP CONSTRAINT "inventory_clothing_wear_confirmation_item_itemId_fkey",
ADD CONSTRAINT "inventory_clothing_wear_confirmation_item_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
