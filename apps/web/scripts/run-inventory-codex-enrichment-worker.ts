import { hostname } from "node:os";
import { runInventoryWorkerLoop } from "./inventory-worker-loop";

import {
  createCodexSdkInventoryEnrichmentClient,
  createInventoryCodexEnrichmentWorkerApiClient,
  runInventoryCodexEnrichmentWorkerOnce,
} from "../lib/inventory-codex-enrichment-worker";

async function main(): Promise<void> {
  const apiClient = createInventoryCodexEnrichmentWorkerApiClient({
    baseUrl: requireEnv("INVENTORY_ENRICHMENT_WORKER_BASE_URL"),
    secret: requireEnv("INVENTORY_ENRICHMENT_WORKER_SECRET"),
  });
  const codexClient = createCodexSdkInventoryEnrichmentClient({
    model: cleanOptionalString(process.env.INVENTORY_ENRICHMENT_CODEX_MODEL) ?? undefined,
    workingDirectory:
      cleanOptionalString(
      process.env.INVENTORY_ENRICHMENT_CODEX_WORKDIR,
      ) ?? undefined,
  });
  const workerId =
    cleanOptionalString(process.env.INVENTORY_ENRICHMENT_WORKER_ID) ??
    `inventory-codex-${hostname()}-${process.pid}`;
  const leaseSeconds = parseIntegerEnv(
    "INVENTORY_ENRICHMENT_WORKER_LEASE_SECONDS",
    300,
    1,
    60 * 60,
  );
  const limit = parseIntegerEnv("INVENTORY_ENRICHMENT_WORKER_BATCH_SIZE", 1, 1, 50);
  const pollIntervalMs = parseIntegerEnv(
    "INVENTORY_ENRICHMENT_WORKER_POLL_INTERVAL_MS",
    5000,
    250,
    300000,
  );
  await runInventoryWorkerLoop(async () => {
    await requireCodexLogin();

    const summary = await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      leaseSeconds,
      limit,
      workerId,
    });

    if (summary.claimed > 0) {
      console.log(
        `[inventory-codex-worker] claimed=${summary.claimed} succeeded=${summary.succeeded} failed=${summary.failed}`,
      );
    }

    return summary.claimed;
  }, { pollIntervalMs, runOnce: process.argv.includes("--once") });
}

async function requireCodexLogin(): Promise<void> {
  const process = Bun.spawn(["codex", "login", "status"], {
    stderr: "ignore",
    stdout: "ignore",
  });

  if ((await process.exited) !== 0) {
    throw new Error(
      "Codex authentication is required before the inventory enrichment worker can start.",
    );
  }
}

function requireEnv(name: string): string {
  const value = cleanOptionalString(process.env[name]);

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function cleanOptionalString(value: string | undefined): string | null {
  const cleaned = value?.trim();

  return cleaned ? cleaned : null;
}

function parseIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = cleanOptionalString(process.env[name]);

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, parsed));
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Inventory Codex enrichment worker failed.",
  );
  process.exit(1);
});
