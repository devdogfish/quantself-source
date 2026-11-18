import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("API key rate-limit migration", () => {
  test("raises the default limit to 25,000 requests per day", () => {
    expect(migration).toContain(
      'ALTER COLUMN "rateLimitMax" SET DEFAULT 25000',
    );
    expect(migration).toContain(
      'ALTER COLUMN "rateLimitTimeWindow" SET DEFAULT 86400000',
    );
  });

  test("unlocks existing keys that still use Better Auth defaults", () => {
    expect(migration).toContain('UPDATE "apikey"');
    expect(migration).toContain('"rateLimitMax" = 25000');
    expect(migration).toContain('"requestCount" = 0');
    expect(migration).toContain('"lastRequest" = NULL');
    expect(migration).toContain('"rateLimitMax" = 10');
    expect(migration).toContain('"rateLimitEnabled" IS DISTINCT FROM FALSE');
  });
});
