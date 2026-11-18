import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { Context } from "hono";
import type {
  InventoryContainer,
  InventoryContainerVisualBoundsOverride,
  InventoryItem,
  InventoryItemAsset,
  InventoryItemAudio,
  InventoryItemImage,
  InventoryItemPlacement,
  InventoryLocation,
  Prisma,
} from "@quantself/db/generated/prisma/client";
import {
  buildInventoryItemSearchTextForContainer,
  buildInventoryItemSearchText,
  createInventoryContainer as createInventoryContainerService,
  deleteInventoryContainer as deleteInventoryContainerService,
  moveInventoryItems,
  normalizeInventoryContainerReferenceId,
  normalizeInventoryLocationName,
  type InventoryContainerRecord,
  type InventoryContainerRepository,
  type InventoryRelocationRepository,
  type InventoryContainerSummary,
  type InventoryContainerVisualPresetRecord,
  type InventoryItemRecord,
  type InventoryLocationRecord,
} from "./inventory-service";
import {
  getDefaultInventoryContainerVisualCatalogEntry,
  getInventoryContainerVisualCatalogEntry,
  INVENTORY_CONTAINER_VISUAL_KEYS,
  isInventoryContainerVisualBounds,
  listInventoryContainerVisualCatalog,
  type InventoryContainerVisualBounds,
  type InventoryContainerVisualKey,
} from "../../web/lib/inventory-container-visual-catalog";
import {
  authorizationErrorSchema,
  jsonAuthorizationFailure,
} from "./authorization-response";

type EditableInventoryContainerVisual = {
  bounds: InventoryContainerVisualBounds;
  defaultBounds: InventoryContainerVisualBounds;
  defaultHoverBounds: InventoryContainerVisualBounds;
  frontImageUrl: string;
  height: number;
  hoverBounds: InventoryContainerVisualBounds;
  key: InventoryContainerVisualKey;
  name: string;
  width: number;
};

const pointSchema = z
  .object({
    x: z.number().min(0).max(1).openapi({ example: 0.1856 }),
    y: z.number().min(0).max(1).openapi({ example: 0.1943 }),
  })
  .openapi("InventoryContainerVisualPoint");

const boundsSchema = z
  .tuple([pointSchema, pointSchema, pointSchema, pointSchema])
  .openapi("InventoryContainerVisualBounds");

const visualPresetKeySchema = z.enum(INVENTORY_CONTAINER_VISUAL_KEYS);

const apiFailureSchema = z
  .object({
    code: z
      .enum(["BAD_REQUEST", "CONFLICT", "IDEMPOTENCY_CONFLICT", "NOT_FOUND"])
      .openapi({ example: "CONFLICT" }),
    message: z
      .string()
      .min(1)
      .openapi({ example: "A container with that name already exists." }),
  })
  .openapi("ApiFailure");

const visualPresetSchema = z
  .object({
    backImageUrl: z.string().min(1).openapi({
      example: "/inventory/container-visual-catalog/39l/back.webp",
    }),
    bounds: boundsSchema,
    emptyImageUrl: z.string().min(1).openapi({
      example: "/inventory/container-visual-catalog/39l/empty.webp",
    }),
    frontImageUrl: z.string().min(1).openapi({
      example: "/inventory/container-visual-catalog/39l/front.webp",
    }),
    height: z.number().int().positive().openapi({ example: 857 }),
    hoverBounds: boundsSchema,
    id: visualPresetKeySchema.openapi({ example: "39L" }),
    isDefault: z.boolean().openapi({ example: false }),
    name: z.string().min(1).openapi({ example: "39L" }),
    shadowImageUrl: z.string().min(1).openapi({
      example: "/inventory/container-visual-catalog/39l/shadow.webp",
    }),
    width: z.number().int().positive().openapi({ example: 1456 }),
  })
  .openapi("InventoryContainerVisualPreset");

const visualPresetOptionSchema = z
  .object({
    id: visualPresetKeySchema.openapi({ example: "39L" }),
    isDefault: z.boolean().openapi({ example: false }),
    name: z.string().min(1).openapi({ example: "39L" }),
  })
  .openapi("InventoryContainerVisualPresetOption");

const editableVisualSchema = z
  .object({
    bounds: boundsSchema,
    defaultBounds: boundsSchema,
    defaultHoverBounds: boundsSchema,
    frontImageUrl: z.string().min(1).openapi({
      example: "/inventory/container-visual-catalog/39l/front.webp",
    }),
    height: z.number().int().positive().openapi({ example: 857 }),
    hoverBounds: boundsSchema,
    key: visualPresetKeySchema.openapi({ example: "39L" }),
    name: z.string().min(1).openapi({ example: "39L" }),
    width: z.number().int().positive().openapi({ example: 1456 }),
  })
  .openapi("EditableInventoryContainerVisual");

const sampleImageSchema = z
  .object({
    alt: z.string().min(1).openapi({ example: "Camera" }),
    caption: z.string().nullable().openapi({ example: null }),
    id: z.string().min(1).openapi({ example: "image-camera" }),
  })
  .openapi("InventoryContainerSampleImage");

const sampleItemSchema = z
  .object({
    audioId: z.string().nullable().openapi({ example: null }),
    hasAudio: z.boolean().openapi({ example: false }),
    id: z.string().min(1).openapi({ example: "item-camera" }),
    imageHeight: z.number().int().nullable().openapi({ example: null }),
    imageId: z.string().nullable().openapi({ example: "image-camera" }),
    imageIds: z
      .array(z.string().min(1))
      .openapi({ example: ["image-camera", "image-camera-detail"] }),
    imageWidth: z.number().int().nullable().openapi({ example: null }),
    localQuantity: z.number().int().positive().openapi({ example: 2 }),
    textPreview: z.string().nullable().openapi({ example: null }),
    title: z.string().min(1).openapi({ example: "Camera" }),
    totalQuantity: z.number().int().nonnegative().openapi({ example: 2 }),
    videoId: z.string().nullable().openapi({ example: null }),
  })
  .openapi("InventoryContainerSampleItem");

const containerSummarySchema = z
  .object({
    id: z.string().min(1).openapi({ example: "container-travel-tote" }),
    itemCount: z.number().int().nonnegative().openapi({ example: 2 }),
    latestCapturedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: "2026-07-28T10:00:00.000Z" }),
    locationName: z.string().nullable().openapi({ example: "Hall closet" }),
    name: z.string().min(1).openapi({ example: "Travel tote" }),
    referenceId: z.string().min(1).openapi({ example: "BIN-0001" }),
    sampleImages: z.array(sampleImageSchema).openapi({
      example: [{ alt: "Camera", caption: null, id: "image-camera" }],
    }),
    sampleItems: z.array(sampleItemSchema),
    sizeLiters: z.number().nullable().openapi({ example: 39 }),
    unitCount: z.number().int().nonnegative().openapi({ example: 2 }),
    visualPreset: visualPresetSchema,
    visualPresetKey: z.string().min(1).openapi({ example: "39L" }),
  })
  .openapi("InventoryContainerSummary");

const locationSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "location-1" }),
    kind: z
      .enum(["ROOM", "STORAGE", "SHELF", "AREA", "OTHER"])
      .openapi({ example: "STORAGE" }),
    name: z.string().min(1).openapi({ example: "Hall closet" }),
  })
  .openapi("InventoryLocation");

const containerSchema = z
  .object({
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-07-28T09:00:00.000Z" }),
    id: z.string().min(1).openapi({ example: "container-travel-tote" }),
    location: locationSchema.nullable().openapi({ example: null }),
    locationId: z.string().nullable().openapi({ example: "location-1" }),
    metadata: z.record(z.string(), z.unknown()).openapi({ example: {} }),
    name: z.string().min(1).openapi({ example: "Travel tote" }),
    normalizedName: z.string().min(1).openapi({ example: "travel tote" }),
    referenceId: z.string().min(1).openapi({ example: "BIN-0001" }),
    sizeLiters: z.number().nullable().openapi({ example: 39 }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-07-28T09:00:00.000Z" }),
    visualPreset: visualPresetSchema,
    visualPresetKey: z.string().min(1).openapi({ example: "39L" }),
  })
  .openapi("InventoryContainer");

const containerShelfItemSchema = z
  .object({
    audioId: z.string().nullable().openapi({ example: null }),
    hasAudio: z.boolean().openapi({ example: false }),
    id: z.string().min(1).openapi({ example: "item-camera" }),
    imageHeight: z.number().int().nullable().openapi({ example: null }),
    imageId: z.string().nullable().openapi({ example: "image-camera" }),
    imageIds: z
      .array(z.string().min(1))
      .openapi({ example: ["image-camera", "image-camera-detail"] }),
    imageWidth: z.number().int().nullable().openapi({ example: null }),
    localQuantity: z.number().int().nonnegative().openapi({ example: 2 }),
    textPreview: z.string().nullable().openapi({ example: null }),
    title: z.string().min(1).openapi({ example: "Camera" }),
    totalQuantity: z.number().int().nonnegative().openapi({ example: 2 }),
    videoId: z.string().nullable().openapi({ example: null }),
  })
  .openapi("InventoryContainerShelfItem");

const retrievalCandidateSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "item-passport" }),
    title: z.string().min(1).openapi({ example: "Passport pouch" }),
    where: z.string().min(1).openapi({ example: "Travel drawer" }),
  })
  .openapi("InventoryContainerRetrievalCandidate");

