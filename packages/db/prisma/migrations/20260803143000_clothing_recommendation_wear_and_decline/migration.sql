ALTER TYPE "InventoryClothingRecommendationStatus"
ADD VALUE 'WORN';

ALTER TYPE "InventoryClothingRecommendationStatus"
ADD VALUE 'DECLINED';

ALTER TABLE "inventory_clothing_wear_confirmation"
ADD COLUMN "recommendationId" TEXT,
ADD COLUMN "recommendationOptionId" TEXT,
ADD CONSTRAINT "inventory_clothing_wear_confirmation_recommendation_source_check"
  CHECK (
    ("recommendationId" IS NULL AND "recommendationOptionId" IS NULL)
    OR ("recommendationId" IS NOT NULL AND "recommendationOptionId" IS NOT NULL)
  );

CREATE INDEX "inventory_clothing_wear_confirmation_recommendationId_idx"
ON "inventory_clothing_wear_confirmation"("recommendationId");

CREATE INDEX "inventory_clothing_wear_confirmation_recommendationOptionId_idx"
ON "inventory_clothing_wear_confirmation"("recommendationOptionId");

ALTER TABLE "inventory_clothing_wear_confirmation"
ADD CONSTRAINT "inventory_clothing_wear_confirmation_recommendationId_fkey"
FOREIGN KEY ("recommendationId")
REFERENCES "inventory_clothing_recommendation"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "inventory_clothing_wear_confirmation"
ADD CONSTRAINT "inventory_clothing_wear_confirmation_recommendationOptionId_fkey"
FOREIGN KEY ("recommendationOptionId")
REFERENCES "inventory_clothing_recommendation_option"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
