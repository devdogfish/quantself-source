import { describe, expect, test } from "bun:test";

const cardSource = await Bun.file(
  new URL("./api-keys-card.tsx", import.meta.url),
).text();
const contractSource = await Bun.file(
  new URL("../../../../packages/auth/src/api-key-contract.ts", import.meta.url),
).text();
const authPackage = JSON.parse(
  await Bun.file(
    new URL("../../../../packages/auth/package.json", import.meta.url),
  ).text(),
) as {
  exports?: Record<string, string>;
};

describe("API key client boundary", () => {
  test("imports its runtime contract from a client-safe auth subpath", () => {
    expect(cardSource).not.toContain('from "@quantself/auth";');
    expect(cardSource).toContain('from "@quantself/auth/api-key-contract";');
    expect(authPackage.exports?.["./api-key-contract"]).toBe(
      "./src/api-key-contract.ts",
    );
    expect(contractSource).not.toContain("@quantself/db");
    expect(contractSource).not.toContain("./auth-config");
  });
});
