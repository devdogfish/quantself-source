import { originalFiles, isOriginalReference, readOriginalBytes } from "./original-files";
import { assertOriginalWritesEnabled } from "./original-storage";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, realpath, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { TodoWriteError } from "./todos-write";

export type AudioIntegrity = { sha256: string; size: number };
const integrity = (bytes: Uint8Array): AudioIntegrity => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
});
export type AudioStorage = {
  read(key: string, expected: AudioIntegrity): Promise<Buffer>;
  put(key: string, bytes: Uint8Array, mime?: string): Promise<AudioIntegrity>;
  remove(key: string): Promise<void>;
  response?(key: string, expected: AudioIntegrity, range?: string | null): Promise<Response>;
};
export function createAudioStorage(
  root = () => process.env.QUANTSELF_TODO_CAPTURE_ROOT,
) {
  async function path(key: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.audio$/i.test(key))
      throw new TodoWriteError("UNSAFE_AUDIO_KEY", "Invalid archive key.", 400);
    const configured = root();
    if (!configured) throw Error("Capture root unavailable");
    await mkdir(resolve(configured), { recursive: true, mode: 0o700 });
    return join(await realpath(resolve(configured)), key);
  }
  async function read(key: string, expected: AudioIntegrity) {
    if (isOriginalReference(key)) {
      const bytes = await readOriginalBytes(key);
      if (integrity(bytes).sha256 !== expected.sha256 || bytes.length !== expected.size) throw Error("Archive integrity mismatch");
      return bytes;
    }
    const file = await open(
      await path(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!(await file.stat()).isFile()) throw Error("Invalid archive file");
      const bytes = await file.readFile();
      const actual = integrity(bytes);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
        throw Error("Archive integrity mismatch");
      return bytes;
    } finally {
      await file.close();
    }
  }
  return {
    read,
    async response(key: string, expected: AudioIntegrity, range?: string | null) {
      if (isOriginalReference(key)) return originalFiles.open(key, range);
      const bytes = await read(key, expected);
      return audioBytesResponse(bytes, range);
    },
    async put(key: string, bytes: Uint8Array, mime = "application/octet-stream") {
      assertOriginalWritesEnabled();
      if (isOriginalReference(key)) {
        await originalFiles.put(key.slice(9), bytes, mime, "Recordings", `${key.split(":").at(-1)}.audio`);
        return integrity(bytes);
      }
      const target = await path(key);
      const expected = integrity(bytes);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await read(key, expected);
      } finally {
        try {
          await unlink(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return expected;
    },
    async remove(key: string) {
      assertOriginalWritesEnabled();
      if (isOriginalReference(key)) return originalFiles.remove(key);
      const target = await path(key);
      const files = [
        target,
        ...(await readdir(dirname(target)))
          .filter((name) => name.startsWith(`${key}.`) && name.endsWith(".tmp"))
          .map((name) => join(dirname(target), name)),
      ];
      for (const file of files) {
        try {
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
  };
}

export function audioBytesResponse(bytes: Uint8Array, range?: string | null) {
  const headers = new Headers({ "Accept-Ranges": "bytes" });
  if (!range) return new Response(new Uint8Array(bytes), { headers });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= bytes.length) {
    headers.set("Content-Range", `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
}