const containerMutationInputSchema = z
  .object({
    locationName: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .openapi({ example: "Garage shelf A" }),
    name: z.string().trim().min(1).max(200).openapi({ example: "Blue bin 4" }),
    sizeLiters: z.number().positive().nullable().openapi({ example: 45 }),
    visualPresetKey: visualPresetKeySchema.openapi({ example: "39L" }),
  })
  .openapi("InventoryContainerMutationInput");

const visualBoundsInputSchema = z
  .object({
    bounds: boundsSchema,
    hoverBounds: boundsSchema,
  })
  .openapi("InventoryContainerVisualBoundsInput");

const moveItemsToContainerRequestSchema = z
  .object({
    itemIds: z
      .array(z.string().min(1))
      .min(1)
      .openapi({ example: ["item-camera", "item-passport"] }),
  })
  .openapi("MoveInventoryItemsToContainerRequest");

function normalizeMoveItemsToContainerRequest(
  request: z.infer<typeof moveItemsToContainerRequestSchema>,
) {
  return {
    itemIds: [
      ...new Set(
        request.itemIds
          .map((itemId) => itemId.trim())
          .filter(Boolean),
      ),
    ].sort(),
  };
}

const listContainersResponseSchema = z
  .object({
    containers: z.array(containerSummarySchema),
  })
  .openapi("InventoryContainersResponse");

const getContainerResponseSchema = z
  .object({
    container: containerSchema,
  })
  .openapi("InventoryContainerResponse");

const containerContentsResponseSchema = z
  .object({
    items: z.array(containerShelfItemSchema),
    retrievalCandidates: z.array(retrievalCandidateSchema),
  })
  .openapi("InventoryContainerContentsResponse");

const listVisualsResponseSchema = z
  .object({
    editableVisuals: z.array(editableVisualSchema),
    visualPresets: z.array(visualPresetOptionSchema),
  })
  .openapi("InventoryContainerVisualsResponse");

const saveBoundsResponseSchema = z
  .object({
    editableVisual: editableVisualSchema,
  })
  .openapi("InventoryContainerVisualBoundsResponse");

const moveItemsToContainerResponseSchema = z
  .object({
    movedItemIds: z
      .array(z.string().min(1))
      .openapi({ example: ["item-camera", "item-passport"] }),
  })
  .openapi("MoveInventoryItemsToContainerResponse");

type InventoryContainerSummaryDto = z.infer<typeof containerSummarySchema>;
type InventoryContainerDto = z.infer<typeof containerSchema>;
type InventoryContainerShelfItemDto = z.infer<typeof containerShelfItemSchema>;
type InventoryContainerRetrievalCandidateDto = z.infer<
  typeof retrievalCandidateSchema
>;
type EditableVisualDto = z.infer<typeof editableVisualSchema>;
type InventoryContainerVisualPresetOptionDto = z.infer<
  typeof visualPresetOptionSchema
>;
type InventoryContainerJsonStatus = 200 | 201 | 400 | 404 | 409;
type InventoryContainerDatabaseClient =
  Prisma.TransactionClient | typeof prisma;
type InventoryContainerMutationResult = {
  body: Record<string, unknown>;
  status: InventoryContainerJsonStatus;
};
type InventoryContainerMutationRunner = {
  run: (input: {
    clientId: string;
    execute: (
      database: InventoryContainerDatabaseClient,
    ) => Promise<InventoryContainerMutationResult>;
    key: string;
    operationId: string;
    requestHash: string;
  }) => Promise<InventoryContainerMutationResult>;
};

type InventoryContainersRouteHandlers = {
  createContainer: (
    input: z.infer<typeof containerMutationInputSchema>,
    database?: InventoryContainerDatabaseClient,
  ) => Promise<InventoryContainerDto>;
  deleteContainer: (
    containerId: string,
    database?: InventoryContainerDatabaseClient,
  ) => Promise<InventoryContainerDto>;
  getContainer: (containerId: string) => Promise<InventoryContainerDto | null>;
  getContainerContents: (containerId: string) => Promise<{
    items: InventoryContainerShelfItemDto[];
    retrievalCandidates: InventoryContainerRetrievalCandidateDto[];
  } | null>;
  listContainers: () => Promise<InventoryContainerSummaryDto[]>;
  listVisuals: () => Promise<{
    editableVisuals: EditableVisualDto[];
    visualPresets: InventoryContainerVisualPresetOptionDto[];
  }>;
  moveItemsToContainer: (
    input: {
      containerId: string;
      itemIds: string[];
    },
    database?: InventoryContainerDatabaseClient,
  ) => Promise<{ movedItemIds: string[] }>;
  resolveContainerByReference: (
    referenceId: string,
  ) => Promise<InventoryContainerDto | null>;
  saveVisualBounds: (
    input: {
      bounds: z.infer<typeof boundsSchema>;
      hoverBounds: z.infer<typeof boundsSchema>;
      presetKey: string;
    },
    database?: InventoryContainerDatabaseClient,
  ) => Promise<EditableVisualDto>;
  updateContainer: (
    containerId: string,
    input: z.infer<typeof containerMutationInputSchema>,
    database?: InventoryContainerDatabaseClient,
  ) => Promise<InventoryContainerDto>;
};

const containerInclude = {
  location: true,
} satisfies Prisma.InventoryContainerInclude;

const itemInclude = {
  captureSession: {
    include: {
      defaultOriginLocation: true,
      defaultDestinationLocation: true,
    },
  },
  placements: {
    orderBy: {
      createdAt: "asc",
    },
    include: {
      container: {
        include: containerInclude,
      },
    },
  },
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
  audioNotes: {
    orderBy: {
      createdAt: "asc",
    },
  },
  assets: {
    orderBy: {
      createdAt: "asc",
    },
  },
} satisfies Prisma.InventoryItemInclude;

const containerSummaryInclude = {
  location: true,
  placements: {
    where: {
      item: {
        archivedAt: null,
      },
    },
    orderBy: {
      item: {
        capturedAt: "desc",
      },
    },
    include: {
      item: {
        include: {
          images: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          },
          placements: {
            select: {
              quantity: true,
            },
          },
          audioNotes: {
            orderBy: {
              createdAt: "asc",
            },
            take: 1,
          },
          assets: {
            orderBy: {
              createdAt: "asc",
            },
            where: {
              mimeType: {
                startsWith: "video/",
              },
            },
            take: 1,
          },
        },
      },
    },
  },
  _count: {
    select: {
      placements: {
        where: {
          item: {
            archivedAt: null,
          },
        },
      },
    },
  },
} satisfies Prisma.InventoryContainerInclude;

type InventoryContainerWithRelations = Prisma.InventoryContainerGetPayload<{
  include: typeof containerInclude;
}>;

type InventoryContainerSummaryWithRelations =
  Prisma.InventoryContainerGetPayload<{
    include: typeof containerSummaryInclude;
  }>;

type InventoryItemWithRelations = Prisma.InventoryItemGetPayload<{
  include: typeof itemInclude;
}>;

const errorExamples = {
  badRequest: {
    code: "BAD_REQUEST",
    message: "Container image must match the repository catalog.",
  },
  conflict: {
    code: "CONFLICT",
    message: "A container with that name already exists.",
  },
  idempotencyConflict: {
    code: "IDEMPOTENCY_CONFLICT",
    message: "Idempotency-Key was already used for a different request.",
  },
  notFound: {
    code: "NOT_FOUND",
    message: "Container was not found.",
  },
} as const;

