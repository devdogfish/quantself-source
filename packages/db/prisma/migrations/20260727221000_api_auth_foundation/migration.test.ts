import { describe, expect, it } from "bun:test";

const migration = await Bun.file(
  new URL("./migration.sql", import.meta.url),
).text();

describe("API auth foundation migration", () => {
  it("creates Better Auth core, passkey, and API-key storage", () => {
    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "passkey",
      "apikey",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }

    expect(migration).toContain(
      'CREATE INDEX "apikey_key_idx" ON "apikey"("key")',
    );
    expect(migration).toContain(
      'ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey"',
    );
  });

  it("does not disturb the manually managed Inventory partial index", () => {
    expect(migration).not.toContain(
      "inventory_item_placement_one_unplaced_key",
    );
  });
});
