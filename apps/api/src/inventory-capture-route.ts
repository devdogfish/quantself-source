import { withOriginalUploadSlot, originalsEnabled } from "./original-storage";
import { createRoute, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiErrorSchema, jsonApiError } from "./api-error-response";
import {
  authorizationErrorSchema,
  jsonAuthorizationFailure,
} from "./authorization-response";
import {
  idempotencyConflictMessage,
  runIdempotentCommand,
  type IdempotentCommandResult,
} from "./idempotency";
import {
  InventoryImageNormalizationError,
} from "./inventory-image-normalization";
import {
  inventoryItemSchema,
  mapInventoryItem,
  type InventoryItem,
} from "./inventory-items-route";
import {
  generateInventoryCaptureMetadata,
  inventoryCategoryValues,
} from "./inventory-capture-metadata";
import {
  defaultInventoryClothingProfileAttributes,
} from "./inventory-service";
import {
  createInventoryItemMediaRecords,
  deleteStoredItemMediaOrThrow,
  fingerprintItemMediaFiles,
  inventoryItemMediaBodyLimit,
  inventoryItemMediaSchema,
  maximumItemMediaFileCount,
  maximumItemMediaFileSizeBytes,
  maximumItemMediaRequestSizeBytes,
  maximumItemMediaUploadSizeBytes,
  queueItemMediaPreprocessing,
  storeInventoryItemMediaFiles,
  validateItemMediaFiles,
  type InventoryStoredItemMedia,
} from "./inventory-item-media-route";

const inventoryItemKinds = ["ITEM", "GROUP"] as const;
const inventoryItemStatuses = ["KEEP", "DONATE", "TRASH", "UNSURE"] as const;
const inventoryImportanceValues = ["HIGH", "MEDIUM", "LOW"] as const;
const inventoryAcquisitionSourceValues = [
  "online",
  "retail",
  "gift",
  "found",
  "work",
  "secondhand",
  "other",
] as const;

const sessionContainerSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "container_123" }),
    locationName: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "Hall closet" }),
    name: z.string().min(1).openapi({ example: "Blue bin 4" }),
    referenceId: z.string().min(1).openapi({ example: "BIN-0004" }),
    sizeLiters: z.number().positive().nullable().openapi({ example: 45 }),
    visualPresetKey: z.string().min(1).openapi({ example: "39L" }),
  })
  .openapi("InventoryCaptureSessionContainer");

const inventoryCaptureSessionSchema = z
  .object({
    container: sessionContainerSchema.nullable(),
    containerLabel: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "Blue bin 4" }),
    destinationLocation: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "Hall closet" }),
    id: z.string().min(1).openapi({ example: "session_123" }),
    label: z.string().min(1).nullable().openapi({ example: "Apartment reset" }),
    note: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "Keep travel gear together." }),
    originRoom: z.string().min(1).nullable().openapi({ example: "Office" }),
  })
  .openapi("InventoryCaptureSession");

const inventoryCaptureSessionResponseSchema = z
  .object({
    session: inventoryCaptureSessionSchema.nullable(),
  })
  .openapi("InventoryCaptureSessionResponse");

const saveInventoryCaptureSessionDefaultsRequestSchema = z
  .object({
    defaultContainerId: z.string().min(1).nullable().optional(),
    defaultContainerLabel: z.string().min(1).nullable().optional(),
    destinationLocation: z.string().min(1).nullable().optional(),
    id: z.string().min(1).nullable().optional(),
    label: z.string().min(1).nullable().optional(),
    note: z.string().min(1).nullable().optional(),
    originRoom: z.string().min(1).nullable().optional(),
  })
  .openapi("SaveInventoryCaptureSessionDefaultsRequest");

const idempotencyKeyHeadersSchema = z.object({
  "Idempotency-Key": z
    .string()
    .trim()
    .min(1)
    .max(255)
    .openapi({
      example: "capture-item-018f5f86",
      param: {
        in: "header",
        name: "Idempotency-Key",
      },
    }),
});

