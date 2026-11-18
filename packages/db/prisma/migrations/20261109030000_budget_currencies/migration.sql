ALTER TABLE "budget_expense" ADD COLUMN "originalAmountMinor" INTEGER,
  ADD COLUMN "originalFoodMinor" INTEGER, ADD COLUMN "originalCurrency" TEXT,
  ADD COLUMN "conversion" JSONB;
CREATE TABLE "budget_fx_rate" ("key" TEXT NOT NULL, "data" JSONB NOT NULL, CONSTRAINT "budget_fx_rate_pkey" PRIMARY KEY ("key"));
