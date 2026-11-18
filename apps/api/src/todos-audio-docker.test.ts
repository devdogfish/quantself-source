import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { captureStore } from "./todos-captures";
import { createAudioStorage } from "./todos-audio";
import { registerCaptureRoutes } from "./todos-captures-route";

// Opt in only after discovering the project Docker database and configuring its URL.
test.skipIf(process.env.QUANTSELF_TODO_ARCHIVE_DB_TEST !== "1")(
  "Docker PostgreSQL archive survives service recreation and redacts source only",
  async () => {
    for (const args of [["compose", "ps"], ["ps"]]) {
      const result = Bun.spawnSync(["docker", ...args]);
      expect(result.exitCode).toBe(0);
    }
    const port = Bun.spawnSync([
      "docker",
      "compose",
      "port",
      "postgres",
      "5432",
    ]);
    expect(port.exitCode).toBe(0);
    const published = port.stdout.toString().trim().split("\n")[0]!;
    const url = new URL(process.env.DATABASE_URL!);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.port).toBe(published.slice(published.lastIndexOf(":") + 1));
    const { prisma } = await import("@quantself/db");
    const root = await mkdtemp(join(tmpdir(), "todo-db-archive-"));
    const id = crypto.randomUUID();
    const path = `/api/v1/todo-captures/${id}`;
    const makeApp = () => {
      const app = new OpenAPIHono<any>();
      app.use("*", async (c, next) => {
        c.set("accessContext", {
          owner: { id: "owner" },
          client: { id: "fixture", kind: "api-key" },
          permissions: ["todos:read", "todos:write", "todos:delete"],
        });
        await next();
      });
      registerCaptureRoutes(
        app,
        {
          list: async () => [],
          detail: async () => {
            throw Error();
          },
        },
        captureStore,
        createAudioStorage(() => root),
      );
      return app;
    };
    try {
      const app = makeApp();
      const input = {
        id,
        source: "fixture",
        capturedAt: "2026-10-26T12:00:00Z",
        transcript: "Original fixture conversation",
      };
      const create = () =>
        app.request("/api/v1/todo-captures", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      expect((await create()).status).toBe(200);
      expect((await create()).status).toBe(200);
      const bytes = Buffer.from([0, 255, 12, 88]);
      expect(
        (
          await app.request(`${path}/audio`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
          })
        ).status,
      ).toBe(200);
      const restarted = makeApp();
      expect(
        Buffer.from(
          await (await restarted.request(`${path}/audio`)).arrayBuffer(),
        ),
      ).toEqual(bytes);
      expect((await restarted.request(path, { method: "DELETE" })).status).toBe(
        200,
      );
      expect((await captureStore.get(`capture:${id}`))?.input).toBeNull();
      expect((await restarted.request(`${path}/audio`)).status).toBe(409);
      expect((await create()).status).toBe(409);
    } finally {
      await prisma.apiIdempotencyKey.deleteMany({
        where: {
          clientId: "todos",
          operation: "capture-archive",
          idempotencyKey: {
            in: [`capture:${id}`, `audio:${id}`, `deleted:${id}`],
          },
        },
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);
