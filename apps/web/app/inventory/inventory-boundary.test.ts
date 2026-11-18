import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const inventoryRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const webLibRoot = join(webRoot, "lib");
const blockedExternalImports = [
  "@quantself/auth",
  "@quantself/db",
  "@better-auth/",
  "better-auth",
];
const blockedLocalModules = new Set([
  "inventory-asset-response.ts",
  "inventory-audio-response.ts",
  "inventory-codex-enrichment-worker.ts",
  "inventory-container-visual-bounds.ts",
  "inventory-enrichment-route-handlers.ts",
  "inventory-enrichment-service.ts",
  "inventory-girke-preprocessing-worker.ts",
  "inventory-girke-preprocessing.ts",
  "inventory-image-response.ts",
  "inventory-preprocessing-route-handlers.ts",
  "inventory-preprocessing-service.ts",
  "inventory-prisma-repository.ts",
  "inventory-service.ts",
  "inventory-values.ts",
  "owner-api-keys-server.ts",
  "owner-session-server.ts",
]);
const obsoleteWebBackendModules = [
  "inventory-asset-response.ts",
  "inventory-audio-response.ts",
  "inventory-container-visual-bounds.ts",
  "inventory-enrichment-route-handlers.ts",
  "inventory-enrichment-service.ts",
  "inventory-image-response.ts",
  "inventory-preprocessing-route-handlers.ts",
  "inventory-preprocessing-service.ts",
  "inventory-prisma-repository.ts",
  "inventory-service.ts",
  "inventory-values.ts",
];

describe("inventory web boundary", () => {
  test("production inventory code cannot transitively reach Web backend modules", () => {
    const entrypoints = listInventoryProductionSourceFiles(inventoryRoot);

    expect(entrypoints.length).toBeGreaterThan(0);
    expect(findBoundaryViolations(entrypoints)).toEqual([]);
  });

  test("privileged Inventory implementations are absent from Web ownership", () => {
    expect(
      obsoleteWebBackendModules.filter((moduleName) =>
        existsSync(join(webLibRoot, moduleName)),
      ),
    ).toEqual([]);
  });
});

function findBoundaryViolations(entrypoints: string[]): string[] {
  const visited = new Set<string>();
  const violations = new Set<string>();

  function visit(file: string, importChain: string[]): void {
    if (visited.has(file)) {
      return;
    }

    visited.add(file);
    const source = readFileSync(file, "utf8");

    for (const importSpecifier of sourceImportSpecifiers(source)) {
      const localModule = resolveLocalModule(file, importSpecifier);

      if (localModule) {
        const nextChain = [...importChain, localModule];

        if (blockedLocalModules.has(localModule.split("/").at(-1) ?? "")) {
          violations.add(formatViolation(importSpecifier, nextChain));
          continue;
        }

        visit(localModule, nextChain);
        continue;
      }

      if (isBlockedExternalImport(importSpecifier)) {
        violations.add(formatViolation(importSpecifier, importChain));
      }
    }
  }

  for (const entrypoint of entrypoints) {
    visit(entrypoint, [entrypoint]);
  }

  return [...violations].sort();
}

function sourceImportSpecifiers(source: string): string[] {
  const staticImports =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

  return [
    ...source.matchAll(staticImports),
    ...source.matchAll(dynamicImports),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
}

function resolveLocalModule(
  importingFile: string,
  importSpecifier: string,
): string | null {
  const basePath = importSpecifier.startsWith("@/")
    ? resolve(webRoot, importSpecifier.slice(2))
    : importSpecifier.startsWith(".")
      ? resolve(dirname(importingFile), importSpecifier)
      : null;

  if (!basePath) {
    return null;
  }

  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
  ];

  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

function isBlockedExternalImport(importSpecifier: string): boolean {
  return blockedExternalImports.some(
    (blockedImport) =>
      importSpecifier === blockedImport ||
      importSpecifier.startsWith(
        blockedImport.endsWith("/") ? blockedImport : `${blockedImport}/`,
      ),
  );
}

function formatViolation(
  importSpecifier: string,
  importChain: string[],
): string {
  return `${importSpecifier}: ${importChain
    .map((file) => relative(webRoot, file))
    .join(" -> ")}`;
}

function listInventoryProductionSourceFiles(root: string): string[] {
  return walk(root).filter(
    (file) =>
      (file.endsWith(".ts") || file.endsWith(".tsx")) &&
      !file.endsWith(".test.ts") &&
      !file.endsWith(".test.tsx"),
  );
}

function walk(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const file = join(directory, entry.name);

    if (entry.isDirectory()) {
      return walk(file);
    }

    return [file];
  });
}
