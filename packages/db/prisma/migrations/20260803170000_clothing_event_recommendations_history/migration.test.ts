import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);
const inventorySchema = readFileSync(
  join(import.meta.dir, "../../models/inventory.prisma"),
  "utf8",
);

describe("Clothing event recommendations history migration", () => {
  test("adds event recommendation shape to persisted outfits", () => {
    expect(migrationSql).toContain(
      'ALTER TYPE "InventoryClothingRecommendationKind"',
    );
    expect(migrationSql).toContain("ADD VALUE 'EVENT';");
    expect(migrationSql).toContain('"eventLabel" TEXT');
    expect(migrationSql).toContain('"eventStartsAt" TIMESTAMP(3)');
  });

  test("guards daily versus event recommendation shape", () => {
    expect(migrationSql).toContain(
      '"inventory_clothing_recommendation_kind_event_shape"',
    );
    expect(migrationSql).toContain('"kind" = \'DAILY\'');
    expect(migrationSql).toContain('"kind" = \'EVENT\'');
    expect(migrationSql).toContain(
      '"targetDate" = CAST("eventStartsAt" AS DATE)',
    );
  });

  test("enforces one published event slot per label and start time", () => {
    expect(migrationSql).toContain(
      '"inventory_clothing_recommendation_one_published_event_per_start"',
    );
    expect(migrationSql).toContain('"eventLabel", "eventStartsAt"');
    expect(migrationSql).toContain('"status" = \'PUBLISHED\'');
  });

  test("keeps the event lookup index represented in the Prisma schema", () => {
    expect(inventorySchema).toContain(
      "@@index([kind, eventStartsAt, status, publishedAt])",
    );
  });
});
