ALTER TABLE "budget_subscription"
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'subscription',
ADD COLUMN "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN "lastReviewed" TEXT,
ADD COLUMN "documentId" TEXT,
ADD COLUMN "planEntry" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "budget_subscription_ownerId_documentId_idx"
ON "budget_subscription"("ownerId", "documentId");

ALTER TABLE "budget_subscription"
ADD CONSTRAINT "budget_subscription_ownerId_documentId_fkey"
FOREIGN KEY ("ownerId", "documentId") REFERENCES "budget_receipt"("ownerId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
