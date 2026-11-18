import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("./migration.sql", import.meta.url), "utf8");

test("snapshots Clothing Product identity before detaching history on deletion", () => {
  expect(migration).toContain('ADD COLUMN "productId" TEXT');
  expect(migration).toContain('ADD COLUMN "productTitle" TEXT');
  expect(migration.match(/ON DELETE SET NULL/g)).toHaveLength(2);
  expect(migration).toContain('ALTER COLUMN "itemId" DROP NOT NULL');
});
