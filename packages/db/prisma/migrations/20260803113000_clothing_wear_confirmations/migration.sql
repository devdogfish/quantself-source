ALTER TABLE "inventory_clothing_profile"
ADD COLUMN "wearStateVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "inventory_clothing_wear_confirmation" (
    "id" TEXT NOT NULL,
    "confirmedByClientId" TEXT NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "undoneByClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_clothing_wear_confirmation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_clothing_wear_confirmation_undo_provenance_check"
      CHECK (
        ("undoneAt" IS NULL AND "undoneByClientId" IS NULL)
        OR ("undoneAt" IS NOT NULL AND "undoneByClientId" IS NOT NULL)
      )
);

CREATE TABLE "inventory_clothing_wear_confirmation_item" (
    "confirmationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "wearStateVersionAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_clothing_wear_confirmation_item_pkey" PRIMARY KEY ("confirmationId","itemId")
);

CREATE INDEX "inventory_clothing_wear_confirmation_createdAt_idx"
ON "inventory_clothing_wear_confirmation"("createdAt");

CREATE INDEX "inventory_clothing_wear_confirmation_item_itemId_createdAt_idx"
ON "inventory_clothing_wear_confirmation_item"("itemId", "createdAt");

ALTER TABLE "inventory_clothing_wear_confirmation_item"
ADD CONSTRAINT "inventory_clothing_wear_confirmation_item_confirmationId_fkey"
FOREIGN KEY ("confirmationId")
REFERENCES "inventory_clothing_wear_confirmation"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "inventory_clothing_wear_confirmation_item"
ADD CONSTRAINT "inventory_clothing_wear_confirmation_item_itemId_fkey"
FOREIGN KEY ("itemId")
REFERENCES "inventory_item"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
