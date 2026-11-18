import type { AccessContext } from "@quantself/auth";
import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import {
  inventoryContainersRouteHandlers,
  type InventoryContainerMutationRunner,
} from "./inventory-containers-route";

const bounds: [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.8 },
  { x: 0.1, y: 0.8 },
];

const container = {
  createdAt: "2026-07-28T09:00:00.000Z",
  id: "container-1",
  location: null,
  locationId: null,
  metadata: {},
  name: "Blue bin",
  normalizedName: "blue bin",
  referenceId: "BIN-0001",
  sizeLiters: 39,
  updatedAt: "2026-07-28T09:00:00.000Z",
  visualPreset: {
    backImageUrl: "/inventory/container-visual-catalog/39l/back.webp",
    bounds,
    emptyImageUrl: "/inventory/container-visual-catalog/39l/empty.webp",
    frontImageUrl: "/inventory/container-visual-catalog/39l/front.webp",
    height: 857,
    hoverBounds: bounds,
    id: "39L" as const,
    isDefault: false,
    name: "39L",
    shadowImageUrl: "/inventory/container-visual-catalog/39l/shadow.webp",
    width: 1456,
  },
  visualPresetKey: "39L",
};

const summary = {
  id: container.id,
  itemCount: 0,
  latestCapturedAt: null,
  locationName: null,
  name: container.name,
  referenceId: container.referenceId,
  sampleImages: [],
  sampleItems: [],
  sizeLiters: container.sizeLiters,
  unitCount: 0,
  visualPreset: container.visualPreset,
  visualPresetKey: container.visualPresetKey,
};

const writeAccessContext = {
  owner: {
    email: "owner@example.com",
    id: "user-1",
    name: "QuantSelf Owner",
  },
  client: {
    id: "api-key-1",
    kind: "api-key",
    name: "inventory-writer",
  },
  permissions: ["inventory:read", "inventory:write"],
} satisfies AccessContext;

function memoryMutationRunner(): InventoryContainerMutationRunner {
  const requests = new Map<
    string,
    {
      requestHash: string;
      result: Promise<{
        body: Record<string, unknown>;
        status: 200 | 201 | 400 | 404 | 409;
      }>;
    }
  >();

  return {
    async run(input) {
      const permission = `${input.clientId}:${input.operationId}:${input.key}`;
      const existing = requests.get(permission);

      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          return {
            body: {
              code: "IDEMPOTENCY_CONFLICT",
              message:
                "Idempotency-Key was already used for a different request.",
            },
            status: 409,
          };
        }

        return existing.result;
      }

      const result = Promise.resolve().then(() => input.execute({} as never));
      requests.set(permission, {
        requestHash: input.requestHash,
        result,
      });

      return result;
    },
  };
}

function jsonRequest(method: "POST" | "PUT", body: unknown, key?: string) {
  return {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
      "x-api-key": "qs_test_credential",
    },
    method,
  };
}

