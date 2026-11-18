import { test, expect } from "bun:test";
import {
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudioStorage } from "./todos-audio";

test("original bytes survive replay and relocation; unsafe keys and corruption fail", async () => {
  const parent = await mkdtemp(join(tmpdir(), "todo-audio-"));
  try {
    const root = join(parent, "disk");
    const storage = createAudioStorage(() => root);
    const bytes = Buffer.from([0, 255, 4, 19]);
    const key = `${crypto.randomUUID()}.audio`;
    const metadata: any = await storage.put(key, bytes);
    expect(await storage.read(key, metadata)).toEqual(bytes);
    expect(await storage.put(key, bytes)).toEqual(metadata);
    await expect(storage.put(key, Buffer.from("changed"))).rejects.toThrow();
    await expect(storage.put("../escape", bytes)).rejects.toThrow();
    await rename(root, join(parent, "hdd"));
    const relocated = createAudioStorage(() => join(parent, "hdd"));
    expect(await relocated.read(key, metadata)).toEqual(bytes);
    await expect(
      relocated.read(key, { ...metadata, size: 1 }),
    ).rejects.toThrow();
    await relocated.remove(key);
    const outside = join(parent, "outside");
    await writeFile(outside, bytes);
    await symlink(outside, join(parent, "hdd", key));
    await expect(relocated.read(key, metadata)).rejects.toThrow();
    await expect(relocated.put(key, bytes)).rejects.toThrow();
    await writeFile(join(parent, "hdd", `${key}.interrupted.tmp`), bytes);
    await relocated.remove(key);
    expect(await readFile(outside)).toEqual(bytes);
    await expect(
      readFile(join(parent, "hdd", `${key}.interrupted.tmp`)),
    ).rejects.toThrow();
    await relocated.remove(key);
    await expect(relocated.read(key, metadata)).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./todos-captures-route";
import { type CaptureStore } from "./todos-captures";
import { TodoWriteError } from "./todos-write";

test("HTTP archive preserves bytes and provenance through interruptions, relocation and explicit deletion", async () => {
  const parent = await mkdtemp(join(tmpdir(), "todo-http-audio-"));
  let root = join(parent, "disk");
  const disk = createAudioStorage(() => root);
  const rows = new Map<string, any>();
  let failRedaction = true;
  let failWrite = true;
  const store: CaptureStore = {
    async reserve(key, input) {
      const old = rows.get(key);
      if (old && JSON.stringify(old.input) !== JSON.stringify(input))
        throw new TodoWriteError("CAPTURE_CONFLICT", "Conflict");
      if (!old) rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async save(key, result) {
      rows.get(key).result = result;
    },
    async list(prefix) {
      return [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, row]) => row);
    },
    async redact(key) {
      if (failRedaction) throw Error("interrupted");
      rows.set(key, { input: null, result: null });
    },
  };
  let permissions = ["todos:write", "todos:read"];
  let authenticated = true;
  const app = new OpenAPIHono<any>();
  app.use("*", async (c, next) => {
    c.set(
      "accessContext",
      authenticated
        ? {
            owner: { id: "owner" },
            client: { id: "client", kind: "api-key" },
            permissions,
          }
        : null,
    );
    await next();
  });
  let taskWrites = 0;
  registerCaptureRoutes(
    app,
    {
      list: async () => [],
      detail: async () => {
        throw Error();
      },
      write: async (_, command) => {
        taskWrites++;
        return {
          commandId: command.commandId,
          todo: { number: 7 } as any,
          outcomes: { issue: "saved" },
          retryable: false,
          message: "saved",
        };
      },
    },
    store,
    {
      ...disk,
      async put(key, bytes) {
        const result = await disk.put(key, bytes);
        if (failWrite) throw Error("response lost");
        return result;
      },
    },
  );
  const id = crypto.randomUUID();
  const path = `/api/v1/todo-captures/${id}`;
  const bytes = Buffer.from([0, 255, 7, 10, 13, 88]);
  const upload = (body = bytes) =>
    app.request(`${path}/audio`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-audio-mime": "audio/ogg",
        "x-audio-duration": "1.25",
      },
      body,
    });
  try {
    expect(
      (
        await app.request("/api/v1/todo-captures", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            transcript: "Original conversation",
            source: "voice",
            provider: { name: "provider", conversationId: "original-id" },
            capturedAt: "2026-10-26T12:00:00Z",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`${path}/links`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmed: true,
            targets: [
              { commandId: crypto.randomUUID(), title: "Fixture task" },
            ],
          }),
        })
      ).status,
    ).toBe(200);
    expect(taskWrites).toBe(1);
    expect(
      (await app.request("/api/v1/todo-captures/..%2Foutside/audio")).status,
    ).toBe(400);
    expect((await upload()).status).toBe(503);
    failWrite = false;
    expect((await upload()).status).toBe(200);
    const metadata: any = await (await app.request(path)).json();
    expect(metadata.audio).toMatchObject({
      size: bytes.length,
      duration: 1.25,
      mime: "audio/ogg",
      key: `${id}.audio`,
    });
    expect(metadata.audio.sha256).toBe(
      (await disk.put(`${id}.audio`, bytes)).sha256,
    );
    expect((await upload(Buffer.from("changed"))).status).toBe(409);
    expect(
      Buffer.from(await (await app.request(`${path}/audio`)).arrayBuffer()),
    ).toEqual(bytes);
    authenticated = false;
    expect((await app.request(`${path}/audio`)).status).toBe(401);
    authenticated = true;
    permissions = [];
    expect((await app.request(`${path}/audio`)).status).toBe(403);
    expect((await upload()).status).toBe(403);
    permissions = ["todos:write", "todos:read"];
    expect((await app.request(path, { method: "DELETE" })).status).toBe(403);
    await rename(root, join(parent, "hdd"));
    root = join(parent, "hdd");
    expect(
      Buffer.from(
        await (await app.request(`${path}/audio?download=1`)).arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect(
      ((await (await app.request(path)).json()) as any).capture.provider
        .conversationId,
    ).toBe("original-id");
    await disk.remove(`${id}.audio`);
    expect((await app.request(`${path}/audio`)).status).toBe(503);
    expect((await upload()).status).toBe(200);
    permissions = ["todos:read", "todos:delete"];
    expect((await app.request(path, { method: "DELETE" })).status).toBe(503);
    expect((await app.request(`${path}/audio`)).status).toBe(409);
    const deleted: any = await (await app.request(path)).json();
    expect(deleted.deleted).toBe(true);
    expect(deleted.links[0]).toMatchObject({ number: 7, status: "linked" });
    expect(taskWrites).toBe(1);
    expect(deleted.capture).toBeNull();
    failRedaction = false;
    expect((await app.request(path, { method: "DELETE" })).status).toBe(200);
    expect(rows.get(`capture:${id}`).input).toBeNull();
    expect((await app.request(path, { method: "DELETE" })).status).toBe(200);
    permissions = ["todos:write"];
    expect((await upload()).status).toBe(409);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