function createLocalContainerRepository(
  database: InventoryContainerDatabaseClient,
): InventoryContainerRepository & {
  allocateContainerReferenceId(): Promise<string>;
  getContainerByReferenceId(
    referenceId: string,
  ): Promise<InventoryContainerRecord | null>;
} & InventoryRelocationRepository {
  return {
    async allocateContainerReferenceId() {
      for (;;) {
        const rows = await database.$queryRaw<Array<{ value: bigint }>>`
        SELECT nextval('inventory_container_reference_seq') AS value
      `;
        const value = rows[0]?.value;

        if (value === undefined) {
          throw new Error("Could not allocate a container reference ID.");
        }

        const referenceId = `BIN-${Number(value).toString().padStart(4, "0")}`;
        const existing = await database.inventoryContainer.findUnique({
          where: { referenceId },
          select: { id: true },
        });

        if (!existing) {
          return referenceId;
        }
      }
    },

    async createItem() {
      throw new Error(
        "Inventory Item writes are not supported by this route.",
      );
    },

    async deleteContainer(id) {
      const container = await database.inventoryContainer.findUnique({
        where: { id },
        select: { id: true, name: true },
      });

      if (!container) {
        return;
      }

      const placements = await database.inventoryItemPlacement.findMany({
        where: { containerId: id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          itemId: true,
          quantity: true,
        },
      });

      for (const placement of placements) {
        const existingUnplaced =
          await database.inventoryItemPlacement.findFirst({
            where: {
              containerId: null,
              itemId: placement.itemId,
            },
            select: {
              id: true,
              note: true,
              quantity: true,
            },
          });

        if (existingUnplaced) {
          await database.inventoryItemPlacement.update({
            where: { id: existingUnplaced.id },
            data: {
              note: existingUnplaced.note ?? container.name,
              quantity: existingUnplaced.quantity + placement.quantity,
            },
          });
          await database.inventoryItemPlacement.delete({
            where: { id: placement.id },
          });
        } else {
          await database.inventoryItemPlacement.update({
            where: { id: placement.id },
            data: {
              containerId: null,
              note: container.name,
            },
          });
        }
      }

      await database.inventoryCaptureSession.updateMany({
        where: { defaultContainerId: id },
        data: { defaultContainerId: null },
      });

      await database.inventoryContainer.delete({
        where: { id },
      });

      for (const itemId of new Set(
        placements.map((placement) => placement.itemId),
      )) {
        await refreshInventoryItem(database, itemId);
      }
    },

    async findInventoryItems() {
      throw new Error(
        "Inventory Item search is not supported by this route.",
      );
    },

    async getActiveCaptureSession() {
      throw new Error("Capture sessions are not supported by this route.");
    },

    async getCaptureSession() {
      throw new Error("Capture sessions are not supported by this route.");
    },

    async getContainer(id) {
      const container = await database.inventoryContainer.findUnique({
        where: { id },
        include: containerInclude,
      });

      return container ? mapContainer(container) : null;
    },

    async getContainerByReferenceId(referenceId) {
      const container = await database.inventoryContainer.findUnique({
        where: { referenceId },
        include: containerInclude,
      });

      return container ? mapContainer(container) : null;
    },

    async listContainers() {
      const containers = await database.inventoryContainer.findMany({
        orderBy: { name: "asc" },
        include: containerInclude,
      });

      return containers.map(mapContainer);
    },

    async listContainerSummaries() {
      const containers = await database.inventoryContainer.findMany({
        orderBy: { name: "asc" },
        include: containerSummaryInclude,
      });

      return containers.map(mapContainerSummary);
    },

    async listItemsForContainer(id) {
      const items = await database.inventoryItem.findMany({
        where: {
          archivedAt: null,
          placements: {
            some: {
              containerId: id,
            },
          },
        },
        orderBy: { capturedAt: "desc" },
        include: itemInclude,
      });

      return items.map((item) => mapItem(item as InventoryItemWithRelations));
    },

    async moveItemsToContainer(input: {
      containerId: string;
      itemIds: string[];
    }) {
      const container = await database.inventoryContainer.findUnique({
        where: { id: input.containerId },
        select: {
          id: true,
          location: {
            select: { name: true },
          },
          name: true,
          referenceId: true,
        },
      });

      if (!container) {
        throw new Error("Destination container was not found.");
      }

      const movable = await database.inventoryItem.findMany({
        where: {
          archivedAt: null,
          id: { in: input.itemIds },
        },
        include: itemInclude,
      });

      if (movable.length !== input.itemIds.length) {
        throw new Error(
          "One or more selected items were missing or archived. Nothing was moved.",
        );
      }

      const movableWithQuantities = movable.map((item) => ({
        item,
        quantity: item.placements.reduce(
          (total, placement) => total + placement.quantity,
          0,
        ),
      }));

      if (movableWithQuantities.some(({ quantity }) => quantity <= 0)) {
        throw new Error(
          "One or more selected Items have no units. Nothing was moved.",
        );
      }

      for (const { item, quantity } of movableWithQuantities) {
        await database.inventoryItemPlacement.deleteMany({
          where: { itemId: item.id },
        });
        await database.inventoryItemPlacement.create({
          data: {
            containerId: input.containerId,
            itemId: item.id,
            quantity,
          },
        });
        await database.inventoryItem.update({
          data: {
            searchText: buildInventoryItemSearchTextForContainer(
              mapItem(item as InventoryItemWithRelations),
              container,
            ),
          },
          where: { id: item.id },
        });
      }

      const items = await database.inventoryItem.findMany({
        where: { id: { in: input.itemIds } },
        orderBy: { capturedAt: "desc" },
        include: itemInclude,
      });

      return items.map((item) => mapItem(item as InventoryItemWithRelations));
    },

    async listRecentItems() {
      throw new Error(
        "Inventory Item reads are not supported by this route.",
      );
    },

    async upsertCaptureSession() {
      throw new Error("Capture sessions are not supported by this route.");
    },

    async upsertContainer(input) {
      const data = {
        locationId: input.location?.id ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        name: input.name,
        normalizedName: input.normalizedName,
        referenceId: input.referenceId,
        sizeLiters: input.sizeLiters ?? null,
        visualPresetKey: input.visualPresetKey,
      };
      const container = input.id
        ? await database.inventoryContainer.update({
            where: { id: input.id },
            data,
            include: containerInclude,
          })
        : await database.inventoryContainer.create({
            data,
            include: containerInclude,
          });

      return mapContainer(container);
    },

    async upsertLocation(input) {
      const name = input.name?.trim();
      const kind = input.kind ?? "OTHER";

      if (!name) {
        return null;
      }

      const normalizedName = normalizeInventoryLocationName(name);
      const location = await database.inventoryLocation.upsert({
        where: { normalizedName },
        update: { kind, name },
        create: { kind, name, normalizedName },
      });

      return mapLocation(location);
    },
  };
}

const localContainerRepository = createLocalContainerRepository(prisma);

const inventoryContainersRouteHandlers = {
  async createContainer(input, database = prisma) {
    const container = await createInventoryContainerService(
      createLocalContainerRepository(database),
      input,
    );
    const visual = await getEditableVisual(database, container.visualPresetKey);

    return toContainerDto(container, visual);
  },

  async deleteContainer(containerId, database = prisma) {
    const container = await deleteInventoryContainerService(
      createLocalContainerRepository(database),
      {
        id: containerId,
      },
    );
    const visual = await getEditableVisual(database, container.visualPresetKey);

    return toContainerDto(container, visual);
  },

  async getContainer(containerId) {
    const container = await localContainerRepository.getContainer(containerId);
    const visual = container
      ? await getEditableVisual(prisma, container.visualPresetKey)
      : null;

    return container ? toContainerDto(container, visual) : null;
  },

  async getContainerContents(containerId) {
    const container = await localContainerRepository.getContainer(containerId);

    if (!container) {
      return null;
    }

    const items =
      await localContainerRepository.listItemsForContainer(containerId);
    const activeItems = await prisma.inventoryItem.findMany({
      where: { archivedAt: null },
      orderBy: { capturedAt: "desc" },
      include: itemInclude,
    });

    return {
      items: items.map((item) => toShelfItemDto(item, containerId)),
      retrievalCandidates: activeItems
        .map((item) => mapItem(item as InventoryItemWithRelations))
        .filter(
          (item) =>
            !(item.placements ?? []).some(
              (placement) => placement.containerId === containerId,
            ),
        )
        .map((item) => ({
          id: item.id,
          title:
            item.title ??
            item.captureText ??
            item.note ??
            "Untitled inventory item",
          where: item.container?.name ?? "Unplaced",
        })),
    };
  },

  async listContainers() {
    const [containers, visuals] = await Promise.all([
      localContainerRepository.listContainerSummaries(),
      listInventoryContainerVisualBoundsWithDatabase(prisma),
    ]);
    const visualsByKey = new Map<string, EditableInventoryContainerVisual>(
      visuals.map((visual) => [visual.key, visual]),
    );

    return containers.map((container) =>
      toContainerSummaryDto(
        container,
        visualsByKey.get(container.visualPresetKey) ?? null,
      ),
    );
  },

  async listVisuals() {
    return {
      editableVisuals: (
        await listInventoryContainerVisualBoundsWithDatabase(prisma)
      ).map(toEditableVisualDto),
      visualPresets: listInventoryContainerVisualCatalog().map((preset) => ({
        id: preset.key,
        isDefault: preset.isDefault,
        name: preset.name,
      })),
    };
  },

  async moveItemsToContainer(input, database = prisma) {
    const repository = createLocalContainerRepository(database);
    const items = await moveInventoryItems(repository, {
      containerId: input.containerId,
      itemIds: input.itemIds,
    });

    return {
      movedItemIds: items.map((item) => item.id),
    };
  },

  async resolveContainerByReference(referenceId) {
    const container = await localContainerRepository.getContainerByReferenceId(
      normalizeInventoryContainerReferenceId(referenceId),
    );
    const visual = container
      ? await getEditableVisual(prisma, container.visualPresetKey)
      : null;

    return container ? toContainerDto(container, visual) : null;
  },

  async saveVisualBounds(input, database = prisma) {
    await saveInventoryContainerVisualBoundsWithDatabase(database, input);
    const editableVisuals =
      await listInventoryContainerVisualBoundsWithDatabase(database);
    const editableVisual = editableVisuals.find(
      (visual) => visual.key === input.presetKey,
    );

    if (!editableVisual) {
      throw new Error("Container visual preset was not found.");
    }

    return toEditableVisualDto(editableVisual);
  },

  async updateContainer(containerId, input, database = prisma) {
    const repository = createLocalContainerRepository(database);
    const existingContainer = await repository.getContainer(containerId);

    if (!existingContainer) {
      throw new Error("Container was not found.");
    }

    const container = await createInventoryContainerService(repository, {
      ...input,
      id: containerId,
      referenceId: existingContainer.referenceId,
    });
    const visual = await getEditableVisual(database, container.visualPresetKey);

    return toContainerDto(container, visual);
  },
} satisfies InventoryContainersRouteHandlers;

