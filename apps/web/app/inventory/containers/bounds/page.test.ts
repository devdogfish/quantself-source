import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("container bounds page", () => {
  test("links back to the container view", () => {
    const source = readFileSync(
      new URL("./bounds-frame.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('href="/inventory/containers"');
    expect(source).toContain("Containers");
    expect(source).toContain("<ArrowLeftIcon");
  });
});
