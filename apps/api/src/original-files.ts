import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "@quantself/db";
import type { Prisma, PrismaClient, OriginalFile } from "@quantself/db/generated/prisma/client";
import { assertOriginalWritesEnabled, verifyOriginalResponse, openCloudFromEnvironment, OriginalStorageError, sha256, type OriginalStorage } from "./original-storage";

function streamOriginalBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  function releaseReader() {
    if (released) return;
    released = true;
    reader.releaseLock();
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseReader();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        releaseReader();
        throw error;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // The upstream connection may already have closed.
      } finally {
        releaseReader();
      }
    },
  }, { highWaterMark: 0 });
}

export const originalReference = (key: string) => `original:${key}`;
export const isOriginalReference = (key: string) => key.startsWith("original:");
export const referenceKey = (reference: string) => reference.slice("original:".length);
export function createOriginalFiles(db: PrismaClient = prisma, provider: () => OriginalStorage = openCloudFromEnvironment) {
  async function locked<T>(key: string, run: (tx: Prisma.TransactionClient) => Promise<T>) {
    // Cross-process serialization; a crashed connection releases the lock. No expiring lease
    // can let a slow upload resurrect an explicitly deleted original.
    return db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`original:${key}`}, 0))`;
      return run(tx);
    }, { timeout: 600_000, maxWait: 10_000 });
  }
  function identity(row: OriginalFile) {
    if (!row.fileId || !row.etag) throw new OriginalStorageError("ORIGINAL_PENDING", "Original upload is incomplete; retry identical bytes.");
    return { spaceId: row.spaceId, fileId: row.fileId, etag: row.etag };
  }
  return {
    async put(key: string, bytes: Uint8Array, mime: string, category: "Receipts" | "Recordings" | "Inventory" | "Jobs", name: string) {
      assertOriginalWritesEnabled();
      const storage = provider();
      const digest = sha256(bytes);
      const suffix = sha256(Buffer.from(key)).slice(0, 32);
      const filename = name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-100) || "original";
      const dot = filename.lastIndexOf(".");
      const pathHint = `${category}/${dot > 0 ? filename.slice(0, dot) : filename}-${suffix}${dot > 0 ? filename.slice(dot) : ""}`;
      await db.originalFile.createMany({ data: [{ key, spaceId: storage.spaceId, pathHint, mime, bytes: bytes.length, sha256: digest }], skipDuplicates: true });
      const row = await db.originalFile.findUniqueOrThrow({ where: { key } });
      if (row.sha256 !== digest || row.bytes !== bytes.length || row.mime !== mime || row.spaceId !== storage.spaceId)
        throw new OriginalStorageError("ORIGINAL_CONFLICT", "Original key already used for different content or storage.", 409);
      if (row.state === "ready") return originalReference(key);
      if (["deleted", "deleting"].includes(row.state)) throw new OriginalStorageError("ORIGINAL_DELETED", "Original was deleted.", 409);
      const temporaryPath = `Pending/${randomUUID()}`;
      // Durable attempt survives a crash during PUT. Never reuse a staging PUT path.
      await db.originalUploadAttempt.create({ data: { key, path: temporaryPath } });
      return locked(key, async tx => {
        const current = await tx.originalFile.findUniqueOrThrow({ where: { key } });
        if (["deleting", "deleted"].includes(current.state)) throw new OriginalStorageError("ORIGINAL_DELETED", "Original was deleted.", 409);
        if (current.state === "ready") return originalReference(key);
        const result = await storage.upload(temporaryPath, current, bytes);
        const published = await tx.originalFile.updateMany({ where: { key, state: "pending" }, data: { ...result, state: "ready" } });
        if (!published.count) throw new OriginalStorageError("ORIGINAL_DELETED", "Deletion superseded this upload.", 409);
        return originalReference(key);
      });
    },
    async open(reference: string, range?: string | null) {
      const row = await db.originalFile.findUnique({ where: { key: referenceKey(reference) } });
      if (!row || ["deleted", "deleting"].includes(row.state)) throw new OriginalStorageError("ORIGINAL_DELETED", "Original no longer available.", 404);
      if (row.state !== "ready") throw new OriginalStorageError("ORIGINAL_PENDING", "Original upload incomplete; retry identical bytes.");
      const upstream = await provider().open(identity(row), range);
      const headers = new Headers({ "Content-Type": row.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" });
      for (const name of ["content-length", "content-range", "etag"]) {
        const value = upstream.headers.get(name); if (value) headers.set(name, value);
      }
      // Bun can leave a forwarded fetch body pending after the client disconnects.
      // Forward each chunk on demand and cancel the upstream reader on disconnect.
      const body = upstream.body ? streamOriginalBody(upstream.body) : null;
      return new Response(body, { status: upstream.status, headers });
    },
    async remove(reference: string) {
      assertOriginalWritesEnabled();
      const key = referenceKey(reference);
      await queueOriginalDeletion(reference, db);
      await locked(key, async tx => {
        const row = await tx.originalFile.findUnique({ where: { key } });
        if (!row || row.state === "deleted") return;
        const storage = provider();
        const target = row.fileId ? identity(row) : await storage.inspect(row.pathHint);
        if (target) {
          // Uncommitted upload may have moved already. Verify its identity/content before deletion.
          if (!row.fileId) {
            const response = await storage.open(target);
            await verifyOriginalResponse(response, row);
          }
          await storage.remove(target);
        }
        await tx.originalFile.update({ where: { key }, data: { state: "deleted" } });
      });
    },
    async reconcile(limit = 50, retentionMs = 24 * 60 * 60 * 1000) {
      assertOriginalWritesEnabled();
      const deleting = await db.originalFile.findMany({ where: { state: "deleting" }, orderBy: { updatedAt: "asc" }, take: limit, select: { key: true } });
      const failures: string[] = [];
      for (const row of deleting) try { await this.remove(originalReference(row.key)); } catch { failures.push(row.key); }
      const attempts = await db.originalUploadAttempt.findMany({ where: { createdAt: { lt: new Date(Date.now() - retentionMs) } }, orderBy: { createdAt: "asc" }, take: limit });
      for (const attempt of attempts) try {
        await locked(attempt.key, async tx => {
          await provider().removeTemporary(attempt.path);
          await tx.originalUploadAttempt.deleteMany({ where: { id: attempt.id } });
        });
      } catch { failures.push(attempt.id); }
      return { deletes: deleting.length, temporaryFiles: attempts.length, failures };
    },
  };
}
export async function queueOriginalDeletions(references: string[], db: Pick<Prisma.TransactionClient, "originalFile"> = prisma) {
  assertOriginalWritesEnabled();
  const keys = [...new Set(references.filter(isOriginalReference).map(referenceKey))];
  if (!keys.length) return;
  await db.originalFile.updateMany({ where: { key: { in: keys }, state: { not: "deleted" } }, data: { state: "deleting" } });
}
export async function queueOriginalDeletion(reference: string, db: Pick<Prisma.TransactionClient, "originalFile"> = prisma) {
  return queueOriginalDeletions([reference], db);
}
export const originalFiles = createOriginalFiles();
export async function readOriginalBytes(reference: string) {
  if (!isOriginalReference(reference)) return readFile(reference);
  const response = await originalFiles.open(reference);
  return Buffer.from(await response.arrayBuffer());
}