const listContainersRoute = createRoute({
  method: "get",
  operationId: "listInventoryContainers",
  path: "/api/v1/inventory-containers",
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            containers: [
              {
                id: "container-travel-tote",
                itemCount: 2,
                latestCapturedAt: "2026-07-28T10:00:00.000Z",
                locationName: "Hall closet",
                name: "Travel tote",
                referenceId: "BIN-0001",
                sampleImages: [
                  {
                    alt: "Camera",
                    caption: null,
                    id: "image-camera",
                  },
                ],
                sampleItems: [
                  {
                    audioId: null,
                    hasAudio: false,
                    id: "item-camera",
                    imageHeight: null,
                    imageId: "image-camera",
                    imageIds: ["image-camera"],
                    imageWidth: null,
                    localQuantity: 2,
                    textPreview: null,
                    title: "Camera",
                    totalQuantity: 2,
                    videoId: null,
                  },
                ],
                sizeLiters: 39,
                unitCount: 2,
                visualPreset: {
                  backImageUrl:
                    "/inventory/container-visual-catalog/39l/back.webp",
                  bounds: [
                    { x: 0.1856, y: 0.1943 },
                    { x: 0.8137, y: 0.1943 },
                    { x: 0.7768, y: 0.6736 },
                    { x: 0.2225, y: 0.6736 },
                  ],
                  emptyImageUrl:
                    "/inventory/container-visual-catalog/39l/empty.webp",
                  frontImageUrl:
                    "/inventory/container-visual-catalog/39l/front.webp",
                  height: 857,
                  hoverBounds: [
                    { x: 0.1856, y: 0.1943 },
                    { x: 0.8137, y: 0.1943 },
                    { x: 0.7768, y: 0.6736 },
                    { x: 0.2225, y: 0.6736 },
                  ],
                  id: "39L",
                  isDefault: false,
                  name: "39L",
                  shadowImageUrl:
                    "/inventory/container-visual-catalog/39l/shadow.webp",
                  width: 1456,
                },
                visualPresetKey: "39L",
              },
            ],
          },
          schema: listContainersResponseSchema,
        },
      },
      description: "Inventory Container shelf summaries.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "List Inventory Containers",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns Inventory Container summaries for the current owner, including visual preset and sample item data used by the existing Container shelf and capture forms. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: none. Success response: 200 with Container summaries in stable name order. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const getContainerParamsSchema = z.object({
  containerId: z.string().min(1).openapi({ example: "container-travel-tote" }),
});

const getContainerRoute = createRoute({
  method: "get",
  operationId: "getInventoryContainer",
  path: "/api/v1/inventory-containers/{containerId}",
  request: {
    params: getContainerParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            container: {
              createdAt: "2026-07-28T09:00:00.000Z",
              id: "container-travel-tote",
              location: {
                id: "location-1",
                kind: "STORAGE",
                name: "Hall closet",
              },
              locationId: "location-1",
              metadata: {},
              name: "Travel tote",
              normalizedName: "travel tote",
              referenceId: "BIN-0001",
              sizeLiters: 39,
              updatedAt: "2026-07-28T09:00:00.000Z",
              visualPreset: {
                backImageUrl:
                  "/inventory/container-visual-catalog/39l/back.webp",
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                emptyImageUrl:
                  "/inventory/container-visual-catalog/39l/empty.webp",
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                id: "39L",
                isDefault: false,
                name: "39L",
                shadowImageUrl:
                  "/inventory/container-visual-catalog/39l/shadow.webp",
                width: 1456,
              },
              visualPresetKey: "39L",
            },
          },
          schema: getContainerResponseSchema,
        },
      },
      description: "Inventory Container detail.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: errorExamples.notFound,
          schema: apiFailureSchema,
        },
      },
      description: "The requested Container does not exist.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Container",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns one Inventory Container record with visual preset and label data used by the existing Web detail and label flows. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: containerId path parameter. Success response: 200 with the Container record. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Container does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const getContainerContentsRoute = createRoute({
  method: "get",
  operationId: "getInventoryContainerContents",
  path: "/api/v1/inventory-containers/{containerId}/contents",
  request: {
    params: getContainerParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            items: [
              {
                audioId: null,
                hasAudio: false,
                id: "item-camera",
                imageHeight: null,
                imageId: "image-camera",
                imageIds: ["image-camera"],
                imageWidth: null,
                localQuantity: 2,
                textPreview: null,
                title: "Camera",
                totalQuantity: 2,
                videoId: null,
              },
            ],
            retrievalCandidates: [
              {
                id: "item-passport",
                title: "Passport pouch",
                where: "Travel drawer",
              },
            ],
          },
          schema: containerContentsResponseSchema,
        },
      },
      description: "Inventory Container item scene and retrieval candidates.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: errorExamples.notFound,
          schema: apiFailureSchema,
        },
      },
      description: "The requested Container does not exist.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Container contents",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns the current Container scene items and retrieval candidates used by the fullscreen Web detail. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: containerId path parameter. Success response: 200 with shelf items and retrieval candidates. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Container does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const listVisualsRoute = createRoute({
  method: "get",
  operationId: "listInventoryContainerVisuals",
  path: "/api/v1/inventory-container-visuals",
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            editableVisuals: [
              {
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                defaultBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                defaultHoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                key: "39L",
                name: "39L",
                width: 1456,
              },
            ],
            visualPresets: [
              {
                id: "6L",
                isDefault: true,
                name: "6L",
              },
            ],
          },
          schema: listVisualsResponseSchema,
        },
      },
      description: "Inventory Container visual presets and bounds overrides.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "List Inventory Container visuals",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns visual preset options and current bounds overrides for the existing Container views and bounds editor. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: none. Success response: 200 with preset metadata and editable bounds. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const referenceParamsSchema = z.object({
  referenceId: z.string().min(1).openapi({ example: "BIN-0001" }),
});

const resolveByReferenceRoute = createRoute({
  method: "get",
  operationId: "resolveInventoryContainerByReference",
  path: "/api/v1/inventory-containers/reference/{referenceId}",
  request: {
    params: referenceParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            container: {
              createdAt: "2026-07-28T09:00:00.000Z",
              id: "container-travel-tote",
              location: null,
              locationId: null,
              metadata: {},
              name: "Travel tote",
              normalizedName: "travel tote",
              referenceId: "BIN-0001",
              sizeLiters: 39,
              updatedAt: "2026-07-28T09:00:00.000Z",
              visualPreset: {
                backImageUrl:
                  "/inventory/container-visual-catalog/39l/back.webp",
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                emptyImageUrl:
                  "/inventory/container-visual-catalog/39l/empty.webp",
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                id: "39L",
                isDefault: false,
                name: "39L",
                shadowImageUrl:
                  "/inventory/container-visual-catalog/39l/shadow.webp",
                width: 1456,
              },
              visualPresetKey: "39L",
            },
          },
          schema: getContainerResponseSchema,
        },
      },
      description:
        "Inventory Container resolved from a printed reference label.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: errorExamples.notFound,
          schema: apiFailureSchema,
        },
      },
      description:
        "The printed reference does not resolve to a current Container.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Resolve Inventory Container by reference label",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Resolves a printed Container reference label to its current Container record. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: referenceId path parameter; the API normalizes the printed value before lookup. Success response: 200 with the Container record. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the reference does not resolve. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const mutationHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(255).openapi({
    example: "7cde2a5f-f64b-4de3-90ce-d89597d0f6ad",
  }),
});

