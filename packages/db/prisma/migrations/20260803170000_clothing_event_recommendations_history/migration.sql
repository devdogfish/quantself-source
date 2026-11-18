ALTER TYPE "InventoryClothingRecommendationKind"
ADD VALUE 'EVENT';

ALTER TABLE "inventory_clothing_recommendation"
ADD COLUMN "eventLabel" TEXT,
ADD COLUMN "eventStartsAt" TIMESTAMP(3);

ALTER TABLE "inventory_clothing_recommendation"
ADD CONSTRAINT "inventory_clothing_recommendation_kind_event_shape"
CHECK (
  (
    "kind" = 'DAILY'
    AND "eventLabel" IS NULL
    AND "eventStartsAt" IS NULL
  )
  OR (
    "kind" = 'EVENT'
    AND "eventLabel" IS NOT NULL
    AND "eventStartsAt" IS NOT NULL
    AND "targetDate" = CAST("eventStartsAt" AS DATE)
  )
);

CREATE INDEX "inventory_clothing_recommendation_kind_eventStartsAt_status_publishedAt_idx"
ON "inventory_clothing_recommendation"(
  "kind",
  "eventStartsAt",
  "status",
  "publishedAt"
);

CREATE UNIQUE INDEX "inventory_clothing_recommendation_one_published_event_per_start"
ON "inventory_clothing_recommendation"("eventLabel", "eventStartsAt")
WHERE "kind" = 'EVENT' AND "status" = 'PUBLISHED';
