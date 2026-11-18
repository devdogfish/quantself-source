import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("./migration.sql", import.meta.url), "utf8");

test("enforces specialist Profile category agreement from both write directions", () => {
  expect(migration).toContain("enforce_inventory_specialist_profile_category");
  expect(migration).toContain("inventory_clothing_profile_category_trigger");
  expect(migration).toContain("inventory_remedy_profile_category_trigger");
  expect(migration).toContain("inventory_item_specialist_profile_category_trigger");
  expect(migration).toContain("ERRCODE = '23514'");
});