const createContainerRoute = createRoute({
  method: "post",
  operationId: "createInventoryContainer",
  path: "/api/v1/inventory-containers",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            locationName: "Garage shelf A",
            name: "Blue bin 4",
            sizeLiters: 45,
            visualPresetKey: "39L",
          },
          schema: containerMutationInputSchema,
        },
      },
      required: true,
    },
    headers: mutationHeadersSchema,
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            container: {
              createdAt: "2026-07-28T09:00:00.000Z",
              id: "container-blue-bin-4",
              location: {
                id: "location-1",
                kind: "STORAGE",
                name: "Garage shelf A",
              },
              locationId: "location-1",
              metadata: {},
              name: "Blue bin 4",
              normalizedName: "blue bin 4",
              referenceId: "BIN-0007",
              sizeLiters: 45,
              updatedAt: "2026-07-28T09:00:00.000Z",
              visualPreset: {
                backImageUrl:
                  "/inventory/container-visual-catalog/39l/back.webp",
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                emptyImageUrl:
                  "/inventory/container-visual-catalog/39l/empty.webp",
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                id: "39L",
                isDefault: false,
                name: "39L",
                shadowImageUrl:
                  "/inventory/container-visual-catalog/39l/shadow.webp",
                width: 1456,
              },
              visualPresetKey: "39L",
            },
          },
          schema: getContainerResponseSchema,
        },
      },
      description: "Inventory Container created.",
    },
    400: {
      content: {
        "application/json": {
          example: errorExamples.badRequest,
          schema: apiFailureSchema,
        },
      },
      description: "The request body or Idempotency-Key was invalid.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Write.",
    },
    409: {
      content: {
        "application/json": {
          example: errorExamples.conflict,
          schema: apiFailureSchema,
        },
      },
      description:
        "The Container conflicts with an existing name, reference, or Idempotency-Key reuse.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Create Inventory Container",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Creates one Inventory Container using canonical API validation and a required Idempotency-Key. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with name, optional location name, optional sizeLiters, and a catalog visualPresetKey; Idempotency-Key header is required. Success response: 201 with the created Container. Failure responses: 400 when validation fails or the Idempotency-Key is missing, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 409 when the name or reference conflicts or the Idempotency-Key is reused for a different request. Side effects: creates or reuses a location, allocates a reference label when needed, and persists the Container. Destructive: no. Retry safety: replay-safe only with the same Idempotency-Key and normalized request.",
});

const updateContainerRoute = createRoute({
  method: "put",
  operationId: "updateInventoryContainer",
  path: "/api/v1/inventory-containers/{containerId}",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            locationName: "Garage shelf A",
            name: "Blue bin 4",
            sizeLiters: 45,
            visualPresetKey: "39L",
          },
          schema: containerMutationInputSchema,
        },
      },
      required: true,
    },
    headers: mutationHeadersSchema,
    params: getContainerParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            container: {
              createdAt: "2026-07-28T09:00:00.000Z",
              id: "container-blue-bin-4",
              location: {
                id: "location-1",
                kind: "STORAGE",
                name: "Garage shelf A",
              },
              locationId: "location-1",
              metadata: {},
              name: "Blue bin 4",
              normalizedName: "blue bin 4",
              referenceId: "BIN-0007",
              sizeLiters: 45,
              updatedAt: "2026-07-28T10:00:00.000Z",
              visualPreset: {
                backImageUrl:
                  "/inventory/container-visual-catalog/39l/back.webp",
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                emptyImageUrl:
                  "/inventory/container-visual-catalog/39l/empty.webp",
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                id: "39L",
                isDefault: false,
                name: "39L",
                shadowImageUrl:
                  "/inventory/container-visual-catalog/39l/shadow.webp",
                width: 1456,
              },
              visualPresetKey: "39L",
            },
          },
          schema: getContainerResponseSchema,
        },
      },
      description: "Inventory Container updated.",
    },
    400: {
      content: {
        "application/json": {
          example: errorExamples.badRequest,
          schema: apiFailureSchema,
        },
      },
      description: "The request body or Idempotency-Key was invalid.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Write.",
    },
    404: {
      content: {
        "application/json": {
          example: errorExamples.notFound,
          schema: apiFailureSchema,
        },
      },
      description: "The requested Container does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: errorExamples.idempotencyConflict,
          schema: apiFailureSchema,
        },
      },
      description:
        "The Container conflicts with an existing name, reference, or Idempotency-Key reuse.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Update Inventory Container",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Updates one Inventory Container using canonical API validation and a required Idempotency-Key while preserving its printed reference label. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: containerId path parameter plus JSON body with name, optional location name, optional sizeLiters, and visualPresetKey; Idempotency-Key header is required. Success response: 200 with the updated Container. Failure responses: 400 when validation fails or the Idempotency-Key is missing, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Container does not exist, 409 when the name conflicts or the Idempotency-Key is reused for a different request. Side effects: updates location links and persisted Container fields. Destructive: no. Retry safety: replay-safe only with the same Idempotency-Key and normalized request.",
});

const deleteContainerRoute = createRoute({
  method: "delete",
  operationId: "deleteInventoryContainer",
  path: "/api/v1/inventory-containers/{containerId}",
  request: {
    headers: mutationHeadersSchema,
    params: getContainerParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            container: {
              createdAt: "2026-07-28T09:00:00.000Z",
              id: "container-blue-bin-4",
              location: null,
              locationId: null,
              metadata: {},
              name: "Blue bin 4",
              normalizedName: "blue bin 4",
              referenceId: "BIN-0007",
              sizeLiters: 45,
              updatedAt: "2026-07-28T10:00:00.000Z",
              visualPreset: {
                backImageUrl:
                  "/inventory/container-visual-catalog/39l/back.webp",
                bounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                emptyImageUrl:
                  "/inventory/container-visual-catalog/39l/empty.webp",
                frontImageUrl:
                  "/inventory/container-visual-catalog/39l/front.webp",
                height: 857,
                hoverBounds: [
                  { x: 0.1856, y: 0.1943 },
                  { x: 0.8137, y: 0.1943 },
                  { x: 0.7768, y: 0.6736 },
                  { x: 0.2225, y: 0.6736 },
                ],
                id: "39L",
                isDefault: false,
                name: "39L",
                shadowImageUrl:
                  "/inventory/container-visual-catalog/39l/shadow.webp",
                width: 1456,
              },
              visualPresetKey: "39L",
            },
          },
          schema: getContainerResponseSchema,
        },
      },
      description: "Inventory Container deleted.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "BAD_REQUEST",
            message: "Idempotency-Key is required.",
          },
          schema: apiFailureSchema,
        },
      },
      description: "The Idempotency-Key was missing or invalid.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Write.",
    },
    404: {
      content: {
        "application/json": {
          example: errorExamples.notFound,
          schema: apiFailureSchema,
        },
      },
      description: "The requested Container does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: errorExamples.idempotencyConflict,
          schema: apiFailureSchema,
        },
      },
      description:
        "The Idempotency-Key was already used for a different delete request.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Delete Inventory Container",
  tags: ["Inventory"],
  "x-destructive": true,
  "x-required-permissions": ["inventory:write"],
  description:
    "Deletes one Inventory Container with a required Idempotency-Key, clears capture defaults that referenced it, and preserves item label history by unplacing affected Placements. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: containerId path parameter; Idempotency-Key header is required. Success response: 200 with the deleted Container record. Failure responses: 400 when the Idempotency-Key is missing, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Container does not exist, 409 when the Idempotency-Key is reused for a different request. Side effects: unplaces affected Placements, clears capture defaults, refreshes Item search text, and deletes the Container. Destructive: yes. Retry safety: replay-safe only with the same Idempotency-Key and normalized request.",
});

const moveItemsToContainerRoute = createRoute({
  method: "post",
  operationId: "moveInventoryItemsToContainer",
  path: "/api/v1/inventory-containers/{containerId}/move-items",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            itemIds: ["item-camera", "item-passport"],
          },
          schema: moveItemsToContainerRequestSchema,
        },
      },
      required: true,
    },
    headers: mutationHeadersSchema,
    params: getContainerParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            movedItemIds: ["item-camera", "item-passport"],
          },
          schema: moveItemsToContainerResponseSchema,
        },
      },
      description: "Moved Inventory Items.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "BAD_REQUEST",
            message:
              "One or more selected items were missing or archived. Nothing was moved.",
          },
          schema: apiFailureSchema,
        },
      },
      description:
        "The request body or Idempotency-Key was invalid, or the selected Items could not be moved together.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Write.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Destination container was not found.",
          },
          schema: apiFailureSchema,
        },
      },
      description: "The destination Container does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: errorExamples.idempotencyConflict,
          schema: apiFailureSchema,
        },
      },
      description:
        "The Idempotency-Key was already used for a different move request.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Move Inventory Items to a Container",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Moves multiple active Inventory Items into one destination Container as one API-owned atomic operation. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: containerId path parameter, JSON itemIds array, and Idempotency-Key header. Success response: 200 with the moved Item identifiers. Failure responses: 400 when the request, selection, or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the destination Container does not exist, 409 when the Idempotency-Key is reused for a different request. Side effects: rewrites Placements for every selected Item, refreshes Item search text, and commits the whole move transactionally or not at all. Destructive: no. Retry safety: replay-safe only with the same Idempotency-Key and normalized request.",
});

