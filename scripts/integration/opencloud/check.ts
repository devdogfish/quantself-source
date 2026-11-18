import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { OpenAPIHono } from "../../../apps/api/node_modules/@hono/zod-openapi";
import sharp from "../../../apps/api/node_modules/sharp";
import { prisma } from "../../../packages/db";
import { registerBudgetingRoutes } from "../../../apps/api/src/budgeting-route";
import { registerInventoryWorkerRoutes, inventoryWorkerRouteHandlers } from "../../../apps/api/src/inventory-worker-route";
import { registerCaptureRoutes } from "../../../apps/api/src/todos-captures-route";
import { captureStore } from "../../../apps/api/src/todos-captures";
import { createAudioStorage } from "../../../apps/api/src/todos-audio";
import { registerInventoryItemMediaRoutes, inventoryItemMediaRouteHandlers } from "../../../apps/api/src/inventory-item-media-route";
import { originalFiles, createOriginalFiles, readOriginalBytes } from "../../../apps/api/src/original-files";
import { openCloudFromEnvironment, createOpenCloudStorage, OriginalStorageError, sha256 } from "../../../apps/api/src/original-storage";
import { inventory, convert, replayManifest } from "../../originals/convert";

assert.equal(process.env.QUANTSELF_STORAGE_INTEGRATION, "1");
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/quantself_storage_integration");
assert.equal(process.env.QUANTSELF_OPENCLOUD_URL, "https://localhost:19200");
const dir = process.env.INTEGRATION_DIR!;
const report: { checks: string[]; measurements: any[] } = { checks: [], measurements: [] };
const pass = (name: string) => { report.checks.push(name); console.log("PASS", name); };
const transport = globalThis.fetch;
let requests: { method: string; bytes: number; status: number; ms: number; downloadedBytes: number }[] = [];
let loseMove = false, forceStatus = 0, failNetwork = false;
globalThis.fetch = (async (url: any, init: any = {}) => {
  if (!String(url).startsWith("https://localhost:19200")) return transport(url, init);
  if (failNetwork) throw new DOMException("Synthetic network timeout", "TimeoutError");
  if (forceStatus) return new Response(null, { status: forceStatus });
  const start = performance.now();
  const response = await transport(url, init);
  requests.push({ method: init.method ?? "GET", bytes: init.body instanceof Uint8Array ? init.body.length : 0, status: response.status, downloadedBytes: Number(response.headers.get("content-length") ?? 0), ms: Math.round(performance.now() - start) });
  if (loseMove && init.method === "MOVE" && response.ok) { loseMove = false; await response.body?.cancel(); throw Error("Ambiguous MOVE"); }
  return response;
}) as typeof fetch;
const app = new OpenAPIHono<any>();
app.use("*", async (c, next) => {
  const role = c.req.header("x-test-role");
  c.set("accessContext", role === "anonymous" ? null : {
    owner: { id: "synthetic-owner" }, client: { id: "synthetic-client", kind: role === "agent" ? "api-key" : "web" },
    permissions: role === "denied" ? [] : ["budgeting:read", "budgeting:write", "budgeting:delete", "todos:read", "todos:write", "todos:delete", "inventory:read", "inventory:write"],
  });
  await next();
});
app.onError((error) => { if (error instanceof OriginalStorageError) return Response.json({ code: error.code }, { status: error.status }); console.error(error); return new Response("Failed", { status: 500 }); });
registerBudgetingRoutes(app);
registerCaptureRoutes(app, { list: async () => [], detail: async () => { throw Error("No GitHub in synthetic tests"); } } as any);
registerInventoryItemMediaRoutes(app, inventoryItemMediaRouteHandlers);
registerInventoryWorkerRoutes(app, inventoryWorkerRouteHandlers);
process.env.INVENTORY_PREPROCESSING_WORKER_SECRET = "synthetic-worker-secret";
  let failAttachment = true;
  const receiptDb = new Proxy(prisma, { get(target, prop) {
    if (prop !== "$transaction") return Reflect.get(target, prop);
    return (run: any, opts: any) => target.$transaction(async tx => run(new Proxy(tx, { get(transaction, member) {
      if (member !== "budgetReceipt") return Reflect.get(transaction, member);
      return new Proxy(transaction.budgetReceipt, { get(model, method) {
        if (method === "create") return (input: any) => { if (failAttachment) { failAttachment = false; throw Error("Synthetic receipt DB write failure"); } return model.create(input); };
        return Reflect.get(model, method);
      } });
    } })), opts);
  } });
  const failureApp = new OpenAPIHono<any>(); registerBudgetingRoutes(failureApp, receiptDb); app.route("/db-failure", failureApp);
