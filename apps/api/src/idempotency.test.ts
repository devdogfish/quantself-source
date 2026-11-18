import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Prisma } from "@quantself/db/generated/prisma/client";

type IdempotencyRow = {
  clientId: string;
  id: string;
  idempotencyKey: string;
  operation: string;
  requestFingerprint: string;
  responseBody: Record<string, unknown> | null;
  responseStatus: number | null;
};

const rows = new Map<string, IdempotencyRow>();
const transactionFailures: unknown[] = [];

function storageKey(input: {
  clientId: string;
  idempotencyKey: string;
  operation: string;
}) {
  return `${input.clientId}:${input.operation}:${input.idempotencyKey}`;
}

mock.module("@quantself/db", () => {
  const transaction = {
    apiIdempotencyKey: {
      create: async ({
        data,
      }: {
        data: Omit<IdempotencyRow, "id">;
      }) => {
        rows.set(
          storageKey(data),
          {
            id: `row-${rows.size + 1}`,
            ...data,
          },
        );
      },
      findUnique: async ({
        where,
      }: {
        where: {
          clientId_operation_idempotencyKey: {
            clientId: string;
            idempotencyKey: string;
            operation: string;
          };
        };
      }) =>
        rows.get(storageKey(where.clientId_operation_idempotencyKey)) ?? null,
      update: async ({
        data,
        where,
      }: {
        data: {
          responseBody: Prisma.InputJsonValue;
          responseStatus: number;
        };
        where: {
          clientId_operation_idempotencyKey: {
            clientId: string;
            idempotencyKey: string;
            operation: string;
          };
        };
      }) => {
        const key = storageKey(where.clientId_operation_idempotencyKey);
        const existing = rows.get(key);

        if (!existing) {
          throw new Error("Missing idempotency row.");
        }

        rows.set(key, {
          ...existing,
          responseBody: data.responseBody as Record<string, unknown>,
          responseStatus: data.responseStatus,
        });
      },
    },
  };

  return {
    prisma: {
      $transaction: async <T>(
        callback: (value: typeof transaction) => Promise<T>,
      ) => {
        const failure = transactionFailures.shift();

        if (failure) {
          throw failure;
        }

        const snapshot = new Map(rows);

        try {
          return await callback(transaction);
        } catch (error) {
          rows.clear();
          snapshot.forEach((row, key) => rows.set(key, row));
          throw error;
        }
      },
      apiIdempotencyKey: transaction.apiIdempotencyKey,
    },
  };
});

afterEach(() => {
  rows.clear();
  transactionFailures.length = 0;
  delete process.env.INVENTORY_ASSET_UPLOAD_DIR;
});

describe("idempotent command helper", () => {
  test("replays the original result for the same key and normalized request", async () => {
    const calls: string[] = [];
    const { runIdempotentCommand } = await import("./idempotency");

    const first = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => {
        calls.push("execute");

        return {
          body: { itemId: "item-1" },
          kind: "success" as const,
          status: 201,
        };
      },
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        captureText: "Passport pouch",
        quantity: 1,
      },
    });
    const replay = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => {
        calls.push("execute-again");

        return {
          body: { itemId: "item-2" },
          kind: "success" as const,
          status: 201,
        };
      },
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        quantity: 1,
        captureText: "Passport pouch",
      },
    });

    expect(first).toEqual({
      body: { itemId: "item-1" },
      kind: "success",
      status: 201,
    });
    expect(replay).toEqual(first);
    expect(calls).toEqual(["execute"]);
  });

  test("returns conflict for the same key with different input", async () => {
    const { runIdempotentCommand } = await import("./idempotency");

    await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => ({
        body: { itemId: "item-1" },
        kind: "success" as const,
        status: 201,
      }),
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        captureText: "Passport pouch",
      },
    });

    const conflict = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => ({
        body: { itemId: "item-2" },
        kind: "success" as const,
        status: 201,
      }),
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        captureText: "Travel charger",
      },
    });

    expect(conflict).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      kind: "conflict",
      message: "Idempotency-Key was already used with different input.",
      status: 409,
    });
  });

  test("isolates keys by client and operation", async () => {
    const calls: string[] = [];
    const { runIdempotentCommand } = await import("./idempotency");

    const first = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => {
        calls.push("client-1");

        return {
          body: { sessionId: "session-1" },
          kind: "success" as const,
          status: 200,
        };
      },
      idempotencyKey: "shared-key",
      operation: "saveInventoryCaptureSessionDefaults",
      request: {
        label: "Apartment reset",
      },
    });
    const second = await runIdempotentCommand({
      clientId: "client-2",
      execute: async () => {
        calls.push("client-2");

        return {
          body: { sessionId: "session-2" },
          kind: "success" as const,
          status: 200,
        };
      },
      idempotencyKey: "shared-key",
      operation: "saveInventoryCaptureSessionDefaults",
      request: {
        label: "Apartment reset",
      },
    });
    const third = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => {
        calls.push("different-operation");

        return {
          body: { itemId: "item-1" },
          kind: "success" as const,
          status: 201,
        };
      },
      idempotencyKey: "shared-key",
      operation: "captureInventoryItem",
      request: {
        captureText: "Passport pouch",
      },
    });

    expect(first.kind).toBe("success");
    expect(second.kind).toBe("success");
    expect(third.kind).toBe("success");
    expect(calls).toEqual(["client-1", "client-2", "different-operation"]);
  });

  test("retries serializable write conflicts", async () => {
    transactionFailures.push(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        clientVersion: "test",
        code: "P2034",
      }),
    );
    const calls: string[] = [];
    const { runIdempotentCommand } = await import("./idempotency");

    const result = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => {
        calls.push("execute");

        return {
          body: { itemId: "item-1" },
          kind: "success" as const,
          status: 201,
        };
      },
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        captureText: "Passport pouch",
      },
    });

    expect(result).toMatchObject({
      body: { itemId: "item-1" },
      kind: "success",
      status: 201,
    });
    expect(calls).toEqual(["execute"]);
  });

  test("does not retain idempotency state after a failed command", async () => {
    const { runIdempotentCommand } = await import("./idempotency");

    await expect(
      runIdempotentCommand({
        clientId: "client-1",
        execute: async () => {
          throw new Error("planned failure");
        },
        idempotencyKey: "capture-1",
        operation: "captureInventoryItem",
        request: {
          captureText: "Passport pouch",
        },
      }),
    ).rejects.toThrow("planned failure");

    const retry = await runIdempotentCommand({
      clientId: "client-1",
      execute: async () => ({
        body: { itemId: "item-1" },
        kind: "success" as const,
        status: 201,
      }),
      idempotencyKey: "capture-1",
      operation: "captureInventoryItem",
      request: {
        captureText: "Passport pouch",
      },
    });

    expect(retry).toMatchObject({
      body: { itemId: "item-1" },
      kind: "success",
      status: 201,
    });
  });
});

