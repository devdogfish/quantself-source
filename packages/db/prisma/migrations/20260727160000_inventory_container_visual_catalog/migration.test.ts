import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migrationSql = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("inventory container visual catalog migration", () => {
  test("maps the known preset, defaults unknown presets, and reports fallback IDs", () => {
    expect(migrationSql).toContain(
      "WHEN preset.\"id\" = 'inventory-container-visual-preset-standard-tote' THEN '39L'",
    );
    expect(migrationSql).toContain(
      "WHEN preset.\"name\" = 'Standard tote' THEN '39L'",
    );
    expect(migrationSql).toContain("ELSE '6L'");
    expect(migrationSql).toContain(
      "'inventory_container % fallback to 6L from legacy preset id=% name=%'",
    );
    expect(migrationSql).toContain("fallback_container.container_id");
  });

  test("makes the catalog key required before removing legacy persistence", () => {
    const requireKeyIndex = migrationSql.indexOf(
      'ALTER COLUMN "visualPresetKey" SET NOT NULL',
    );
    const dropLegacyColumnIndex = migrationSql.indexOf(
      'DROP COLUMN "visualPresetId"',
    );
    const dropLegacyTableIndex = migrationSql.indexOf(
      'DROP TABLE "inventory_container_visual_preset"',
    );

    expect(requireKeyIndex).toBeGreaterThan(-1);
    expect(dropLegacyColumnIndex).toBeGreaterThan(requireKeyIndex);
    expect(dropLegacyTableIndex).toBeGreaterThan(dropLegacyColumnIndex);
    expect(migrationSql).not.toMatch(
      /\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE)\s+"inventory_container"/i,
    );
  });
});
