import { describe, expect, it } from "bun:test";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { createApp } from "./app";
import { createInventoryLocationsRouteHandlers } from "./inventory-locations-route";

const ownerAccessContext = {
  owner: {
    email: "owner@example.com",
    id: "user-1",
    name: "QuantSelf Owner",
  },
  client: {
    id: "user-1",
    kind: "web" as const,
    name: "QuantSelf Owner",
  },
  permissions: ["inventory:read", "inventory:write"],
};

describe("inventory location routes", () => {
  it("enforces Inventory permissions before location handlers", async () => {
    let calls = 0;
    const handlers = {
      createLocation: async () => {
        calls += 1;
        throw new Error("createLocation should not run");
      },
      listLocations: async () => {
        calls += 1;
        throw new Error("listLocations should not run");
      },
      updateLocation: async () => {
        calls += 1;
        throw new Error("updateLocation should not run");
      },
    };
    const unauthenticatedApp = createApp({
      emitAccessLog: () => {},
      inventoryLocations: handlers,
      resolveAccessContext: async () => null,
    });
    const readOnlyApp = createApp({
      emitAccessLog: () => {},
      inventoryLocations: handlers,
      resolveAccessContext: async () => ({
        ...ownerAccessContext,
        permissions: ["inventory:read"],
      }),
    });

    const unauthenticatedResponse = await unauthenticatedApp.request(
      "/api/v1/inventory-locations",
    );
    const forbiddenResponse = await readOnlyApp.request(
      "/api/v1/inventory-locations",
      {
        body: JSON.stringify({ name: "Pantry" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "forbidden-location-1",
        },
        method: "POST",
      },
    );

    expect(unauthenticatedResponse.status).toBe(401);
    expect(forbiddenResponse.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("lists Inventory Locations with optional filters", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryLocations: {
        createLocation: async () => {
          throw new Error("createLocation should not run");
        },
        listLocations: async (input) => {
          calls.push(input);

          return [
            {
              containerCount: 1,
              id: "location-pantry",
              kind: "STORAGE",
              name: "Pantry",
              note: null,
              placementCount: 4,
            },
          ];
        },
        updateLocation: async () => {
          throw new Error("updateLocation should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request(
      "/api/v1/inventory-locations?kind=STORAGE&q=pantry",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      locations: [
        {
          containerCount: 1,
          id: "location-pantry",
          kind: "STORAGE",
          name: "Pantry",
          note: null,
          placementCount: 4,
        },
      ],
    });
    expect(calls).toEqual([{ kind: "STORAGE", query: "pantry" }]);
  });

  it("creates and updates Inventory Locations with Idempotency-Key", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryLocations: {
        createLocation: async (input) => {
          createCalls.push(input);

          return {
            containerCount: 0,
            id: "location-pantry",
            kind: "STORAGE",
            name: "Pantry",
            note: null,
            placementCount: 0,
          };
        },
        listLocations: async () => [],
        updateLocation: async (input) => {
          updateCalls.push(input);

          return {
            containerCount: 1,
            id: input.locationId,
            kind: "STORAGE",
            name: "Kitchen pantry",
            note: null,
            placementCount: 4,
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const createResponse = await app.request("/api/v1/inventory-locations", {
      body: JSON.stringify({
        name: "Pantry",
        note: "Dry goods",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-location-1",
      },
      method: "POST",
    });
    const updateResponse = await app.request(
      "/api/v1/inventory-locations/location-pantry",
      {
        body: JSON.stringify({
          note: null,
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-location-1",
        },
        method: "PUT",
      },
    );

    expect(createResponse.status).toBe(201);
    expect(updateResponse.status).toBe(200);
    expect(createCalls).toEqual([
      {
        clientId: "user-1",
        idempotencyKey: "create-location-1",
        operation: "createInventoryLocation",
        request: {
          name: "Pantry",
          note: "Dry goods",
        },
      },
    ]);
    expect(updateCalls).toEqual([
      {
        clientId: "user-1",
        idempotencyKey: "update-location-1",
        locationId: "location-pantry",
        operation: "updateInventoryLocation",
        request: { note: null },
      },
    ]);
  });

  it("normalizes create defaults and applies partial updates atomically", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const transaction = {
      inventoryLocation: {
        create: async (input: Record<string, unknown>) => {
          creates.push(input);
          return {
            _count: { containers: 0, placements: 0 },
            id: "location-pantry",
            kind: "OTHER",
            name: "Kitchen Pantry",
            note: "Dry goods",
          };
        },
        update: async (input: Record<string, unknown>) => {
          updates.push(input);
          return {
            _count: { containers: 1, placements: 4 },
            id: "location-pantry",
            kind: "STORAGE",
            name: "Kitchen Pantry",
            note: null,
          };
        },
      },
    } as unknown as Prisma.TransactionClient;
    const commands: Array<Record<string, unknown>> = [];
    const handlers = createInventoryLocationsRouteHandlers({
      runCommand: async (input) => {
        commands.push(input.request);
        return input.execute(transaction);
      },
    });

    const created = await handlers.createLocation({
      clientId: "client-1",
      idempotencyKey: "create-location-1",
      operation: "createInventoryLocation",
      request: { name: "  Kitchen   Pantry ", note: " Dry goods " },
    });
    const updated = await handlers.updateLocation({
      clientId: "client-1",
      idempotencyKey: "update-location-1",
      locationId: "location-pantry",
      operation: "updateInventoryLocation",
      request: { kind: "STORAGE", note: null },
    });

    expect(created).toEqual({
      containerCount: 0,
      id: "location-pantry",
      kind: "OTHER",
      name: "Kitchen Pantry",
      note: "Dry goods",
      placementCount: 0,
    });
    expect(updated).toEqual({
      containerCount: 1,
      id: "location-pantry",
      kind: "STORAGE",
      name: "Kitchen Pantry",
      note: null,
      placementCount: 4,
    });
    expect(commands).toEqual([
      { kind: "OTHER", name: "Kitchen Pantry", note: "Dry goods" },
      { kind: "STORAGE", locationId: "location-pantry", note: null },
    ]);
    expect(creates[0]).toEqual(
      expect.objectContaining({
        data: {
          kind: "OTHER",
          name: "Kitchen Pantry",
          normalizedName: "kitchen pantry",
          note: "Dry goods",
        },
      }),
    );
    expect(updates[0]).toEqual(
      expect.objectContaining({
        data: { kind: "STORAGE", note: null },
        where: { id: "location-pantry" },
      }),
    );
  });

  it("documents Inventory Location routes in OpenAPI", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async () => ownerAccessContext,
    });
    const document = (await (
      await app.request("/api/openapi.json")
    ).json()) as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, unknown> }
        >;
      };
      paths: Record<
        string,
        {
          get?: { operationId?: string };
          post?: { operationId?: string };
          put?: { operationId?: string };
        }
      >;
    };

    expect(document.paths["/api/v1/inventory-locations"]?.get?.operationId).toBe(
      "listInventoryLocations",
    );
    expect(
      document.paths["/api/v1/inventory-locations"]?.post?.operationId,
    ).toBe("createInventoryLocation");
    expect(
      document.paths["/api/v1/inventory-locations/{locationId}"]?.put
        ?.operationId,
    ).toBe("updateInventoryLocation");
    expect(
      document.components.schemas.InventoryLocationWithUsage?.properties,
    ).toHaveProperty("containerCount");
    expect(
      document.components.schemas.InventoryLocation?.properties,
    ).not.toHaveProperty("containerCount");
  });
});
