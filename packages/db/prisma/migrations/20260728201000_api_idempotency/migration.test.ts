import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationSql = readFileSync(
  join(import.meta.dir, "migration.sql"),
  "utf8",
);

describe("API idempotency migration", () => {
  test("creates a client-and-operation scoped idempotency table", () => {
    expect(migrationSql).toContain('CREATE TABLE "api_idempotency_key"');
    expect(migrationSql).toContain(
      '"api_idempotency_key_clientId_operation_idempotencyKey_key"',
    );
    expect(migrationSql).toContain(
      'ON "api_idempotency_key"("clientId", "operation", "idempotencyKey")',
    );
  });

  test("stores response payloads after business writes complete", () => {
    expect(migrationSql).toContain('"responseStatus" INTEGER');
    expect(migrationSql).toContain('"responseBody" JSONB');
  });
});
