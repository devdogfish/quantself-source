import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("Inventory specialization profiles migration", () => {
  test("extends the closed category vocabulary", () => {
    expect(migrationSql).toContain(
      `ALTER TYPE "InventoryCategory" ADD VALUE 'homeopathy'`,
    );
    expect(migrationSql).toContain(
      `ALTER TYPE "InventoryCategory" ADD VALUE 'supplement'`,
    );
  });

  test("creates one-to-one Clothing and Remedy Profiles with cascade ownership", () => {
    expect(migrationSql).toContain(
      'CREATE TABLE "inventory_clothing_profile"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE "inventory_remedy_profile"',
    );
    expect(migrationSql).toContain(
      '"attributes" JSONB NOT NULL DEFAULT \'{}\'::jsonb',
    );
    expect(migrationSql).toContain(
      '"potencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]',
    );
    expect(migrationSql).toContain(
      '"externalReferences" JSONB NOT NULL DEFAULT \'[]\'::jsonb',
    );
    expect(migrationSql.match(/ON DELETE CASCADE ON UPDATE CASCADE/g)).toHaveLength(
      2,
    );
  });

  test("backfills clean empty Clothing Profiles after creating the table", () => {
    const createProfile = migrationSql.indexOf(
      'CREATE TABLE "inventory_clothing_profile"',
    );
    const backfill = migrationSql.indexOf(
      'INSERT INTO "inventory_clothing_profile"',
    );

    expect(backfill).toBeGreaterThan(createProfile);
    expect(migrationSql).toContain(`WHERE "category" = 'clothing'`);
    expect(migrationSql).toContain("    false,");
    expect(migrationSql).toContain("    '{}'::jsonb,");
  });

  test("supports container, direct-location, or one unplaced Placement", () => {
    expect(migrationSql).toContain('ADD COLUMN "locationId" TEXT');
    expect(migrationSql).toContain(
      'CHECK ("containerId" IS NULL OR "locationId" IS NULL)',
    );
    expect(migrationSql).toContain(
      '"inventory_item_placement_itemId_locationId_key"',
    );
    expect(migrationSql).toContain(
      'WHERE "containerId" IS NULL AND "locationId" IS NULL',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id")',
    );
  });
});
