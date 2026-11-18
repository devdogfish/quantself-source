-- Preserve the original Tax Planning records before the replacement migration
-- removes their table. The new record types cannot represent every old field.
BEGIN;

CREATE TABLE "budget_tax_entry_archive" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "commandId" TEXT NOT NULL,
    "entry" JSONB NOT NULL,

    CONSTRAINT "budget_tax_entry_archive_pkey" PRIMARY KEY ("ownerId", "year", "id")
);

DO $$
BEGIN
    IF to_regclass('budget_tax_entry') IS NOT NULL THEN
        LOCK TABLE "budget_tax_entry" IN ACCESS EXCLUSIVE MODE;
        INSERT INTO "budget_tax_entry_archive" ("ownerId", "year", "id", "revision", "commandId", "entry")
        SELECT "ownerId", "year", "id", "revision", "commandId", "entry"
        FROM "budget_tax_entry";
    END IF;
END
$$;

COMMIT;
