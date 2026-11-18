CREATE TYPE "BudgetReceiptScanProvenance" AS ENUM ('upload_only', 'ocr_completed');
ALTER TABLE "budget_receipt" ADD COLUMN "scanProvenance" "BudgetReceiptScanProvenance";
