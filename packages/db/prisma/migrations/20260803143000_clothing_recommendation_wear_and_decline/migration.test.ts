import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migration = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("Clothing Recommendation wear and decline migration", () => {
  test("extends recommendation lifecycle states for worn and declined history", () => {
    expect(migration).toContain(
      'ALTER TYPE "InventoryClothingRecommendationStatus"',
    );
    expect(migration).toContain("ADD VALUE 'WORN';");
    expect(migration).toContain("ADD VALUE 'DECLINED';");
  });

  test("links optional recommendation sources onto wear confirmations", () => {
    expect(migration).toContain(
      'ADD COLUMN "recommendationId" TEXT',
    );
    expect(migration).toContain(
      'ADD COLUMN "recommendationOptionId" TEXT',
    );
    expect(migration).toContain(
      'CONSTRAINT "inventory_clothing_wear_confirmation_recommendation_source_check"',
    );
    expect(migration).toContain(
      'CREATE INDEX "inventory_clothing_wear_confirmation_recommendationId_idx"',
    );
    expect(migration).toContain(
      'CREATE INDEX "inventory_clothing_wear_confirmation_recommendationOptionId_idx"',
    );
  });
});
