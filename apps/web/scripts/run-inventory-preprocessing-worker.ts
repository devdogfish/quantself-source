import { hostname } from "node:os";
import { runInventoryWorkerLoop } from "./inventory-worker-loop";

import { createInventoryGirkePreprocessingAdapter } from "../lib/inventory-girke-preprocessing";
import {
  createInventoryGirkePreprocessingWorkerApiClient,
  runInventoryGirkePreprocessingWorkerOnce,
} from "../lib/inventory-girke-preprocessing-worker";

async function main(): Promise<void> {
  const apiClient = createInventoryGirkePreprocessingWorkerApiClient({
    baseUrl: requireEnv("INVENTORY_PREPROCESSING_WORKER_BASE_URL"),
    secret: requireEnv("INVENTORY_PREPROCESSING_WORKER_SECRET"),
  });
  const adapter = createInventoryGirkePreprocessingAdapter();
  const workerId =
    cleanOptionalString(process.env.INVENTORY_PREPROCESSING_WORKER_ID) ??
    `inventory-preprocessing-${hostname()}-${process.pid}`;
  const leaseSeconds = parseIntegerEnv(
    "INVENTORY_PREPROCESSING_WORKER_LEASE_SECONDS",
    300,
    1,
    60 * 60,
  );
  const limit = parseIntegerEnv("INVENTORY_PREPROCESSING_WORKER_BATCH_SIZE", 1, 1, 50);
  const pollIntervalMs = parseIntegerEnv(
    "INVENTORY_PREPROCESSING_WORKER_POLL_INTERVAL_MS",
    5000,
    250,
    300000,
  );
  await runInventoryWorkerLoop(async () => {
    const summary = await runInventoryGirkePreprocessingWorkerOnce({
      adapter,
      apiClient,
      leaseSeconds,
      limit,
      workerId,
    });

    if (summary.claimed > 0) {
      console.log(
        `[inventory-preprocessing-worker] claimed=${summary.claimed} succeeded=${summary.succeeded} failed=${summary.failed}`,
      );
    }

    return summary.claimed;
  }, { pollIntervalMs, runOnce: process.argv.includes("--once") });
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
      : "Inventory preprocessing worker failed.",
  );
  process.exit(1);
});