describe("Item Media idempotency and compensation", () => {
  test("replays an upload without writing duplicate metadata or files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "media-idempotency-"));
    process.env.INVENTORY_ASSET_UPLOAD_DIR = root;
    const { createInventoryItemMediaRouteHandlers } = await import(
      "./inventory-item-media-route"
    );
    let createCalls = 0;
    const repository: Parameters<
      typeof createInventoryItemMediaRouteHandlers
    >[0] = {
      createMedia: async (_itemId, media) => {
        createCalls += 1;
        return media.map((entry, index) => ({
          contentType: entry.mimeType,
          id: `asset-${index + 1}`,
          kind: entry.kind,
          originalName: entry.originalName,
          position: null,
          sizeBytes: entry.sizeBytes,
        }));
      },
      deleteMedia: async () => null,
      findMediaFile: async () => null,
      listMedia: async () => [],
      reorderImages: async () => null,
    };
    const handlers = createInventoryItemMediaRouteHandlers(repository);
    const mutation = {
      clientId: "write-client",
      idempotencyKey: "upload-1",
    };

    try {
      const first = await handlers.uploadMedia(
        "item-1",
        [new File(["manual"], "manual.txt", { type: "text/plain" })],
        mutation,
      );
      const replay = await handlers.uploadMedia(
        "item-1",
        [new File(["manual"], "manual.txt", { type: "text/plain" })],
        mutation,
      );

      expect(replay).toEqual(first);
      expect(createCalls).toBe(1);
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("removes stored upload bytes when metadata persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "media-compensation-"));
    process.env.INVENTORY_ASSET_UPLOAD_DIR = root;
    const { createInventoryItemMediaRouteHandlers } = await import(
      "./inventory-item-media-route"
    );
    const repository: Parameters<
      typeof createInventoryItemMediaRouteHandlers
    >[0] = {
      createMedia: async () => {
        throw new Error("planned database failure");
      },
      deleteMedia: async () => null,
      findMediaFile: async () => null,
      listMedia: async () => [],
      reorderImages: async () => null,
    };
    const handlers = createInventoryItemMediaRouteHandlers(repository);

    try {
      await expect(
        handlers.uploadMedia(
          "item-1",
          [new File(["manual"], "manual.txt", { type: "text/plain" })],
          {
            clientId: "write-client",
            idempotencyKey: "upload-failure",
          },
        ),
      ).rejects.toThrow("planned database failure");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores deleted bytes when metadata deletion fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "media-compensation-"));
    process.env.INVENTORY_ASSET_UPLOAD_DIR = root;
    const filePath = path.join(root, "manual.txt");
    await writeFile(filePath, "manual");
    const { createInventoryItemMediaRouteHandlers } = await import(
      "./inventory-item-media-route"
    );
    const repository: Parameters<
      typeof createInventoryItemMediaRouteHandlers
    >[0] = {
      createMedia: async () => [],
      deleteMedia: async () => {
        throw new Error("planned database failure");
      },
      findMediaFile: async () => ({
        filePath,
        kind: "asset",
        mimeType: "text/plain",
        originalName: "manual.txt",
      }),
      listMedia: async () => [],
      reorderImages: async () => null,
    };
    const handlers = createInventoryItemMediaRouteHandlers(repository);

    try {
      await expect(
        handlers.deleteMedia("item-1", "asset-1", {
          clientId: "write-client",
          idempotencyKey: "delete-failure",
        }),
      ).rejects.toThrow("planned database failure");
      expect(await readFile(filePath, "utf8")).toBe("manual");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
