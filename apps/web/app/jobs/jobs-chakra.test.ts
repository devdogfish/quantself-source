import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

test("Jobs presentation uses Chakra without utility classes", async () => {
  const directory = import.meta.dir;
  const files = (await readdir(directory, { recursive: true })).filter(
    (file) => file.endsWith(".tsx") && !file.includes(".test."),
  );
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    expect(source, file).not.toMatch(/className=["{]/);
  }
});
