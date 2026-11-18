import { describe, expect, it } from "bun:test";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { createApp } from "./app";
import {
  createInventoryClothingRecommendationsRouteHandlers,
  inventoryClothingLocalDayKey,
} from "./inventory-clothing-recommendations-route";

describe("Inventory Clothing recommendations routes", () => {
  it("resolves today from the requested owner-local time zone", () => {
    const instant = new Date("2026-08-04T01:30:00.000Z");

    expect(inventoryClothingLocalDayKey(instant, "America/Halifax")).toBe(
      "2026-08-03",
    );
    expect(inventoryClothingLocalDayKey(instant, "Asia/Tokyo")).toBe(
      "2026-08-04",
    );
  });

  it("publishes event outfits and forwards event/history list filters through authenticated HTTP routes", async () => {
    const recommendation = {
      createdAt: "2026-08-03T09:00:00.000Z",
      event: {
        label: "Board dinner",
        startsAt: "2026-08-04T19:00:00.000Z",
      },
      id: "recommendation-event-1",
      kind: "EVENT" as const,
      options: [
        {
          id: "option-primary",
          items: [
            {
              archiveState: "ACTIVE" as const,
              availability: "AVAILABLE" as const,
              clothingState: "clean" as const,
              id: "item-blazer",
              imageId: "image-blazer",
              title: "Navy blazer",
              where: "Bedroom closet / Rail C × 1",
            },
          ],
          reason: "Formal enough for dinner without overheating.",
          slot: "PRIMARY" as const,
        },
      ],
      publishedAt: "2026-08-03T09:00:00.000Z",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key" as const,
        clientName: "Outfit Writer",
      },
      reason: "Client picked a concise outfit for the board dinner.",
      status: "PUBLISHED" as const,
      supersededByRecommendationId: null,
      targetDate: "2026-08-04",
    };
    const listInputs: Array<Record<string, unknown>> = [];
    let publishInput: unknown = null;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryClothingRecommendations: {
        getRecommendation: async (recommendationId) =>
          recommendationId === recommendation.id ? recommendation : null,
        listRecommendations: async (input) => {
          listInputs.push(input);
          return [recommendation];
        },
        publishRecommendation: async (input) => {
          publishInput = input;
          return { recommendation };
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "client-writer-1",
          kind: "api-key",
          name: "Outfit Writer",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const publishResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations",
      {
        body: JSON.stringify({
          event: {
            label: "Board dinner",
            startsAt: "2026-08-04T19:00:00.000Z",
          },
          kind: "EVENT",
          primary: {
            itemIds: ["item-blazer"],
            reason: "Formal enough for dinner without overheating.",
          },
          reason: "Client picked a concise outfit for the board dinner.",
          targetDate: "2026-08-04",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-event-outfit-1",
        },
        method: "POST",
      },
    );
    const listResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations?kind=event&status=declined&from=2026-08-01&to=2026-08-31&limit=10&timeZone=America%2FHalifax",
    );

    expect(publishResponse.status).toBe(201);
    expect(await publishResponse.json()).toEqual({ recommendation });
    expect(publishInput).toEqual({
      clientId: "client-writer-1",
      idempotencyKey: "publish-event-outfit-1",
      operation: "publishInventoryClothingRecommendation",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key",
        clientName: "Outfit Writer",
      },
      request: {
        event: {
          label: "Board dinner",
          startsAt: "2026-08-04T19:00:00.000Z",
        },
        kind: "EVENT",
        primary: {
          itemIds: ["item-blazer"],
          reason: "Formal enough for dinner without overheating.",
        },
        reason: "Client picked a concise outfit for the board dinner.",
        targetDate: "2026-08-04",
      },
    });

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      recommendations: [recommendation],
    });
    expect(listInputs).toEqual([
      {
        from: "2026-08-01",
        kind: "EVENT",
        limit: 10,
        status: "DECLINED",
        timeZone: "America/Halifax",
        to: "2026-08-31",
      },
    ]);
  });

  it("publishes, lists, and reads today's outfit through authenticated HTTP routes", async () => {
    const recommendation = {
      createdAt: "2026-08-03T09:00:00.000Z",
      event: null,
      id: "recommendation-1",
      kind: "DAILY" as const,
      options: [
        {
          id: "option-primary",
          items: [
            {
              archiveState: "ACTIVE" as const,
              availability: "AVAILABLE" as const,
              clothingState: "clean" as const,
              id: "item-shirt",
              imageId: "image-shirt",
              title: "Blue oxford shirt",
              where: "Hall closet / Rail A × 1",
            },
            {
              archiveState: "ACTIVE" as const,
              availability: "UNAVAILABLE" as const,
              clothingState: "dirty" as const,
              id: "item-pants",
              imageId: null,
              title: "Grey trousers",
              where: "Dresser drawer × 1",
            },
          ],
          reason: "Breathable layers for a warm meeting day.",
          slot: "PRIMARY" as const,
        },
        {
          id: "option-alternative",
          items: [
            {
              archiveState: "ACTIVE" as const,
              availability: "AVAILABLE" as const,
              clothingState: "clean" as const,
              id: "item-polo",
              imageId: null,
              title: "Navy polo",
              where: "Hall closet / Rail B × 1",
            },
          ],
          reason: "Lower-formality fallback.",
          slot: "ALTERNATIVE" as const,
        },
      ],
      publishedAt: "2026-08-03T09:00:00.000Z",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key" as const,
        clientName: "Outfit Writer",
      },
      reason: "Client picked a concise outfit for Monday, August 3, 2026.",
      status: "PUBLISHED" as const,
      supersededByRecommendationId: null,
      targetDate: "2026-08-03",
    };
    const listInputs: Array<Record<string, unknown>> = [];
    let publishInput: unknown = null;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryClothingRecommendations: {
        getRecommendation: async (recommendationId) =>
          recommendationId === recommendation.id ? recommendation : null,
        listRecommendations: async (input) => {
          listInputs.push(input);
          return [recommendation];
        },
        publishRecommendation: async (input) => {
          publishInput = input;
          return { recommendation };
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "client-writer-1",
          kind: "api-key",
          name: "Outfit Writer",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const publishResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations",
      {
        body: JSON.stringify({
          alternative: {
            itemIds: ["item-polo"],
            reason: "Lower-formality fallback.",
          },
          kind: "DAILY",
          primary: {
            itemIds: ["item-shirt", "item-pants"],
            reason: "Breathable layers for a warm meeting day.",
          },
          reason: "Client picked a concise outfit for Monday, August 3, 2026.",
          targetDate: "2026-08-03",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-outfit-1",
        },
        method: "POST",
      },
    );
    const listResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations?kind=daily",
    );
    const wornHistoryResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations?status=worn",
    );
    const getResponse = await app.request(
      `/api/v1/inventory-clothing/outfit-recommendations/${recommendation.id}`,
    );

    expect(publishResponse.status).toBe(201);
    expect(await publishResponse.json()).toEqual({ recommendation });
    expect(publishInput).toEqual({
      clientId: "client-writer-1",
      idempotencyKey: "publish-outfit-1",
      operation: "publishInventoryClothingRecommendation",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key",
        clientName: "Outfit Writer",
      },
      request: {
        alternative: {
          itemIds: ["item-polo"],
          reason: "Lower-formality fallback.",
        },
        kind: "DAILY",
        primary: {
          itemIds: ["item-shirt", "item-pants"],
          reason: "Breathable layers for a warm meeting day.",
        },
        reason: "Client picked a concise outfit for Monday, August 3, 2026.",
        targetDate: "2026-08-03",
      },
    });

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      recommendations: [recommendation],
    });
    expect(listInputs).toEqual([
      {
        from: undefined,
        kind: "DAILY",
        limit: undefined,
        status: undefined,
        to: undefined,
      },
      {
        from: undefined,
        kind: undefined,
        limit: undefined,
        status: "WORN",
        to: undefined,
      },
    ]);
    expect(wornHistoryResponse.status).toBe(200);

    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ recommendation });
  });

  it("wears and declines a published recommendation through authenticated HTTP routes", async () => {
    const recommendation = {
      createdAt: "2026-08-03T09:00:00.000Z",
      event: null,
      id: "recommendation-1",
      kind: "DAILY" as const,
      options: [
        {
          id: "option-primary",
          items: [
            {
              archiveState: "ACTIVE" as const,
              availability: "AVAILABLE" as const,
              clothingState: "dirty" as const,
              id: "item-shirt",
              imageId: null,
              title: "Blue oxford shirt",
              where: "Hall closet / Rail A × 1",
            },
          ],
          reason: "Breathable layers for a warm meeting day.",
          slot: "PRIMARY" as const,
        },
      ],
      publishedAt: "2026-08-03T09:00:00.000Z",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key" as const,
        clientName: "Outfit Writer",
      },
      reason: "Client picked a concise outfit for Monday, August 3, 2026.",
      status: "WORN" as const,
      supersededByRecommendationId: null,
      targetDate: "2026-08-03",
    };
    const wearInputs: unknown[] = [];
    let declineInput: unknown = null;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryClothingRecommendations: {
        declineRecommendation: async (input) => {
          declineInput = input;
          return {
            recommendation: {
              ...recommendation,
              status: "DECLINED" as const,
            },
          };
        },
        getRecommendation: async () => recommendation,
        listRecommendations: async () => [recommendation],
        markRecommendationWorn: async (input) => {
          wearInputs.push(input);
          return {
            recommendation,
            wearConfirmation: {
              createdAt: "2026-08-03T10:30:00.000Z",
              id: "wear-1",
              itemIds: ["item-shirt"],
              undoneAt: null,
            },
          };
        },
        publishRecommendation: async () => ({ recommendation }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "client-writer-1",
          kind: "api-key",
          name: "Outfit Writer",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const wearResponse = await app.request(
      `/api/v1/inventory-clothing/outfit-recommendations/${recommendation.id}/worn`,
      {
        body: JSON.stringify({
          optionId: "option-primary",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "wear-outfit-1",
        },
        method: "POST",
      },
    );
    const declineResponse = await app.request(
      `/api/v1/inventory-clothing/outfit-recommendations/${recommendation.id}/decline`,
      {
        headers: {
          "idempotency-key": "decline-outfit-1",
        },
        method: "POST",
      },
    );
    const defaultWearResponse = await app.request(
      `/api/v1/inventory-clothing/outfit-recommendations/${recommendation.id}/worn`,
      {
        headers: {
          "idempotency-key": "wear-default-outfit-1",
        },
        method: "POST",
      },
    );

    expect(wearResponse.status).toBe(200);
    expect(await wearResponse.json()).toEqual({
      recommendation,
      wearConfirmation: {
        createdAt: "2026-08-03T10:30:00.000Z",
        id: "wear-1",
        itemIds: ["item-shirt"],
        undoneAt: null,
      },
    });
    expect(wearInputs).toEqual([
      {
        clientId: "client-writer-1",
        idempotencyKey: "wear-outfit-1",
        operation: "markInventoryClothingRecommendationWorn",
        recommendationId: "recommendation-1",
        request: {
          optionId: "option-primary",
        },
      },
      {
        clientId: "client-writer-1",
        idempotencyKey: "wear-default-outfit-1",
        operation: "markInventoryClothingRecommendationWorn",
        recommendationId: "recommendation-1",
        request: {},
      },
    ]);
    expect(defaultWearResponse.status).toBe(200);

    expect(declineResponse.status).toBe(200);
    expect(await declineResponse.json()).toEqual({
      recommendation: {
        ...recommendation,
        status: "DECLINED",
      },
    });
    expect(declineInput).toEqual({
      clientId: "client-writer-1",
      idempotencyKey: "decline-outfit-1",
      operation: "declineInventoryClothingRecommendation",
      recommendationId: "recommendation-1",
    });
  });

  it("rejects publication conflicts and replays list validation failures", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryClothingRecommendations: {
        getRecommendation: async () => null,
        listRecommendations: async () => [],
        publishRecommendation: async () => {
          const error = new Error(
            "Daily Clothing Recommendation already exists for target date.",
          ) as Error & { code: string };
          error.code = "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT";
          throw error;
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "client-writer-1",
          kind: "api-key",
          name: "Outfit Writer",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const publishResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations",
      {
        body: JSON.stringify({
          kind: "DAILY",
          primary: {
            itemIds: ["item-shirt", "item-shirt"],
          },
          reason: "Conflict case.",
          targetDate: "2026-08-03",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-outfit-conflict-1",
        },
        method: "POST",
      },
    );
    const invalidListResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations?from=2026-08-10&to=2026-08-01",
    );
    const invalidDateResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations?limit=101",
    );
    const invalidEventShapeResponses = await Promise.all([
      app.request("/api/v1/inventory-clothing/outfit-recommendations", {
        body: JSON.stringify({
          kind: "EVENT",
          primary: { itemIds: ["item-shirt"] },
          reason: "Missing event details.",
          targetDate: "2026-08-03",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-event-missing-details",
        },
        method: "POST",
      }),
      app.request("/api/v1/inventory-clothing/outfit-recommendations", {
        body: JSON.stringify({
          event: {
            label: "Board dinner",
            startsAt: "2026-08-04T19:00:00.000Z",
          },
          kind: "DAILY",
          primary: { itemIds: ["item-shirt"] },
          reason: "Daily outfit with event details.",
          targetDate: "2026-08-04",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-daily-with-event-details",
        },
        method: "POST",
      }),
      app.request("/api/v1/inventory-clothing/outfit-recommendations", {
        body: JSON.stringify({
          event: {
            label: "Board dinner",
            startsAt: "2026-08-04T19:00:00.000Z",
          },
          kind: "EVENT",
          primary: { itemIds: ["item-shirt"] },
          reason: "Event outfit with a mismatched date.",
          targetDate: "2026-08-05",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-event-mismatched-date",
        },
        method: "POST",
      }),
    ]);

    expect(publishResponse.status).toBe(409);
    expect(await publishResponse.json()).toEqual({
      code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
      message: "Daily Clothing Recommendation already exists for target date.",
    });
    expect(invalidListResponse.status).toBe(400);
    expect(invalidDateResponse.status).toBe(400);
    expect(invalidEventShapeResponses.map(({ status }) => status)).toEqual([
      400, 400, 400,
    ]);
  });

  it("maps daily and event database slot conflicts without exposing Prisma details", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryClothingRecommendations: {
        getRecommendation: async () => null,
        listRecommendations: async () => [],
        publishRecommendation: async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            "Sensitive database constraint detail.",
            {
              clientVersion: "test",
              code: "P2002",
            },
          );
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "client-writer-1",
          kind: "api-key",
          name: "Outfit Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const dailyResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations",
      {
        body: JSON.stringify({
          kind: "DAILY",
          primary: { itemIds: ["item-shirt"] },
          reason: "Conflict case.",
          targetDate: "2026-08-03",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-outfit-prisma-conflict",
        },
        method: "POST",
      },
    );
    const eventResponse = await app.request(
      "/api/v1/inventory-clothing/outfit-recommendations",
      {
        body: JSON.stringify({
          event: {
            label: "Board dinner",
            startsAt: "2026-08-04T19:00:00.000Z",
          },
          kind: "EVENT",
          primary: { itemIds: ["item-blazer"] },
          reason: "Conflict case.",
          targetDate: "2026-08-04",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publish-event-outfit-prisma-conflict",
        },
        method: "POST",
      },
    );

    expect(dailyResponse.status).toBe(409);
    expect(await dailyResponse.json()).toEqual({
      code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
      message: "Daily Clothing Recommendation already exists for target date.",
    });
    expect(eventResponse.status).toBe(409);
    expect(await eventResponse.json()).toEqual({
      code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
      message:
        "Event Clothing Recommendation already exists for label and start time.",
    });
  });

  it("releases the published slot before inserting its explicit replacement", async () => {
    const operationOrder: string[] = [];
    let replacementId = "";
    const targetDate = new Date("2026-08-03T00:00:00.000Z");
    const item = {
      archivedAt: null,
      category: "clothing",
      clothingProfile: { dirtyQuantity: 0, isDirty: false },
      id: "item-shirt",
      images: [],
      placements: [{ quantity: 1 }],
      title: "Blue oxford shirt",
    };
    const existing = {
      id: "recommendation-existing",
      kind: "DAILY",
      status: "PUBLISHED",
      targetDate,
    };
    const transaction = {
      inventoryClothingRecommendation: {
        create: async ({ data }: { data: { id: string } }) => {
          operationOrder.push("create");
          expect(data.id).toBe(replacementId);
          return {};
        },
        findFirst: async () => existing,
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === existing.id
            ? existing
            : {
                createdAt: new Date("2026-08-03T09:00:00.000Z"),
                id: where.id,
                kind: "DAILY",
                options: [
                  {
                    id: "option-primary",
                    items: [{ item }],
                    reason: null,
                    slot: "PRIMARY",
                  },
                ],
                publishedAt: new Date("2026-08-03T09:00:00.000Z"),
                publishedByClientId: "client-writer-1",
                publishedByClientKind: "api-key",
                publishedByClientName: "Outfit Writer",
                reason: "Replacement outfit.",
                status: "PUBLISHED",
                supersededByRecommendationId: null,
                targetDate,
              },
        update: async ({
          data,
        }: {
          data: { supersededByRecommendationId: string };
        }) => {
          operationOrder.push("update");
          replacementId = data.supersededByRecommendationId;
          return existing;
        },
      },
      inventoryItem: {
        findMany: async () => [item],
      },
    } as unknown as Prisma.TransactionClient;
    const handlers = createInventoryClothingRecommendationsRouteHandlers({
      runCommand: async (input) => input.execute(transaction),
    });

    const result = await handlers.publishRecommendation({
      clientId: "client-writer-1",
      idempotencyKey: "replace-outfit-1",
      operation: "publishInventoryClothingRecommendation",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key",
        clientName: "Outfit Writer",
      },
      request: {
        kind: "DAILY",
        primary: { itemIds: ["item-shirt"] },
        reason: "Replacement outfit.",
        supersedesRecommendationId: existing.id,
        targetDate: "2026-08-03",
      },
    });

    expect(operationOrder).toEqual(["update", "create"]);
    expect(result.recommendation.id).toBe(replacementId);
  });

  it("persists item snapshots and hydrates deleted Items in recommendation history", async () => {
    const eventStartsAt = new Date("2026-08-04T19:00:00.000Z");
    const targetDate = new Date("2026-08-04T00:00:00.000Z");
    const item = {
      archivedAt: null,
      category: "clothing",
      clothingProfile: { dirtyQuantity: 0, isDirty: false },
      id: "item-blazer",
      images: [],
      placements: [{ quantity: 1 }],
      title: "Navy blazer",
    };
    let persistedEvent:
      | {
          eventLabel: string | null;
          eventStartsAt: Date | null;
          kind: "DAILY" | "EVENT";
          targetDate: Date;
        }
      | undefined;
    let recommendationId = "";
    let persistedPrimaryItem: unknown;
    const transaction = {
      inventoryClothingRecommendation: {
        create: async ({
          data,
        }: {
          data: {
            eventLabel: string | null;
            eventStartsAt: Date | null;
            id: string;
            kind: "DAILY" | "EVENT";
            options: {
              create: Array<{ items: { create: unknown[] } }>;
            };
            targetDate: Date;
          };
        }) => {
          recommendationId = data.id;
          persistedPrimaryItem = data.options.create[0]?.items.create[0];
          persistedEvent = {
            eventLabel: data.eventLabel,
            eventStartsAt: data.eventStartsAt,
            kind: data.kind,
            targetDate: data.targetDate,
          };
          return {};
        },
        findFirst: async () => null,
        findUnique: async ({ where }: { where: { id: string } }) => ({
          createdAt: new Date("2026-08-03T09:00:00.000Z"),
          eventLabel: "Board dinner",
          eventStartsAt,
          id: where.id,
          kind: "EVENT",
          options: [
            {
              id: "option-primary",
              items: [
                {
                  item: null,
                  itemId: item.id,
                  productId: item.id,
                  productTitle: item.title,
                },
              ],
              reason: "Formal enough for dinner.",
              slot: "PRIMARY",
            },
          ],
          publishedAt: new Date("2026-08-03T09:00:00.000Z"),
          publishedByClientId: "client-writer-1",
          publishedByClientKind: "api-key",
          publishedByClientName: "Outfit Writer",
          reason: "Client picked an outfit for the board dinner.",
          status: "PUBLISHED",
          supersededByRecommendationId: null,
          targetDate,
        }),
      },
      inventoryItem: {
        findMany: async () => [item],
      },
    } as unknown as Prisma.TransactionClient;
    const handlers = createInventoryClothingRecommendationsRouteHandlers({
      runCommand: async (input) => input.execute(transaction),
    });

    const result = await handlers.publishRecommendation({
      clientId: "client-writer-1",
      idempotencyKey: "publish-event-outfit-1",
      operation: "publishInventoryClothingRecommendation",
      publishedBy: {
        clientId: "client-writer-1",
        clientKind: "api-key",
        clientName: "Outfit Writer",
      },
      request: {
        event: {
          label: "Board dinner",
          startsAt: eventStartsAt.toISOString(),
        },
        kind: "EVENT",
        primary: {
          itemIds: [item.id],
          reason: "Formal enough for dinner.",
        },
        reason: "Client picked an outfit for the board dinner.",
        targetDate: "2026-08-04",
      },
    });

    expect(recommendationId).not.toBe("");
    expect(persistedEvent).toEqual({
      eventLabel: "Board dinner",
      eventStartsAt,
      kind: "EVENT",
      targetDate,
    });
    expect(persistedPrimaryItem).toMatchObject({
      itemId: "item-blazer",
      productId: "item-blazer",
      productTitle: "Navy blazer",
    });
    expect(result.recommendation).toMatchObject({
      event: {
        label: "Board dinner",
        startsAt: "2026-08-04T19:00:00.000Z",
      },
      id: recommendationId,
      kind: "EVENT",
      options: [
        {
          items: [
            {
              archiveState: "DELETED",
              availability: "UNAVAILABLE",
              id: "item-blazer",
              title: "Navy blazer",
            },
          ],
        },
      ],
      targetDate: "2026-08-04",
    });
  });

  it("marks only the selected recommendation option worn", async () => {
    const shirt = recommendationItemRecord("item-shirt");
    const trousers = recommendationItemRecord("item-trousers");
    const polo = recommendationItemRecord("item-polo");
    const recommendation = recommendationRecord({
      options: [
        recommendationOptionRecord("option-primary", "PRIMARY", [shirt, trousers]),
        recommendationOptionRecord("option-alternative", "ALTERNATIVE", [polo]),
      ],
    });
    const database = recommendationCommandTestDatabase(recommendation);
    const handlers = createInventoryClothingRecommendationsRouteHandlers({
      runCommand: async (input) => input.execute(database.transaction),
    });

    const result = await handlers.markRecommendationWorn({
      clientId: "client-writer-1",
      idempotencyKey: "wear-outfit-1",
      operation: "markInventoryClothingRecommendationWorn",
      recommendationId: recommendation.id,
      request: {
        optionId: "option-alternative",
      },
    });

    expect(result).toMatchObject({
      recommendation: {
        id: recommendation.id,
        status: "WORN",
      },
      wearConfirmation: {
        itemIds: ["item-polo"],
      },
    });
    expect(shirt.clothingProfile?.isDirty).toBe(false);
    expect(trousers.clothingProfile?.isDirty).toBe(false);
    expect(polo.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 1,
    });
    expect(database.confirmations).toHaveLength(1);
  });

  it("rejects unavailable selected recommendation items without partial changes", async () => {
    const shirt = recommendationItemRecord("item-shirt");
    const dirtyPolo = recommendationItemRecord("item-polo", { isDirty: true });
    const recommendation = recommendationRecord({
      options: [
        recommendationOptionRecord("option-primary", "PRIMARY", [shirt]),
        recommendationOptionRecord("option-alternative", "ALTERNATIVE", [dirtyPolo]),
      ],
    });
    const database = recommendationCommandTestDatabase(recommendation);
    const handlers = createInventoryClothingRecommendationsRouteHandlers({
      runCommand: async (input) => input.execute(database.transaction),
    });

    await expect(
      handlers.markRecommendationWorn({
        clientId: "client-writer-1",
        idempotencyKey: "wear-outfit-conflict-1",
        operation: "markInventoryClothingRecommendationWorn",
        recommendationId: recommendation.id,
        request: {
          optionId: "option-alternative",
        },
      }),
    ).rejects.toThrow("Selected Clothing Recommendation is no longer available.");
    expect(recommendation.status).toBe("PUBLISHED");
    expect(shirt.clothingProfile?.isDirty).toBe(false);
    expect(dirtyPolo.clothingProfile?.isDirty).toBe(true);
    expect(database.confirmations).toHaveLength(0);
  });

  it("declines a published recommendation without mutating Clothing Items", async () => {
    const shirt = recommendationItemRecord("item-shirt");
    const recommendation = recommendationRecord({
      options: [recommendationOptionRecord("option-primary", "PRIMARY", [shirt])],
    });
    const database = recommendationCommandTestDatabase(recommendation);
    const handlers = createInventoryClothingRecommendationsRouteHandlers({
      runCommand: async (input) => input.execute(database.transaction),
    });

    const result = await handlers.declineRecommendation({
      clientId: "client-writer-1",
      idempotencyKey: "decline-outfit-1",
      operation: "declineInventoryClothingRecommendation",
      recommendationId: recommendation.id,
    });

    expect(result).toMatchObject({
      recommendation: {
        id: recommendation.id,
        status: "DECLINED",
      },
    });
    expect(shirt.clothingProfile?.isDirty).toBe(false);
    expect(database.confirmations).toHaveLength(0);
  });
});

