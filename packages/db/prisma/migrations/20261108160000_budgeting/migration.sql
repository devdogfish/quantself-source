CREATE TABLE "budget_plan" (
  "ownerId" TEXT PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT NOT NULL DEFAULT '',
  "plan" JSONB NOT NULL,
  "proposal" JSONB
);

CREATE TABLE "budget_receipt" (
  "ownerId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "merchant" TEXT NOT NULL DEFAULT '',
  "date" TEXT,
  "totalCents" INTEGER,
  "lines" JSONB NOT NULL,
  "image" BYTEA,
  "mime" TEXT,
  "imageHash" TEXT,
  "scanStatus" TEXT NOT NULL,
  PRIMARY KEY ("ownerId", "id")
);

CREATE TABLE "budget_expense" (
  "ownerId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "merchant" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "foodCents" INTEGER NOT NULL,
  "receiptId" TEXT,
  "billKey" TEXT,
  PRIMARY KEY ("ownerId", "id"),
  FOREIGN KEY ("ownerId", "receiptId") REFERENCES "budget_receipt" ("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "budget_receipt_ownerId_imageHash_key" ON "budget_receipt" ("ownerId", "imageHash");
CREATE INDEX "budget_receipt_ownerId_createdAt_id_idx" ON "budget_receipt" ("ownerId", "createdAt", "id");
CREATE UNIQUE INDEX "budget_expense_ownerId_receiptId_key" ON "budget_expense" ("ownerId", "receiptId");
CREATE UNIQUE INDEX "budget_expense_ownerId_billKey_key" ON "budget_expense" ("ownerId", "billKey");
CREATE INDEX "budget_expense_ownerId_date_id_idx" ON "budget_expense" ("ownerId", "date", "id");
