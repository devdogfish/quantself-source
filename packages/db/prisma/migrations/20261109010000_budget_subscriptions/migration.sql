CREATE TABLE "budget_subscription" (
 "ownerId" TEXT NOT NULL, "id" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
 "commandId" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active',
 "stopsOn" TEXT, "websiteUrl" TEXT, "cancelUrl" TEXT, "logoKey" TEXT,
 "estimated" BOOLEAN NOT NULL DEFAULT false, "terms" JSONB NOT NULL,
 "evidence" TEXT NOT NULL DEFAULT '', "sourceKey" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "budget_subscription_pkey" PRIMARY KEY ("ownerId", "id")
);
CREATE UNIQUE INDEX "budget_subscription_ownerId_sourceKey_key" ON "budget_subscription"("ownerId", "sourceKey");
CREATE INDEX "budget_subscription_ownerId_status_idx" ON "budget_subscription"("ownerId", "status");
ALTER TABLE "budget_expense" ADD COLUMN "subscriptionId" TEXT;
ALTER TABLE "budget_expense" ADD CONSTRAINT "budget_expense_ownerId_subscriptionId_fkey"
 FOREIGN KEY ("ownerId", "subscriptionId") REFERENCES "budget_subscription"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "budget_expense_ownerId_subscriptionId_idx" ON "budget_expense"("ownerId", "subscriptionId");
