import { describe, expect, it } from "bun:test";

const migration = await Bun.file(
  new URL("./migration.sql", import.meta.url),
).text();

describe("owner setup bootstrap migration", () => {
  it("creates owner and setup token storage", () => {
    expect(migration).toContain('CREATE TABLE "auth_owner"');
    expect(migration).toContain(
      `CONSTRAINT "auth_owner_singleton_check" CHECK ("id" = 'singleton')`,
    );
    expect(migration).toContain('CREATE TABLE "owner_setup_token"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "owner_setup_token_tokenHash_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "owner_setup_token_one_open_key"',
    );
    expect(migration).toContain(
      'ALTER TABLE "auth_owner" ADD CONSTRAINT "auth_owner_userId_fkey"',
    );
    expect(migration).toContain("ON DELETE RESTRICT");
  });
});
