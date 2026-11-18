ALTER TABLE "budget_expense"
    ADD COLUMN "allowance" TEXT,
    ADD COLUMN "category" TEXT,
    ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "budget_expense_ownerId_reviewed_date_id_idx" ON "budget_expense"("ownerId", "reviewed", "date", "id");

CREATE TABLE "budget_check_in" (
    "ownerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    CONSTRAINT "budget_check_in_pkey" PRIMARY KEY ("ownerId", "date")
);

CREATE TABLE "budget_skipped_spending" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    CONSTRAINT "budget_skipped_spending_pkey" PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "budget_skipped_spending_ownerId_date_id_idx" ON "budget_skipped_spending"("ownerId", "date", "id");

CREATE TABLE "budget_weekly_limit" (
    "ownerId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "allowance" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    CONSTRAINT "budget_weekly_limit_pkey" PRIMARY KEY ("ownerId", "allowance", "week")
);
CREATE INDEX "budget_weekly_limit_ownerId_week_idx" ON "budget_weekly_limit"("ownerId", "week");

CREATE TABLE "budget_transaction_command" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    CONSTRAINT "budget_transaction_command_pkey" PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "budget_transaction_command_ownerId_sessionId_idx" ON "budget_transaction_command"("ownerId", "sessionId");
