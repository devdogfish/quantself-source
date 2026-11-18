import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("Inventory Clothing daily recommendations migration", () => {
  test("creates recommendation, option, and option-item tables", () => {
    expect(migrationSql).toContain(
      'CREATE TABLE "inventory_clothing_recommendation"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE "inventory_clothing_recommendation_option"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE "inventory_clothing_recommendation_option_item"',
    );
  });

  test("stores one published daily slot per target date and tracks supersession", () => {
    expect(migrationSql).toContain(
      '"kind" "InventoryClothingRecommendationKind" NOT NULL',
    );
    expect(migrationSql).toContain(
      '"status" "InventoryClothingRecommendationStatus" NOT NULL',
    );
    expect(migrationSql).toContain('"targetDate" DATE NOT NULL');
    expect(migrationSql).toContain('"supersededByRecommendationId" TEXT');
    expect(migrationSql).toContain(
      '"inventory_clothing_recommendation_one_published_daily_per_date"',
    );
  });

  test("persists publisher provenance and ordered outfit items", () => {
    expect(migrationSql).toContain('"publishedByClientId" TEXT NOT NULL');
    expect(migrationSql).toContain('"publishedByClientName" TEXT NOT NULL');
    expect(migrationSql).toContain('"publishedByClientKind" TEXT NOT NULL');
    expect(migrationSql).toContain('"slot" "InventoryClothingRecommendationOptionSlot" NOT NULL');
    expect(migrationSql).toContain('"position" INTEGER NOT NULL');
    expect(migrationSql).toContain(
      '"inventory_clothing_recommendation_option_item_optionId_position_key"',
    );
  });
});
