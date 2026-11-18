import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeAuthSecretFile,
  resolveAuthSecret,
} from "./auth-secret";

describe("resolveAuthSecret", () => {
  test("permits a build-only secret during Next production compilation", () => {
    expect(
      resolveAuthSecret({
        NEXT_PHASE: "phase-production-build",
        NODE_ENV: "production",
      }).length,
    ).toBeGreaterThanOrEqual(32);
  });

  test("still requires a strong secret at production runtime", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(
      "BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE is required in production",
    );
    expect(() =>
      resolveAuthSecret({
        BETTER_AUTH_SECRET: "short",
        NODE_ENV: "production",
      }),
    ).toThrow("BETTER_AUTH_SECRET must contain at least 32 characters");
  });

  test("reads a persistent secret file at production runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "quantself-auth-secret-"));
    const path = join(directory, "auth-secret");
    const secret = "persistent-auth-secret-that-is-long-enough";
    writeFileSync(path, `${secret}\n`);

    expect(
      resolveAuthSecret({
        BETTER_AUTH_SECRET_FILE: path,
        NODE_ENV: "production",
      }),
    ).toBe(secret);
  });

  test("prefers an explicit secret over the persistent file", () => {
    expect(
      resolveAuthSecret({
        BETTER_AUTH_SECRET: "explicit-auth-secret-that-is-long-enough",
        BETTER_AUTH_SECRET_FILE: "/does/not/exist",
        NODE_ENV: "production",
      }),
    ).toBe("explicit-auth-secret-that-is-long-enough");
  });

  test("reports a missing persistent secret file", () => {
    expect(() =>
      resolveAuthSecret({
        BETTER_AUTH_SECRET_FILE: "/does/not/exist",
        NODE_ENV: "production",
      }),
    ).toThrow("BETTER_AUTH_SECRET_FILE does not exist: /does/not/exist");
  });
});

describe("initializeAuthSecretFile", () => {
  test("creates a strong private secret once and preserves it", () => {
    const directory = mkdtempSync(join(tmpdir(), "quantself-auth-secret-"));
    const path = join(directory, "nested", "auth-secret");
    const generated = "generated-auth-secret-that-is-long-enough";

    expect(initializeAuthSecretFile(path, () => generated)).toEqual({
      created: true,
      path,
    });
    expect(readFileSync(path, "utf8")).toBe(`${generated}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(
      initializeAuthSecretFile(path, () => {
        throw new Error("must not regenerate");
      }),
    ).toEqual({ created: false, path });
    expect(readFileSync(path, "utf8")).toBe(`${generated}\n`);
  });

  test("rejects an invalid existing secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "quantself-auth-secret-"));
    const path = join(directory, "auth-secret");
    writeFileSync(path, "short\n");
    chmodSync(path, 0o600);

    expect(() => initializeAuthSecretFile(path)).toThrow(
      "BETTER_AUTH_SECRET_FILE must contain at least 32 characters",
    );
  });
});