const captureInventoryItemMetadataSchema = z.object({
  acquisitionSource: z
    .enum(inventoryAcquisitionSourceValues)
    .nullable()
    .optional()
    .openapi({
      description: "Known acquisition channel for the physical Item.",
    }),
  captureSessionId: z.string().min(1).nullable().optional(),
  captureText: z.string().min(1).nullable().optional().openapi({
    description: "Source evidence describing the Item; preserve observed details here.",
  }),
  category: z.enum(inventoryCategoryValues).nullable().optional().openapi({
    description:
      "Use generic capture for food, supplement, and clothing. Food and supplement have no specialist Profile. Clothing creates a default Clothing Profile. Never use generic capture for a remedy; use POST /api/v1/inventory-remedies so the Remedy Profile and linked Substance are created atomically.",
    example: "food",
  }),
  containerId: z.string().min(1).nullable().optional().openapi({
    description:
      "Initial Container Placement target. Mutually exclusive with locationId.",
  }),
  containerLabelOverride: z.string().min(1).nullable().optional(),
  costCents: z.int().nonnegative().nullable().optional(),
  costCurrency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .refine((value) => value.toUpperCase() === "CAD", {
      message: "Estimated value currency must be CAD.",
    })
    .nullable()
    .optional(),
  importance: z.enum(inventoryImportanceValues).nullable().optional(),
  kind: z.enum(inventoryItemKinds).nullable().optional(),
  locationId: z.string().min(1).nullable().optional().openapi({
    description:
      "Initial direct Inventory Location Placement target. Mutually exclusive with containerId.",
  }),
  note: z.string().min(1).nullable().optional(),
  quantity: z.int().positive().optional().openapi({
    description:
      "Initial aggregate Item quantity at the selected Placement; defaults to 1.",
    example: 1,
  }),
  status: z.enum(inventoryItemStatuses).nullable().optional(),
  title: z.string().min(1).nullable().optional().openapi({
    description: "Human-readable Item name when known.",
  }),
});

const captureInventoryItemRequestSchema =
  captureInventoryItemMetadataSchema
    .refine(
      (request) =>
        [request.captureText, request.note, request.title].some((value) =>
          Boolean(value?.trim()),
        ),
      {
        message:
          "Inventory Item capture requires a title, note, or capture text.",
      },
    )
    .refine((request) => !(request.containerId && request.locationId), {
      message:
        "Capture may target either a Container or an Inventory Location, not both.",
      path: ["locationId"],
    })
    .refine(
      (request) => !(request.locationId && request.containerLabelOverride),
      {
        message:
          "Container label overrides are only valid for unplaced or Container-targeted capture.",
        path: ["containerLabelOverride"],
      },
    )
    .openapi("CaptureInventoryItemRequest", {
      description:
        "Creates Food, Supplement, Clothing, or generic Inventory Items from source facts. Do not use for Remedy Registration.",
    });

const captureInventoryItemResponseSchema = z
  .object({
    media: z.array(inventoryItemMediaSchema),
    preprocessingJob: z.object({
      id: z.string().min(1).openapi({ example: "preprocessing_job_123" }),
      status: z.literal("QUEUED").openapi({ example: "QUEUED" }),
    }),
    item: inventoryItemSchema,
  })
  .openapi("CaptureInventoryItemResponse");

type InventoryCaptureSession = z.infer<typeof inventoryCaptureSessionSchema>;
type SaveInventoryCaptureSessionDefaultsRequest = z.infer<
  typeof saveInventoryCaptureSessionDefaultsRequestSchema
>;
type CaptureInventoryItemRequest = z.infer<
  typeof captureInventoryItemRequestSchema
>;
type CaptureInventoryItemResponse = z.infer<
  typeof captureInventoryItemResponseSchema
>;

type SessionWithRelations = Prisma.InventoryCaptureSessionGetPayload<{
  include: typeof sessionInclude;
}>;

type ItemWithRelations = {
  archivedAt: Date | null;
  captureText: string | null;
  id: string;
  images: Array<{ id: string }>;
  placements: Array<{
    containerId: string | null;
    container: {
      location: {
        id: string;
        name: string;
      } | null;
      name: string;
      referenceId: string;
    } | null;
    id: string;
    location: {
      id: string;
      name: string;
    } | null;
    locationId: string | null;
    note: string | null;
    quantity: number;
  }>;
  searchText: string;
  title: string | null;
};

type InventoryCaptureSessionRouteHandlers = {
  getActiveSession: () => Promise<InventoryCaptureSession | null>;
  saveDefaults: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "saveInventoryCaptureSessionDefaults";
    request: SaveInventoryCaptureSessionDefaultsRequest;
  }) => Promise<InventoryCaptureSession>;
};

