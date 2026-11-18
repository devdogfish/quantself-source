-- CreateEnum
CREATE TYPE "BudgetTaxMoneyKind" AS ENUM ('income', 'withheld');

-- CreateEnum
CREATE TYPE "BudgetTaxCertainty" AS ENUM ('confirmed', 'likely', 'uncertain');

-- CreateEnum
CREATE TYPE "BudgetTaxTreatment" AS ENUM ('deduction', 'credit', 'medicalCredit');

-- CreateEnum
CREATE TYPE "BudgetTaxItemType" AS ENUM ('Income', 'Deduction', 'Credit', 'Payment');

-- CreateEnum
CREATE TYPE "BudgetTaxGatherStatus" AS ENUM ('To gather', 'Requested');

-- DropTable
DROP TABLE "budget_tax_entry";

-- CreateTable
CREATE TABLE "budget_tax_rules" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "bands" JSONB NOT NULL,
    "creditRate" DOUBLE PRECISION NOT NULL,
    "baselineCreditsCents" INTEGER NOT NULL,
    "medicalFloorRate" DOUBLE PRECISION NOT NULL,
    "medicalFloorCapCents" INTEGER NOT NULL,

    CONSTRAINT "budget_tax_rules_pkey" PRIMARY KEY ("ownerId","year")
);

-- CreateTable
CREATE TABLE "budget_tax_money_line" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" "BudgetTaxMoneyKind" NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_tax_money_line_pkey" PRIMARY KEY ("ownerId","year","kind","id")
);

-- CreateTable
CREATE TABLE "budget_tax_claim" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "certainty" "BudgetTaxCertainty" NOT NULL,
    "treatment" "BudgetTaxTreatment" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_tax_claim_pkey" PRIMARY KEY ("ownerId","year","id")
);

-- CreateTable
CREATE TABLE "budget_tax_item" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "BudgetTaxItemType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "claimId" TEXT,
    "links" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_tax_item_pkey" PRIMARY KEY ("ownerId","year","id")
);

-- CreateTable
CREATE TABLE "budget_tax_gather_document" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "where" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "status" "BudgetTaxGatherStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_tax_gather_document_pkey" PRIMARY KEY ("ownerId","year","id")
);

-- CreateTable
CREATE TABLE "budget_tax_command" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,

    CONSTRAINT "budget_tax_command_pkey" PRIMARY KEY ("ownerId","year","commandId")
);

-- CreateIndex
CREATE INDEX "budget_tax_item_ownerId_year_claimId_idx" ON "budget_tax_item"("ownerId", "year", "claimId");

-- CreateIndex
CREATE INDEX "budget_tax_gather_document_ownerId_year_itemId_idx" ON "budget_tax_gather_document"("ownerId", "year", "itemId");

-- CreateIndex
CREATE INDEX "budget_tax_command_ownerId_year_kind_recordId_revision_idx" ON "budget_tax_command"("ownerId", "year", "kind", "recordId", "revision");

-- AddForeignKey
ALTER TABLE "budget_tax_item" ADD CONSTRAINT "budget_tax_item_ownerId_year_claimId_fkey" FOREIGN KEY ("ownerId", "year", "claimId") REFERENCES "budget_tax_claim"("ownerId", "year", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_tax_gather_document" ADD CONSTRAINT "budget_tax_gather_document_ownerId_year_itemId_fkey" FOREIGN KEY ("ownerId", "year", "itemId") REFERENCES "budget_tax_item"("ownerId", "year", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

