ALTER TABLE "budget_receipt"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'receipt',
  ADD COLUMN "title" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "dueDate" TEXT,
  ADD COLUMN "amazonAsin" TEXT;
