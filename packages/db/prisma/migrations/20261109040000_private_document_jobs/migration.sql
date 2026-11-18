ALTER TABLE "budget_receipt" ADD COLUMN "scanLeaseId" TEXT, ADD COLUMN "scanLeaseUntil" TIMESTAMP(3);
CREATE INDEX "budget_receipt_scanStatus_scanLeaseUntil_createdAt_idx" ON "budget_receipt"("scanStatus", "scanLeaseUntil", "createdAt");
