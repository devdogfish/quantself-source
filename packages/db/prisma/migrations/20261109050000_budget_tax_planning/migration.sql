CREATE TABLE "budget_tax_entry" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "commandId" TEXT NOT NULL,
    "entry" JSONB NOT NULL,

    CONSTRAINT "budget_tax_entry_pkey" PRIMARY KEY ("ownerId", "year", "id")
);
