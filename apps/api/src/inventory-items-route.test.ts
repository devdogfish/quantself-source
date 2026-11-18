import { describe, expect, it } from "bun:test";
import { Prisma } from "@quantself/db/generated/prisma/client";
import type { InventoryItemRecord } from "./inventory-service";
import { InventoryEnrichmentRetryConflictError } from "./inventory-enrichment-service";
import type { InventoryPreprocessingJobRecord } from "./inventory-preprocessing-service";
import { createApp } from "./app";
import {
  buildInventoryProcessingEvidence,
  buildInventoryItemsFindManyArgs,
  compactInventoryProcessingHistory,
  createInventoryItemsRouteHandlers,
  filterInventoryItemCollection,
  filterInventoryItemsByClothingState,
  filterRemedyIntakeRange,
  inventoryLifecycleWhere,
  inventoryItemMatchExplanation,
  inventoryItemScore,
  mapInventoryItem,
  normalizeOptionalQuery,
  paginateInventoryItems,
  paginateRemedyIntakeProjections,
  projectRemedyIntake,
  summarizeRemedyIntakeProjections,
  type InventoryItemsRepository,
  type RemedyIntake,
} from "./inventory-items-route";

describe("Inventory Item query helpers", () => {
  it("paginates the complete filtered Item collection with a cursor-bound filter", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      mapInventoryItem(inventoryItemRecord(`item-${String(index).padStart(2, "0")}`) as never),
    );
    const firstPage = paginateInventoryItems(items, {
      cursor: null,
      filterKey: "active",
      limit: 24,
    });
    const secondPage = paginateInventoryItems(items, {
      cursor: firstPage.pageInfo.nextCursor,
      filterKey: "active",
      limit: 24,
    });

    expect(firstPage.items).toHaveLength(24);
    expect(firstPage.total).toBe(25);
    expect(secondPage.items.map((item) => item.id)).toEqual(["item-24"]);
    expect(secondPage.pageInfo.nextCursor).toBeNull();
    expect(() =>
      paginateInventoryItems(items, {
        cursor: firstPage.pageInfo.nextCursor,
        filterKey: "different-filter",
        limit: 24,
      }),
    ).toThrow("cursor");
    expect(() =>
      paginateInventoryItems(items, {
        cursor: firstPage.pageInfo.nextCursor,
        filterKey: "active",
        limit: "all",
      }),
    ).toThrow("cursor");
  });

  it("applies every derived collection filter before pagination", () => {
    const captured = mapInventoryItem(
      inventoryItemRecord("captured") as never,
    );
    const complete = {
      ...captured,
      containerId: "container-1",
      id: "complete",
      importance: "HIGH" as const,
      kind: "GROUP" as const,
      placements: [
        {
          containerId: "container-1",
          label: "Travel drawer",
          locationId: null,
          locationName: null,
          note: null,
          placementId: "placement-1",
          quantity: 1,
        },
      ],
      processing: {
        ...captured.processing,
        evidence: [
          {
            id: "image-1",
            kind: "photo" as const,
            label: "Item image",
            summary: "Front",
          },
        ],
        proposal: {
          ...captured.processing.proposal,
          status: "APPROVED" as const,
        },
      },
      status: "KEEP" as const,
    };
    const input = {
      archived: false,
      category: null,
      clothingState: null,
      containerId: "container-1",
      evidence: "photo" as const,
      importance: "HIGH" as const,
      includeUnready: false,
      kind: "GROUP" as const,
      query: null,
      status: "KEEP" as const,
      workflow: "COMPLETE" as const,
    };

    expect(filterInventoryItemCollection([captured, complete], input)).toEqual([
      complete,
    ]);
    expect(
      filterInventoryItemCollection([captured], {
        ...input,
        containerId: null,
        evidence: null,
        importance: null,
        includeUnready: true,
        kind: null,
        status: null,
        workflow: null,
      }),
    ).toEqual([captured]);
  });

  it("derives Remedy Intake ranges and totals from the selected IANA time zone", () => {
    const intake: RemedyIntake = {
      id: "intake-edge",
      note: null,
      occurredAt: "2026-07-28T14:00:00.000Z",
      potency: "30C",
      itemArchivedAt: "2026-08-01T12:00:00.000Z",
      itemId: "item-ars",
      itemTitle: "Arsenicum album",
    };
    const utcProjection = projectRemedyIntake(intake, "UTC");
    const tokyoProjection = projectRemedyIntake(intake, "Asia/Tokyo");
    const rangeInput = {
      now: new Date("2026-08-03T16:00:00.000Z"),
      range: "7d" as const,
    };

    expect(utcProjection.bucketDate).toBe("2026-07-28");
    expect(tokyoProjection.bucketDate).toBe("2026-07-28");
    expect(
      filterRemedyIntakeRange([utcProjection], {
        ...rangeInput,
        timeZone: "UTC",
      }),
    ).toHaveLength(1);
    expect(
      filterRemedyIntakeRange([tokyoProjection], {
        ...rangeInput,
        timeZone: "Asia/Tokyo",
      }),
    ).toHaveLength(0);

    const summaries = summarizeRemedyIntakeProjections([
      utcProjection,
      projectRemedyIntake(
        {
          ...intake,
          id: "intake-later",
          occurredAt: "2026-08-03T12:00:00.000Z",
          potency: "200C",
        },
        "UTC",
      ),
    ]);
    expect(summaries).toEqual([
      expect.objectContaining({
        archivedAt: "2026-08-01T12:00:00.000Z",
        colorKey: utcProjection.colorKey,
        firstIntakeAt: "2026-07-28T14:00:00.000Z",
        lastIntakeAt: "2026-08-03T12:00:00.000Z",
        potencyTotals: [
          { potency: "200C", total: 1 },
          { potency: "30C", total: 1 },
        ],
        total: 2,
      }),
    ]);
  });

  it("paginates all-time Remedy Intakes with a stable cursor", () => {
    const projections = Array.from({ length: 101 }, (_, index) =>
      projectRemedyIntake(
        {
          id: `intake-${String(index).padStart(3, "0")}`,
          note: null,
          occurredAt: new Date(Date.UTC(2026, 7, 3, 0, 0, -index)).toISOString(),
          potency: "30C",
          itemArchivedAt: null,
          itemId: "item-ars",
          itemTitle: "Arsenicum album",
        },
        "UTC",
      ),
    );
    const firstPage = paginateRemedyIntakeProjections(projections, {
      cursor: null,
      range: "all",
    });
    const secondPage = paginateRemedyIntakeProjections(projections, {
      cursor: firstPage.pageInfo.nextCursor,
      range: "all",
    });

    expect(firstPage.intakes).toHaveLength(100);
    expect(firstPage.pageInfo.nextCursor).toBe("intake-099");
    expect(secondPage.intakes.map((intake) => intake.id)).toEqual(["intake-100"]);
    expect(secondPage.pageInfo.nextCursor).toBeNull();
    expect(() =>
      paginateRemedyIntakeProjections(projections, {
        cursor: "missing",
        range: "all",
      }),
    ).toThrow();
  });

  it("keeps the latest eight processing history entries", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      at: `2026-08-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      stage: "enrichment" as const,
      status: "FAILED",
      summary: `Attempt ${index}`,
    }));

    expect(compactInventoryProcessingHistory(history)).toEqual(
      history.reverse().slice(0, 8),
    );
  });

  it("defaults to active items and uses archived order only when requested", () => {
    expect(inventoryLifecycleWhere(false)).toEqual({ archivedAt: null });
    expect(inventoryLifecycleWhere(true)).toEqual({
      archivedAt: { not: null },
    });
    expect(
      buildInventoryItemsFindManyArgs({
        archived: false,
        category: null,
        clothingState: null,
        query: null,
      }).orderBy,
    ).toEqual([{ capturedAt: "desc" }, { id: "desc" }]);
    expect(
      buildInventoryItemsFindManyArgs({
        archived: true,
        category: null,
        clothingState: null,
        query: null,
      }).orderBy,
    ).toEqual([
      { archivedAt: "desc" },
      { capturedAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("treats blank q as listing behavior and filters searchable terms when present", () => {
    expect(normalizeOptionalQuery(undefined)).toBeNull();
    expect(normalizeOptionalQuery("   ")).toBeNull();
    expect(normalizeOptionalQuery(" projector ")).toBe("projector");

    expect(
      buildInventoryItemsFindManyArgs({
        archived: true,
        category: null,
        clothingState: null,
        query: "projector tote",
      }).where,
    ).toMatchObject({
      AND: [
        {
          AND: [
            expect.any(Object),
            expect.any(Object),
          ],
        },
      ],
      archivedAt: { not: null },
    });
  });

  it("combines category with current direct and Container location filters", () => {
    const where = buildInventoryItemsFindManyArgs({
      archived: false,
      category: "food",
      clothingState: null,
      query: "pantry",
    }).where;

    expect(where).toMatchObject({
      archivedAt: null,
      category: "food",
    });
    expect(JSON.stringify(where).match(/"location"/gu)).toHaveLength(2);
  });

  it("defers Clothing state filters until unit counts are mapped", () => {
    expect(
      buildInventoryItemsFindManyArgs({
        archived: false,
        category: "clothing",
        clothingState: "dirty",
        query: null,
      }).where,
    ).toEqual({
      archivedAt: null,
      category: "clothing",
    });
    expect(
      buildInventoryItemsFindManyArgs({
        archived: false,
        category: "clothing",
        clothingState: "clean",
        query: null,
      }).where,
    ).toEqual({
      archivedAt: null,
      category: "clothing",
    });
  });

  it("includes mixed-unit Clothing Items in both clean and dirty filters", () => {
    const items = [
      {
        clothingProfile: { dirtyQuantity: 0, isDirty: false },
        id: "clean",
        totalQuantity: 2,
      },
      {
        clothingProfile: { dirtyQuantity: 1, isDirty: true },
        id: "mixed",
        totalQuantity: 2,
      },
      {
        clothingProfile: { dirtyQuantity: 2, isDirty: true },
        id: "dirty",
        totalQuantity: 2,
      },
    ] as never;

    expect(
      filterInventoryItemsByClothingState(items, "clean").map(
        ({ id }) => id,
      ),
    ).toEqual(["clean", "mixed"]);
    expect(
      filterInventoryItemsByClothingState(items, "dirty").map(
        ({ id }) => id,
      ),
    ).toEqual(["mixed", "dirty"]);
  });

  it("maps item summaries with archive metadata and stable placement fallbacks", () => {
    expect(
      mapInventoryItem({
        category: null,
        archivedAt: new Date("2026-07-26T12:00:00.000Z"),
        captureText: "Captured title",
        containerId: null,
        containerLabel: null,
        id: "item-1",
        importance: "MEDIUM",
        images: [{ id: "image-1" }],
        kind: "ITEM",
        locationId: null,
        locationName: null,
        note: null,
        placements: [
          {
            containerId: "container-1",
            container: {
              location: {
                id: "location-hall",
                name: "Hall closet",
              },
              name: "Travel drawer",
              referenceId: "BIN-0003",
            },
            id: "placement-container-1",
            location: null,
            locationId: null,
            note: null,
            quantity: 2,
          },
          {
            containerId: null,
            container: null,
            id: "placement-unplaced",
            location: null,
            locationId: null,
            note: "Loose shelf",
            quantity: 1,
          },
        ],
        searchText: "captured title loose shelf",
        status: "UNSURE",
        tags: [],
        title: null,
        totalQuantity: 3,
      }),
    ).toMatchObject({
      acquisitionSource: null,
      aliases: [],
      archivedAt: "2026-07-26T12:00:00.000Z",
      category: null,
      id: "item-1",
      imageId: "image-1",
      placements: [
        {
          containerId: "container-1",
          label: "Hall closet / Travel drawer (BIN-0003)",
          locationId: null,
          locationName: "Hall closet",
          note: null,
          placementId: "placement-container-1",
          quantity: 2,
        },
        {
          containerId: null,
          label: "Loose shelf",
          locationId: null,
          note: "Loose shelf",
          placementId: "placement-unplaced",
          quantity: 1,
        },
      ],
      processing: expect.objectContaining({
        proposal: expect.objectContaining({ status: "NONE" }),
      }),
      title: "Captured title",
      totalQuantity: 3,
      where: "Hall closet / Travel drawer (BIN-0003) × 2",
    });
  });

  it("ranks direct title matches above search-text matches", () => {
    const item = {
      category: null,
      archivedAt: new Date("2026-07-26T12:00:00.000Z"),
      captureText: null,
      containerId: null,
      containerLabel: null,
      id: "item-1",
      importance: "MEDIUM" as const,
      images: [],
      kind: "ITEM" as const,
      locationId: null,
      locationName: null,
      note: null,
      placements: [],
      searchText: "projector",
      status: "KEEP" as const,
      tags: [],
      title: "Media equipment",
      totalQuantity: 0,
    };

    expect(
      inventoryItemScore(
        {
          ...item,
          title: "Projector",
        },
        "projector",
      ),
    ).toBeGreaterThan(inventoryItemScore(item, "projector"));
    expect(inventoryItemScore(item, "missing")).toBe(0);
    expect(
      inventoryItemMatchExplanation(
        {
          ...item,
          title: "Projector",
        },
        "projector",
      ),
    ).toBe("Matched title, search text");
  });

  it("keeps current direct and Container location matches during ranking", () => {
    const item = {
      category: "food" as const,
      archivedAt: null,
      captureText: null,
      containerId: null,
      containerLabel: null,
      id: "item-1",
      importance: "MEDIUM" as const,
      images: [],
      kind: "GROUP" as const,
      locationId: null,
      locationName: null,
      note: null,
      searchText: "kale chips",
      status: "KEEP" as const,
      tags: [],
      title: "Kale chips",
      totalQuantity: 2,
    };

    expect(
      inventoryItemScore(
        {
          ...item,
          placements: [
            {
              container: null,
              id: "placement-location-1",
              location: { id: "location-1", name: "Pantry" },
              note: null,
              quantity: 1,
            },
          ],
        },
        "pantry",
      ),
    ).toBeGreaterThan(0);
    expect(
      inventoryItemScore(
        {
          ...item,
          placements: [
            {
              container: {
                location: { id: "location-2", name: "Basement" },
                name: "Food tote",
                referenceId: "BIN-0004",
              },
              id: "placement-container-1",
              location: null,
              note: null,
              quantity: 1,
            },
          ],
        },
        "basement",
      ),
    ).toBeGreaterThan(0);
  });

  it("includes stored video and file evidence in API Item summaries", () => {
    const evidence = buildInventoryProcessingEvidence(
      inventoryItemRecord("item-1", {
        assets: [
          {
            filePath: "inventory/assets/walkaround.mp4",
            id: "video-1",
            mimeType: "video/mp4",
            originalName: "walkaround.mp4",
          },
          {
            filePath: "inventory/assets/manual.pdf",
            id: "file-1",
            mimeType: "application/pdf",
            originalName: "manual.pdf",
          },
        ],
      }),
    );

    expect(evidence).toEqual([
      {
        id: "video-1",
        kind: "video",
        label: "Item Video",
        summary: "walkaround.mp4",
      },
      {
        id: "file-1",
        kind: "file",
        label: "Item File",
        summary: "manual.pdf",
      },
    ]);
  });
});

describe("Inventory Item routes", () => {
  it("exports all ranked matches with the authorized collection filters and a narrow read", async () => {
    const queries: Prisma.InventoryItemFindManyArgs[] = [];
    let access: "reader" | "denied" | "anonymous" = "reader";
    const candidate = {
      title: null,
      captureText: "Canvas pouch",
      searchText: "",
      placements: [],
      preprocessingJobs: [],
      enrichmentJobs: [{ status: "APPLIED" }],
    };
    const items = Array.from({ length: 25 }, (_, index) => ({
      ...candidate,
      id: `item-${index}`,
    }));
    const handlers = createInventoryItemsRouteHandlers({
      exportDatabase: {
        inventoryItem: {
          async findMany(args: Prisma.InventoryItemFindManyArgs) {
            queries.push(args);
            return [
              ...items,
              { ...candidate, id: "unready", title: "Pouch", enrichmentJobs: [] },
              { ...candidate, id: "ranked", title: "Pouch" },
            ];
          },
        },
      } as never,
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: { exportItems: handlers.exportItems },
      resolveAccessContext: async () => access === "anonymous" ? null : ({
        owner: { email: "owner@example.com", id: "owner-1", name: "Owner" },
        client: { id: "client-1", kind: "api-key", name: "Client" },
        permissions: access === "reader" ? ["inventory:read"] : [],
      }),
    });
    const path = "/api/v1/inventory-items/export";
    const response = await app.request(
      `${path}?archived=true&category=technology&q=pouch&status=KEEP&importance=HIGH&kind=ITEM&evidence=voice&containerId=tote&includeUnready=false`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      items: [{ id: "ranked", title: "Pouch" }, ...items.map(({ id }) => ({ id, title: "Canvas pouch" }))],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      where: { AND: [
        { archivedAt: { not: null }, category: "technology", AND: [expect.any(Object)] },
        { status: "KEEP" }, { importance: "HIGH" }, { kind: "ITEM" },
        { placements: { some: { containerId: "tote" } } },
        { audioNotes: { some: { id: { not: "" } } } },
      ] },
      select: { id: true, title: true, enrichmentJobs: { take: 1, select: { status: true } } },
    });
    expect(queries[0]?.include).toBeUndefined();
    expect(queries[0]?.take).toBeUndefined();
    expect((await app.request(`${path}?cursor=not-for-export`)).status).toBe(400);
    access = "denied";
    expect((await app.request(path)).status).toBe(403);
    access = "anonymous";
    expect((await app.request(path)).status).toBe(401);
    expect(queries).toHaveLength(1);
  });

  it("hard-cuts the public collection route from products to items", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        listItems: async () => ({
          items: [],
          pageInfo: { nextCursor: null },
          total: 0,
        }),
      },
      resolveAccessContext: async () => ({
        owner: { email: "owner@example.com", id: "owner-1", name: "Owner" },
        client: { id: "reader-1", kind: "api-key", name: "Reader" },
        permissions: ["inventory:read"],
      }),
    });

    expect((await app.request("/api/v1/inventory-items")).status).toBe(200);
    const formerRoutes = [
      app.request("/api/v1/inventory-products"),
      app.request("/api/v1/inventory-products/item-1"),
      app.request("/api/v1/inventory-products/capture", { method: "POST" }),
      app.request("/api/v1/inventory-products/item-1/media"),
      app.request("/api/v1/inventory-containers/container-1/move-products", {
        method: "POST",
      }),
    ];

    for (const response of await Promise.all(formerRoutes)) {
      expect(response.status).toBe(404);
    }
  });

  it("exposes bounded traversal, bulk reads, and safe cursor failures", async () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      mapInventoryItem(
        inventoryItemRecord(
          `item-${String(index).padStart(2, "0")}`,
        ) as never,
      ),
    );
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        listItems: async (input) =>
          paginateInventoryItems(items, {
            cursor: input.cursor ?? null,
            filterKey: JSON.stringify({
              archived: input.archived,
              query: input.query,
            }),
            limit: input.limit ?? 24,
          }),
      },
      resolveAccessContext: async () => ({
        owner: { email: "owner@example.com", id: "owner-1", name: "Owner" },
        client: { id: "reader-1", kind: "api-key", name: "Reader" },
        permissions: ["inventory:read"],
      }),
    });

    const firstResponse = await app.request("/api/v1/inventory-items");
    const firstPage = (await firstResponse.json()) as {
      items: Array<{ id: string }>;
      pageInfo: { nextCursor: string | null };
      total: number;
    };
    const secondResponse = await app.request(
      `/api/v1/inventory-items?cursor=${encodeURIComponent(firstPage.pageInfo.nextCursor ?? "")}`,
    );
    const secondPage = (await secondResponse.json()) as typeof firstPage;
    const allResponse = await app.request("/api/v1/inventory-items?limit=all");
    const allPage = (await allResponse.json()) as typeof firstPage;
    const changedFilterResponse = await app.request(
      `/api/v1/inventory-items?q=changed&cursor=${encodeURIComponent(firstPage.pageInfo.nextCursor ?? "")}`,
    );
    const invalidCursorResponse = await app.request(
      "/api/v1/inventory-items?cursor=not-a-cursor",
    );
    const incompatibleLimitResponse = await app.request(
      `/api/v1/inventory-items?limit=all&cursor=${encodeURIComponent(firstPage.pageInfo.nextCursor ?? "")}`,
    );

    expect(firstResponse.status).toBe(200);
    expect(firstPage.items).toHaveLength(24);
    expect(firstPage.total).toBe(25);
    expect(firstPage.pageInfo.nextCursor).not.toBeNull();
    expect(secondResponse.status).toBe(200);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.pageInfo.nextCursor).toBeNull();
    expect(
      [...firstPage.items, ...secondPage.items].map((item) => item.id),
    ).toEqual(items.map((item) => item.id));
    expect(allResponse.status).toBe(200);
    expect(allPage.items).toHaveLength(25);
    expect(allPage.pageInfo.nextCursor).toBeNull();
    expect(changedFilterResponse.status).toBe(400);
    expect(invalidCursorResponse.status).toBe(400);
    expect(incompatibleLimitResponse.status).toBe(400);
  });

  it("composes controlled category with text and archive filters", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        listItems: async (input) => {
          inputs.push(input);
          return { items: [], pageInfo: { nextCursor: null }, total: 0 };
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "reader-1",
          kind: "api-key",
          name: "Reader",
        },
        permissions: ["inventory:read"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-items?archived=true&category=food&q=greens",
    );

    expect(response.status).toBe(200);
    expect(inputs).toEqual([
      {
        archived: true,
        category: "food",
        clothingState: null,
        containerId: null,
        cursor: null,
        evidence: null,
        importance: null,
        includeUnready: undefined,
        kind: null,
        limit: 24,
        query: "greens",
        status: null,
        workflow: null,
      },
    ]);
  });

  it("accepts clothing state only for clothing wardrobe queries", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        listItems: async (input) => {
          inputs.push(input);
          return { items: [], pageInfo: { nextCursor: null }, total: 0 };
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "reader-1",
          kind: "api-key",
          name: "Reader",
        },
        permissions: ["inventory:read"],
      }),
    });

    const allowed = await app.request(
      "/api/v1/inventory-items?category=clothing&clothingState=dirty&q=shirt",
    );
    const rejected = await app.request(
      "/api/v1/inventory-items?category=food&clothingState=dirty",
    );

    expect(allowed.status).toBe(200);
    expect(inputs).toEqual([
      {
        archived: false,
        category: "clothing",
        clothingState: "dirty",
        containerId: null,
        cursor: null,
        evidence: null,
        importance: null,
        includeUnready: undefined,
        kind: null,
        limit: 24,
        query: "shirt",
        status: null,
        workflow: null,
      },
    ]);
    expect(rejected.status).toBe(400);
  });

  it("reads and replaces Clothing Profiles through authenticated HTTP routes", async () => {
    const profile = {
      itemId: "item-shirt",
      dirtyQuantity: 0,
      isDirty: false,
      attributes: { version: 1 as const, kind: "shirt" },
      createdAt: "2026-08-03T09:00:00.000Z",
      updatedAt: "2026-08-03T09:00:00.000Z",
    };
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        getClothingProfile: async () => profile,
        updateClothingProfile: async ({ request }) => ({
          clothingProfile: {
            ...profile,
            attributes: request.attributes,
            isDirty: request.isDirty,
            updatedAt: "2026-08-03T10:00:00.000Z",
          },
          item: mapInventoryItem({
            category: "clothing",
            archivedAt: null,
            captureText: null,
            clothingProfile: {
              attributes: request.attributes,
              createdAt: new Date("2026-08-03T09:00:00.000Z"),
              isDirty: request.isDirty,
              updatedAt: new Date("2026-08-03T10:00:00.000Z"),
            },
            containerId: null,
            containerLabel: null,
            id: "item-shirt",
            importance: "MEDIUM",
            images: [],
            kind: "ITEM",
            locationId: null,
            locationName: null,
            note: null,
            placements: [],
            searchText: "blue shirt",
            status: "KEEP",
            tags: [],
            title: "Blue oxford shirt",
            totalQuantity: 1,
          }),
        }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const getResponse = await app.request(
      "/api/v1/inventory-items/item-shirt/clothing-profile",
    );
    const putResponse = await app.request(
      "/api/v1/inventory-items/item-shirt/clothing-profile",
      {
        body: JSON.stringify({
          attributes: {
            version: 1,
            kind: "shirt",
            colors: ["blue", "white"],
          },
          isDirty: true,
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "clothing-profile-1",
        },
        method: "PUT",
      },
    );
    const invalidProfileResponses = await Promise.all(
      [
        { attributes: {}, isDirty: false },
        { attributes: { version: 2 }, isDirty: false },
        {
          attributes: { version: 1, unsupported: "value" },
          isDirty: false,
        },
      ].map((body, index) =>
        app.request(
          "/api/v1/inventory-items/item-shirt/clothing-profile",
          {
            body: JSON.stringify(body),
            headers: {
              "content-type": "application/json",
              "idempotency-key": `invalid-clothing-profile-${index}`,
            },
            method: "PUT",
          },
        ),
      ),
    );

    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({
      clothingProfile: profile,
    });
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toMatchObject({
      clothingProfile: {
        ...profile,
        attributes: {
          version: 1,
          kind: "shirt",
          colors: ["blue", "white"],
        },
        isDirty: true,
        updatedAt: "2026-08-03T10:00:00.000Z",
      },
      item: {
        category: "clothing",
        clothingProfile: {
          isDirty: true,
        },
        id: "item-shirt",
      },
    });
    expect(invalidProfileResponses.map(({ status }) => status)).toEqual([
      400, 400, 400,
    ]);
  });

  it("marks one clean Clothing Item worn through an authenticated HTTP route", async () => {
    const wornAt = "2026-08-03T10:30:00.000Z";
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        markClothingItemWorn: async ({ itemId }) => ({
          item: mapInventoryItem({
            category: "clothing",
            archivedAt: null,
            captureText: null,
            clothingProfile: {
              attributes: { version: 1, kind: "shirt" },
              createdAt: new Date("2026-08-03T09:00:00.000Z"),
              isDirty: true,
              updatedAt: new Date(wornAt),
            },
            containerId: null,
            containerLabel: null,
            id: itemId,
            importance: "MEDIUM",
            images: [],
            kind: "ITEM",
            locationId: null,
            locationName: null,
            note: null,
            placements: [],
            searchText: "blue shirt",
            status: "KEEP",
            tags: [],
            title: "Blue oxford shirt",
            totalQuantity: 1,
          }),
          wearConfirmation: {
            createdAt: wornAt,
            id: "wear-1",
            itemIds: [itemId],
            undoneAt: null,
          },
        }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-items/item-shirt/worn",
      {
        headers: {
          "idempotency-key": "wear-item-1",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      item: expect.objectContaining({
        category: "clothing",
        clothingProfile: expect.objectContaining({ isDirty: true }),
        id: "item-shirt",
      }),
      wearConfirmation: {
        createdAt: wornAt,
        id: "wear-1",
        itemIds: ["item-shirt"],
        undoneAt: null,
      },
    });
  });

  it("undos one Clothing Wear Confirmation through an authenticated HTTP route", async () => {
    const undoneAt = "2026-08-03T10:35:00.000Z";
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        undoClothingWearConfirmation: async ({ confirmationId }) => ({
          items: [
            mapInventoryItem({
              category: "clothing",
              archivedAt: null,
              captureText: null,
              clothingProfile: {
                attributes: { version: 1, kind: "shirt" },
                createdAt: new Date("2026-08-03T09:00:00.000Z"),
                isDirty: false,
                updatedAt: new Date(undoneAt),
              },
              containerId: null,
              containerLabel: null,
              id: "item-shirt",
              importance: "MEDIUM",
              images: [],
              kind: "ITEM",
              locationId: null,
              locationName: null,
              note: null,
              placements: [],
              searchText: "blue shirt",
              status: "KEEP",
              tags: [],
              title: "Blue oxford shirt",
              totalQuantity: 1,
            }),
          ],
          wearConfirmation: {
            createdAt: "2026-08-03T10:30:00.000Z",
            id: confirmationId,
            itemIds: ["item-shirt"],
            undoneAt,
          },
        }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-clothing/wear-confirmations/wear-1/undo",
      {
        headers: {
          "idempotency-key": "undo-wear-1",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        expect.objectContaining({
          clothingProfile: expect.objectContaining({ isDirty: false }),
          id: "item-shirt",
        }),
      ],
      wearConfirmation: {
        createdAt: "2026-08-03T10:30:00.000Z",
        id: "wear-1",
        itemIds: ["item-shirt"],
        undoneAt,
      },
    });
  });

  it("maps an undo daily-slot collision to a safe conflict", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        undoClothingWearConfirmation: async () => {
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
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-clothing/wear-confirmations/wear-1/undo",
      {
        headers: {
          "idempotency-key": "undo-wear-slot-conflict",
        },
        method: "POST",
      },
    );

    expect(await response.json()).toEqual({
      code: "INVENTORY_CLOTHING_CONFLICT",
      message: "Clothing Wear Confirmation can no longer be safely undone.",
    });
    expect(response.status).toBe(409);
  });

  it("completes Clothing laundry through an authenticated HTTP route", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        completeClothingLaundry: async () => ({
          cleanedCount: 1,
          items: [
            mapInventoryItem({
              category: "clothing",
              archivedAt: null,
              captureText: null,
              clothingProfile: {
                attributes: { version: 1, kind: "shirt" },
                createdAt: new Date("2026-08-03T09:00:00.000Z"),
                isDirty: false,
                updatedAt: new Date("2026-08-03T10:45:00.000Z"),
              },
              containerId: null,
              containerLabel: null,
              id: "item-shirt",
              importance: "MEDIUM",
              images: [],
              kind: "ITEM",
              locationId: null,
              locationName: null,
              note: null,
              placements: [],
              searchText: "blue shirt",
              status: "KEEP",
              tags: [],
              title: "Blue oxford shirt",
              totalQuantity: 1,
            }),
          ],
        }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request(
      "/api/v1/inventory-clothing/laundry-completed",
      {
        body: JSON.stringify({
          mode: "selected",
          itemIds: ["item-shirt"],
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "laundry-1",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cleanedCount: 1,
      items: [
        expect.objectContaining({
          clothingProfile: expect.objectContaining({ isDirty: false }),
          id: "item-shirt",
        }),
      ],
    });
  });

  it("maps profile-category conflicts to HTTP 409 during Item updates", async () => {
    const handlers = createInventoryItemsRouteHandlers({
      createMutationRepository: () =>
        inventoryMutationRepository({
          getInventoryItem: async () =>
            inventoryItemRecord("item-shirt", {
              category: "clothing",
              clothingProfile: {
                attributes: { version: 1, kind: "shirt" },
                createdAt: new Date("2026-08-03T09:00:00.000Z"),
                isDirty: false,
                updatedAt: new Date("2026-08-03T09:00:00.000Z"),
              },
            }),
        }),
      repository: createMemoryRepository(new Map()),
      runCommand: async (input) => input.execute({} as never),
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: handlers,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request("/api/v1/inventory-items/item-shirt", {
      body: JSON.stringify({ category: "medical" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "profile-category-conflict-1",
      },
      method: "PUT",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PROFILE_CATEGORY_CONFLICT",
      message: "Inventory Clothing Profile conflicts with non-clothing category.",
    });
  });

  it("registers and reads owned Remedy Profiles through dedicated routes", async () => {
    const remedyProfile = {
      createdAt: "2026-08-03T09:00:00.000Z",
      externalReferences: [
        {
          referenceId: "arn",
          source: "oorep",
          url: "https://www.oorep.com/remedy/arn",
        },
      ],
      potencies: ["30C", "200C"],
      itemId: "item-remedy",
      registeredByClientId: "research-client",
      selectionSummary: "Restlessness after midnight.",
      substanceId: "substance-remedy",
      updatedAt: "2026-08-03T09:00:00.000Z",
    };
    const item = mapInventoryItem({
      archivedAt: null,
      category: "homeopathy",
      captureText: null,
      containerId: null,
      containerLabel: null,
      id: "item-remedy",
      images: [],
      placements: [
        {
          container: null,
          containerId: null,
          id: "placement-remedy",
          location: {
            id: "location-apothecary",
            name: "Apothecary cabinet",
          },
          locationId: "location-apothecary",
          note: null,
          quantity: 2,
        },
      ],
      searchText: "arsenicum album 30c 200c",
      title: "Arsenicum album",
      totalQuantity: 2,
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        getItem: async () => ({
          ...item,
          remedyProfile,
        }),
        getRemedyProfile: async () => remedyProfile,
        registerRemedy: async () => ({
          item: {
            ...item,
            remedyProfile,
          },
          remedyProfile,
        }),
        updateRemedyProfile: async () => ({
          item: {
            ...item,
            remedyProfile: {
              ...remedyProfile,
              potencies: ["30C", "1M"],
              updatedAt: "2026-08-03T10:00:00.000Z",
            },
          },
          remedyProfile: {
            ...remedyProfile,
            potencies: ["30C", "1M"],
            updatedAt: "2026-08-03T10:00:00.000Z",
          },
        }),
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "research-client",
          kind: "api-key",
          name: "Research client",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const registerResponse = await app.request("/api/v1/inventory-remedies", {
      body: JSON.stringify({
        externalReferences: [
          {
            referenceId: " arn ",
            source: " OOREP ",
            url: "https://www.oorep.com/remedy/arn",
          },
        ],
        locationId: "location-apothecary",
        potencies: [" 30c ", "200C"],
        quantity: 2,
        selectionSummary: " Restlessness after midnight. ",
        title: "Arsenicum album",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "register-remedy-1",
      },
      method: "POST",
    });
    const getProfileResponse = await app.request(
      "/api/v1/inventory-items/item-remedy/remedy-profile",
    );
    const updateProfileResponse = await app.request(
      "/api/v1/inventory-items/item-remedy/remedy-profile",
      {
        body: JSON.stringify({
          potencies: ["30C", "1M"],
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-remedy-profile-1",
        },
        method: "PUT",
      },
    );

    expect(registerResponse.status).toBe(201);
    expect(await registerResponse.json()).toEqual({
      item: {
        ...item,
        remedyProfile,
      },
      remedyProfile,
    });
    expect(getProfileResponse.status).toBe(200);
    expect(await getProfileResponse.json()).toEqual({
      remedyProfile,
    });
    expect(updateProfileResponse.status).toBe(200);
    expect(await updateProfileResponse.json()).toEqual({
      item: {
        ...item,
        remedyProfile: {
          ...remedyProfile,
          potencies: ["30C", "1M"],
          updatedAt: "2026-08-03T10:00:00.000Z",
        },
      },
      remedyProfile: {
        ...remedyProfile,
        potencies: ["30C", "1M"],
        updatedAt: "2026-08-03T10:00:00.000Z",
      },
    });
  });

  it("records, lists, and deletes Remedy Intakes through dedicated routes", async () => {
    const intake = {
      id: "intake-1",
      note: "Before bed.",
      occurredAt: "2026-08-03T22:15:00.000Z",
      potency: "200C",
      itemArchivedAt: null,
      itemId: "item-remedy",
      itemTitle: "Arsenicum album",
    };
    const intakeProjection = {
      ...intake,
      bucketDate: "2026-08-03",
      colorKey: "remedy-3",
    };
    const createCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];
    const listCalls: Array<Record<string, unknown>> = [];
    const summaryCalls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        createRemedyIntake: async (input) => {
          createCalls.push(input as unknown as Record<string, unknown>);

          return { intake };
        },
        deleteRemedyIntake: async (input) => {
          deleteCalls.push(input as unknown as Record<string, unknown>);

          return { deletedIntakeId: input.intakeId };
        },
        listRemedyIntakes: async (input) => {
          listCalls.push(input as unknown as Record<string, unknown>);

          return {
            intakes: [intakeProjection],
            pageInfo: { nextCursor: null },
            range: input.range,
          };
        },
        summarizeRemedyIntakes: async (input) => {
          summaryCalls.push(input as unknown as Record<string, unknown>);

          return {
            range: input.range,
            remedies: [
              {
                archivedAt: null,
                colorKey: "remedy-3",
                firstIntakeAt: intake.occurredAt,
                lastIntakeAt: intake.occurredAt,
                potencyTotals: [{ potency: "200C", total: 1 }],
                itemId: intake.itemId,
                itemTitle: intake.itemTitle,
                total: 1,
              },
            ],
            totalIntakes: 1,
          };
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "health-client",
          kind: "api-key",
          name: "Health client",
        },
        permissions: [
          "health:delete",
          "health:read",
          "health:write",
          "inventory:read",
        ],
      }),
    });

    const createResponse = await app.request("/api/v1/remedy-intakes", {
      body: JSON.stringify({
        note: "Before bed.",
        occurredAt: "2026-08-03T22:15:00.000Z",
        potency: "200C",
        itemId: "item-remedy",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-remedy-intake-1",
      },
      method: "POST",
    });
    const listResponse = await app.request(
      "/api/v1/remedy-intakes?range=30d&timeZone=America%2FToronto",
    );
    const summaryResponse = await app.request(
      "/api/v1/remedy-intakes/summary?range=30d&timeZone=America%2FToronto",
    );
    const missingQueryResponse = await app.request("/api/v1/remedy-intakes");
    const invalidTimeZoneResponse = await app.request(
      "/api/v1/remedy-intakes/summary?range=30d&timeZone=Not%2FAZone",
    );
    const invalidCursorResponse = await app.request(
      "/api/v1/remedy-intakes?range=7d&timeZone=UTC&cursor=intake-1",
    );
    const deleteResponse = await app.request("/api/v1/remedy-intakes/intake-1", {
      headers: {
        "idempotency-key": "delete-remedy-intake-1",
      },
      method: "DELETE",
    });

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual({ intake });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      intakes: [intakeProjection],
      pageInfo: { nextCursor: null },
      range: "30d",
    });
    expect(summaryResponse.status).toBe(200);
    expect(await summaryResponse.json()).toEqual({
      range: "30d",
      remedies: [
        {
          archivedAt: null,
          colorKey: "remedy-3",
          firstIntakeAt: intake.occurredAt,
          lastIntakeAt: intake.occurredAt,
          potencyTotals: [{ potency: "200C", total: 1 }],
          itemId: intake.itemId,
          itemTitle: intake.itemTitle,
          total: 1,
        },
      ],
      totalIntakes: 1,
    });
    expect(missingQueryResponse.status).toBe(400);
    expect(invalidTimeZoneResponse.status).toBe(400);
    expect(invalidCursorResponse.status).toBe(400);
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      deletedIntakeId: "intake-1",
    });
    expect(createCalls).toEqual([
      {
        clientId: "health-client",
        idempotencyKey: "create-remedy-intake-1",
        operation: "createRemedyIntake",
        request: {
          note: "Before bed.",
          occurredAt: "2026-08-03T22:15:00.000Z",
          potency: "200C",
          itemId: "item-remedy",
        },
      },
    ]);
    expect(listCalls).toEqual([
      {
        cursor: null,
        itemId: null,
        range: "30d",
        timeZone: "America/Toronto",
      },
    ]);
    expect(summaryCalls).toEqual([
      {
        itemId: null,
        range: "30d",
        timeZone: "America/Toronto",
      },
    ]);
    expect(deleteCalls).toEqual([
      {
        clientId: "health-client",
        idempotencyKey: "delete-remedy-intake-1",
        intakeId: "intake-1",
        operation: "deleteRemedyIntake",
      },
    ]);
  });

  it("rejects malformed Remedy Intake commands before persistence", async () => {
    let createCalls = 0;
    let deleteCalls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        createRemedyIntake: async () => {
          createCalls += 1;
          throw new Error("invalid create reached persistence");
        },
        deleteRemedyIntake: async () => {
          deleteCalls += 1;
          throw new Error("invalid delete reached persistence");
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "health-client",
          kind: "api-key",
          name: "Health client",
        },
        permissions: ["health:delete", "health:write", "inventory:read"],
      }),
    });

    const missingBody = await app.request("/api/v1/remedy-intakes", {
      headers: {
        "content-type": "application/json",
        "idempotency-key": "missing-body",
      },
      method: "POST",
    });
    const blankPotency = await app.request("/api/v1/remedy-intakes", {
      body: JSON.stringify({ potency: "", itemId: "item-remedy" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "blank-potency",
      },
      method: "POST",
    });
    const missingCreateKey = await app.request("/api/v1/remedy-intakes", {
      body: JSON.stringify({ potency: "30C", itemId: "item-remedy" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const missingDeleteKey = await app.request(
      "/api/v1/remedy-intakes/intake-1",
      { method: "DELETE" },
    );

    expect(missingBody.status).toBe(400);
    expect(blankPotency.status).toBe(400);
    expect(missingCreateKey.status).toBe(400);
    expect(missingDeleteKey.status).toBe(400);
    expect(createCalls).toBe(0);
    expect(deleteCalls).toBe(0);
  });

  it("rejects blank Remedy titles and every invalid owned potency", async () => {
    let commandRuns = 0;
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: async () => {
        commandRuns += 1;
        throw new Error("Invalid Remedy Registration reached persistence.");
      },
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: handlers,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "research-client",
          kind: "api-key",
          name: "Research client",
        },
        permissions: ["inventory:write"],
      }),
    });
    const register = (body: Record<string, unknown>) =>
      app.request("/api/v1/inventory-remedies", {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "invalid-remedy",
        },
        method: "POST",
      });

    const blankTitle = await register({ potencies: ["30C"], title: "   " });
    const blankPotency = await register({
      potencies: ["30C", "   "],
      title: "Arnica montana",
    });
    const longPotency = await register({
      potencies: ["30C", "X".repeat(33)],
      title: "Arnica montana",
    });

    expect(blankTitle.status).toBe(400);
    expect(blankPotency.status).toBe(400);
    expect(longPotency.status).toBe(400);
    expect(commandRuns).toBe(0);
  });

  it("rejects mixed targets and reports insufficient stock as a conflict", async () => {
    const baseHandlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...baseHandlers,
        addUnits: async () => {
          throw new Error("add should not run");
        },
        moveUnits: async () => {
          throw new Error("Move quantity exceeds available units.");
        },
        removeUnits: async () => {
          throw new Error("Remove quantity exceeds available units.");
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });
    const request = (path: string, body: Record<string, unknown>) =>
      app.request(path, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `issue-80-${path}`,
        },
        method: "POST",
      });

    const mixedTarget = await request(
      "/api/v1/inventory-items/item-1/add-units",
      {
        containerId: "container-1",
        locationId: "location-1",
        quantity: 1,
      },
    );
    const moveConflict = await request(
      "/api/v1/inventory-items/item-1/move-units",
      { destinationLocationId: "location-1", quantity: 2 },
    );
    const removeConflict = await request(
      "/api/v1/inventory-items/item-1/remove-units",
      { quantity: 2 },
    );

    expect(mixedTarget.status).toBe(400);
    expect(moveConflict.status).toBe(409);
    expect(await moveConflict.json()).toEqual({
      code: "INVENTORY_PLACEMENT_CONFLICT",
      message: "Move quantity exceeds available units.",
    });
    expect(removeConflict.status).toBe(409);
    expect(await removeConflict.json()).toEqual({
      code: "INVENTORY_PLACEMENT_CONFLICT",
      message: "Remove quantity exceeds available units.",
    });
  });

  it("returns 404 for missing source and removal targets", async () => {
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: async (input) =>
        input.execute({
          inventoryContainer: {
            findUnique: async () => null,
          },
          inventoryItem: {
            findFirst: async () => ({}),
          },
          inventoryLocation: {
            findUnique: async () => null,
          },
        } as never),
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: handlers,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "writer-1",
          kind: "api-key",
          name: "Writer",
        },
        permissions: ["inventory:write"],
      }),
    });
    const request = (path: string, body: Record<string, unknown>) =>
      app.request(path, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `missing-target-${path}`,
        },
        method: "POST",
      });

    const missingSourceLocation = await request(
      "/api/v1/inventory-items/item-1/move-units",
      {
        sourceLocationId: "missing-location",
        quantity: 1,
      },
    );
    const missingRemovalContainer = await request(
      "/api/v1/inventory-items/item-1/remove-units",
      {
        containerId: "missing-container",
        quantity: 1,
      },
    );

    expect(missingSourceLocation.status).toBe(404);
    expect(await missingSourceLocation.json()).toEqual({
      code: "INVENTORY_LOCATION_NOT_FOUND",
      message: "Inventory Location was not found.",
    });
    expect(missingRemovalContainer.status).toBe(404);
    expect(await missingRemovalContainer.json()).toEqual({
      code: "INVENTORY_CONTAINER_NOT_FOUND",
      message: "Container was not found.",
    });
  });
});

describe("Remedy Intake command handlers", () => {
  it("normalizes, records, and replays one intake without changing Inventory", async () => {
    const now = new Date("2026-08-03T22:15:00.000Z");
    const testDatabase = remedyIntakeCommandTestDatabase();
    const handlers = createInventoryItemsRouteHandlers({
      now: () => now,
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const command = {
      clientId: "health-client",
      idempotencyKey: "create-intake-1",
      operation: "createRemedyIntake" as const,
      request: {
        note: "  Before bed.  ",
        potency: " 200c ",
        itemId: " item-remedy ",
      },
    };

    const first = await handlers.createRemedyIntake(command);
    const replay = await handlers.createRemedyIntake(command);

    expect(first).toEqual(replay);
    expect(first.intake).toEqual({
      id: "intake-1",
      note: "Before bed.",
      occurredAt: now.toISOString(),
      potency: "200C",
      itemArchivedAt: null,
      itemId: "item-remedy",
      itemTitle: "Arsenicum album",
    });
    expect(testDatabase.intakes.size).toBe(1);
    expect(testDatabase.intakeCreates).toEqual([
      {
        notes: "Before bed.",
        occurredAt: now,
        potency: "200C",
        substanceId: "substance-remedy",
      },
    ]);
    expect(testDatabase.inventoryWrites).toBe(0);
  });

  it("rejects archived, inactive, and unowned-potency intake creation", async () => {
    const testDatabase = remedyIntakeCommandTestDatabase();
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const create = (idempotencyKey: string, potency = "30C") =>
      handlers.createRemedyIntake({
        clientId: "health-client",
        idempotencyKey,
        operation: "createRemedyIntake",
        request: { potency, itemId: "item-remedy" },
      });

    await expect(create("unowned-potency", "1M")).rejects.toThrow(
      "Remedy Intake potency must match one owned remedy potency.",
    );

    testDatabase.item.archivedAt = new Date("2026-08-03T23:00:00.000Z");
    await expect(create("archived-remedy")).rejects.toThrow(
      "Remedy Intake requires an active owned remedy.",
    );

    testDatabase.item.archivedAt = null;
    testDatabase.item.remedyProfile.substance.isActive = false;
    await expect(create("inactive-substance")).rejects.toThrow(
      "Remedy Intake requires an active owned remedy.",
    );
    expect(testDatabase.intakes.size).toBe(0);
    expect(testDatabase.inventoryWrites).toBe(0);
  });

  it("deletes only a linked Remedy Intake and safely replays deletion", async () => {
    const testDatabase = remedyIntakeCommandTestDatabase({
      existingIntake: true,
    });
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const command = {
      clientId: "health-client",
      idempotencyKey: "delete-intake-1",
      intakeId: "intake-existing",
      operation: "deleteRemedyIntake" as const,
    };

    const first = await handlers.deleteRemedyIntake(command);
    const replay = await handlers.deleteRemedyIntake(command);

    expect(first).toEqual({ deletedIntakeId: "intake-existing" });
    expect(replay).toEqual(first);
    expect(testDatabase.intakes.size).toBe(0);
    expect(testDatabase.intakeDeletes).toEqual(["intake-existing"]);
    expect(testDatabase.inventoryWrites).toBe(0);

    await expect(
      handlers.deleteRemedyIntake({
        ...command,
        idempotencyKey: "delete-intake-2",
      }),
    ).rejects.toThrow("Remedy Intake was not found.");
  });
});

describe("Inventory Clothing command handlers", () => {
  it("records and safely undoes one wear confirmation with replay", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: false });
    const testDatabase = clothingCommandTestDatabase([shirt]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const command = {
      clientId: "writer-1",
      idempotencyKey: "wear-shirt-1",
      operation: "markInventoryClothingItemWorn" as const,
      itemId: shirt.id,
    };

    const first = await handlers.markClothingItemWorn(command);
    const replay = await handlers.markClothingItemWorn(command);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      item: {
        clothingProfile: { isDirty: true },
        id: shirt.id,
      },
      wearConfirmation: {
        itemIds: [shirt.id],
        undoneAt: null,
      },
    });
    expect(testDatabase.confirmations.size).toBe(1);
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 1,
    });

    await expect(
      handlers.markClothingItemWorn({
        ...command,
        idempotencyKey: "wear-shirt-2",
      }),
    ).rejects.toThrow("All owned units of this Clothing Item are already dirty.");
    expect(testDatabase.confirmations.size).toBe(1);

    const undoCommand = {
      clientId: "writer-1",
      confirmationId: first.wearConfirmation.id,
      idempotencyKey: "undo-shirt-1",
      operation: "undoInventoryClothingWearConfirmation" as const,
    };
    const undone = await handlers.undoClothingWearConfirmation(undoCommand);
    const undoReplay = await handlers.undoClothingWearConfirmation(undoCommand);

    expect(undone).toEqual(undoReplay);
    expect(undone).toMatchObject({
      items: [
        {
          clothingProfile: { isDirty: false },
          id: shirt.id,
        },
      ],
      wearConfirmation: {
        id: first.wearConfirmation.id,
        itemIds: [shirt.id],
      },
    });
    expect(undone.wearConfirmation.undoneAt).not.toBeNull();
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: false,
      wearStateVersion: 2,
    });
  });

  it("tracks clean and dirty units independently for multi-unit clothing", async () => {
    const shirts = clothingPrismaItem("item-shirts", {
      isDirty: false,
      quantity: 2,
    });
    const testDatabase = clothingCommandTestDatabase([shirts]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    await handlers.markClothingItemWorn({
      clientId: "writer-1",
      idempotencyKey: "wear-shirts-1",
      operation: "markInventoryClothingItemWorn",
      itemId: shirts.id,
    });

    expect(shirts.clothingProfile).toMatchObject({
      dirtyQuantity: 1,
      isDirty: true,
    });

    await handlers.markClothingItemWorn({
      clientId: "writer-1",
      idempotencyKey: "wear-shirts-2",
      operation: "markInventoryClothingItemWorn",
      itemId: shirts.id,
    });

    expect(shirts.clothingProfile).toMatchObject({ dirtyQuantity: 2 });
    await expect(
      handlers.markClothingItemWorn({
        clientId: "writer-1",
        idempotencyKey: "wear-shirts-3",
        operation: "markInventoryClothingItemWorn",
        itemId: shirts.id,
      }),
    ).rejects.toThrow("All owned units");

    const laundry = await handlers.completeClothingLaundry({
      clientId: "writer-1",
      idempotencyKey: "laundry-shirts-1",
      operation: "completeInventoryClothingLaundry",
      request: { mode: "selected", itemIds: [shirts.id] },
    });

    expect(laundry.cleanedCount).toBe(1);
    expect(shirts.clothingProfile).toMatchObject({
      dirtyQuantity: 1,
      isDirty: true,
    });
  });

  it("refuses undo after later manual Clothing Wear State transitions", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: false });
    const testDatabase = clothingCommandTestDatabase([shirt]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const worn = await handlers.markClothingItemWorn({
      clientId: "writer-1",
      idempotencyKey: "wear-before-correction",
      operation: "markInventoryClothingItemWorn",
      itemId: shirt.id,
    });

    await handlers.updateClothingProfile({
      clientId: "writer-1",
      idempotencyKey: "correct-clean",
      operation: "updateInventoryClothingProfile",
      itemId: shirt.id,
      request: {
        attributes: { version: 1 },
        isDirty: false,
      },
    });
    await handlers.updateClothingProfile({
      clientId: "writer-1",
      idempotencyKey: "correct-dirty",
      operation: "updateInventoryClothingProfile",
      itemId: shirt.id,
      request: {
        attributes: { version: 1 },
        isDirty: true,
      },
    });

    expect(shirt.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 3,
    });
    await expect(
      handlers.undoClothingWearConfirmation({
        clientId: "writer-1",
        confirmationId: worn.wearConfirmation.id,
        idempotencyKey: "undo-after-correction",
        operation: "undoInventoryClothingWearConfirmation",
      }),
    ).rejects.toThrow(
      "Clothing Wear Confirmation can no longer be safely undone.",
    );
  });

  it("restores a linked recommendation to published when undo stays safe", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: true });
    shirt.clothingProfile!.wearStateVersion = 1;
    const testDatabase = clothingCommandTestDatabase([shirt], {
      recommendation: {
        id: "recommendation-1",
        status: "WORN",
      },
    });
    const confirmationId = "wear-1";

    testDatabase.confirmations.set(confirmationId, {
      confirmedByClientId: "writer-1",
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
      id: confirmationId,
      items: [
        {
          confirmationId,
          createdAt: new Date("2026-08-03T10:00:00.000Z"),
          itemId: shirt.id,
          wearStateVersionAfter: 1,
        },
      ],
      recommendationId: "recommendation-1",
      recommendationOptionId: "option-primary",
      undoneAt: null,
      undoneByClientId: null,
      updatedAt: new Date("2026-08-03T10:00:00.000Z"),
    });
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    const result = await handlers.undoClothingWearConfirmation({
      clientId: "writer-1",
      confirmationId,
      idempotencyKey: "undo-linked-recommendation-1",
      operation: "undoInventoryClothingWearConfirmation",
    });

    expect(result.wearConfirmation.id).toBe(confirmationId);
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: false,
      wearStateVersion: 2,
    });
    expect(
      testDatabase.recommendations.get("recommendation-1")?.status,
    ).toBe("PUBLISHED");
  });

  it("refuses linked undo when a newer recommendation owns the daily slot", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: true });
    shirt.clothingProfile!.wearStateVersion = 1;
    const testDatabase = clothingCommandTestDatabase([shirt], {
      recommendation: {
        id: "recommendation-worn",
        status: "WORN",
      },
    });
    const confirmationId = "wear-linked";

    testDatabase.recommendations.set("recommendation-new", {
      eventLabel: null,
      eventStartsAt: null,
      id: "recommendation-new",
      kind: "DAILY",
      status: "PUBLISHED",
      targetDate: new Date("2026-08-03T00:00:00.000Z"),
    });
    testDatabase.confirmations.set(confirmationId, {
      confirmedByClientId: "writer-1",
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
      id: confirmationId,
      items: [
        {
          confirmationId,
          createdAt: new Date("2026-08-03T10:00:00.000Z"),
          itemId: shirt.id,
          wearStateVersionAfter: 1,
        },
      ],
      recommendationId: "recommendation-worn",
      recommendationOptionId: "option-primary",
      undoneAt: null,
      undoneByClientId: null,
      updatedAt: new Date("2026-08-03T10:00:00.000Z"),
    });
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    await expect(
      handlers.undoClothingWearConfirmation({
        clientId: "writer-1",
        confirmationId,
        idempotencyKey: "undo-linked-slot-conflict",
        operation: "undoInventoryClothingWearConfirmation",
      }),
    ).rejects.toThrow(
      "Clothing Wear Confirmation can no longer be safely undone.",
    );
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 1,
    });
    expect(
      testDatabase.recommendations.get("recommendation-worn")?.status,
    ).toBe("WORN");
    expect(testDatabase.confirmations.get(confirmationId)?.undoneAt).toBeNull();
  });

  it("refuses linked undo when a newer recommendation owns the event slot", async () => {
    const blazer = clothingPrismaItem("item-blazer", { isDirty: true });
    blazer.clothingProfile!.wearStateVersion = 1;
    const testDatabase = clothingCommandTestDatabase([blazer], {
      recommendation: {
        eventLabel: "Board dinner",
        eventStartsAt: new Date("2026-08-04T19:00:00.000Z"),
        id: "recommendation-event-worn",
        kind: "EVENT",
        status: "WORN",
        targetDate: new Date("2026-08-04T00:00:00.000Z"),
      },
    });
    const confirmationId = "wear-event";

    testDatabase.recommendations.set("recommendation-event-new", {
      eventLabel: "Board dinner",
      eventStartsAt: new Date("2026-08-04T19:00:00.000Z"),
      id: "recommendation-event-new",
      kind: "EVENT",
      status: "PUBLISHED",
      targetDate: new Date("2026-08-04T00:00:00.000Z"),
    });
    testDatabase.confirmations.set(confirmationId, {
      confirmedByClientId: "writer-1",
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
      id: confirmationId,
      items: [
        {
          confirmationId,
          createdAt: new Date("2026-08-03T10:00:00.000Z"),
          itemId: blazer.id,
          wearStateVersionAfter: 1,
        },
      ],
      recommendationId: "recommendation-event-worn",
      recommendationOptionId: "option-primary",
      undoneAt: null,
      undoneByClientId: null,
      updatedAt: new Date("2026-08-03T10:00:00.000Z"),
    });
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    await expect(
      handlers.undoClothingWearConfirmation({
        clientId: "writer-1",
        confirmationId,
        idempotencyKey: "undo-linked-event-slot-conflict",
        operation: "undoInventoryClothingWearConfirmation",
      }),
    ).rejects.toThrow(
      "Clothing Wear Confirmation can no longer be safely undone.",
    );
    expect(blazer.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 1,
    });
    expect(
      testDatabase.recommendations.get("recommendation-event-worn")?.status,
    ).toBe("WORN");
    expect(testDatabase.confirmations.get(confirmationId)?.undoneAt).toBeNull();
  });

  it("cleans selected Clothing Items and refuses stale wear undo", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: false });
    const trousers = clothingPrismaItem("item-trousers", { isDirty: false });
    const testDatabase = clothingCommandTestDatabase([shirt, trousers]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });
    const worn = await handlers.markClothingItemWorn({
      clientId: "writer-1",
      idempotencyKey: "wear-shirt",
      operation: "markInventoryClothingItemWorn",
      itemId: shirt.id,
    });

    const laundry = await handlers.completeClothingLaundry({
      clientId: "writer-1",
      idempotencyKey: "laundry-selected",
      operation: "completeInventoryClothingLaundry",
      request: {
        mode: "selected",
        itemIds: [trousers.id, shirt.id, shirt.id],
      },
    });

    expect(laundry.cleanedCount).toBe(1);
    expect(laundry.items.map(({ id }) => id)).toEqual([
      shirt.id,
      trousers.id,
    ]);
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: false,
      wearStateVersion: 2,
    });
    expect(trousers.clothingProfile).toMatchObject({
      isDirty: false,
      wearStateVersion: 0,
    });
    await expect(
      handlers.undoClothingWearConfirmation({
        clientId: "writer-1",
        confirmationId: worn.wearConfirmation.id,
        idempotencyKey: "undo-after-laundry",
        operation: "undoInventoryClothingWearConfirmation",
      }),
    ).rejects.toThrow(
      "Clothing Wear Confirmation can no longer be safely undone.",
    );
  });

  it("validates every selected laundry Item before changing state", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: true });
    const book = clothingPrismaItem("item-book", {
      category: "generic",
      isDirty: null,
    });
    const testDatabase = clothingCommandTestDatabase([shirt, book]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    await expect(
      handlers.completeClothingLaundry({
        clientId: "writer-1",
        idempotencyKey: "laundry-mixed",
        operation: "completeInventoryClothingLaundry",
        request: {
          mode: "selected",
          itemIds: [shirt.id, book.id],
        },
      }),
    ).rejects.toThrow("Laundry supports Clothing Items only.");
    expect(shirt.clothingProfile).toMatchObject({
      isDirty: true,
      wearStateVersion: 0,
    });
  });

  it("cleans all and only active dirty Clothing Items", async () => {
    const shirt = clothingPrismaItem("item-shirt", { isDirty: true });
    const trousers = clothingPrismaItem("item-trousers", { isDirty: false });
    const archivedCoat = clothingPrismaItem("item-coat", {
      archivedAt: new Date("2026-08-03T08:00:00.000Z"),
      isDirty: true,
    });
    const book = clothingPrismaItem("item-book", {
      category: "generic",
      isDirty: null,
    });
    const testDatabase = clothingCommandTestDatabase([
      shirt,
      trousers,
      archivedCoat,
      book,
    ]);
    const handlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
      runCommand: replayingTestCommandRunner(testDatabase.transaction),
    });

    const laundry = await handlers.completeClothingLaundry({
      clientId: "writer-1",
      idempotencyKey: "laundry-all-dirty",
      operation: "completeInventoryClothingLaundry",
      request: { mode: "all-dirty" },
    });

    expect(laundry.cleanedCount).toBe(1);
    expect(laundry.items.map(({ id }) => id)).toEqual([shirt.id]);
    expect(shirt.clothingProfile?.isDirty).toBe(false);
    expect(trousers.clothingProfile?.isDirty).toBe(false);
    expect(archivedCoat.clothingProfile?.isDirty).toBe(true);
    expect(book.clothingProfile).toBeNull();
  });
});

describe("Inventory Item lifecycle handlers", () => {
  it("keeps archive and restore idempotent and deletes associated files once", async () => {
    const archivedAt = new Date("2026-07-28T12:00:00.000Z");
    const items = new Map<string, Date | null>([
      ["item-active", null],
      ["item-archived", new Date("2026-07-27T12:00:00.000Z")],
    ]);
    const cleanedFiles: string[][] = [];
    const repository = createMemoryRepository(items);
    const handlers = createInventoryItemsRouteHandlers({
      deleteStoredFiles: async (filePaths) => {
        cleanedFiles.push([...filePaths]);
        return [];
      },
      now: () => archivedAt,
      repository,
    });

    expect(await handlers.archiveItem("item-active")).toEqual({
      archivedAt: archivedAt.toISOString(),
      id: "item-active",
    });
    expect(await handlers.archiveItem("item-active")).toEqual({
      archivedAt: archivedAt.toISOString(),
      id: "item-active",
    });
    expect(await handlers.restoreItem("item-active")).toEqual({
      archivedAt: null,
      id: "item-active",
    });
    expect(await handlers.restoreItem("item-active")).toEqual({
      archivedAt: null,
      id: "item-active",
    });
    expect(await handlers.deleteItem("item-archived")).toEqual({
      deletedItemId: "item-archived",
    });
    expect(cleanedFiles).toEqual([
      [
        "/uploads/images/item-archived.jpg",
        "/uploads/audio/item-archived.m4a",
        "/uploads/assets/item-archived.pdf",
      ],
    ]);
  });

  it("returns stable HTTP 404 responses for missing and repeated deletes", async () => {
    const items = new Map<string, Date | null>([["item-1", null]]);
    const handlers = createInventoryItemsRouteHandlers({
      deleteStoredFiles: async () => [],
      repository: createMemoryRepository(items),
    });
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: handlers,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "delete-client",
          kind: "api-key",
          name: "Delete client",
        },
        permissions: ["inventory:delete", "inventory:write"],
      }),
    });

    const deleted = await app.request("/api/v1/inventory-items/item-1", {
      method: "DELETE",
    });
    const repeated = await app.request("/api/v1/inventory-items/item-1", {
      method: "DELETE",
    });
    const missingArchive = await app.request(
      "/api/v1/inventory-items/missing/archive",
      { method: "POST" },
    );

    expect(deleted.status).toBe(200);
    expect(repeated.status).toBe(404);
    expect(await repeated.json()).toEqual({
      code: "NOT_FOUND",
      message: "Inventory Item not found.",
    });
    expect(missingArchive.status).toBe(404);
    expect(await missingArchive.json()).toEqual({
      code: "NOT_FOUND",
      message: "Inventory Item not found.",
    });
  });

  it("returns 409 when permanent remedy deletion would erase intake history", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: {
        ...createInventoryItemsRouteHandlers({
          repository: createMemoryRepository(new Map()),
        }),
        deleteItem: async () => {
          throw new Error("Remedy Intake history blocks permanent deletion.");
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "delete-client",
          kind: "api-key",
          name: "Delete client",
        },
        permissions: ["inventory:delete", "inventory:write"],
      }),
    });

    const response = await app.request("/api/v1/inventory-items/item-remedy", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "REMEDY_HAS_INTAKE_HISTORY",
      message: "Remedy Intake history blocks permanent deletion.",
    });
  });

  it("does not remove stored files when database deletion rolls back", async () => {
    let cleanupCalls = 0;
    const repository = createMemoryRepository(
      new Map<string, Date | null>([["item-1", null]]),
    );
    repository.deleteItem = async () => {
      throw new Error("database rollback");
    };
    const handlers = createInventoryItemsRouteHandlers({
      deleteStoredFiles: async () => {
        cleanupCalls += 1;
        return [];
      },
      repository,
    });

    await expect(handlers.deleteItem("item-1")).rejects.toThrow(
      "database rollback",
    );
    expect(cleanupCalls).toBe(0);
  });

  it("includes the Item path in Placement idempotency input", async () => {
    const idempotentRequests: Record<string, unknown>[] = [];
    const handlers = createInventoryItemsRouteHandlers({
      createMutationRepository: () =>
        inventoryMutationRepository({
          addInventoryUnits: async (input: { itemId: string }) =>
            inventoryItemRecord(input.itemId),
          moveInventoryUnits: async (input: { itemId: string }) =>
            inventoryItemRecord(input.itemId),
          removeInventoryUnits: async (input: { itemId: string }) =>
            inventoryItemRecord(input.itemId),
        }),
      repository: createMemoryRepository(new Map()),
      runCommand: async (input) => {
        idempotentRequests.push(input.request);
        return input.execute({} as never);
      },
    });

    await handlers.addUnits({
      clientId: "writer-1",
      idempotencyKey: "add-1",
      operation: "addInventoryItemUnits",
      itemId: "item-add",
      request: { locationId: "location-a", quantity: 1 },
    });
    await handlers.moveUnits({
      clientId: "writer-1",
      idempotencyKey: "move-1",
      operation: "moveInventoryItemUnits",
      itemId: "item-move",
      request: {
        destinationContainerId: "container-b",
        quantity: 1,
        sourceLocationId: "location-a",
      },
    });
    await handlers.removeUnits({
      clientId: "writer-1",
      idempotencyKey: "remove-1",
      operation: "removeInventoryItemUnits",
      itemId: "item-remove",
      request: { quantity: 1 },
    });

    expect(idempotentRequests).toEqual([
      {
        containerId: null,
        locationId: "location-a",
        note: null,
        itemId: "item-add",
        quantity: 1,
      },
      {
        destinationContainerId: "container-b",
        destinationLocationId: null,
        itemId: "item-move",
        quantity: 1,
        sourceContainerId: null,
        sourceLocationId: "location-a",
      },
      {
        containerId: null,
        locationId: null,
        itemId: "item-remove",
        quantity: 1,
      },
    ]);
  });

  it("archives the item when removing its final units", async () => {
    const archivedAt = new Date("2026-07-29T12:00:00.000Z");
    const archiveWrites: Array<{ archivedAt: Date | null; id: string }> = [];
    let idempotentRequest: Record<string, unknown> | undefined;
    const handlers = createInventoryItemsRouteHandlers({
      createMutationRepository: () =>
        inventoryMutationRepository({
          removeInventoryUnits: async () =>
            inventoryItemRecord("item-1", {
              placements: [],
              totalQuantity: 0,
            }),
          reorderInventoryItemImages: async () => {
            throw new Error("not used");
          },
          setItemArchivedAt: async (id: string, value: Date | null) => {
            archiveWrites.push({ archivedAt: value, id });
            return inventoryItemRecord(id, {
              archivedAt: value,
              placements: [],
              totalQuantity: 0,
            });
          },
        }),
      now: () => archivedAt,
      repository: createMemoryRepository(new Map()),
      runCommand: async (input) => {
        idempotentRequest = input.request;
        return input.execute({} as never);
      },
    });

    expect(
      await handlers.removeUnits({
        clientId: "writer-1",
        idempotencyKey: "remove-final-unit",
        operation: "removeInventoryItemUnits",
        itemId: "item-1",
        request: {
          containerId: "container-1",
          quantity: 1,
        },
      }),
    ).toMatchObject({
      item: {
        archivedAt: archivedAt.toISOString(),
        id: "item-1",
        placements: [],
        title: "Travel pouch",
        totalQuantity: 0,
      },
    });
    expect(archiveWrites).toEqual([
      { archivedAt, id: "item-1" },
    ]);
    expect(idempotentRequest).toEqual({
      containerId: "container-1",
      locationId: null,
      itemId: "item-1",
      quantity: 1,
    });
  });

  it("returns 200 for queued retries and 409 for active equivalent work", async () => {
    const baseHandlers = createInventoryItemsRouteHandlers({
      repository: createMemoryRepository(new Map()),
    });
    const item = mapInventoryItem({
      category: null,
      archivedAt: null,
      captureText: "Travel pouch",
      containerId: null,
      containerLabel: null,
      id: "item-1",
      importance: "MEDIUM",
      images: [],
      kind: "ITEM",
      locationId: null,
      locationName: null,
      note: null,
      placements: [],
      searchText: "travel pouch",
      status: "KEEP",
      tags: [],
      title: "Travel pouch",
      totalQuantity: 0,
    });
    const handlers = {
      ...baseHandlers,
      retryEnrichment: async () => {
        throw new InventoryEnrichmentRetryConflictError(
          "Equivalent Inventory enrichment is already queued or processing.",
        );
      },
      retryPreprocessing: async () => ({ item }),
    };
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItems: handlers,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "retry-client",
          kind: "api-key",
          name: "Retry client",
        },
        permissions: ["inventory:write"],
      }),
    });

    const queued = await app.request(
      "/api/v1/inventory-items/item-1/retry-preprocessing",
      {
        headers: { "Idempotency-Key": "retry-pre-1" },
        method: "POST",
      },
    );
    const conflict = await app.request(
      "/api/v1/inventory-items/item-1/retry-enrichment",
      {
        headers: { "Idempotency-Key": "retry-enrich-1" },
        method: "POST",
      },
    );

    expect(queued.status).toBe(200);
    expect(
      ((await queued.json()) as { item: { id: string } }).item.id,
    ).toBe("item-1");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      code: "INVENTORY_PROCESSING_RETRY_CONFLICT",
      message:
        "Equivalent Inventory enrichment is already queued or processing.",
    });
  });
});

function createMemoryRepository(
  items: Map<string, Date | null>,
): InventoryItemsRepository {
  return {
    async deleteItem(id) {
      if (!items.has(id)) {
        return null;
      }

      const archivedAt = items.get(id) ?? null;
      items.delete(id);

      return {
        archivedAt,
        assets: [{ filePath: `/uploads/assets/${id}.pdf` }],
        audioNotes: [{ filePath: `/uploads/audio/${id}.m4a` }],
        id,
        images: [{ filePath: `/uploads/images/${id}.jpg` }],
      };
    },
    async findItemLifecycle(id) {
      return items.has(id)
        ? {
            archivedAt: items.get(id) ?? null,
            id,
          }
        : null;
    },
    async transitionItemLifecycle(id, input) {
      if (!items.has(id)) {
        return null;
      }

      const currentArchivedAt = items.get(id) ?? null;
      const matchesExpectedState = input.expectedState === "archived"
        ? currentArchivedAt !== null
        : currentArchivedAt === null;

      if (matchesExpectedState) {
        items.set(id, input.archivedAt);
      }

      return {
        archivedAt: items.get(id) ?? null,
        id,
      };
    },
  };
}

function inventoryItemRecord(
  id: string,
  overrides: Partial<InventoryItemRecord> = {},
): InventoryItemRecord {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    assets: [],
    audioNotes: [],
    captureSessionId: null,
    captureText: null,
    capturedAt: new Date("2026-07-28T12:00:00.000Z"),
    category: null,
    container: null,
    containerId: null,
    containerLabel: null,
    costCents: null,
    costCurrency: "CAD",
    id,
    images: [],
    importance: "MEDIUM",
    kind: "ITEM",
    locationId: null,
    locationName: null,
    metadata: {},
    note: null,
    originLocationId: null,
    originLocationName: null,
    placements: [],
    searchText: "",
    status: "KEEP",
    tags: [],
    title: "Travel pouch",
    totalQuantity: 1,
    ...overrides,
  };
}

function inventoryMutationRepository(
  overrides: Record<string, unknown> = {},
) {
  const notUsed = async () => {
    throw new Error("not used");
  };

  return {
    addInventoryUnits: notUsed,
    createItem: notUsed,
    deleteItem: notUsed,
    enqueueInventoryPreprocessingJobs: async () => [],
    findInventoryItems: notUsed,
    getActiveCaptureSession: notUsed,
    getCaptureSession: notUsed,
    getInventoryItem: async () => inventoryItemRecord("item-1"),
    listClaimableInventoryPreprocessingJobs: async () => [],
    listRecentItems: notUsed,
    moveInventoryUnits: notUsed,
    removeInventoryUnits: notUsed,
    reorderInventoryItemImages: notUsed,
    setItemArchivedAt: notUsed,
    updateInventoryPreprocessingJob: async (
      job: InventoryPreprocessingJobRecord,
    ) => job,
    updateItem: notUsed,
    upsertCaptureSession: notUsed,
    upsertLocation: notUsed,
    ...overrides,
  } as never;
}

function clothingPrismaItem(
  id: string,
  input: {
    archivedAt?: Date | null;
    category?: string;
    dirtyQuantity?: number;
    isDirty: boolean | null;
    quantity?: number;
  },
) {
  const timestamp = new Date("2026-08-03T09:00:00.000Z");
  const quantity = input.quantity ?? 1;

  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: input.archivedAt ?? null,
    assets: [],
    audioNotes: [],
    capturedAt: timestamp,
    captureSession: null,
    captureSessionId: null,
    captureText: null,
    category: input.category ?? "clothing",
    clothingProfile: input.isDirty === null
      ? null
      : {
          attributes: { version: 1 },
          createdAt: timestamp,
          dirtyQuantity: input.dirtyQuantity ?? (input.isDirty ? quantity : 0),
          isDirty: input.isDirty,
          itemId: id,
          updatedAt: timestamp,
          wearStateVersion: 0,
        },
    costCents: null,
    costCurrency: "CAD",
    createdAt: timestamp,
    id,
    images: [],
    importance: "MEDIUM",
    kind: "ITEM",
    metadata: {},
    note: null,
    placements: [
      {
        container: null,
        containerId: null,
        createdAt: timestamp,
        id: `${id}-placement`,
        itemId: id,
        location: null,
        locationId: null,
        note: null,
        quantity,
        updatedAt: timestamp,
      },
    ],
    searchText: id,
    status: "KEEP",
    tags: [],
    title: id,
    updatedAt: timestamp,
  };
}

function clothingCommandTestDatabase(
  items: Array<ReturnType<typeof clothingPrismaItem>>,
  options: {
    recommendation?: {
      eventLabel?: string | null;
      eventStartsAt?: Date | null;
      id: string;
      kind?: "DAILY" | "EVENT";
      status: "DECLINED" | "PUBLISHED" | "SUPERSEDED" | "WORN";
      targetDate?: Date;
    };
  } = {},
) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const recommendations = new Map<
    string,
    {
      eventLabel: string | null;
      eventStartsAt: Date | null;
      id: string;
      kind: "DAILY" | "EVENT";
      status: "DECLINED" | "PUBLISHED" | "SUPERSEDED" | "WORN";
      targetDate: Date;
    }
  >();
  const confirmations = new Map<
    string,
    {
      confirmedByClientId: string;
      createdAt: Date;
      id: string;
      items: Array<{
        confirmationId: string;
        createdAt: Date;
        itemId: string;
        wearStateVersionAfter: number;
      }>;
      recommendationId: string | null;
      recommendationOptionId: string | null;
      undoneAt: Date | null;
      undoneByClientId: string | null;
      updatedAt: Date;
    }
  >();
  let confirmationSequence = 0;

  if (options.recommendation) {
    recommendations.set(options.recommendation.id, {
      ...options.recommendation,
      eventLabel: options.recommendation.eventLabel ?? null,
      eventStartsAt: options.recommendation.eventStartsAt ?? null,
      kind: options.recommendation.kind ?? "DAILY",
      targetDate:
        options.recommendation.targetDate ??
        new Date("2026-08-03T00:00:00.000Z"),
    });
  }

  const processingJobs = {
    findMany: async () => [],
  };
  const transaction = {
    inventoryClothingProfile: {
      findMany: async (args: {
        where: { dirtyQuantity: { gt: number }; itemId: { in: string[] } };
      }) => args.where.itemId.in
        .map((id) => itemById.get(id))
        .filter(
          (item) =>
            (item?.clothingProfile?.dirtyQuantity ?? 0) >
            args.where.dirtyQuantity.gt,
        )
        .map((item) => ({
          dirtyQuantity: item!.clothingProfile!.dirtyQuantity,
          itemId: item!.id,
        })),
      update: async (args: {
        data: {
          attributes?: unknown;
          dirtyQuantity?: number | { decrement?: number; increment?: number };
          isDirty: boolean;
          wearStateVersion?: { increment: number };
        };
        where: { itemId: string };
      }) => {
        const profile = itemById.get(args.where.itemId)?.clothingProfile;

        if (!profile) {
          throw new Error("missing Clothing Profile");
        }

        profile.isDirty = args.data.isDirty;
        if (typeof args.data.dirtyQuantity === "number") {
          profile.dirtyQuantity = args.data.dirtyQuantity;
        } else {
          profile.dirtyQuantity += args.data.dirtyQuantity?.increment ?? 0;
          profile.dirtyQuantity -= args.data.dirtyQuantity?.decrement ?? 0;
        }
        profile.wearStateVersion += args.data.wearStateVersion?.increment ?? 0;
        profile.updatedAt = new Date("2026-08-03T10:00:00.000Z");
        return profile;
      },
      updateMany: async (args: {
        data: {
          dirtyQuantity: number;
          isDirty: boolean;
          wearStateVersion: { increment: number };
        };
        where: { dirtyQuantity: { gt: number }; itemId: { in: string[] } };
      }) => {
        let count = 0;

        for (const id of args.where.itemId.in) {
          const profile = itemById.get(id)?.clothingProfile;

          if (
            !profile ||
            profile.dirtyQuantity <= args.where.dirtyQuantity.gt
          ) {
            continue;
          }

          profile.dirtyQuantity = args.data.dirtyQuantity;
          profile.isDirty = args.data.isDirty;
          profile.wearStateVersion += args.data.wearStateVersion.increment;
          profile.updatedAt = new Date("2026-08-03T10:00:00.000Z");
          count += 1;
        }

        return { count };
      },
    },
    inventoryClothingWearConfirmation: {
      create: async (args: {
        data: {
          confirmedByClientId: string;
          items: {
            create: { itemId: string; wearStateVersionAfter: number };
          };
        };
      }) => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const id = `wear-${++confirmationSequence}`;
        const confirmation = {
          confirmedByClientId: args.data.confirmedByClientId,
          createdAt,
          id,
          items: [
            {
              confirmationId: id,
              createdAt,
              ...args.data.items.create,
            },
          ],
          recommendationId: null,
          recommendationOptionId: null,
          undoneAt: null,
          undoneByClientId: null,
          updatedAt: createdAt,
        };

        confirmations.set(id, confirmation);
        return confirmation;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const confirmation = confirmations.get(args.where.id);

        return confirmation
          ? {
              ...confirmation,
              items: confirmation.items.map((item) => ({
                ...item,
                item: itemById.get(item.itemId),
              })),
              recommendation: confirmation.recommendationId
                ? recommendations.get(confirmation.recommendationId) ?? null
                : null,
            }
          : null;
      },
      update: async (args: {
        data: { undoneAt: Date; undoneByClientId: string };
        where: { id: string };
      }) => {
        const confirmation = confirmations.get(args.where.id);

        if (!confirmation) {
          throw new Error("missing Wear Confirmation");
        }

        confirmation.undoneAt = args.data.undoneAt;
        confirmation.undoneByClientId = args.data.undoneByClientId;
        confirmation.updatedAt = args.data.undoneAt;
        return confirmation;
      },
    },
    inventoryClothingRecommendation: {
      findFirst: async (args: {
        where: {
          id: { not: string };
          eventLabel?: string | null;
          eventStartsAt?: Date | null;
          kind: "DAILY" | "EVENT";
          status: "PUBLISHED";
          targetDate?: Date;
        };
      }) =>
        [...recommendations.values()].find(
          (recommendation) =>
            recommendation.id !== args.where.id.not &&
            recommendation.kind === args.where.kind &&
            recommendation.status === args.where.status &&
            (args.where.kind === "DAILY"
              ? recommendation.targetDate.getTime() ===
                args.where.targetDate?.getTime()
              : recommendation.eventLabel === args.where.eventLabel &&
                recommendation.eventStartsAt?.getTime() ===
                  args.where.eventStartsAt?.getTime()),
        ) ?? null,
      update: async (args: {
        data: {
          status: "DECLINED" | "PUBLISHED" | "SUPERSEDED" | "WORN";
        };
        where: { id: string };
      }) => {
        const recommendation = recommendations.get(args.where.id);

        if (!recommendation) {
          throw new Error("missing recommendation");
        }

        recommendation.status = args.data.status;
        return recommendation;
      },
    },
    inventoryEnrichmentJob: processingJobs,
    inventoryItem: {
      findFirst: async (args: { where: { archivedAt: null; id: string } }) => {
        const item = itemById.get(args.where.id);

        return item?.archivedAt === null ? item : null;
      },
      findMany: async (args: {
        where: {
          archivedAt: null;
          category?: string;
          clothingProfile?: { is: { dirtyQuantity: { gt: number } } };
          id?: { in: string[] };
        };
      }) => items.filter((item) =>
        item.archivedAt === null &&
        (!args.where.category || item.category === args.where.category) &&
        (!args.where.id || args.where.id.in.includes(item.id)) &&
        (!args.where.clothingProfile ||
          (item.clothingProfile?.dirtyQuantity ?? 0) >
            args.where.clothingProfile.is.dirtyQuantity.gt)
      ),
      findUnique: async (args: { where: { id: string } }) =>
        itemById.get(args.where.id) ?? null,
    },
    inventoryPreprocessingJob: processingJobs,
  };

  return {
    confirmations,
    recommendations,
    transaction: transaction as never,
  };
}

function remedyIntakeCommandTestDatabase(
  options: { existingIntake?: boolean } = {},
) {
  const item = {
    archivedAt: null as Date | null,
    captureText: null,
    category: "homeopathy",
    id: "item-remedy",
    remedyProfile: {
      potencies: ["30C", "200C"],
      substance: {
        id: "substance-remedy",
        isActive: true,
      },
    },
    title: "Arsenicum album",
  };
  const intakes = new Map<
    string,
    {
      id: string;
      notes: string | null;
      occurredAt: Date;
      potency: string | null;
      substance: { remedyProfile: { itemId: string } | null };
    }
  >();
  const intakeCreates: Array<{
    notes: string | null;
    occurredAt: Date;
    potency: string;
    substanceId: string;
  }> = [];
  const intakeDeletes: string[] = [];
  let inventoryWrites = 0;

  if (options.existingIntake) {
    intakes.set("intake-existing", {
      id: "intake-existing",
      notes: "Incorrect record.",
      occurredAt: new Date("2026-08-03T20:00:00.000Z"),
      potency: "30C",
      substance: {
        remedyProfile: { itemId: item.id },
      },
    });
  }

  const transaction = {
    inventoryItem: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === item.id ? item : null,
      update: async () => {
        inventoryWrites += 1;
        throw new Error("Remedy Intake must not update Inventory.");
      },
      updateMany: async () => {
        inventoryWrites += 1;
        throw new Error("Remedy Intake must not update Inventory.");
      },
    },
    substanceIntake: {
      create: async (args: {
        data: {
          notes: string | null;
          occurredAt: Date;
          potency: string;
          substanceId: string;
        };
      }) => {
        intakeCreates.push(args.data);
        const id = `intake-${intakes.size + 1}`;
        const intake = {
          id,
          notes: args.data.notes,
          occurredAt: args.data.occurredAt,
          potency: args.data.potency,
          substance: {
            remedyProfile: { itemId: item.id },
          },
        };
        intakes.set(id, intake);

        return intake;
      },
      delete: async (args: { where: { id: string } }) => {
        intakeDeletes.push(args.where.id);
        const intake = intakes.get(args.where.id);
        intakes.delete(args.where.id);
        return intake;
      },
      findUnique: async (args: { where: { id: string } }) =>
        intakes.get(args.where.id) ?? null,
    },
  };

  return {
    get inventoryWrites() {
      return inventoryWrites;
    },
    intakeCreates,
    intakeDeletes,
    intakes,
    item,
    transaction: transaction as never,
  };
}

function replayingTestCommandRunner(transaction: never) {
  const results = new Map<string, unknown>();

  return (async (input) => {
    const key = `${input.clientId}:${input.operation}:${input.idempotencyKey}`;
    const replay = results.get(key);

    if (replay) {
      return replay as never;
    }

    const result = await input.execute(transaction);
    results.set(key, result);
    return result;
  }) as NonNullable<
    Parameters<typeof createInventoryItemsRouteHandlers>[0]
  >["runCommand"];
}
