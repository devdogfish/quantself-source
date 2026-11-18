import { describe, expect, test } from "bun:test";
import { createOpenCloudStorage, sha256 } from "./original-storage";

function fixture() {
  const files = new Map<string, { bytes: Uint8Array; id: string; etag: string }>();
  const calls: { method: string; path: string; headers: Headers }[] = [];
  let loseMove = false, failure = 0;
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => {
    const path = decodeURIComponent(new URL(String(url)).pathname).replace("/dav/spaces/", "");
    const headers = new Headers(init.headers), method = init.method!;
    calls.push({ method, path, headers });
    expect(init.redirect).toBe("error");
    if (failure) return new Response(null, { status: failure });
    if (method === "MKCOL") return new Response(null, { status: 201 });
    const entry = files.get(path) ?? [...files.values()].find(file => file.id === path);
    if (method === "PUT") {
      files.set(path, { bytes: new Uint8Array(init.body as Uint8Array), id: `space!${crypto.randomUUID()}`, etag: '"v1"' });
      return new Response(null, { status: 201 });
    }
    if (method === "MOVE") {
      const target = decodeURIComponent(new URL(headers.get("Destination")!).pathname).replace("/dav/spaces/", "");
      expect(headers.get("Overwrite")).toBe("F");
      if (files.has(target)) return new Response(null, { status: 412 });
      files.set(target, entry!); files.delete(path);
      if (loseMove) { loseMove = false; throw Error("Connection lost after MOVE"); }
      return new Response(null, { status: 201 });
    }
    if (!entry) return new Response(null, { status: 404 });
    if (headers.has("If-Match") && headers.get("If-Match") !== entry.etag) return new Response(null, { status: 412 });
    if (method === "PROPFIND") return new Response(`<d:multistatus><oc:fileid>${entry.id}</oc:fileid><d:getetag>&quot;v1&quot;</d:getetag></d:multistatus>`, { status: 207 });
    if (method === "DELETE") { for (const [key, value] of files) if (value === entry) files.delete(key); return new Response(null, { status: 204 }); }
    return new Response(new Uint8Array(entry.bytes), { headers: { etag: entry.etag } });
  }) as typeof fetch;
  const options = { baseUrl: "https://opencloud.invalid", spaceId: "space", username: "scoped-app", token: "synthetic-token", fetch: fetcher };
  return { storage: createOpenCloudStorage(options), files, calls, options, loseMove: () => { loseMove = true; }, fail: (status: number) => { failure = status; } };
}
const bytes = Buffer.from("synthetic original");
const metadata = { pathHint: "Receipts/test.txt", mime: "text/plain", bytes: bytes.length, sha256: sha256(bytes) };

describe("OpenCloud immutable original adapter", () => {
  test("unique staging + guarded MOVE, hash verification; warm reads use one ID request", async () => {
    const f = fixture();
    const identity = await f.storage.upload("Pending/aaaaaaaa-bbbb", metadata, bytes);
    expect(f.calls.map(call => call.method)).toEqual(["PROPFIND", "MKCOL", "MKCOL", "PUT", "MOVE", "PROPFIND", "GET"]);
    expect(f.calls.find(call => call.method === "PUT")!.headers.has("If-None-Match")).toBe(false);
    const before = f.calls.length;
    expect(await (await f.storage.open(identity, "bytes=1-3")).text()).toBe(bytes.toString());
    expect(f.calls.length - before).toBe(1);
    expect(f.calls.at(-1)!.path).toBe(identity.fileId);
    expect(f.calls.at(-1)!.headers.get("Range")).toBe("bytes=1-3");
    expect(f.calls.at(-1)!.headers.get("If-Match")).toBe(identity.etag);
  });
  test("lost MOVE response reconciles same final bytes without another PUT", async () => {
    const f = fixture(); f.loseMove();
    await expect(f.storage.upload("Pending/aaaa", metadata, bytes)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const identity = await f.storage.upload("Pending/bbbb", metadata, bytes);
    expect(identity.fileId).toStartWith("space!");
    expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    await expect(f.storage.upload("Pending/cccc", { ...metadata, sha256: sha256(Buffer.from("changed")) }, bytes)).rejects.toMatchObject({ code: "ORIGINAL_CONFLICT" });
  });
  test("rename does not break stable-ID reads; external mutation blocks reads and deletes", async () => {
    const f = fixture(); const identity = await f.storage.upload("Pending/aaaa", metadata, bytes);
    const file = f.files.get("space/Receipts/test.txt")!;
    f.files.delete("space/Receipts/test.txt"); f.files.set("space/renamed.txt", file);
    expect(await (await f.storage.open(identity)).text()).toBe(bytes.toString());
    file.etag = '"changed"';
    await expect(f.storage.open(identity)).rejects.toMatchObject({ code: "ORIGINAL_CHANGED" });
    await expect(f.storage.remove(identity)).rejects.toMatchObject({ code: "ORIGINAL_CHANGED" });
    await expect(f.storage.open({ ...identity, spaceId: "other" })).rejects.toMatchObject({ code: "STORAGE_SPACE" });
  });
  test("missing files, full storage and revoked credentials remain explicit and recoverable", async () => {
    const f = fixture(); const identity = { spaceId: "space", fileId: "space!missing", etag: '"v1"' };
    await expect(f.storage.open(identity)).rejects.toMatchObject({ code: "ORIGINAL_MISSING", status: 503 });
    f.fail(507);
    await expect(f.storage.upload("Pending/aaaa", metadata, bytes)).rejects.toMatchObject({ code: "STORAGE_FULL" });
    f.fail(401);
    await expect(f.storage.open(identity)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  test("rejects unsafe settings and cleanup outside tracked staging namespace", async () => {
    const f = fixture();
    expect(() => createOpenCloudStorage({ ...f.options, baseUrl: "http://host.invalid" })).toThrow();
    await expect(f.storage.inspect("../secret")).rejects.toThrow();
    await expect(f.storage.removeTemporary("Receipts/test.txt")).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  test("timeout uses a bounded abort signal and does not expose transport secrets", async () => {
    const f = fixture();
    const storage = createOpenCloudStorage({ ...f.options, timeoutMs: 5, fetch: (async (_url: unknown, init: RequestInit) => {
      return await new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(Error("synthetic-token"))));
    }) as unknown as typeof fetch });
    await expect(storage.inspect("Receipts/test.txt")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", message: "Original storage timed out or is unavailable." });
  });
});

test("upload admission bounds concurrency before transactions and releases failed slots", async () => {
  const { withOriginalUploadSlot } = await import("./original-storage");
  const prior = process.env.QUANTSELF_ORIGINALS_PROVIDER;
  process.env.QUANTSELF_ORIGINALS_PROVIDER = "opencloud";
  let active = 0, peak = 0;
  const releases: (() => void)[] = [];
  try {
    const work = Array.from({ length: 8 }, (_, index) => withOriginalUploadSlot(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      if (index === 0) throw Error("synthetic failure");
    }));
    const result = Promise.allSettled(work);
    expect(active).toBe(3);
    for (let index = 0; index < 8; index++) {
      releases[index](); await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect((await result).filter(row => row.status === "rejected")).toHaveLength(1);
    expect(peak).toBe(3); expect(active).toBe(0);
  } finally {
    if (prior === undefined) delete process.env.QUANTSELF_ORIGINALS_PROVIDER; else process.env.QUANTSELF_ORIGINALS_PROVIDER = prior;
  }
});
