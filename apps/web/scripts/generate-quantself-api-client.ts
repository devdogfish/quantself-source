import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "quantself-openapi-"));
  try {
    const document = join(directory, "openapi.json");
    const emitter = fileURLToPath(new URL("../../api/src/emit-openapi.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", emitter, document], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("OpenAPI document generation failed.");

    const ast = await openapiTS(await readFile(document));
    const output = new URL("../lib/generated/quantself-api-schema.ts", import.meta.url);
    await writeFile(output, COMMENT_HEADER + astToString(ast), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
