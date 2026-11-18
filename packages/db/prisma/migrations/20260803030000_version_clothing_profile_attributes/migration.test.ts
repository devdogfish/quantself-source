import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("version Clothing Profile attributes migration", () => {
  test("backfills version 1 and makes it the database default", () => {
    expect(migrationSql).toContain(
      `jsonb_set("attributes", '{version}', '1'::jsonb, true)`,
    );
    expect(migrationSql).toContain(`WHERE NOT ("attributes" ? 'version')`);
    expect(migrationSql).toContain(
      `ALTER COLUMN "attributes" SET DEFAULT '{"version":1}'::jsonb`,
    );
  });
});
