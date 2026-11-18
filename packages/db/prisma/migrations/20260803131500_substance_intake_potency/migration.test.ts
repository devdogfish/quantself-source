import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("Substance Intake potency migration", () => {
  test("adds an optional potency source fact column", () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "substance_intake"\nADD COLUMN "potency" TEXT',
    );
    expect(migrationSql).not.toContain('"potency" TEXT NOT NULL');
  });
});
