import { writeFile } from "node:fs/promises";
import { createApp } from "./app";
import { getOpenAPIDocument } from "./openapi";

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("An OpenAPI output path is required.");

  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => null,
  });
  await writeFile(output, JSON.stringify(getOpenAPIDocument(app)), "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
