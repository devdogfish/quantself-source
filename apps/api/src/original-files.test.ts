import { expect, test } from "bun:test";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { createOriginalFiles } from "./original-files";
import type { OriginalStorage } from "./original-storage";

const identity = { spaceId: "vault", fileId: "vault!audio", etag: '"original"' };

function fixture(upstream: Response) {
  let dbReads = 0;
  const reads: { id: typeof identity; range?: string | null }[] = [];
  const db = {
    originalFile: {
      async findUnique({ where }: { where: { key: string } }) {
        expect(where.key).toBe("recording");
        dbReads++;
        return { state: "ready", mime: "audio/wav", ...identity };
      },
    },
  } as unknown as PrismaClient;
  const storage: OriginalStorage = {
    spaceId: identity.spaceId,
    async open(id, range) {
      reads.push({ id, range });
      return upstream;
    },
    async upload() { throw Error("Unexpected upload"); },
    async remove() { throw Error("Unexpected removal"); },
    async removeTemporary() { throw Error("Unexpected temporary removal"); },
    async inspect() { throw Error("Unexpected inspection"); },
  };
  return { originals: createOriginalFiles(db, () => storage), reads, dbReads: () => dbReads };
}

test("original range streams on demand with the same identity, bytes, and headers", async () => {
  let pulls = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls <= 2) controller.enqueue(Uint8Array.of(pulls + 2));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const fixtureResponse = new Response(upstream, {
    status: 206,
    headers: { "Content-Length": "2", "Content-Range": "bytes 2-3/8", ETag: identity.etag },
  });
  const { originals, reads, dbReads } = fixture(fixtureResponse);
  const response = await originals.open("original:recording", "bytes=2-3");
  expect(reads).toEqual([{ id: identity, range: "bytes=2-3" }]);
  expect(dbReads()).toBe(1);
  expect(response.status).toBe(206);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(response.headers.get("content-length")).toBe("2");
  expect(response.headers.get("content-range")).toBe("bytes 2-3/8");
  expect(response.headers.get("etag")).toBe(identity.etag);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(pulls).toBe(0);

  const reader = response.body!.getReader();
  expect(await reader.read()).toEqual({ value: Uint8Array.of(3), done: false });
  expect(pulls).toBe(1);
  expect(await reader.read()).toEqual({ value: Uint8Array.of(4), done: false });
  expect(pulls).toBe(2);
  expect((await reader.read()).done).toBe(true);
  expect(upstream.locked).toBe(false);
});

test("cancelling an original response cancels and unlocks its upstream even when cancellation fails", async () => {
  const reasons: unknown[] = [];
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Uint8Array.of(1)); },
    cancel(reason) {
      reasons.push(reason);
      throw Error("Upstream already disconnected");
    },
  }, { highWaterMark: 0 });
  const { originals } = fixture(new Response(upstream));
  const response = await originals.open("original:recording");
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(Uint8Array.of(1));
  await reader.cancel("Client disconnected");
  expect(reasons).toEqual(["Client disconnected"]);
  expect(upstream.locked).toBe(false);
});

test("an original response preserves a bodyless unsatisfiable range", async () => {
  const { originals } = fixture(new Response(null, { status: 416, headers: { "Content-Range": "bytes */8" } }));
  const response = await originals.open("original:recording", "bytes=8-9");
  expect(response.status).toBe(416);
  expect(response.body).toBeNull();
  expect(response.headers.get("content-range")).toBe("bytes */8");
});

test("disconnecting during a pending upstream read cancels it without waiting for bytes", async () => {
  let entered!: () => void;
  const pulling = new Promise<void>(resolve => { entered = resolve; });
  const reasons: unknown[] = [];
  const upstream = new ReadableStream<Uint8Array>({
    pull() {
      entered();
    },
    cancel(reason) {
      reasons.push(reason);
    },
  }, { highWaterMark: 0 });
  const { originals } = fixture(new Response(upstream));
  const response = await originals.open("original:recording");
  const reader = response.body!.getReader();
  const read = reader.read();
  await pulling;
  await reader.cancel("Client disconnected before first chunk");

  expect((await read).done).toBe(true);
  expect(reasons).toEqual(["Client disconnected before first chunk"]);
  expect(upstream.locked).toBe(false);
});

test("a failed upstream read reaches the client and unlocks the body", async () => {
  const failure = new Error("Upstream connection reset");
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  }, { highWaterMark: 0 });
  const { originals } = fixture(new Response(upstream));
  const response = await originals.open("original:recording");

  await expect(response.body!.getReader().read()).rejects.toThrow(failure.message);
  expect(upstream.locked).toBe(false);
});