describe("Inventory Container HTTP API", () => {
  test("covers list, get, reference resolution, and missing contents", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryContainers: {
        getContainer: async (id) => (id === container.id ? container : null),
        getContainerContents: async (id) =>
          id === container.id ? { items: [], retrievalCandidates: [] } : null,
        listContainers: async () => [summary],
        resolveContainerByReference: async (referenceId) =>
          referenceId === container.referenceId ? container : null,
      },
      resolveAccessContext: async () => writeAccessContext,
    });
    const headers = { "x-api-key": "qs_test_credential" };

    const [list, get, reference, missing, missingContents] = await Promise.all([
      app.request("/api/v1/inventory-containers", { headers }),
      app.request("/api/v1/inventory-containers/container-1", { headers }),
      app.request("/api/v1/inventory-containers/reference/bin-0001", {
        headers,
      }),
      app.request("/api/v1/inventory-containers/missing", { headers }),
      app.request("/api/v1/inventory-containers/missing/contents", { headers }),
    ]);

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ containers: [summary] });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ container });
    expect(reference.status).toBe(200);
    expect(await reference.json()).toEqual({ container });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      code: "NOT_FOUND",
      message: "Container was not found.",
    });
    expect(missingContents.status).toBe(404);
  });

  test("returns stable validation failures before mutation", async () => {
    let createCalls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryContainerMutationRunner: memoryMutationRunner(),
      inventoryContainers: {
        createContainer: async () => {
          createCalls += 1;
          return container;
        },
      },
      resolveAccessContext: async () => writeAccessContext,
    });
    const body = {
      locationName: null,
      name: "Blue bin",
      sizeLiters: 39,
      visualPresetKey: "39L",
    };

    const missingKey = await app.request(
      "/api/v1/inventory-containers",
      jsonRequest("POST", body),
    );
    const invalidBody = await app.request(
      "/api/v1/inventory-containers",
      jsonRequest("POST", { ...body, name: " " }, "validation-key"),
    );
    const invalidPreset = await app.request(
      "/api/v1/inventory-containers",
      jsonRequest(
        "POST",
        { ...body, visualPresetKey: "unknown" },
        "invalid-preset-key",
      ),
    );

    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({
      code: "INVALID_IDEMPOTENCY_KEY",
      message:
        "Idempotency-Key header is required and must not exceed 255 characters.",
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
    expect(invalidPreset.status).toBe(400);
    expect(createCalls).toBe(0);
  });

  test("replays normalized concurrent requests and isolates keys by operation and Client", async () => {
    const runner = memoryMutationRunner();
    let createCalls = 0;
    let deleteCalls = 0;
    let updateCalls = 0;
    const createContainerApp = (accessContext: AccessContext) =>
      createApp({
        emitAccessLog: () => {},
        inventoryContainerMutationRunner: runner,
        inventoryContainers: {
          createContainer: async (input) => {
            createCalls += 1;
            return {
              ...container,
              name: input.name,
              normalizedName: input.name.toLowerCase(),
              sizeLiters: input.sizeLiters,
            };
          },
          deleteContainer: async () => {
            deleteCalls += 1;
            return container;
          },
          updateContainer: async () => {
            updateCalls += 1;
            return container;
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const app = createContainerApp(writeAccessContext);
    const body = {
      locationName: null,
      name: " Blue bin ",
      sizeLiters: 39,
      visualPresetKey: "39L",
    };

    const [first, replay] = await Promise.all([
      app.request(
        "/api/v1/inventory-containers",
        jsonRequest("POST", body, "same-key"),
      ),
      app.request(
        "/api/v1/inventory-containers",
        jsonRequest(
          "POST",
          {
            visualPresetKey: "39L",
            sizeLiters: 39,
            name: "Blue bin",
            locationName: null,
          },
          "same-key",
        ),
      ),
    ]);
    const mismatch = await app.request(
      "/api/v1/inventory-containers",
      jsonRequest("POST", { ...body, sizeLiters: 80 }, "same-key"),
    );
    const otherOperation = await app.request(
      "/api/v1/inventory-containers/container-1",
      jsonRequest("PUT", { ...body, name: "Blue bin" }, "same-key"),
    );
    const otherClient = createContainerApp({
      ...writeAccessContext,
      client: {
        ...writeAccessContext.client,
        id: "api-key-2",
      },
    });
    const isolated = await otherClient.request(
      "/api/v1/inventory-containers",
      jsonRequest("POST", { ...body, name: "Blue bin" }, "same-key"),
    );
    const deleted = await app.request(
      "/api/v1/inventory-containers/container-1",
      {
        headers: {
          "idempotency-key": "delete-key",
          "x-api-key": "qs_test_credential",
        },
        method: "DELETE",
      },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Idempotency-Key was already used for a different request.",
    });
    expect(otherOperation.status).toBe(200);
    expect(isolated.status).toBe(201);
    expect(deleted.status).toBe(200);
    expect(createCalls).toBe(2);
    expect(deleteCalls).toBe(1);
    expect(updateCalls).toBe(1);
  });

  test("requires Inventory Write before a validated command runs", async () => {
    let createCalls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryContainerMutationRunner: memoryMutationRunner(),
      inventoryContainers: {
        createContainer: async () => {
          createCalls += 1;
          return container;
        },
      },
      resolveAccessContext: async () => ({
        ...writeAccessContext,
        permissions: ["inventory:read"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-containers",
      jsonRequest(
        "POST",
        {
          locationName: null,
          name: "Blue bin",
          sizeLiters: 39,
          visualPresetKey: "39L",
        },
        "write-key",
      ),
    );

    expect(response.status).toBe(403);
    expect(createCalls).toBe(0);
  });

  test("moves selected items to a container through one idempotent API command", async () => {
    const moveCalls: Array<{
      containerId: string;
      itemIds: string[];
    }> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryContainerMutationRunner: memoryMutationRunner(),
      inventoryContainers: {
        moveItemsToContainer: async (input) => {
          moveCalls.push({
            containerId: input.containerId,
            itemIds: [...input.itemIds],
          });

          return {
            movedItemIds: [...input.itemIds],
          };
        },
      },
      resolveAccessContext: async () => writeAccessContext,
    });

    const response = await app.request(
      "/api/v1/inventory-containers/container-1/move-items",
      jsonRequest(
        "POST",
        {
          itemIds: [
            " item-passport ",
            "item-camera",
            "item-passport",
          ],
        },
        "move-items-1",
      ),
    );
    const replay = await app.request(
      "/api/v1/inventory-containers/container-1/move-items",
      jsonRequest(
        "POST",
        {
          itemIds: ["item-camera", "item-passport"],
        },
        "move-items-1",
      ),
    );
    const missingBody = await app.request(
      "/api/v1/inventory-containers/container-1/move-items",
      {
        headers: {
          "idempotency-key": "move-items-missing-body",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      movedItemIds: ["item-camera", "item-passport"],
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      movedItemIds: ["item-camera", "item-passport"],
    });
    expect(missingBody.status).toBe(400);
    expect(await missingBody.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
    expect(moveCalls).toEqual([
      {
        containerId: "container-1",
        itemIds: ["item-camera", "item-passport"],
      },
    ]);
  });

  test("rejects batch relocation before creating a zero-quantity Placement", async () => {
    let placementWrites = 0;
    const timestamp = new Date("2026-07-29T12:00:00.000Z");
    const database = {
      inventoryContainer: {
        findUnique: async () => ({
          createdAt: timestamp,
          id: "container-1",
          location: null,
          locationId: null,
          metadata: {},
          name: "Blue bin",
          normalizedName: "blue bin",
          referenceId: "BIN-0001",
          sizeLiters: 39,
          updatedAt: timestamp,
          visualPresetKey: "39L",
        }),
      },
      inventoryItem: {
        findMany: async () => [
          {
            id: "item-empty",
            placements: [],
          },
        ],
      },
      inventoryItemPlacement: {
        create: async () => {
          placementWrites += 1;
        },
        deleteMany: async () => {
          placementWrites += 1;
        },
      },
    };

    await expect(
      inventoryContainersRouteHandlers.moveItemsToContainer(
        {
          containerId: "container-1",
          itemIds: ["item-empty"],
        },
        database as never,
      ),
    ).rejects.toThrow(
      "One or more selected Items have no units. Nothing was moved.",
    );
    expect(placementWrites).toBe(0);
  });
});
