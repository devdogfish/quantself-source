import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migrationSql = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("track Clothing dirty quantity migration", () => {
  test("adds and backfills a nonnegative dirty unit count", () => {
    expect(migrationSql).toContain('ADD COLUMN "dirtyQuantity" INTEGER NOT NULL DEFAULT 0');
    expect(migrationSql).toContain('SUM(placement."quantity")');
    expect(migrationSql).toContain('profile."isDirty" = TRUE');
    expect(migrationSql).toContain('CHECK ("dirtyQuantity" >= 0)');
  });
});
