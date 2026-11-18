CREATE TABLE "budget_inventory_link" (
 "ownerId" TEXT NOT NULL, "id" TEXT NOT NULL,
 "receiptId" TEXT, "expenseId" TEXT, "itemId" TEXT NOT NULL,
 CONSTRAINT "budget_inventory_link_pkey" PRIMARY KEY ("ownerId", "id"),
 CONSTRAINT "budget_inventory_link_one_source" CHECK (("receiptId" IS NOT NULL) <> ("expenseId" IS NOT NULL)),
 CONSTRAINT "budget_inventory_link_receipt_fkey" FOREIGN KEY ("ownerId", "receiptId") REFERENCES "budget_receipt"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "budget_inventory_link_expense_fkey" FOREIGN KEY ("ownerId", "expenseId") REFERENCES "budget_expense"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "budget_inventory_link_item_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "budget_inventory_link_ownerId_receiptId_itemId_key" ON "budget_inventory_link"("ownerId", "receiptId", "itemId");
CREATE UNIQUE INDEX "budget_inventory_link_ownerId_expenseId_itemId_key" ON "budget_inventory_link"("ownerId", "expenseId", "itemId");
CREATE INDEX "budget_inventory_link_itemId_idx" ON "budget_inventory_link"("itemId");
