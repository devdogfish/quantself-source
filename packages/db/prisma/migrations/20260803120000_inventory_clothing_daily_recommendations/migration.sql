CREATE TYPE "InventoryClothingRecommendationKind" AS ENUM ('DAILY');

CREATE TYPE "InventoryClothingRecommendationStatus" AS ENUM (
    'PUBLISHED',
    'SUPERSEDED'
);

CREATE TYPE "InventoryClothingRecommendationOptionSlot" AS ENUM (
    'PRIMARY',
    'ALTERNATIVE'
);

CREATE TABLE "inventory_clothing_recommendation" (
    "id" TEXT NOT NULL,
    "kind" "InventoryClothingRecommendationKind" NOT NULL,
    "status" "InventoryClothingRecommendationStatus" NOT NULL DEFAULT 'PUBLISHED',
    "targetDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "publishedByClientId" TEXT NOT NULL,
    "publishedByClientName" TEXT NOT NULL,
    "publishedByClientKind" TEXT NOT NULL,
    "supersededByRecommendationId" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_clothing_recommendation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_clothing_recommendation_option" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "slot" "InventoryClothingRecommendationOptionSlot" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_clothing_recommendation_option_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_clothing_recommendation_option_item" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_clothing_recommendation_option_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_clothing_recommendation_option_recommendationId_slot_key"
ON "inventory_clothing_recommendation_option"("recommendationId", "slot");

CREATE UNIQUE INDEX "inventory_clothing_recommendation_option_item_optionId_itemId_key"
ON "inventory_clothing_recommendation_option_item"("optionId", "itemId");

CREATE UNIQUE INDEX "inventory_clothing_recommendation_option_item_optionId_position_key"
ON "inventory_clothing_recommendation_option_item"("optionId", "position");

CREATE INDEX "inventory_clothing_recommendation_kind_targetDate_status_publishedAt_idx"
ON "inventory_clothing_recommendation"("kind", "targetDate", "status", "publishedAt");

CREATE INDEX "inventory_clothing_recommendation_option_item_itemId_idx"
ON "inventory_clothing_recommendation_option_item"("itemId");

CREATE UNIQUE INDEX "inventory_clothing_recommendation_one_published_daily_per_date"
ON "inventory_clothing_recommendation"("targetDate")
WHERE "kind" = 'DAILY' AND "status" = 'PUBLISHED';

ALTER TABLE "inventory_clothing_recommendation_option"
ADD CONSTRAINT "inventory_clothing_recommendation_option_recommendationId_fkey"
FOREIGN KEY ("recommendationId") REFERENCES "inventory_clothing_recommendation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_clothing_recommendation_option_item"
ADD CONSTRAINT "inventory_clothing_recommendation_option_item_optionId_fkey"
FOREIGN KEY ("optionId") REFERENCES "inventory_clothing_recommendation_option"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_clothing_recommendation_option_item"
ADD CONSTRAINT "inventory_clothing_recommendation_option_item_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
