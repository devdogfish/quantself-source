import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migration = readFileSync(
  new URL("./migration.sql", import.meta.url),
  "utf8",
);

describe("API idempotency request migration", () => {
  test("persists replay data and scopes keys by Client and operation", () => {
    expect(migration).toContain('CREATE TABLE "api_idempotency_request"');
    expect(migration).toContain('"requestHash" TEXT NOT NULL');
    expect(migration).toContain('"responseBody" JSONB NOT NULL');
    expect(migration).toContain('"statusCode" INTEGER NOT NULL');
    expect(migration).toContain(
      'ON "api_idempotency_request"("clientId", "operationId", "key")',
    );
  });
});
