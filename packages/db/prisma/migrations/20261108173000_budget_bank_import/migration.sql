ALTER TABLE "budget_expense"
  ADD COLUMN "bankAccount" TEXT,
  ADD COLUMN "bankFlow" TEXT,
  ADD COLUMN "manualReceiptMatch" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "budget_expense_ownerId_totalCents_date_idx"
  ON "budget_expense" ("ownerId", "totalCents", "date");
CREATE INDEX "budget_receipt_ownerId_totalCents_date_idx"
  ON "budget_receipt" ("ownerId", "totalCents", "date");