type InventoryItemCaptureRouteHandlers = {
  captureItem: (input: {
    clientId: string;
    files: File[];
    idempotencyKey: string;
    operation: "captureInventoryItem";
    request: CaptureInventoryItemRequest;
  }) => Promise<CaptureInventoryItemResponse>;
};

type InventoryItemCaptureCommandRunner = (input: {
  clientId: string;
  timeoutMs?: number;
  execute: (transaction: Prisma.TransactionClient) => Promise<{
    body: CaptureInventoryItemResponse;
    kind: "success";
    status: number;
  }>;
  idempotencyKey: string;
  operation: string;
  request: Record<string, unknown>;
}) => Promise<IdempotentCommandResult<CaptureInventoryItemResponse>>;

type InventoryItemCaptureDependencies = {
  cleanupStoredMedia: typeof deleteStoredItemMediaOrThrow;
  runCommand: InventoryItemCaptureCommandRunner;
  storeMedia: typeof storeInventoryItemMediaFiles;
};

const sessionInclude = {
  defaultContainer: {
    include: {
      location: true,
    },
  },
  defaultDestinationLocation: true,
  defaultOriginLocation: true,
} satisfies Prisma.InventoryCaptureSessionInclude;

const itemInclude = {
  images: {
    orderBy: { position: "asc" },
    select: { id: true },
    take: 1,
  },
  placements: {
    orderBy: { createdAt: "asc" },
    select: {
      containerId: true,
      container: {
        select: {
          location: {
            select: {
              id: true,
              name: true,
            },
          },
          name: true,
          referenceId: true,
        },
      },
      id: true,
      location: {
        select: {
          id: true,
          name: true,
        },
      },
      locationId: true,
      note: true,
      quantity: true,
    },
  },
} as const;

const inventoryCaptureSessionRouteHandlers = {
  async getActiveSession() {
    const session = await prisma.inventoryCaptureSession.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
      include: sessionInclude,
    });

    return session ? mapInventoryCaptureSession(session) : null;
  },

  async saveDefaults(input) {
    const result = await runIdempotentCommand({
      clientId: input.clientId,
      execute: async (transaction) => {
        const defaultOriginLocation = await upsertLocation(transaction, {
          kind: "ROOM",
          name: input.request.originRoom ?? null,
        });
        const defaultDestinationLocation = await upsertLocation(transaction, {
          kind: inferLocationKind(input.request.destinationLocation ?? null),
          name: input.request.destinationLocation ?? null,
        });
        const defaultContainer = await findContainer(
          transaction,
          input.request.defaultContainerId,
        );
        const existingActiveSession = cleanOptional(input.request.id)
          ? null
          : await transaction.inventoryCaptureSession.findFirst({
              where: { endedAt: null },
              orderBy: { startedAt: "desc" },
              select: { id: true },
            });
        const data = {
          defaultContainerId: defaultContainer?.id ?? null,
          defaultContainerLabel:
            cleanOptional(input.request.defaultContainerLabel) ?? null,
          defaultDestinationLocationId: defaultDestinationLocation?.id ?? null,
          defaultOriginLocationId: defaultOriginLocation?.id ?? null,
          label: cleanOptional(input.request.label) ?? null,
          note: cleanOptional(input.request.note) ?? null,
        };
        const requestedId = cleanOptional(input.request.id);
        const session = requestedId
          ? await transaction.inventoryCaptureSession.upsert({
              create: {
                id: requestedId,
                ...data,
              },
              include: sessionInclude,
              update: data,
              where: { id: requestedId },
            })
          : existingActiveSession
            ? await transaction.inventoryCaptureSession.update({
                data,
                include: sessionInclude,
                where: { id: existingActiveSession.id },
              })
            : await transaction.inventoryCaptureSession.create({
                data,
                include: sessionInclude,
              });

        return {
          body: {
            session: mapInventoryCaptureSession(session),
          },
          kind: "success" as const,
          status: 200,
        };
      },
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      request: sanitizeSaveSessionRequest(input.request),
    });

    return readIdempotentRouteResult(result).session;
  },
} satisfies InventoryCaptureSessionRouteHandlers;