function recommendationItemRecord(
  id: string,
  input: { isDirty?: boolean } = {},
) {
  return {
    archivedAt: null,
    category: "clothing",
    clothingProfile: {
      dirtyQuantity: input.isDirty ? 1 : 0,
      isDirty: input.isDirty ?? false,
      wearStateVersion: 0,
    },
    id,
    images: [],
    placements: [{ quantity: 1 }],
    title: id,
  };
}

function recommendationOptionRecord(
  id: string,
  slot: "PRIMARY" | "ALTERNATIVE",
  items: Array<ReturnType<typeof recommendationItemRecord>>,
) {
  return {
    id,
    items: items.map((item, index) => ({
      item,
      optionId: id,
      position: index,
    })),
    reason: null,
    slot,
  };
}

function recommendationRecord(input: {
  options: Array<ReturnType<typeof recommendationOptionRecord>>;
}) {
  return {
    createdAt: new Date("2026-08-03T09:00:00.000Z"),
    id: "recommendation-1",
    kind: "DAILY" as const,
    options: input.options,
    publishedAt: new Date("2026-08-03T09:00:00.000Z"),
    publishedByClientId: "client-writer-1",
    publishedByClientKind: "api-key" as const,
    publishedByClientName: "Outfit Writer",
    reason: "Client picked a concise outfit for Monday, August 3, 2026.",
    status: "PUBLISHED" as
      | "DECLINED"
      | "PUBLISHED"
      | "SUPERSEDED"
      | "WORN",
    supersededByRecommendationId: null,
    targetDate: new Date("2026-08-03T00:00:00.000Z"),
  };
}

