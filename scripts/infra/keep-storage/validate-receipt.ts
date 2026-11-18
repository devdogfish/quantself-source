/** Run only inside the existing private Keep API container, with a synthetic PNG.
 * Uses the deployed adapter and its existing scoped credential; creates no token.
 * Leaves the synthetic receipt in place for the coordinated restore drill.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Keep this probe self-contained for the documented bun stdin invocation.
function expectedProbeOrigin(name: string): string {
  try {
    const value = new URL(process.env[name] ?? "");
    if (value.protocol === "https:" && value.hostname && !value.username &&
      !value.password && value.port !== "0" && value.pathname === "/" && !value.search && !value.hash) {
      return value.origin;
    }
  } catch {
    // A malformed private input must fail before any probe traffic.
  }
  throw new Error("Explicit private HTTPS probe origin required");
}

const expectedAppOrigin = expectedProbeOrigin("KEEP_BETTER_AUTH_URL");
const expectedVaultOrigin = expectedProbeOrigin("KEEP_OPENCLOUD_URL");

if (process.env.BETTER_AUTH_URL !== expectedAppOrigin
  || process.env.QUANTSELF_OPENCLOUD_URL !== expectedVaultOrigin
  || process.env.QUANTSELF_ORIGINALS_PROVIDER !== "opencloud"
  || process.env.QUANTSELF_INSTANCE_NAME !== "Quantself Keep — private validation") {
  throw new Error("Refusing to run outside the private Keep validation environment");
}

const bytes = await readFile("/tmp/keep-storage-254-synthetic-receipt.png");
if (bytes.length > 10_000_000 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("Expected the bounded synthetic PNG fixture");
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const digest = hash(bytes);
if (digest !== "617dde7b47140b8da416a5e1fff569bdb889b1f8181ed11c3dfbe947e75ecc86") {
  throw new Error("Fixture hash differs; refusing to upload unknown contents");
}
const receiptId = "cb117495-d376-4a39-a8a0-4437b0a03855";
const seedReceiptId = "7d76f27e-20cf-47ee-b0b3-9075c336bf74";
const requests: Record<string, Record<string, number>> = {};
let phase = "setup";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // Count methods only. Never log request URLs, headers, bodies or credentials.
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin === expectedVaultOrigin) {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests[phase] ??= {};
    requests[phase][method] = (requests[phase][method] ?? 0) + 1;
  }
  return realFetch(input, init);
}) as typeof fetch;

// These absolute imports deliberately select the deployed code, not a local build.
const { originalFiles } = await import("/app/apps/api/src/original-files.ts");
const { prisma } = await import("/app/packages/db/index.ts");
try {
  const seed = await prisma.budgetReceipt.findFirst({
    where: { id: seedReceiptId }, select: { ownerId: true },
  });
  if (!seed) throw new Error("Expected synthetic browser receipt is missing");
  const key = `receipt:${seed.ownerId}:${receiptId}`;
  const previous = await prisma.originalFile.findUnique({ where: { key }, select: { state: true } });
  phase = "upload";
  const uploadStarted = performance.now();
  const reference = await originalFiles.put(key, bytes, "image/png", "Receipts", "keep-storage-254-synthetic-receipt.png");
  const uploadMs = performance.now() - uploadStarted;
  const existing = await prisma.budgetReceipt.findUnique({
    where: { ownerId_id: { ownerId: seed.ownerId, id: receiptId } },
    select: { originalKey: true, imageHash: true },
  });
  if (existing && (existing.originalKey !== reference || existing.imageHash !== digest)) {
    throw new Error("Synthetic receipt identity conflicts with an existing record");
  }
  if (!existing) await prisma.budgetReceipt.create({ data: {
    ownerId: seed.ownerId, id: receiptId, kind: "receipt",
    title: "SYNTHETIC #254 image recovery test", originalKey: reference,
    imageHash: digest, mime: "image/png", lines: [], scanStatus: "archived",
  } });
  const reads = [];
  for (let i = 0; i < 2; i++) {
    phase = `read${i + 1}`;
    const started = performance.now();
    const response = await originalFiles.open(reference);
    const restored = new Uint8Array(await response.arrayBuffer());
    const elapsedMs = performance.now() - started;
    if (response.status !== 200 || restored.length !== bytes.length || hash(restored) !== digest) {
      throw new Error("Synthetic original readback failed");
    }
    reads.push({ elapsedMs: Math.round(elapsedMs), status: response.status, bytes: restored.length });
  }
  const ledger = await prisma.originalFile.findUniqueOrThrow({ where: { key }, select: {
    provider: true, spaceId: true, fileId: true, pathHint: true, bytes: true, sha256: true, state: true,
  } });
  console.log(JSON.stringify({ syntheticOnly: true, receiptId, originalReference: reference,
    reusedReadyOriginal: previous?.state === "ready", sourceSha256: digest,
    uploadMs: Math.round(uploadMs), reads, requests, ledger,
    scope: "Deployed adapter timings inside API container; not browser upload latency or backup recovery",
  }, null, 2));
} catch {
  // Do not expose an upstream exception's private response body or connection URL.
  console.error("Synthetic receipt validation failed; inspect privately on Keep");
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
}