const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:19301${path}`, { ...init, headers: { origin: "http://localhost:19301", ...Object.fromEntries(new Headers(init.headers)) } });
async function json(path: string, init: RequestInit = {}, expected = 200) {
  const response = await request(path, init);
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body)); return body as any;
}
const receiptId = crypto.randomUUID();
const image = await sharp({ create: { width: 64, height: 96, channels: 3, background: "white" } }).png().toBuffer();
const uploadReceipt = (id = receiptId, bytes = image) => {
  const body = new FormData(); body.set("id", id); body.set("scan", "no"); body.set("photo", new File([new Uint8Array(bytes)], "synthetic-receipt.png", { type: "image/png" }));
  return request("/api/v1/budgeting/receipts", { method: "POST", body });
};
async function measured(name: string, operation: () => Promise<unknown>, payloadBytes: number) {
  requests = []; const start = performance.now(); await operation();
  report.measurements.push({ name, ms: Math.round(performance.now() - start), requests: requests.length, payloadBytes, uploadedBytes: requests.reduce((sum, r) => sum + r.bytes, 0), downloadedBytes: requests.reduce((sum, r) => sum + r.downloadedBytes, 0), methods: requests.map(r => `${r.method}:${r.status}`) });
}
try {
  await measured("receipt upload cold", async () => { const response = await uploadReceipt(); assert.equal(response.status, 200, await response.text()); }, image.length);
  const receipt = await prisma.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId: "synthetic-owner", id: receiptId } } });
  assert.equal(receipt.image, null); assert(receipt.originalKey);
  for (const role of ["anonymous", "agent", "denied"]) {
    const response = await request(`/api/v1/budgeting/receipts/${receiptId}/original`, { headers: { "x-test-role": role } });
    assert.equal(response.status, role === "anonymous" ? 401 : 403);
  }
  await measured("receipt open warm", async () => assert.deepEqual(Buffer.from(await (await request(`/api/v1/budgeting/receipts/${receiptId}/original`)).arrayBuffer()), image), image.length);
  await measured("receipt list", () => json("/api/v1/budgeting/receipts"), 0);
  assert.equal(requests.length, 0);
  pass("Actual receipt upload/open/list; original bytes absent from PostgreSQL; Owner-only authorization");
  assert.equal((await uploadReceipt(receiptId, Buffer.concat([image, Buffer.from("changed")]))).status, 409);
  const before = await prisma.originalFile.count();
  await Promise.all([uploadReceipt(), uploadReceipt()]);
  assert.equal(await prisma.originalFile.count(), before);
  const sameContent = Buffer.concat([image, Buffer.from("concurrent-new-content")]);
  const beforeConcurrent = await prisma.originalFile.count();
  const duplicates = await Promise.all([uploadReceipt(crypto.randomUUID(), sameContent), uploadReceipt(crypto.randomUUID(), sameContent)]);
  for (const response of duplicates) assert.equal(response.status, 200, await response.clone().text());
  const identities = await Promise.all(duplicates.map(response => response.json() as Promise<any>));
  assert.equal(identities[0].id, identities[1].id);
  assert.equal(await prisma.originalFile.count(), beforeConcurrent + 1);
  pass("Concurrent receipt retries deduplicate even across different IDs; changed-payload replay rejected");

  const recording = dir + "/recording.wav";
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=180", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", recording]);
  const audio = await readFile(recording); // realistic three-minute, 34.6MB PCM upload
  const captureId = crypto.randomUUID(); const capturePath = `/api/v1/todo-captures/${captureId}`;
  await json("/api/v1/todo-captures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: captureId, source: "synthetic", capturedAt: new Date().toISOString(), transcript: "Synthetic tone only" }) });
  const uploadAudio = () => request(capturePath + "/audio", { method: "PUT", headers: { "x-audio-mime": "audio/wav" }, body: audio });
  await measured("recording upload cold", async () => { const r = await uploadAudio(); assert.equal(r.status, 200, await r.text()); }, audio.length);
  await measured("recording range warm", async () => {
    const response = await request(capturePath + "/audio", { headers: { range: "bytes=1000000-1000999" } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes 1000000-1000999/${audio.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(1000000, 1001000));
  }, 1000);
  assert.equal(requests.length, 1);
  await measured("recording open warm", async () => {
    const response = await request(capturePath + "/audio");
    const digest = createHash("sha256");
    for await (const chunk of response.body!) digest.update(chunk);
    assert.equal(digest.digest("hex"), sha256(audio));
  }, audio.length);
  await measured("capture transcript", () => json(capturePath), 0); assert.equal(requests.length, 0);
  assert.equal((await request(capturePath + "/audio", { headers: { "x-test-role": "denied" } })).status, 403);
  assert.equal((await request(capturePath + "/audio", { headers: { range: "bytes=999999999-" } })).status, 416);
  pass("Actual capture recording upload/seek, denied access, invalid range and database-only transcript");

  const ambiguousId = crypto.randomUUID(); loseMove = true;
  assert.equal((await uploadReceipt(ambiguousId, Buffer.concat([image, Buffer.from("ambiguous")]))).status, 503);
  const pending = await prisma.originalFile.findUniqueOrThrow({ where: { key: `receipt:synthetic-owner:${ambiguousId}` } }); assert.equal(pending.state, "pending");
  const beforeAmbiguousRetry = await prisma.originalFile.count();
  assert.equal((await uploadReceipt(crypto.randomUUID(), Buffer.concat([image, Buffer.from("ambiguous")]))).status, 200);
  assert.equal(await prisma.originalFile.count(), beforeAmbiguousRetry);
  pass("Actual route recovers ambiguous MOVE using durable pending record and verified hash");
  const failedId = crypto.randomUUID(); const failedBytes = Buffer.concat([image, Buffer.from("db-attachment")]);
  const failedUpload = () => {
    const body = new FormData(); body.set("id", failedId); body.set("scan", "no"); body.set("photo", new File([failedBytes], "failed-db.png", { type: "image/png" }));
    return request("/db-failure/api/v1/budgeting/receipts", { method: "POST", body });
  };
  assert.equal((await failedUpload()).status, 500);
  requests = [];
  assert.equal((await failedUpload()).status, 200); assert.equal(requests.length, 0);
  pass("Actual receipt route recovers DB attachment failure without uploading another original");

  // Inject a DB commit failure after successful remote storage; fresh service must recover.
  const key = `integration-db-failure:${crypto.randomUUID()}`;
  let failDb = true;
  const failingDb = new Proxy(prisma, { get(target, prop) {
    if (prop === "$transaction") return (run: any, opts: any) => target.$transaction(async tx => { const result = await run(tx); if (failDb) { failDb = false; throw Error("Synthetic database failure"); } return result; }, opts);
    return Reflect.get(target, prop);
  } });
  const failing = createOriginalFiles(failingDb);
  await assert.rejects(failing.put(key, image, "image/png", "Receipts", "db-failure.png"));
  assert.equal((await prisma.originalFile.findUniqueOrThrow({ where: { key } })).state, "pending");
  const recovered = await createOriginalFiles().put(key, image, "image/png", "Receipts", "db-failure.png");
  assert.deepEqual(await readOriginalBytes(recovered), image);
  const concurrentKey = `integration-concurrent:${crypto.randomUUID()}`;
  assert.deepEqual(await Promise.all([originalFiles.put(concurrentKey, image, "image/png", "Receipts", "concurrent.png"), originalFiles.put(concurrentKey, image, "image/png", "Receipts", "concurrent.png")]), [`original:${concurrentKey}`, `original:${concurrentKey}`]);
  pass("Database failure after remote success and independent concurrent attempts recover without overwrite");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { started = resolve; });
  const realStorage = openCloudFromEnvironment();
  const delayed = createOriginalFiles(prisma, () => ({ ...realStorage, async upload(...args) { started(); await gate; return realStorage.upload(...args); } }));
  const raceKey = `integration-delete-race:${crypto.randomUUID()}`;
  const uploading = delayed.put(raceKey, image, "image/png", "Receipts", "race.png");
  const rejected = assert.rejects(uploading, (error: any) => error.code === "ORIGINAL_DELETED");
  await begun;
  const { queueOriginalDeletion } = await import("../../../apps/api/src/original-files");
  await queueOriginalDeletion(`original:${raceKey}`);
  release(); await rejected;
  assert.equal((await prisma.originalFile.findUniqueOrThrow({ where: { key: raceKey } })).state, "deleting");
  await originalFiles.remove(`original:${raceKey}`);
  assert.equal((await prisma.originalFile.findUniqueOrThrow({ where: { key: raceKey } })).state, "deleted");
  pass("Deferred upload cannot overwrite a later durable deletion intent");

  for (const status of [401, 507]) {
    forceStatus = status;
    assert.equal((await request(capturePath + "/audio")).status, 503);
    assert.equal((await uploadReceipt(crypto.randomUUID(), Buffer.concat([image, Buffer.from(String(status))]))).status, 503);
  }
  forceStatus = 0;
  const row = await prisma.originalFile.findUniqueOrThrow({ where: { key: recovered.slice(9) } });
  await openCloudFromEnvironment().remove({ spaceId: row.spaceId, fileId: row.fileId!, etag: row.etag! });
  await assert.rejects(originalFiles.open(recovered), (error: any) => error.code === "ORIGINAL_MISSING");
  failNetwork = true;
  assert.equal((await request(capturePath + "/audio")).status, 503);
  failNetwork = false;
  const missingReceipt = await prisma.originalFile.findUniqueOrThrow({ where: { key: `receipt:synthetic-owner:${failedId}` } });
  await openCloudFromEnvironment().remove({ spaceId: missingReceipt.spaceId, fileId: missingReceipt.fileId!, etag: missingReceipt.etag! });
  const missingResponse = await request(`/api/v1/budgeting/receipts/${failedId}/original`);
  assert.equal(missingResponse.status, 503); assert.equal((await missingResponse.json() as any).code, "ORIGINAL_MISSING");
  assert(await prisma.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId: "synthetic-owner", id: failedId } } }));
  pass("Actual routes preserve metadata and report revoked credential, full storage, timeout and missing originals");

  const item = await prisma.inventoryItem.create({ data: { title: "Synthetic integration item" } });
  const body = new FormData();
  body.append("files", new File([new Uint8Array(image)], "image.png", { type: "image/png" }));
  body.append("files", new File([audio.subarray(0, 4096)], "note.wav", { type: "audio/wav" }));
  body.append("files", new File(["synthetic asset"], "asset.txt", { type: "text/plain" }));
  const media = await json(`/api/v1/inventory-items/${item.id}/media`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body }, 201);
  assert.equal(media.media.length, 3);
  for (const entry of media.media) {
    const response = await request(`/api/v1/inventory-items/${item.id}/media/${entry.id}`);
    assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
  }
  await measured("inventory list", () => json(`/api/v1/inventory-items/${item.id}/media`), 0); assert.equal(requests.length, 0);
  const storedImage = await prisma.inventoryItemImage.findUniqueOrThrow({ where: { id: media.media.find((entry: any) => entry.kind === "image").id } });
  const workerPath = `/api/internal/inventory/preprocessing/originals/${encodeURIComponent(storedImage.filePath)}`;
  assert.equal((await request(workerPath)).status, 401);
  const workerRead = await request(workerPath, { headers: { authorization: "Bearer synthetic-worker-secret" } });
  assert.equal(workerRead.status, 200); await workerRead.arrayBuffer();
  requests = [];
  assert.equal((await request(`/api/internal/inventory/preprocessing/originals/${encodeURIComponent(receipt.originalKey!)}`, { headers: { authorization: "Bearer synthetic-worker-secret" } })).status, 404);
  assert.equal(requests.length, 0);
  pass("Actual inventory multipart upload and reads cover image/audio/asset; lists make zero WebDAV requests");
  pass("Preprocessing API reads only attached inventory; receipt references and unauthenticated workers denied");

  // All five legacy categories, including inline receipt bytes and capture archive JSON.
  const legacyReceiptId = crypto.randomUUID(); const legacyBytes = Buffer.concat([image, Buffer.from("legacy")]);
  await prisma.budgetReceipt.create({ data: { ownerId: "synthetic-owner", id: legacyReceiptId, image: legacyBytes, imageHash: sha256(legacyBytes), mime: "image/png", lines: [], scanStatus: "archived" } });
  await mkdir(dir + "/legacy", { recursive: true });
  for (const category of ["image", "audio", "asset"] as const) {
    const file = `${dir}/legacy/${category}`; await writeFile(file, image);
    const model = { image: prisma.inventoryItemImage, audio: prisma.inventoryItemAudio, asset: prisma.inventoryItemAsset }[category] as any;
    await model.create({ data: { itemId: item.id, filePath: file, mimeType: "image/png", sizeBytes: image.length } });
  }
  const legacyCaptureId = crypto.randomUUID(); const disk = createAudioStorage();
  const integrity = await disk.put(`${legacyCaptureId}.audio`, image);
  await captureStore.reserve(`capture:${legacyCaptureId}`, { id: legacyCaptureId, source: "synthetic", capturedAt: new Date().toISOString(), transcript: "Legacy synthetic" });
  await captureStore.reserve(`audio:${legacyCaptureId}`, { key: `${legacyCaptureId}.audio`, ...integrity, mime: "audio/wav" });
  const extraIds = Array.from({ length: 205 }, () => crypto.randomUUID());
  await prisma.inventoryItemAsset.createMany({ data: extraIds.map(id => ({ id, itemId: item.id, filePath: `${dir}/synthetic-pagination/${id}`, sizeBytes: 12 })) });
  requests = [];
  let inventoryCount = 0; for await (const entry of inventory()) inventoryCount++;
  assert.equal(inventoryCount, 210); assert.equal(requests.length, 0);
  let convertedInventoryCount = 0;
  const syntheticIds = new Set(extraIds);
  for await (const entry of inventory()) {
    if (entry.category === "asset" && syntheticIds.has(entry.id)) {
      await prisma.inventoryItemAsset.update({ where: { id: entry.id }, data: { filePath: `original:pagination:${entry.id}` } });
      convertedInventoryCount++;
    }
  }
  assert.equal(convertedInventoryCount, 205); // Changing the eligibility predicate must not skip page boundaries.
  assert.equal(requests.length, 0);
  await prisma.inventoryItemAsset.deleteMany({ where: { id: { in: extraIds } } });
  const entries: any[] = []; for await (const entry of inventory()) entries.push(entry);
  assert.equal(entries.length, 5); assert.equal(requests.length, 0);
  const manifest = dir + "/mapping.jsonl";
  for (const entry of entries) await convert(entry, manifest);
  assert.equal(await replayManifest(manifest, false), 5);
  const replayAudio = await request(`/api/v1/todo-captures/${legacyCaptureId}/audio`, { method: "PUT", headers: { "x-audio-mime": "audio/wav" }, body: image });
  assert.equal(replayAudio.status, 200, await replayAudio.text());
  assert.equal(await replayManifest(manifest, true), 5);
  const rolledBack = await prisma.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId: "synthetic-owner", id: legacyReceiptId } } });
  assert.deepEqual(Buffer.from(rolledBack.image!), legacyBytes);
  assert.equal(rolledBack.originalKey, null);
  pass("Dry-run inventory, all five conversion categories, manifest restart and checksum-verified rollback");

  const { checkBrowser } = await import("./browser");
  await checkBrowser(app, captureId, Buffer.concat([image, Buffer.from("browser")]));
  pass("Actual receipt library/detail UI upload/open; actual AudioPlayer playback and seeking in Chromium");

  process.env.QUANTSELF_ORIGINALS_WRITE_PAUSED = "1";
  assert.equal((await uploadAudio()).status, 503);
  assert.equal((await request(capturePath + "/audio", { headers: { range: "bytes=0-9" } })).status, 206);
  process.env.QUANTSELF_ORIGINALS_WRITE_PAUSED = "0";
  const removeMedia = media.media[0];
  await json(`/api/v1/inventory-items/${item.id}/media/${removeMedia.id}`, { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } });
  assert.equal(await prisma.originalFile.count({ where: { state: "deleting" } }), 1);
  forceStatus = 507;
  const failed = await originalFiles.reconcile(100, 0); assert(failed.failures.length > 0);
  forceStatus = 0;
  const cleaned = await originalFiles.reconcile(100, 0); assert.equal(cleaned.failures.length, 0);
  await json(capturePath, { method: "DELETE" });
  assert.equal((await request(capturePath + "/audio")).status, 409);
  pass("Write pause preserves reads; durable inventory delete retries outages; capture deletion revokes reads");

  // Export only synthetic IDs for the browser exercise, never credentials.
  await writeFile(dir + "/ui.json", JSON.stringify({ receiptId, captureId, legacyCaptureId, itemId: item.id }));
  await writeFile(dir + "/application-results.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.measurements, null, 2));
} finally { globalThis.fetch = transport; await prisma.$disconnect(); }