function createInventoryItemCaptureRouteHandlers(
  dependencies: InventoryItemCaptureDependencies = {
    cleanupStoredMedia: deleteStoredItemMediaOrThrow,
    runCommand: (input) => runIdempotentCommand(input),
    storeMedia: storeInventoryItemMediaFiles,
  },
): InventoryItemCaptureRouteHandlers {
  return {
    async captureItem(input) {
      return withOriginalUploadSlot(async () => {
      const request = sanitizeCaptureItemRequest(input.request);
      const fileFingerprints = await fingerprintItemMediaFiles(input.files);
      let storedMedia: InventoryStoredItemMedia[] = [];

      try {
        const result = await dependencies.runCommand({
          clientId: input.clientId,
          timeoutMs: originalsEnabled() ? 600_000 : undefined,
          execute: async (transaction) => {
            if (storedMedia.length === 0 && input.files.length > 0) {
              storedMedia = await dependencies.storeMedia(input.files, `capture:${input.clientId}:${input.idempotencyKey}`);
            }

            const session = await resolveCaptureSession(
              transaction,
              request.captureSessionId,
            );
            const location = await resolveCaptureLocation(transaction, {
              locationId: request.locationId,
            });
            const container = await resolveCaptureContainer(transaction, {
              containerId: request.containerId,
              locationId: request.locationId,
              session,
            });
            const title = cleanOptional(request.title);
            const note = cleanOptional(request.note);
            const captureText = cleanOptional(request.captureText);
            const quantity = normalizeQuantity(request.quantity);
            const placementLocation = container?.location ?? location;
            const containerLabel = container
              ? container.name
              : placementLocation
                ? null
                : (cleanOptional(request.containerLabelOverride) ??
                  session?.defaultContainerLabel ??
                  null);
            const locationName = placementLocation?.name ?? null;
            const kind = request.kind ?? "GROUP";
            const status = request.status ?? "UNSURE";
            const importance = request.importance ?? "MEDIUM";
            const generatedMetadata = generateInventoryCaptureMetadata({
              acquisitionSource: request.acquisitionSource ?? null,
              captureText,
              category: request.category ?? null,
              containerLabel,
              containerLocationName: locationName,
              containerReferenceId: container?.referenceId ?? null,
              costCents: request.costCents ?? null,
              importance,
              kind,
              note,
              status,
              title,
            });
            const item = await transaction.inventoryItem.create({
              data: {
                acquisitionSource: request.acquisitionSource ?? null,
                aliases: generatedMetadata.aliases,
                archivedAt: null,
                captureSessionId: session?.id ?? null,
                captureText,
                category: generatedMetadata.category,
                costCents: request.costCents ?? null,
                costCurrency: request.costCurrency ?? "CAD",
                importance,
                kind,
                metadata: generatedMetadata.metadata as Prisma.InputJsonValue,
                note,
                placements: {
                  create: {
                    containerId: container?.id ?? null,
                    locationId: location?.id ?? null,
                    note: container || location ? null : containerLabel,
                    quantity,
                  },
                },
                searchText: generatedMetadata.searchText,
                status,
                tags: generatedMetadata.tags,
                title,
                ...(generatedMetadata.category === "clothing"
                  ? {
                      clothingProfile: {
                        create: {
                          attributes:
                            defaultInventoryClothingProfileAttributes() as unknown as Prisma.InputJsonValue,
                        },
                      },
                    }
                  : {}),
              },
              include: itemInclude,
            });

            const media = await createInventoryItemMediaRecords(
              transaction,
              item.id,
              storedMedia,
            );
            const preprocessingJob = await queueItemMediaPreprocessing(
              transaction,
              item.id,
            );
            const completedItem =
              media.length > 0
                ? await transaction.inventoryItem.findUnique({
                    where: { id: item.id },
                    include: itemInclude,
                  })
                : item;

            if (!completedItem) {
              throw new Error("Captured Inventory Item was not found.");
            }

            return {
              body: {
                media,
                preprocessingJob: {
                  id: preprocessingJob.id,
                  status: "QUEUED" as const,
                },
                item: mapInventoryItem(
                  completedItem as ItemWithRelations,
                ),
              },
              kind: "success" as const,
              status: 201,
            };
          },
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
          request: {
            files: fileFingerprints,
            metadata: request,
          },
        });

        return readIdempotentRouteResult(result);
      } catch (error) {
        await dependencies.cleanupStoredMedia(storedMedia);
        throw error;
      }
      });
    },
  };
}

const inventoryItemCaptureRouteHandlers =
  createInventoryItemCaptureRouteHandlers();

