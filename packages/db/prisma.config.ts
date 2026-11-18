import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { env } from "prisma/config";

const packageDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(packageDir, "../../.env"), quiet: true });
config({ path: resolve(packageDir, ".env"), quiet: true });

export default defineConfig({
  // Multi-file schema layout per Prisma docs:
  // https://www.prisma.io/docs/orm/prisma-schema/overview/location#multi-file-prisma-schema
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