const saveBoundsParamsSchema = z.object({
  presetKey: visualPresetKeySchema.openapi({ example: "39L" }),
});

const saveBoundsRoute = createRoute({
  method: "put",
  operationId: "saveInventoryContainerVisualBounds",
  path: "/api/v1/inventory-container-visuals/{presetKey}/bounds",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            bounds: [
              { x: 0.1856, y: 0.1943 },
              { x: 0.8137, y: 0.1943 },
              { x: 0.7768, y: 0.6736 },
              { x: 0.2225, y: 0.6736 },
            ],
            hoverBounds: [
              { x: 0.1856, y: 0.1943 },
              { x: 0.8137, y: 0.1943 },
              { x: 0.7768, y: 0.6736 },
              { x: 0.2225, y: 0.6736 },
            ],
          },
          schema: visualBoundsInputSchema,
        },
      },
      required: true,
    },
    headers: mutationHeadersSchema,
    params: saveBoundsParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            editableVisual: {
              bounds: [
                { x: 0.1856, y: 0.1943 },
                { x: 0.8137, y: 0.1943 },
                { x: 0.7768, y: 0.6736 },
                { x: 0.2225, y: 0.6736 },
              ],
              defaultBounds: [
                { x: 0.1856, y: 0.1943 },
                { x: 0.8137, y: 0.1943 },
                { x: 0.7768, y: 0.6736 },
                { x: 0.2225, y: 0.6736 },
              ],
              defaultHoverBounds: [
                { x: 0.1856, y: 0.1943 },
                { x: 0.8137, y: 0.1943 },
                { x: 0.7768, y: 0.6736 },
                { x: 0.2225, y: 0.6736 },
              ],
              frontImageUrl:
                "/inventory/container-visual-catalog/39l/front.webp",
              height: 857,
              hoverBounds: [
                { x: 0.1856, y: 0.1943 },
                { x: 0.8137, y: 0.1943 },
                { x: 0.7768, y: 0.6736 },
                { x: 0.2225, y: 0.6736 },
              ],
              key: "39L",
              name: "39L",
              width: 1456,
            },
          },
          schema: saveBoundsResponseSchema,
        },
      },
      description: "Inventory Container bounds override saved.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "BAD_REQUEST",
            message: "Item bounds must form a clockwise convex shape.",
          },
          schema: apiFailureSchema,
        },
      },
      description: "The bounds payload or Idempotency-Key was invalid.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: {
            code: "FORBIDDEN",
            message: "Missing required permission.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Write.",
    },
    409: {
      content: {
        "application/json": {
          example: errorExamples.idempotencyConflict,
          schema: apiFailureSchema,
        },
      },
      description:
        "The Idempotency-Key was already used for a different bounds update request.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Save Inventory Container visual bounds",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Saves one Container visual bounds override with a required Idempotency-Key for the bounds editor. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: presetKey path parameter, JSON body with bounds and hoverBounds, and Idempotency-Key header. Success response: 200 with the saved editable visual record. Failure responses: 400 when bounds validation fails or the Idempotency-Key is missing, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 409 when the Idempotency-Key is reused for a different request. Side effects: persists visual bounds overrides. Destructive: no. Retry safety: replay-safe only with the same Idempotency-Key and normalized request.",
});

function jsonFailure(
  code: z.infer<typeof apiFailureSchema>["code"],
  message: string,
  status: number,
) {
  return {
    body: {
      code,
      message,
    },
    status,
  } as const;
}

function normalizeError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unexpected API failure.";

  if (message === "Idempotency-Key is required.") {
    return jsonFailure("BAD_REQUEST", message, 400);
  }

  if (
    message === "Destination container is required." ||
    message === "One or more selected items were missing or archived. Nothing was moved." ||
    message === "One or more selected Items have no units. Nothing was moved." ||
    message === "Select at least one inventory item." ||
    message === "Container ID is required." ||
    message === "Container image is required." ||
    message === "Container image must match the repository catalog." ||
    message === "Container name is required." ||
    message === "Hover bounds must form a clockwise convex shape." ||
    message === "Item bounds must form a clockwise convex shape." ||
    message === "Container visual preset was not found."
  ) {
    return jsonFailure("BAD_REQUEST", message, 400);
  }

  if (
    message === "A container with that name already exists." ||
    message === "A container with that reference ID already exists."
  ) {
    return jsonFailure("CONFLICT", message, 409);
  }

  if (message === "Idempotency-Key was already used for a different request.") {
    return jsonFailure("IDEMPOTENCY_CONFLICT", message, 409);
  }

  if (message === "Container was not found.") {
    return jsonFailure("NOT_FOUND", message, 404);
  }

  if (message === "Destination container was not found.") {
    return jsonFailure("NOT_FOUND", message, 404);
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  ) {
    return jsonFailure(
      "CONFLICT",
      "A container with that name or reference ID already exists.",
      409,
    );
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2025"
  ) {
    return jsonFailure("NOT_FOUND", "Container was not found.", 404);
  }

  throw error;
}

const maximumContainerMutationAttempts = 3;

function isPrismaWriteConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2034"
  );
}

const inventoryContainerMutationRunner: InventoryContainerMutationRunner = {
  async run(input) {
    for (
      let attempt = 1;
      attempt <= maximumContainerMutationAttempts;
      attempt += 1
    ) {
      try {
        return await prisma.$transaction(
          async (transaction) => {
            const claim = await transaction.apiIdempotencyRequest.create({
              data: {
                clientId: input.clientId,
                key: input.key,
                operationId: input.operationId,
                requestHash: input.requestHash,
                responseBody: {},
                statusCode: 0,
              },
            });
            let result: InventoryContainerMutationResult;

            try {
              result = await input.execute(transaction);
            } catch (error) {
              const failure = normalizeError(error);
              result = {
                body: failure.body,
                status: failure.status as 400 | 404 | 409,
              };
            }

            await transaction.apiIdempotencyRequest.update({
              where: { id: claim.id },
              data: {
                responseBody: result.body as Prisma.InputJsonValue,
                statusCode: result.status,
              },
            });

            return result;
          },
          {
            isolationLevel: "Serializable",
            timeout: 30_000,
          },
        );
      } catch (error) {
        if (
          isPrismaWriteConflict(error) &&
          attempt < maximumContainerMutationAttempts
        ) {
          continue;
        }

        const existing = await prisma.apiIdempotencyRequest.findUnique({
          where: {
            clientId_operationId_key: {
              clientId: input.clientId,
              key: input.key,
              operationId: input.operationId,
            },
          },
        });

        if (!existing) {
          throw error;
        }

        if (existing.requestHash !== input.requestHash) {
          const failure = normalizeError(
            new Error(
              "Idempotency-Key was already used for a different request.",
            ),
          );

          return {
            body: failure.body,
            status: failure.status as 409,
          };
        }

        return {
          body: existing.responseBody as Record<string, unknown>,
          status: existing.statusCode as InventoryContainerJsonStatus,
        };
      }
    }

    throw new Error("Container mutation retry limit exceeded.");
  },
};

async function runMutationWithIdempotency(
  context: Context<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  input: {
    execute: (
      database: InventoryContainerDatabaseClient,
    ) => Promise<InventoryContainerMutationResult>;
    operationId: string;
    requestBody: Record<string, unknown> | null;
  },
  runner: InventoryContainerMutationRunner,
) {
  const authorization = authorizeAccessContext(context.get("accessContext"), {
    action: "write",
    domain: "inventory",
  });
  if (!authorization.ok) {
    return jsonAuthorizationFailure(context, authorization.error);
  }

  const idempotencyKey = context.req.header("idempotency-key")!.trim();
  const requestHash = await hashNormalizedRequest(input.requestBody ?? {});
  const clientId = authorization.accessContext.client.id;
  const result = await runner.run({
    clientId: clientId,
    execute: input.execute,
    key: idempotencyKey,
    operationId: input.operationId,
    requestHash,
  });

  return context.json(result.body, result.status);
}

function registerInventoryContainerRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  handlers: InventoryContainersRouteHandlers,
  mutationRunner: InventoryContainerMutationRunner = inventoryContainerMutationRunner,
) {
  app.openapi(listContainersRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    return context.json(
      {
        containers: await handlers.listContainers(),
      },
      200,
    );
  });

  app.openapi(getContainerRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const containerId = context.req.param("containerId") as string;
    const container = await handlers.getContainer(containerId);

    if (!container) {
      const failure = normalizeError(new Error("Container was not found."));

      return context.json(failure.body, failure.status as 404);
    }

    return context.json({ container }, 200);
  });

  app.openapi(getContainerContentsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const containerId = context.req.param("containerId") as string;

    const contents = await handlers.getContainerContents(containerId);

    if (!contents) {
      const failure = normalizeError(new Error("Container was not found."));

      return context.json(failure.body, failure.status as 404);
    }

    return context.json(contents, 200);
  });

  app.openapi(listVisualsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    return context.json(await handlers.listVisuals(), 200);
  });

  app.openapi(resolveByReferenceRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const referenceId = normalizeInventoryContainerReferenceId(
      context.req.param("referenceId") as string,
    );
    const container = await handlers.resolveContainerByReference(referenceId);

    if (!container) {
      const failure = normalizeError(new Error("Container was not found."));

      return context.json(failure.body, failure.status as 404);
    }

    return context.json({ container }, 200);
  });

  app.openapi(createContainerRoute, async (context) => {
    const payload = containerMutationInputSchema.parse(
      await context.req.json(),
    );

    return runMutationWithIdempotency(
      context,
      {
        execute: async (database) => ({
          body: {
            container: await handlers.createContainer(payload, database),
          },
          status: 201,
        }),
        operationId: "createInventoryContainer",
        requestBody: payload,
      },
      mutationRunner,
    );
  });

  app.openapi(updateContainerRoute, async (context) => {
    const containerId = context.req.param("containerId") as string;
    const payload = containerMutationInputSchema.parse(
      await context.req.json(),
    );

    return runMutationWithIdempotency(
      context,
      {
        execute: async (database) => ({
          body: {
            container: await handlers.updateContainer(
              containerId,
              payload,
              database,
            ),
          },
          status: 200,
        }),
        operationId: "updateInventoryContainer",
        requestBody: {
          ...payload,
          containerId,
        },
      },
      mutationRunner,
    );
  });

  app.openapi(deleteContainerRoute, async (context) =>
    runMutationWithIdempotency(
      context,
      {
        execute: async (database) => {
          const containerId = context.req.param("containerId") as string;

          return {
            body: {
              container: await handlers.deleteContainer(containerId, database),
            },
            status: 200,
          };
        },
        operationId: "deleteInventoryContainer",
        requestBody: {
          containerId: context.req.param("containerId") as string,
        },
      },
      mutationRunner,
    ),
  );

  app.openapi(moveItemsToContainerRoute, async (context) => {
    const containerId = context.req.param("containerId") as string;
    const payload = normalizeMoveItemsToContainerRequest(
      moveItemsToContainerRequestSchema.parse(await context.req.json()),
    );

    return runMutationWithIdempotency(
      context,
      {
        execute: async (database) =>
          ({
            body: await handlers.moveItemsToContainer(
              {
                containerId,
                itemIds: payload.itemIds,
              },
              database,
            ),
            status: 200,
          }) satisfies InventoryContainerMutationResult,
        operationId: "moveInventoryItemsToContainer",
        requestBody: {
          containerId,
          ...payload,
        },
      },
      mutationRunner,
    );
  });

  app.openapi(saveBoundsRoute, async (context) => {
    const presetKey = context.req.param("presetKey") as string;
    const payload = visualBoundsInputSchema.parse(await context.req.json());

    return runMutationWithIdempotency(
      context,
      {
        execute: async (database) => ({
          body: {
            editableVisual: await handlers.saveVisualBounds(
              {
                ...payload,
                presetKey,
              },
              database,
            ),
          },
          status: 200,
        }),
        operationId: "saveInventoryContainerVisualBounds",
        requestBody: {
          ...payload,
          presetKey,
        },
      },
      mutationRunner,
    );
  });
}

function mapLocation(location: InventoryLocation): InventoryLocationRecord {
  return {
    id: location.id,
    kind: location.kind,
    name: location.name,
  };
}

function mapOptionalLocation(
  location: InventoryLocation | null,
): InventoryLocationRecord | null {
  return location ? mapLocation(location) : null;
}

function mapContainerVisualPreset(
  key: string,
  hoverBounds?: EditableInventoryContainerVisual["hoverBounds"],
): InventoryContainerVisualPresetRecord & {
  hoverBounds: EditableInventoryContainerVisual["hoverBounds"];
} {
  const preset =
    getInventoryContainerVisualCatalogEntry(key) ??
    getDefaultInventoryContainerVisualCatalogEntry();

  return {
    backImageUrl: preset.assets.back.webpPath,
    bounds: preset.itemBounds,
    emptyImageUrl: preset.assets.empty.webpPath,
    frontImageUrl: preset.assets.front.webpPath,
    height: preset.dimensions.height,
    hoverBounds: hoverBounds ?? preset.itemBounds,
    id: preset.key,
    isDefault: preset.isDefault,
    name: preset.name,
    shadowImageUrl: preset.assets.shadow.webpPath,
    width: preset.dimensions.width,
  };
}

function mapContainer(
  container: InventoryContainerWithRelations,
): InventoryContainerRecord {
  return {
    createdAt: container.createdAt,
    id: container.id,
    location: mapOptionalLocation(container.location),
    locationId: container.locationId,
    metadata: toMetadataRecord(container.metadata),
    name: container.name,
    normalizedName: container.normalizedName,
    referenceId: container.referenceId,
    sizeLiters: container.sizeLiters,
    updatedAt: container.updatedAt,
    visualPreset: mapContainerVisualPreset(container.visualPresetKey),
    visualPresetKey: container.visualPresetKey,
  };
}

function mapPlacement(
  placement: InventoryItemPlacement & {
    container: InventoryContainerWithRelations | null;
  },
) {
  return {
    container: placement.container ? mapContainer(placement.container) : null,
    containerId: placement.containerId,
    createdAt: placement.createdAt,
    id: placement.id,
    itemId: placement.itemId,
    note: placement.note,
    quantity: placement.quantity,
    updatedAt: placement.updatedAt,
  };
}

function mapImage(image: InventoryItemImage) {
  return {
    caption: image.caption,
    filePath: image.filePath,
    height: image.height,
    id: image.id,
    mimeType: image.mimeType,
    ocrText: image.ocrText,
    originalName: image.originalName,
    position: image.position,
    sizeBytes: image.sizeBytes,
    width: image.width,
  };
}

function mapAudioNote(audioNote: InventoryItemAudio) {
  return {
    filePath: audioNote.filePath,
    id: audioNote.id,
    mimeType: audioNote.mimeType,
    originalName: audioNote.originalName,
    sizeBytes: audioNote.sizeBytes,
  };
}

function mapAsset(asset: InventoryItemAsset) {
  return {
    filePath: asset.filePath,
    id: asset.id,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
    sizeBytes: asset.sizeBytes,
  };
}

function mapItem(item: InventoryItemWithRelations): InventoryItemRecord {
  const originLocation = item.captureSession?.defaultOriginLocation ?? null;
  const placements = item.placements.map(mapPlacement);
  const primaryPlacement = placements[0] ?? null;
  const currentLocation =
    primaryPlacement?.container?.location ??
    item.captureSession?.defaultDestinationLocation ??
    null;

  return {
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    archivedAt: item.archivedAt,
    assets: (item.assets ?? []).map(mapAsset),
    audioNotes: item.audioNotes.map(mapAudioNote),
    captureSessionId: item.captureSessionId,
    captureText: item.captureText,
    capturedAt: item.capturedAt,
    category: item.category,
    container: primaryPlacement?.container ?? null,
    containerId: primaryPlacement?.containerId ?? null,
    containerLabel:
      primaryPlacement?.container?.name ?? primaryPlacement?.note ?? null,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    id: item.id,
    images: item.images.map(mapImage),
    importance: item.importance,
    kind: item.kind,
    locationId: currentLocation?.id ?? null,
    locationName: currentLocation?.name ?? null,
    metadata: toMetadataRecord(item.metadata),
    note: item.note,
    originLocationId: originLocation?.id ?? null,
    originLocationName: originLocation?.name ?? null,
    placements,
    searchText: item.searchText,
    status: item.status,
    tags: item.tags,
    title: item.title,
    totalQuantity: placements.reduce(
      (total, placement) => total + placement.quantity,
      0,
    ),
  };
}

