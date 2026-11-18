/** Synthetic Keep-only recording proof. Retain this capture for full restore.
 * Uses deployed service methods and existing credentials; creates no token and
 * never links a GitHub task or contacts a speech/transcription provider.
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
  throw new Error("Refusing to run outside private Keep validation");
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile("/tmp/keep-storage-254-synthetic-audio.wav");
const digest = hash(bytes);
if (bytes.length !== 8_640_044 || digest !== "31d6b7c418ac1485c02d35b70d08596ec14b2de9e879b21fcc8611b539aa2148") {
  throw new Error("Refusing to upload unknown fixture contents");
}
const id = "e36b6ed6-63a7-4de5-8fdc-01c9cfc889a1";
const requests: Record<string, Record<string, number>> = {};
let phase = "setup";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin !== expectedVaultOrigin) throw new Error("Unexpected network destination");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  requests[phase] ??= {};
  requests[phase][method] = (requests[phase][method] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;

const { createCaptureService, captureStore } = await import("/app/apps/api/src/todos-captures.ts");
const { todoGitHub } = await import("/app/apps/api/src/todos-github.ts");
const { prisma } = await import("/app/packages/db/index.ts");
try {
  const service = createCaptureService(captureStore, todoGitHub);
  await service.create({ id, source: "synthetic-storage-validation",
    capturedAt: "2026-11-14T04:00:00.000Z",
    transcript: "Synthetic #254 recovery fixture: 90 seconds of quiet generated tones; no voice or personal data.",
  });
  const previous = await prisma.originalFile.findUnique({ where: { key: `todo:${id}` }, select: { state: true } });
  phase = "upload";
  const started = performance.now();
  await service.upload(id, bytes, "audio/wav", 90);
  const uploadMs = Math.round(performance.now() - started);
  const checks = [];
  for (const [name, range, start, end] of [
    ["full1", null, 0, bytes.length - 1],
    ["full2", null, 0, bytes.length - 1],
    ["prefix", "bytes=0-65535", 0, 65535],
    ["middle", "bytes=4320044-4385579", 4320044, 4385579],
    ["suffix", "bytes=-65536", bytes.length - 65536, bytes.length - 1],
  ] as const) {
    phase = name;
    const started = performance.now();
    const response = await service.mediaResponse(id, range);
    const restored = new Uint8Array(await response.arrayBuffer());
    const elapsedMs = Math.round(performance.now() - started);
    const expected = bytes.subarray(start, end + 1);
    if (response.status !== (range ? 206 : 200) || restored.length !== expected.length
      || hash(restored) !== hash(expected) || response.headers.get("content-type") !== "audio/wav"
      || (range && response.headers.get("content-range") !== `bytes ${start}-${end}/${bytes.length}`)) {
      throw new Error("Audio content or range response differs");
    }
    checks.push({ name, status: response.status, bytes: restored.length, elapsedMs,
      contentRange: response.headers.get("content-range"), hashMatches: true });
  }
  phase = "unsatisfiable";
  const invalid = await service.mediaResponse(id, `bytes=${bytes.length}-`);
  await invalid.body?.cancel();
  if (invalid.status !== 416) throw new Error("Unsatisfiable range was not rejected");
  const ledger = await prisma.originalFile.findUniqueOrThrow({ where: { key: `todo:${id}` }, select: {
    provider: true, spaceId: true, fileId: true, pathHint: true, bytes: true, sha256: true, state: true,
  } });
  console.log(JSON.stringify({ syntheticOnly: true, captureId: id, durationSeconds: 90,
    sourceSha256: digest, reusedReadyOriginal: previous?.state === "ready", uploadMs,
    checks, unsatisfiableRangeStatus: invalid.status, requests, ledger,
    scope: "Deployed capture service timings; HTTP/browser playback and full recovery verified separately",
  }, null, 2));
} catch {
  console.error("Synthetic audio validation failed; inspect privately on Keep");
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
}
