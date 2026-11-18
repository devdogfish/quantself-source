import { createHash } from "node:crypto";

export class OriginalStorageError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}
export type OriginalIdentity = { spaceId: string; fileId: string; etag: string };
export type OriginalMetadata = { pathHint: string; mime: string; bytes: number; sha256: string };
export interface OriginalStorage {
  spaceId: string;
  upload(temporaryPath: string, metadata: OriginalMetadata, bytes: Uint8Array): Promise<OriginalIdentity>;
  open(identity: OriginalIdentity, range?: string | null): Promise<Response>;
  remove(identity: OriginalIdentity): Promise<void>;
  removeTemporary(path: string): Promise<void>;
  inspect(path: string): Promise<OriginalIdentity | null>;
}
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function originalsEnabled() {
  const provider = process.env.QUANTSELF_ORIGINALS_PROVIDER ?? "legacy";
  if (!["legacy", "opencloud"].includes(provider)) throw new OriginalStorageError("STORAGE_CONFIG", "Unknown originals provider.");
  return provider === "opencloud";
}
export function assertOriginalWritesEnabled() {
  if (process.env.QUANTSELF_ORIGINALS_WRITE_PAUSED === "1")
    throw new OriginalStorageError("STORAGE_PAUSED", "Original writes are paused. Retry after backup.");
}