const getInventoryCaptureSessionRoute = createRoute({
  method: "get",
  operationId: "getActiveInventoryCaptureSession",
  path: "/api/v1/inventory-capture-session",
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            session: {
              container: null,
              containerLabel: "Blue bin 4",
              destinationLocation: "Hall closet",
              id: "session_123",
              label: "Apartment reset",
              note: "Keep travel gear together.",
              originRoom: "Office",
            },
          },
          schema: inventoryCaptureSessionResponseSchema,
        },
      },
      description: "Active Capture Session.",
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
  summary: "Get active Capture Session",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns the active Capture Session defaults used by Inventory capture. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: no body. Success response: 200 with the active Capture Session or null when none exists. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const saveInventoryCaptureSessionDefaultsRoute = createRoute({
  method: "put",
  operationId: "saveInventoryCaptureSessionDefaults",
  path: "/api/v1/inventory-capture-session",
  request: {
    headers: idempotencyKeyHeadersSchema,
    body: {
      content: {
        "application/json": {
          example: {
            defaultContainerId: "container_123",
            defaultContainerLabel: "Blue bin 4",
            destinationLocation: "Hall closet",
            id: "session_123",
            label: "Apartment reset",
            note: "Keep travel gear together.",
            originRoom: "Office",
          },
          schema: saveInventoryCaptureSessionDefaultsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            session: {
              container: null,
              containerLabel: "Blue bin 4",
              destinationLocation: "Hall closet",
              id: "session_123",
              label: "Apartment reset",
              note: "Keep travel gear together.",
              originRoom: "Office",
            },
          },
          schema: inventoryCaptureSessionResponseSchema,
        },
      },
      description: "Saved Capture Session defaults.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
              "Idempotency-Key header is required and must not exceed 255 characters.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The command is missing or has an invalid Idempotency-Key, or its body is invalid.",
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
            code: "INVENTORY_CONTAINER_NOT_FOUND",
            message: "Selected container was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The selected default Container does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "IDEMPOTENCY_CONFLICT",
            message: idempotencyConflictMessage,
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Idempotency-Key was already used with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Save Capture Session defaults",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Creates or updates the active Capture Session defaults. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with Capture Session default fields and Idempotency-Key header. Success response: 200 with the saved Capture Session. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the selected Container is missing, 409 when the key is reused with different input. Side effects: creates or updates Inventory Capture Session defaults and any referenced Inventory Locations. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const captureInventoryItemRoute = createRoute({
  method: "post",
  middleware: [inventoryItemMediaBodyLimit],
  operationId: "captureInventoryItem",
  path: "/api/v1/inventory-items/capture",
  request: {
    headers: idempotencyKeyHeadersSchema,
    body: {
      content: {
        "application/json": {
          example: {
            captureText: "Navy hoodie",
            category: "clothing",
            locationId: "location-wardrobe",
            quantity: 1,
          },
          schema: captureInventoryItemRequestSchema,
        },
        "multipart/form-data": {
          schema: z.any().openapi({
            example: {
              files: ["<binary>"],
              metadata: JSON.stringify({
                captureText: "Navy hoodie",
                category: "clothing",
                locationId: "location-wardrobe",
              }),
            },
            properties: {
              files: {
                items: { format: "binary", type: "string" },
                type: "array",
              },
              metadata: {
                contentMediaType: "application/json",
                contentSchema: {
                  $ref: "#/components/schemas/CaptureInventoryItemRequest",
                },
                description: "JSON-encoded Capture Inventory Item fields.",
                type: "string",
              },
            },
            required: ["metadata"],
            type: "object",
          } as never),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            media: [
              {
                contentType: "image/jpeg",
                id: "image_123",
                kind: "image",
                originalName: "front.jpg",
                position: 0,
                sizeBytes: 2048,
              },
            ],
            preprocessingJob: {
              id: "preprocessing_job_123",
              status: "QUEUED",
            },
            item: {
              id: "item_123",
              imageId: "image_123",
              placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
              title: "Passport pouch",
              totalQuantity: 2,
            },
          },
          schema: captureInventoryItemResponseSchema,
        },
      },
      description: "Captured Inventory Item.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
              "Idempotency-Key header is required and must not exceed 255 characters.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The command is missing or has an invalid Idempotency-Key, or its body is invalid.",
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
            code: "INVENTORY_CAPTURE_RESOURCE_NOT_FOUND",
            message: "Requested Capture Session was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The requested Capture Session, Container, or Inventory Location does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "IDEMPOTENCY_CONFLICT",
            message: idempotencyConflictMessage,
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Idempotency-Key was already used with different input.",
    },
    413: {
      content: {
        "application/json": {
          example: {
            code: "PAYLOAD_TOO_LARGE",
            message: `Item Media requests must be at most ${maximumItemMediaRequestSizeBytes} bytes.`,
          },
          schema: apiErrorSchema,
        },
      },
      description: "The multipart capture exceeded the transport limit.",
    },
    415: {
      content: {
        "application/json": {
          example: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message:
              "Inventory Item capture requires application/json or multipart/form-data.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The request media type is not supported for capture.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Capture Inventory Item",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description: `Captures an Inventory Item from text and/or initial Item Media in one request. Use category food or supplement for thin Item-only records; use category clothing to create the Item and a default Clothing Profile. Do not use this operation for remedies; use POST /api/v1/inventory-remedies. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: either a JSON body with capture fields, or multipart form data with JSON metadata plus 0-${maximumItemMediaFileCount} repeated files fields; each file is limited to ${maximumItemMediaFileSizeBytes} bytes, file bytes per request to ${maximumItemMediaUploadSizeBytes} bytes, and multipart transport to ${maximumItemMediaRequestSizeBytes} bytes. JPEG, PNG, WebP, and GIF image orientation is physically normalized before storage; HEIC and HEIF are rejected. At least one title, note, capture text, or non-empty file is required. Success response: 201 with the captured Inventory Item, created Item Media metadata, and queued Inventory Preprocessing job identity/status. Failure responses: 400 when the request, image normalization, or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the requested Capture Session, Container, or Inventory Location is missing, 409 when the key is reused with different metadata or file identity/content, 413 when multipart transport is too large, 415 when the request media type is unsupported. Side effects: stages files, then atomically creates one Inventory Item, its optional Clothing Profile, initial Placement, all initial Item Media, idempotency result, and exactly one queued Inventory Preprocessing job containing every initial source reference; failures compensate staged files. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized metadata and ordered file names, MIME types, sizes, and bytes replays the original result without duplicate records or files.`,
});

function registerInventoryCaptureRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  captureSessionHandlers: InventoryCaptureSessionRouteHandlers,
  itemCaptureHandlers: InventoryItemCaptureRouteHandlers,
) {
  app.openapi(getInventoryCaptureSessionRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    return context.json(
      {
        session: await captureSessionHandlers.getActiveSession(),
      },
      200,
    );
  });

  app.openapi(saveInventoryCaptureSessionDefaultsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey = context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        (await context.req.json()) as SaveInventoryCaptureSessionDefaultsRequest;
      const session = await captureSessionHandlers.saveDefaults({
        clientId: authorization.accessContext.client.id,
        idempotencyKey,
        operation: "saveInventoryCaptureSessionDefaults",
        request: sanitizeSaveSessionRequest(request),
      });

      return context.json({ session }, 200);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }
      if (error instanceof InventoryCaptureResourceNotFoundError) {
        return jsonApiError(context, {
          code: error.code,
          message: error.message,
          status: 404,
        });
      }

      throw error;
    }
  });

  app.openapi(captureInventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey = context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const contentType = context.req.header("content-type") ?? "";
      const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();

      if (
        mediaType !== "application/json" &&
        mediaType !== "multipart/form-data"
      ) {
        return jsonApiError(context, {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message:
            "Inventory Item capture requires application/json or multipart/form-data.",
          status: 415,
        });
      }

      let request: CaptureInventoryItemRequest;
      let files: File[] = [];

      if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        let body: Awaited<ReturnType<typeof context.req.parseBody>>;

        try {
          body = await context.req.parseBody({ all: true });
        } catch {
          return jsonApiError(context, {
            code: "INVALID_REQUEST",
            message: "A valid multipart Inventory Item capture is required.",
            status: 400,
          });
        }

        files = [body.files]
          .flat()
          .filter(
            (value): value is File => value instanceof File && value.size > 0,
          );
        const fileError =
          files.length > 0 ? validateItemMediaFiles(files) : null;

        if (fileError) {
          return jsonApiError(context, {
            code: "INVALID_REQUEST",
            message: fileError,
            status: 400,
          });
        }

        const metadata = Array.isArray(body.metadata)
          ? body.metadata[0]
          : body.metadata;
        let parsedMetadata: unknown;

        try {
          parsedMetadata = JSON.parse(
            typeof metadata === "string" ? metadata : "",
          );
        } catch {
          return jsonApiError(context, {
            code: "INVALID_REQUEST",
            message: "Multipart metadata must be valid JSON.",
            status: 400,
          });
        }

        const parsed =
          captureInventoryItemMetadataSchema.safeParse(parsedMetadata);

        if (
          !parsed.success ||
          (files.length === 0 &&
            ![
              parsed.data.captureText,
              parsed.data.note,
              parsed.data.title,
            ].some((value) => Boolean(value?.trim())))
        ) {
          return jsonApiError(context, {
            code: "INVALID_REQUEST",
            message: "Request validation failed.",
            status: 400,
          });
        }

        request = parsed.data;
      } else {
        request = (await context.req.json()) as CaptureInventoryItemRequest;
      }

      const response = await itemCaptureHandlers.captureItem({
        clientId: authorization.accessContext.client.id,
        files,
        idempotencyKey,
        operation: "captureInventoryItem",
        request: sanitizeCaptureItemRequest(request),
      });

      return context.json(response, 201);
    } catch (error) {
      if (error instanceof InventoryImageNormalizationError) {
        return jsonApiError(context, {
          code: "INVALID_REQUEST",
          message: error.message,
          status: 400,
        });
      }
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }
      if (error instanceof InventoryCaptureResourceNotFoundError) {
        return jsonApiError(context, {
          code: error.code,
          message: error.message,
          status: 404,
        });
      }

      throw error;
    }
  });
}

