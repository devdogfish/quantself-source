import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("keeps container header actions compact and shifts nav controls left", () => {
  const source = readFileSync(
    new URL("./containers-client.tsx", import.meta.url),
    "utf8",
  );

  expect(source).toContain('boxSize: "10"');
  expect(source.match(/\.\.\.headerAction/g)).toHaveLength(2);
  expect(source).toContain('transform: "translateX(-1rem)"');
});
