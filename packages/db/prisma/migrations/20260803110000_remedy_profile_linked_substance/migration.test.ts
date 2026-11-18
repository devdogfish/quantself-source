import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("Remedy Profile linked substance migration", () => {
  test("adds a required unique linked Substance to every Remedy Profile", () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "inventory_remedy_profile"\nADD COLUMN "substanceId" TEXT',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "inventory_remedy_profile"\nALTER COLUMN "substanceId" SET NOT NULL',
    );
    expect(migrationSql).toContain(
      '"inventory_remedy_profile_substanceId_key"',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("substanceId") REFERENCES "substance"("id")',
    );
  });

  test("backfills opaque HOMEOPATHY Substances before enforcing the relation", () => {
    const insertSubstances = migrationSql.indexOf('INSERT INTO "substance"');
    const updateProfiles = migrationSql.indexOf(
      'UPDATE "inventory_remedy_profile" AS profile',
    );
    const enforceRequired = migrationSql.indexOf(
      'ALTER TABLE "inventory_remedy_profile"\nALTER COLUMN "substanceId" SET NOT NULL',
    );

    expect(insertSubstances).toBeGreaterThan(-1);
    expect(updateProfiles).toBeGreaterThan(insertSubstances);
    expect(enforceRequired).toBeGreaterThan(updateProfiles);
    expect(migrationSql).toContain(`'HOMEOPATHY'`);
    expect(migrationSql).toContain(`'remedy_substance_' || md5("itemId")`);
    expect(migrationSql).toContain(`'__remedy__:' || "itemId"`);
    expect(migrationSql).toContain(`jsonb_build_object('linkedInventoryProductId', "itemId")`);
  });
});