function mapInventoryCaptureSession(
  session: SessionWithRelations,
): InventoryCaptureSession {
  return {
    container: session.defaultContainer
      ? {
          id: session.defaultContainer.id,
          locationName: session.defaultContainer.location?.name ?? null,
          name: session.defaultContainer.name,
          referenceId: session.defaultContainer.referenceId,
          sizeLiters: session.defaultContainer.sizeLiters ?? null,
          visualPresetKey: session.defaultContainer.visualPresetKey,
        }
      : null,
    containerLabel: session.defaultContainerLabel ?? null,
    destinationLocation: session.defaultDestinationLocation?.name ?? null,
    id: session.id,
    label: session.label ?? null,
    note: session.note ?? null,
    originRoom: session.defaultOriginLocation?.name ?? null,
  };
}

function cleanOptional(value: string | null | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function sanitizeSaveSessionRequest(
  request: SaveInventoryCaptureSessionDefaultsRequest,
): SaveInventoryCaptureSessionDefaultsRequest {
  return {
    defaultContainerId: cleanOptional(request.defaultContainerId),
    defaultContainerLabel: cleanOptional(request.defaultContainerLabel),
    destinationLocation: cleanOptional(request.destinationLocation),
    id: cleanOptional(request.id),
    label: cleanOptional(request.label),
    note: cleanOptional(request.note),
    originRoom: cleanOptional(request.originRoom),
  };
}

function sanitizeCaptureItemRequest(
  request: CaptureInventoryItemRequest,
): CaptureInventoryItemRequest {
  return {
    acquisitionSource: request.acquisitionSource ?? null,
    captureSessionId: cleanOptional(request.captureSessionId),
    captureText: cleanOptional(request.captureText),
    category: request.category ?? null,
    containerId:
      request.containerId === undefined
        ? undefined
        : cleanOptional(request.containerId),
    containerLabelOverride: cleanOptional(request.containerLabelOverride),
    costCents: request.costCents ?? null,
    costCurrency: (cleanOptional(request.costCurrency) ?? "CAD").toUpperCase(),
    importance: request.importance ?? null,
    kind: request.kind ?? null,
    locationId:
      request.locationId === undefined
        ? undefined
        : cleanOptional(request.locationId),
    note: cleanOptional(request.note),
    quantity: request.quantity ?? 1,
    status: request.status ?? null,
    title: cleanOptional(request.title),
  };
}

type InventoryLocationKind = "AREA" | "OTHER" | "ROOM" | "SHELF" | "STORAGE";

function inferLocationKind(value: string | null): InventoryLocationKind {
  const normalized = cleanOptional(value)?.toLowerCase() ?? "";

  if (!normalized) {
    return "OTHER";
  }
  if (/\b(room|office|bedroom|kitchen|bathroom)\b/u.test(normalized)) {
    return "ROOM";
  }
  if (/\b(shelf|rack|drawer)\b/u.test(normalized)) {
    return "SHELF";
  }
  if (/\b(closet|garage|storage|locker|bin)\b/u.test(normalized)) {
    return "STORAGE";
  }

  return "AREA";
}

function normalizeLocationName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

async function upsertLocation(
  transaction: Prisma.TransactionClient,
  input: {
    kind: InventoryLocationKind;
    name: string | null;
  },
) {
  const name = cleanOptional(input.name);

  if (!name) {
    return null;
  }

  return transaction.inventoryLocation.upsert({
    create: {
      kind: input.kind,
      name,
      normalizedName: normalizeLocationName(name),
    },
    update: {
      kind: input.kind,
      name,
    },
    where: {
      normalizedName: normalizeLocationName(name),
    },
  });
}

async function findContainer(
  transaction: Prisma.TransactionClient,
  containerId: string | null | undefined,
) {
  const id = cleanOptional(containerId);

  if (!id) {
    return null;
  }

  const container = await transaction.inventoryContainer.findUnique({
    where: { id },
    include: {
      location: true,
    },
  });

  if (!container) {
    throw new InventoryCaptureResourceNotFoundError(
      "INVENTORY_CONTAINER_NOT_FOUND",
      "Selected container was not found.",
    );
  }

  return container;
}

async function findLocation(
  transaction: Prisma.TransactionClient,
  locationId: string | null | undefined,
) {
  const id = cleanOptional(locationId);

  if (!id) {
    return null;
  }

  const location = await transaction.inventoryLocation.findUnique({
    where: { id },
  });

  if (!location) {
    throw new InventoryCaptureResourceNotFoundError(
      "INVENTORY_LOCATION_NOT_FOUND",
      "Selected Inventory Location was not found.",
    );
  }

  return location;
}

async function resolveCaptureSession(
  transaction: Prisma.TransactionClient,
  captureSessionId: string | null | undefined,
) {
  const sessionId = cleanOptional(captureSessionId);

  if (sessionId) {
    const session = await transaction.inventoryCaptureSession.findUnique({
      where: { id: sessionId },
      include: sessionInclude,
    });

    if (!session) {
      throw new InventoryCaptureResourceNotFoundError(
        "INVENTORY_CAPTURE_SESSION_NOT_FOUND",
        "Requested Capture Session was not found.",
      );
    }

    return session;
  }

  return transaction.inventoryCaptureSession.findFirst({
    where: { endedAt: null },
    orderBy: { startedAt: "desc" },
    include: sessionInclude,
  });
}

async function resolveCaptureContainer(
  transaction: Prisma.TransactionClient,
  input: {
    containerId: string | null | undefined;
    locationId: string | null | undefined;
    session: SessionWithRelations | null;
  },
) {
  if (input.locationId !== undefined) {
    return null;
  }

  if (input.containerId === undefined) {
    if (!input.session?.defaultContainerId) {
      return null;
    }

    return transaction.inventoryContainer.findUnique({
      where: { id: input.session.defaultContainerId },
      include: {
        location: true,
      },
    });
  }

  return findContainer(transaction, input.containerId);
}

async function resolveCaptureLocation(
  transaction: Prisma.TransactionClient,
  input: {
    locationId: string | null | undefined;
  },
) {
  if (input.locationId === undefined) {
    return null;
  }

  return findLocation(transaction, input.locationId);
}

function normalizeQuantity(value: number | null | undefined) {
  const quantity = value ?? 1;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }

  return quantity;
}

class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

class InventoryCaptureResourceNotFoundError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_CAPTURE_SESSION_NOT_FOUND"
      | "INVENTORY_CONTAINER_NOT_FOUND"
      | "INVENTORY_LOCATION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "InventoryCaptureResourceNotFoundError";
  }
}

function readIdempotentRouteResult<T extends Record<string, unknown>>(
  result: IdempotentCommandResult<T>,
) {
  if (result.kind === "conflict") {
    throw new IdempotencyConflictError(
      result.message ?? idempotencyConflictMessage,
    );
  }

  return result.body;
}

export {
  createInventoryItemCaptureRouteHandlers,
  inventoryCaptureSessionRouteHandlers,
  inventoryItemCaptureRouteHandlers,
  registerInventoryCaptureRoutes,
  type InventoryCaptureSessionRouteHandlers,
  type InventoryItemCaptureRouteHandlers,
};