function mapContainerSummary(
  container: InventoryContainerSummaryWithRelations,
): InventoryContainerSummary {
  const latestCapturedAt = container.placements[0]?.item.capturedAt ?? null;
  const prioritizedPlacements = [...container.placements].sort(
    (left, right) =>
      Number(right.item.images.length > 0) -
      Number(left.item.images.length > 0),
  );
  const sampleImages = prioritizedPlacements.flatMap(({ item }) =>
    item.images.map((image) => ({
      alt:
        image.caption ??
        item.title ??
        item.captureText ??
        "Inventory Item image",
      caption: image.caption,
      id: image.id,
    })),
  );

  return {
    id: container.id,
    itemCount: container._count.placements,
    latestCapturedAt,
    locationName: container.location?.name ?? null,
    name: container.name,
    referenceId: container.referenceId,
    sampleImages,
    sampleItems: prioritizedPlacements.map(({ item, quantity }) => ({
      audioId: item.audioNotes[0]?.id ?? null,
      hasAudio: item.audioNotes.length > 0,
      id: item.id,
      imageHeight: item.images[0]?.height ?? null,
      imageId: item.images[0]?.id ?? null,
      imageIds: item.images.map((image) => image.id),
      imageWidth: item.images[0]?.width ?? null,
      localQuantity: quantity,
      textPreview: item.captureText,
      title: item.title ?? item.captureText ?? "Untitled Inventory Item",
      totalQuantity: item.placements.reduce(
        (total, placement) => total + placement.quantity,
        0,
      ),
      videoId: item.assets[0]?.id ?? null,
    })),
    sizeLiters: container.sizeLiters,
    unitCount: container.placements.reduce(
      (total, placement) => total + placement.quantity,
      0,
    ),
    visualPreset: mapContainerVisualPreset(container.visualPresetKey),
    visualPresetKey: container.visualPresetKey,
  };
}

function toContainerSummaryDto(
  container: InventoryContainerSummary,
  visual: EditableInventoryContainerVisual | null = null,
): InventoryContainerSummaryDto {
  return {
    ...container,
    latestCapturedAt: container.latestCapturedAt?.toISOString() ?? null,
    sampleItems: container.sampleItems.map((item) => ({
      audioId: item.audioId,
      hasAudio: item.hasAudio,
      id: item.id,
      imageHeight: item.imageHeight ?? null,
      imageId: item.imageId,
      imageIds: item.imageIds ?? [],
      imageWidth: item.imageWidth ?? null,
      localQuantity: item.localQuantity ?? 0,
      textPreview: item.textPreview,
      title: item.title,
      totalQuantity: item.totalQuantity ?? 0,
      videoId: item.videoId ?? null,
    })),
    unitCount: container.unitCount ?? 0,
    visualPreset: toVisualPresetDto(container.visualPreset, visual),
  };
}

function toContainerDto(
  container: InventoryContainerRecord,
  visual: EditableInventoryContainerVisual | null = null,
): InventoryContainerDto {
  return {
    createdAt: container.createdAt.toISOString(),
    id: container.id,
    location: container.location,
    locationId: container.locationId,
    metadata: container.metadata,
    name: container.name,
    normalizedName: container.normalizedName,
    referenceId: container.referenceId,
    sizeLiters: container.sizeLiters,
    updatedAt: container.updatedAt.toISOString(),
    visualPreset: toVisualPresetDto(container.visualPreset, visual),
    visualPresetKey: container.visualPresetKey,
  };
}

function toBoundsTuple(
  bounds: ReadonlyArray<{
    x: number;
    y: number;
  }>,
): [
  (typeof bounds)[number],
  (typeof bounds)[number],
  (typeof bounds)[number],
  (typeof bounds)[number],
] {
  return [
    { ...bounds[0]! },
    { ...bounds[1]! },
    { ...bounds[2]! },
    { ...bounds[3]! },
  ];
}

function toEditableVisualDto(
  visual: EditableInventoryContainerVisual,
): EditableVisualDto {
  return {
    ...visual,
    bounds: toBoundsTuple(visual.bounds),
    defaultBounds: toBoundsTuple(visual.defaultBounds),
    defaultHoverBounds: toBoundsTuple(visual.defaultHoverBounds),
    hoverBounds: toBoundsTuple(visual.hoverBounds),
  };
}

function toVisualPresetDto(
  preset: InventoryContainerVisualPresetRecord,
  visual: EditableInventoryContainerVisual | null = null,
): z.infer<typeof visualPresetSchema> {
  return {
    ...preset,
    bounds: toBoundsTuple(visual?.bounds ?? preset.bounds),
    hoverBounds: toBoundsTuple(
      visual?.hoverBounds ?? visual?.bounds ?? preset.bounds,
    ),
  };
}

function toShelfItemDto(
  item: InventoryItemRecord,
  containerId: string,
): InventoryContainerShelfItemDto {
  const placements = item.placements ?? [];

  return {
    audioId: item.audioNotes?.[0]?.id ?? null,
    hasAudio: (item.audioNotes?.length ?? 0) > 0,
    id: item.id,
    imageHeight: item.images[0]?.height ?? null,
    imageId: item.images[0]?.id ?? null,
    imageIds: item.images.flatMap((image) => (image.id ? [image.id] : [])),
    imageWidth: item.images[0]?.width ?? null,
    localQuantity:
      placements.find((placement) => placement.containerId === containerId)
        ?.quantity ?? 0,
    textPreview: item.captureText ?? null,
    title:
      item.title ??
      item.captureText?.slice(0, 120) ??
      item.note?.slice(0, 120) ??
      "Untitled inventory item",
    totalQuantity:
      item.totalQuantity ??
      placements.reduce((total, placement) => total + placement.quantity, 0),
    videoId:
      item.assets?.find(
        (asset) => asset.id && asset.mimeType?.startsWith("video/"),
      )?.id ?? null,
  };
}

function toMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function getEditableVisual(
  database: InventoryContainerDatabaseClient,
  presetKey: string,
): Promise<EditableInventoryContainerVisual | null> {
  const visuals =
    await listInventoryContainerVisualBoundsWithDatabase(database);

  return visuals.find((visual) => visual.key === presetKey) ?? null;
}

async function listInventoryContainerVisualBoundsWithDatabase(
  database: InventoryContainerDatabaseClient,
): Promise<EditableInventoryContainerVisual[]> {
  const overrides =
    await database.inventoryContainerVisualBoundsOverride.findMany();
  const overridesByKey = new Map(
    overrides.map((override) => [override.presetKey, override]),
  );

  return listInventoryContainerVisualCatalog().map((preset) => {
    const override = overridesByKey.get(preset.key);
    const bounds = isInventoryContainerVisualBounds(override?.bounds)
      ? override.bounds
      : preset.itemBounds;
    const hoverBounds = isInventoryContainerVisualBounds(override?.hoverBounds)
      ? override.hoverBounds
      : bounds;

    return {
      bounds,
      defaultBounds: preset.itemBounds,
      defaultHoverBounds: preset.itemBounds,
      frontImageUrl: preset.assets.front.webpPath,
      height: preset.dimensions.height,
      hoverBounds,
      key: preset.key,
      name: preset.name,
      width: preset.dimensions.width,
    };
  });
}

async function saveInventoryContainerVisualBoundsWithDatabase(
  database: InventoryContainerDatabaseClient,
  input: {
    bounds: unknown;
    hoverBounds: unknown;
    presetKey: string;
  },
): Promise<void> {
  const preset = getInventoryContainerVisualCatalogEntry(input.presetKey);

  if (!preset) {
    throw new Error("Container visual preset was not found.");
  }

  if (!isInventoryContainerVisualBounds(input.bounds)) {
    throw new Error("Item bounds must form a clockwise convex shape.");
  }

  if (!isInventoryContainerVisualBounds(input.hoverBounds)) {
    throw new Error("Hover bounds must form a clockwise convex shape.");
  }

  await database.inventoryContainerVisualBoundsOverride.upsert({
    where: { presetKey: preset.key },
    create: {
      bounds: input.bounds as unknown as Prisma.InputJsonValue,
      hoverBounds: input.hoverBounds as unknown as Prisma.InputJsonValue,
      presetKey: preset.key,
    },
    update: {
      bounds: input.bounds as unknown as Prisma.InputJsonValue,
      hoverBounds: input.hoverBounds as unknown as Prisma.InputJsonValue,
    },
  });
}

async function hashNormalizedRequest(
  requestBody: Record<string, unknown>,
): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(requestBody));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

async function refreshInventoryItem(
  transaction: InventoryContainerDatabaseClient,
  itemId: string,
): Promise<void> {
  const item = await transaction.inventoryItem.findUnique({
    where: { id: itemId },
    include: itemInclude,
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  const mapped = mapItem(item as InventoryItemWithRelations);
  const searchText = buildInventoryItemSearchText(mapped);

  if (searchText !== mapped.searchText) {
    await transaction.inventoryItem.update({
      where: { id: itemId },
      data: { searchText },
    });
  }
}

export {
  createContainerRoute,
  deleteContainerRoute,
  getContainerContentsRoute,
  getContainerRoute,
  inventoryContainersRouteHandlers,
  listContainersRoute,
  listVisualsRoute,
  moveItemsToContainerRoute,
  registerInventoryContainerRoutes,
  resolveByReferenceRoute,
  saveBoundsRoute,
  updateContainerRoute,
  type InventoryContainerMutationRunner,
  type InventoryContainersRouteHandlers,
};
