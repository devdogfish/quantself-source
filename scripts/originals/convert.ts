import { open, readFile } from "node:fs/promises";
import { prisma } from "../../packages/db";
import { originalFiles, isOriginalReference, readOriginalBytes } from "../../apps/api/src/original-files";
import { sha256 } from "../../apps/api/src/original-storage";

export type ConversionEntry = {
  category: "receipt" | "capture" | "image" | "audio" | "asset";
  id: string; ownerId?: string; source: string; mime: string;
  bytes: number | null; sha256?: string; destination?: string;
};
type Mapping = ConversionEntry & { destination: string; sha256: string; bytes: number };
async function journal(manifest: string, event: string, mapping: Mapping) {
  const file = await open(manifest, "a", 0o600);
  try { await file.writeFile(JSON.stringify({ event, mapping }) + "\n"); await file.sync(); }
  finally { await file.close(); }
}
const mediaModels = { image: prisma.inventoryItemImage, audio: prisma.inventoryItemAudio, asset: prisma.inventoryItemAsset };

// Keyset pagination; dry runs never fetch original byte payloads or call WebDAV.
export async function* inventory(): AsyncGenerator<ConversionEntry> {
  let cursor: { ownerId: string; id: string } | undefined;
  for (;;) {
    const rows = await prisma.budgetReceipt.findMany({ where: { image: { not: null }, originalKey: null, ...(cursor ? { OR: [{ ownerId: { gt: cursor.ownerId } }, { ownerId: cursor.ownerId, id: { gt: cursor.id } }] } : {}) }, select: { ownerId: true, id: true, mime: true, imageHash: true }, orderBy: [{ ownerId: "asc" }, { id: "asc" }], take: 100 });
    const sizes = rows.length ? await prisma.$queryRaw<{ ownerId: string; id: string; bytes: number }[]>`SELECT "ownerId", id, octet_length(image)::int AS bytes FROM budget_receipt WHERE ("ownerId", id) IN (SELECT x->>'ownerId', x->>'id' FROM jsonb_array_elements(${JSON.stringify(rows.map(row => ({ ownerId: row.ownerId, id: row.id })))}::jsonb) x)` : [];
    const byteCounts = new Map(sizes.map(row => [JSON.stringify([row.ownerId, row.id]), row.bytes]));
    for (const row of rows) yield { category: "receipt", id: row.id, ownerId: row.ownerId, source: "BudgetReceipt.image", mime: row.mime ?? "application/octet-stream", bytes: byteCounts.get(JSON.stringify([row.ownerId, row.id])) ?? null, sha256: row.imageHash ?? undefined };
    if (rows.length < 100) break;
    cursor = rows.at(-1)!;
  }
  for (const category of ["image", "audio", "asset"] as const) {
    let id: string | undefined;
    for (;;) {
      const model = mediaModels[category] as typeof prisma.inventoryItemImage;
      const rows = await model.findMany({ where: { NOT: { filePath: { startsWith: "original:" } }, ...(id ? { id: { gt: id } } : {}) }, select: { id: true, filePath: true, mimeType: true, sizeBytes: true }, orderBy: { id: "asc" }, take: 100 });
      for (const row of rows) yield { category, id: row.id, source: row.filePath, mime: row.mimeType ?? "application/octet-stream", bytes: row.sizeBytes };
      if (rows.length < 100) break;
      id = rows.at(-1)!.id;
    }
  }
  let id: string | undefined;
  for (;;) {
    const rows = await prisma.apiIdempotencyKey.findMany({ where: { clientId: "todos", operation: "capture-archive", idempotencyKey: { startsWith: "audio:" }, ...(id ? { id: { gt: id } } : {}) }, select: { id: true, responseBody: true, idempotencyKey: true }, orderBy: { id: "asc" }, take: 100 });
    const deletionKeys = rows.map(row => row.idempotencyKey.replace("audio:", "deleted:"));
    const deletions = await prisma.apiIdempotencyKey.findMany({ where: { clientId: "todos", operation: "capture-archive", idempotencyKey: { in: deletionKeys } }, select: { idempotencyKey: true } });
    const deleted = new Set(deletions.map(row => row.idempotencyKey));
    for (const row of rows) {
      const input = (row.responseBody as any)?.input;
      if (!input?.key || isOriginalReference(input.key) || deleted.has(row.idempotencyKey.replace("audio:", "deleted:"))) continue;
      yield { category: "capture", id: row.id, source: input.key, mime: input.mime, bytes: input.size, sha256: input.sha256 };
    }
    if (rows.length < 100) break;
    id = rows.at(-1)!.id;
  }
}
async function sourceBytes(entry: ConversionEntry) {
  if (entry.category === "receipt") {
    const row = await prisma.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId: entry.ownerId!, id: entry.id } }, select: { image: true } });
    if (!row.image) throw Error("Legacy receipt bytes unavailable; use the prepared manifest to resume.");
    return Buffer.from(row.image);
  }
  if (entry.category === "capture") {
    const { createAudioStorage } = await import("../../apps/api/src/todos-audio");
    return createAudioStorage().read(entry.source, { size: entry.bytes!, sha256: entry.sha256! });
  }
  return readFile(entry.source);
}
async function attach(entry: Mapping, rollback = false) {
  const bytes = rollback && entry.category === "receipt" ? await readOriginalBytes(entry.destination) : null;
  if (bytes && (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes)) throw Error("Rollback checksum mismatch.");
  if (rollback && entry.category !== "receipt") {
    const legacy = await sourceBytes(entry);
    if (sha256(legacy) !== entry.sha256 || legacy.length !== entry.bytes) throw Error("Rollback source changed or missing.");
  }
  const expected = rollback ? entry.destination : entry.source;
  const destination = rollback ? entry.source : entry.destination;
  await prisma.$transaction(async tx => {
    let count = 0;
    if (entry.category === "receipt") {
      const current = await tx.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId: entry.ownerId!, id: entry.id } }, select: { image: true, originalKey: true, imageHash: true } });
      if (current.originalKey === (rollback ? null : entry.destination)) {
        if (rollback && (!current.image || sha256(current.image) !== entry.sha256)) throw Error("Rollback receipt changed.");
        return;
      }
      if (!rollback && (!current.image || sha256(current.image) !== entry.sha256)) throw Error("Legacy receipt changed.");
      const result = await tx.budgetReceipt.updateMany({ where: { ownerId: entry.ownerId, id: entry.id, originalKey: rollback ? entry.destination : null, ...(rollback ? {} : { image: current.image }) }, data: { originalKey: rollback ? null : entry.destination, image: rollback ? bytes! : null, imageHash: entry.sha256 } });
      count = result.count;
      if (!count) {
        const current = await tx.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId: entry.ownerId!, id: entry.id } }, select: { originalKey: true, imageHash: true } });
        if (current?.originalKey === (rollback ? null : entry.destination) && current?.imageHash === entry.sha256) return;
      }
    } else if (entry.category === "capture") {
      const row = await tx.apiIdempotencyKey.findUniqueOrThrow({ where: { id: entry.id } });
      const body = row.responseBody as any;
      if (body.input.key === destination) return;
      if (body.input.key !== expected || body.input.sha256 !== entry.sha256) throw Error("Capture source changed.");
      body.input.key = destination;
      const canonical = JSON.stringify(body.input, (_, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
      const result = await tx.apiIdempotencyKey.updateMany({ where: { id: entry.id, updatedAt: row.updatedAt }, data: { responseBody: body, requestFingerprint: sha256(Buffer.from(canonical)) } });
      count = result.count;
    } else {
      const model = ({ image: tx.inventoryItemImage, audio: tx.inventoryItemAudio, asset: tx.inventoryItemAsset }[entry.category]) as typeof tx.inventoryItemImage;
      const result = await model.updateMany({ where: { id: entry.id, filePath: expected }, data: { filePath: destination } });
      count = result.count;
      if (!count && (await model.findUnique({ where: { id: entry.id }, select: { filePath: true } }))?.filePath === destination) return;
    }
    if (!count) throw Error("Source changed; no mapping applied.");
  });
}
export async function convert(entry: ConversionEntry, manifest: string) {
  const bytes = await sourceBytes(entry);
  const hash = sha256(bytes);
  if (entry.sha256 && entry.sha256 !== hash) throw Error("Legacy source checksum mismatch.");
  if (entry.bytes !== null && entry.bytes !== bytes.length) throw Error("Legacy source size mismatch.");
  const category = entry.category === "receipt" ? "Receipts" : entry.category === "capture" ? "Recordings" : "Inventory";
  const destination = await originalFiles.put(`migration:${entry.category}:${entry.ownerId ?? ""}:${entry.id}`, bytes, entry.mime, category, `${entry.category}-${entry.id}`);
  const mapping: Mapping = { ...entry, bytes: bytes.length, sha256: hash, destination };
  // Write-ahead manifest: a crash after DB commit but before the completion line remains recoverable.
  await journal(manifest, "prepared", mapping);
  await attach(mapping);
  await journal(manifest, "converted", mapping);
  return mapping;
}
export async function replayManifest(manifest: string, rollback: boolean) {
  const rows = (await readFile(manifest, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const entries = new Map<string, Mapping>();
  for (const row of rows) if (row.mapping) entries.set(row.mapping.destination, row.mapping);
  for (const entry of entries.values()) {
    const bytes = await readOriginalBytes(entry.destination);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw Error("Manifest original checksum mismatch.");
    await attach(entry, rollback);
  }
  return entries.size;
}
async function main() {
  const [command = "inventory", manifest] = process.argv.slice(2);
  if (!["inventory", "convert", "resume", "rollback", "reconcile"].includes(command)) throw Error("Use inventory|convert|resume|rollback|reconcile [manifest.jsonl]");
  if (command !== "inventory" && process.env.QUANTSELF_STORAGE_MAINTENANCE !== "1") throw Error("Stop application/worker writes and set QUANTSELF_STORAGE_MAINTENANCE=1 first.");
  if (command === "reconcile") { console.log(JSON.stringify(await originalFiles.reconcile())); return; }
  if (["resume", "rollback"].includes(command)) { if (!manifest) throw Error("Manifest path required."); console.log(await replayManifest(manifest, command === "rollback")); return; }
  if (command === "convert" && !manifest) throw Error("Manifest path required.");
  const counts: Record<string, number> = {};
  let totalBytes = 0;
  for await (const entry of inventory()) {
    totalBytes += entry.bytes ?? 0;
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    console.log(JSON.stringify(command === "convert" ? await convert(entry, manifest!) : entry));
  }
  console.log(JSON.stringify({ counts, totalBytes }));
}
if (import.meta.main) main().finally(() => prisma.$disconnect());
