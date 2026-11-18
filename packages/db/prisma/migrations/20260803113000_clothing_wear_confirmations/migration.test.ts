import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migration = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("Clothing Wear Confirmation migration", () => {
  test("persists required confirmation and consistent undo provenance", () => {
    expect(migration).toContain('"confirmedByClientId" TEXT NOT NULL');
    expect(migration).toContain(
      'CONSTRAINT "inventory_clothing_wear_confirmation_undo_provenance_check"',
    );
    expect(migration).toContain(
      '("undoneAt" IS NULL AND "undoneByClientId" IS NULL)',
    );
    expect(migration).toContain(
      '("undoneAt" IS NOT NULL AND "undoneByClientId" IS NOT NULL)',
    );
  });

  test("owns confirmation items and tracks the post-wear state version", () => {
    expect(migration).toContain(
      'CREATE TABLE "inventory_clothing_wear_confirmation_item"',
    );
    expect(migration).toContain('"wearStateVersionAfter" INTEGER NOT NULL');
    expect(migration.match(/ON DELETE CASCADE/g)).toHaveLength(2);
  });
});