function recommendationCommandTestDatabase(
  recommendation: ReturnType<typeof recommendationRecord>,
) {
  const items = recommendation.options.flatMap((option) =>
    option.items.map(({ item }) => item),
  );
  const itemById = new Map(items.map((item) => [item.id, item]));
  const confirmations: Array<{
    createdAt: Date;
    id: string;
    items: Array<{ productId: string }>;
    recommendationId: string | null;
    recommendationOptionId: string | null;
    undoneAt: Date | null;
  }> = [];
  let confirmationSequence = 0;
  const transaction = {
    inventoryClothingProfile: {
      update: async (args: {
        data: {
          dirtyQuantity: { increment: number };
          isDirty: boolean;
          wearStateVersion: { increment: number };
        };
        where: { itemId: string };
      }) => {
        const profile = itemById.get(args.where.itemId)?.clothingProfile;

        if (!profile) {
          throw new Error("missing Clothing Profile");
        }

        profile.dirtyQuantity += args.data.dirtyQuantity.increment;
        profile.isDirty = args.data.isDirty;
        profile.wearStateVersion += args.data.wearStateVersion.increment;
        return profile;
      },
    },
    inventoryClothingRecommendation: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === recommendation.id ? recommendation : null,
      update: async (args: {
        data: { status: typeof recommendation.status };
        where: { id: string };
      }) => {
        if (args.where.id !== recommendation.id) {
          throw new Error("missing recommendation");
        }

        recommendation.status = args.data.status;
        return recommendation;
      },
    },
    inventoryClothingWearConfirmation: {
      create: async (args: {
        data: {
          confirmedByClientId: string;
          items: {
            create: Array<{
              itemId: string;
              productId: string;
              productTitle: string;
              wearStateVersionAfter: number;
            }>;
          };
          recommendationId: string;
          recommendationOptionId: string;
        };
      }) => {
        const confirmation = {
          createdAt: new Date("2026-08-03T10:30:00.000Z"),
          id: `wear-${++confirmationSequence}`,
          items: args.data.items.create.map(({ productId }) => ({ productId })),
          recommendationId: args.data.recommendationId,
          recommendationOptionId: args.data.recommendationOptionId,
          undoneAt: null,
        };
        confirmations.push(confirmation);
        return confirmation;
      },
    },
  } as unknown as Prisma.TransactionClient;

  return {
    confirmations,
    transaction,
  };
}
