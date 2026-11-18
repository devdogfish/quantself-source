import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("Inventory Products and Placements migration", () => {
  test("backfills one quantity-one Placement before removing item container columns", () => {
    const createPlacement = migrationSql.indexOf(
      'CREATE TABLE "inventory_item_placement"',
    );
    const backfill = migrationSql.indexOf(
      'INSERT INTO "inventory_item_placement"',
    );
    const dropContainer = migrationSql.indexOf('DROP COLUMN "containerId"');

    expect(createPlacement).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(createPlacement);
    expect(dropContainer).toBeGreaterThan(backfill);
    expect(migrationSql).toContain('    1,');
  });

  test("enforces assigned and unplaced uniqueness plus positive quantity", () => {
    expect(migrationSql).toContain(
      'CONSTRAINT "inventory_item_placement_quantity_check" CHECK ("quantity" > 0)',
    );
    expect(migrationSql).toContain(
      '"inventory_item_placement_itemId_containerId_key"',
    );
    expect(migrationSql).toContain(
      '"inventory_item_placement_one_unplaced_key"',
    );
    expect(migrationSql).toContain('WHERE "containerId" IS NULL');
  });

  test("backfills stable Item Image positions before creating the order index", () => {
    const addPosition = migrationSql.indexOf(
      'ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0',
    );
    const backfillPosition = migrationSql.indexOf(
      "ROW_NUMBER() OVER",
    );
    const orderIndex = migrationSql.indexOf(
      '"inventory_item_image_itemId_position_idx"',
    );

    expect(backfillPosition).toBeGreaterThan(addPosition);
    expect(orderIndex).toBeGreaterThan(backfillPosition);
  });
});
