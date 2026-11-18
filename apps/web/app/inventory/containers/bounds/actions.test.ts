import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("container bounds action boundary", () => {
  test("delegates authorization and persistence to the generated API Client", () => {
    const source = readFileSync(
      new URL("./actions.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('from "@/lib/quantself-api-client"');
    expect(source).not.toContain("owner-session-server");
    expect(source).not.toContain("inventory-prisma-repository");
    expect(source).not.toContain("@quantself/db");
  });
});