// Credential remains server-side. Redirects are never followed with Authorization.
export function createOpenCloudStorage(options: {
  baseUrl: string; spaceId: string; username: string; token: string;
  timeoutMs?: number; fetch?: typeof fetch;
}): OriginalStorage {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new OriginalStorageError("STORAGE_CONFIG", "OpenCloud HTTPS origin is missing or invalid."); }
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new OriginalStorageError("STORAGE_CONFIG", "OpenCloud requires an HTTPS origin.");
  if (!options.spaceId || !options.username || !options.token) throw new OriginalStorageError("STORAGE_CONFIG", "OpenCloud settings incomplete.");
  const request = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.token}`).toString("base64")}`;
  const encode = (path: string) => path.split("/").map(part => {
    if (!part || part === "." || part === ".." || part.includes("\\")) throw new OriginalStorageError("STORAGE_PATH", "Invalid original path.", 400);
    return encodeURIComponent(part);
  }).join("/");
  const byPath = (path: string) => `${base.origin}/dav/spaces/${encodeURIComponent(options.spaceId)}/${encode(path)}`;
  const byId = (identity: OriginalIdentity) => {
    if (identity.spaceId !== options.spaceId || !identity.fileId.startsWith(`${options.spaceId}!`))
      throw new OriginalStorageError("STORAGE_SPACE", "Original belongs to a different space.", 409);
    return `${base.origin}/dav/spaces/${encodeURIComponent(identity.fileId)}`;
  };
  async function req(method: string, url: string, body?: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
    try {
      return await request(url, { method, body, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 120_000), headers: { Authorization: authorization, ...headers } });
    } catch { throw new OriginalStorageError("STORAGE_UNAVAILABLE", "Original storage timed out or is unavailable."); }
  }
  async function check(response: Response, allowed: number[]) {
    if (allowed.includes(response.status)) return response;
    await response.body?.cancel();
    const status = response.status;
    throw new OriginalStorageError(status === 404 ? "ORIGINAL_MISSING" : status === 507 ? "STORAGE_FULL" : status === 412 ? "ORIGINAL_CHANGED" : "STORAGE_UNAVAILABLE",
      status === 404 ? "Original file is missing; restore or reconcile it." : status === 507 ? "Original storage is full. Free capacity and retry." : status === 412 ? "Original changed outside Quantself." : "Original storage unavailable; check connectivity and credentials.", status === 412 ? 409 : 503);
  }
  async function discard(response: Response, allowed: number[]) { await check(response, allowed); await response.body?.cancel(); }
  async function inspect(path: string) {
    const response = await req("PROPFIND", byPath(path), '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/><d:getetag/></d:prop></d:propfind>', { Depth: "0", "Content-Type": "application/xml" });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    await check(response, [207]);
    const xml = await response.text();
    const value = (name: string) => xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([^<]+)</`))?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    const fileId = value("fileid"), etag = value("getetag");
    if (!fileId || !etag) throw new OriginalStorageError("STORAGE_METADATA", "Original identity unavailable.");
    const identity = { spaceId: options.spaceId, fileId, etag };
    byId(identity);
    return identity;
  }
  async function verify(identity: OriginalIdentity, metadata: OriginalMetadata) {
    const response = await check(await req("GET", byId(identity), undefined, { "If-Match": identity.etag }), [200]);
    await verifyOriginalResponse(response, metadata);
  }
  return {
    spaceId: options.spaceId, inspect,
    async upload(temporaryPath, metadata, bytes) {
      // Lookup first permits recovery after MOVE succeeded but its response/DB commit was lost.
      const prior = await inspect(metadata.pathHint);
      if (prior) { await verify(prior, metadata); return prior; }
      for (const folder of new Set([temporaryPath.split("/")[0], metadata.pathHint.split("/")[0]]))
        await discard(await req("MKCOL", byPath(folder)), [201, 405]);
      await discard(await req("PUT", byPath(temporaryPath), new Uint8Array(bytes), { "Content-Type": metadata.mime }), [201, 204]);
      await discard(await req("MOVE", byPath(temporaryPath), undefined, { Destination: byPath(metadata.pathHint), Overwrite: "F" }), [201, 204, 412]);
      const identity = await inspect(metadata.pathHint);
      if (!identity) throw new OriginalStorageError("ORIGINAL_MISSING", "Upload not yet visible; retry identical bytes.");
      await verify(identity, metadata);
      return identity;
    },
    async open(identity, range) {
      return check(await req("GET", byId(identity), undefined, { "If-Match": identity.etag, ...(range ? { Range: range } : {}) }), [200, 206, 416]);
    },
    async remove(identity) {
      await discard(await req("DELETE", byId(identity), undefined, { "If-Match": identity.etag }), [204, 404]);
    },
    async removeTemporary(path) {
      if (!/^Pending\/[0-9a-f-]+$/.test(path)) throw new OriginalStorageError("STORAGE_PATH", "Not an application temporary file.", 400);
      await discard(await req("DELETE", byPath(path)), [204, 404]);
    },
  };
}
export function openCloudFromEnvironment() {
  return createOpenCloudStorage({ baseUrl: process.env.QUANTSELF_OPENCLOUD_URL ?? "", spaceId: process.env.QUANTSELF_OPENCLOUD_SPACE_ID ?? "", username: process.env.QUANTSELF_OPENCLOUD_USERNAME ?? "", token: process.env.QUANTSELF_OPENCLOUD_TOKEN ?? "" });
}

export async function verifyOriginalResponse(response: Response, expected: { bytes: number; sha256: string }) {
  const hash = createHash("sha256"); let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new OriginalStorageError("ORIGINAL_EMPTY", "Original stream unavailable.");
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > expected.bytes) { await reader.cancel(); throw new OriginalStorageError("ORIGINAL_CONFLICT", "Existing original differs from this upload.", 409); }
      hash.update(chunk.value);
    }
  } catch (error) {
    if (error instanceof OriginalStorageError) throw error;
    throw new OriginalStorageError("STORAGE_UNAVAILABLE", "Original stream interrupted; retry identical input.");
  } finally { reader.releaseLock(); }
  if (size !== expected.bytes || hash.digest("hex") !== expected.sha256)
    throw new OriginalStorageError("ORIGINAL_CONFLICT", "Existing original differs from this upload.", 409);
}

// Admission happens before domain transactions take a pool connection. Each upload
// can hold one domain transaction and one independent durable-ledger transaction.
let activeUploads = 0;
const waitingUploads: (() => void)[] = [];
export async function withOriginalUploadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (!originalsEnabled()) return work();
  if (activeUploads < 3) activeUploads++;
  else await new Promise<void>(resolve => waitingUploads.push(resolve));
  try { return await work(); }
  finally {
    const next = waitingUploads.shift();
    if (next) next(); else activeUploads--;
  }
}
