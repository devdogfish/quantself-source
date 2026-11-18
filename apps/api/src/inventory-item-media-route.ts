import { originalFiles, isOriginalReference, readOriginalBytes, queueOriginalDeletion } from "./original-files";
import { withOriginalUploadSlot, originalsEnabled, OriginalStorageError, assertOriginalWritesEnabled } from "./original-storage";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  authorizeAccessContext,
  resolveAuthSecret,
  type AccessContext,
} from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import sharp from "sharp";
import {
  authorizationErrorSchema,
  jsonAuthorizationFailure,
} from "./authorization-response";
import { apiErrorSchema, jsonApiError } from "./api-error-response";
import {
  idempotencyConflictMessage,
  runIdempotentCommand,
} from "./idempotency";
import {
  InventoryImageNormalizationError,
  normalizeInventoryImage,
} from "./inventory-image-normalization";
import { deleteInventoryStoredFiles } from "./inventory-storage";

const maximumItemMediaFileCount = 20;
const maximumItemMediaFileSizeBytes = 50 * 1024 * 1024;
const maximumItemMediaUploadSizeBytes = 100 * 1024 * 1024;
const maximumItemMediaRequestSizeBytes =
  maximumItemMediaUploadSizeBytes + 1024 * 1024;
const safeInlineImageMimeTypes = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const imagePreviewRepresentation = "preview";
const imagePreviewSize = 640;
const gptImagePreviewLifetimeMs = 5 * 60 * 1000;
const gptImagePreviewTokenVersion = "quantself-gpt-image-preview-v1";
const imageCacheControl = "private, max-age=604800";
const mediaCacheControl = "private, max-age=3600";
const pendingImageRepresentations = new Map<string, Promise<Buffer>>();

const extensionByMimeType: Record<string, string> = {
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const idempotencyKeyHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(255).openapi({
    example: "item-media-018f5f86",
  }),
});

const inventoryItemMediaPathParamsSchema = z.object({
  mediaId: z.string().min(1).openapi({ example: "image_123" }),
  itemId: z.string().min(1).openapi({ example: "item_123" }),
});

const inventoryItemMediaContentQuerySchema = z.object({
  representation: z.literal(imagePreviewRepresentation).optional(),
});

const inventoryItemPrimaryImageResponseSchema = z
  .object({
    imageUrl: z.string().url(),
  })
  .openapi("InventoryItemPrimaryImageResponse");

const inventoryItemMediaPreviewTokenParamsSchema = z.object({
  token: z.string().min(1),
});

const inventoryItemPathParamsSchema = z.object({
  itemId: z.string().min(1).openapi({ example: "item_123" }),
});

const inventoryItemMediaSchema = z
  .object({
    contentType: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "image/jpeg" }),
    id: z.string().min(1).openapi({ example: "image_123" }),
    kind: z.enum(["image", "audio", "asset"]).openapi({ example: "image" }),
    originalName: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "front.jpg" }),
    position: z.int().nonnegative().nullable().openapi({ example: 0 }),
    sizeBytes: z.int().nonnegative().nullable().openapi({ example: 2048 }),
  })
  .openapi("InventoryItemMedia");

const inventoryItemMediaListResponseSchema = z
  .object({
    media: z.array(inventoryItemMediaSchema).openapi({
      example: [
        {
          contentType: "image/jpeg",
          id: "image_123",
          kind: "image",
          originalName: "front.jpg",
          position: 0,
          sizeBytes: 2048,
        },
      ],
    }),
  })
  .openapi("InventoryItemMediaListResponse");

const inventoryItemMediaDeleteResponseSchema = z
  .object({
    deletedMediaId: z.string().min(1).openapi({ example: "image_123" }),
  })
  .openapi("InventoryItemMediaDeleteResponse");

const inventoryItemImageOrderRequestSchema = z.object({
  imageIds: z
    .array(z.string().min(1))
    .min(1)
    .openapi({ example: ["image_2", "image_1"] }),
});

const inventoryItemImageOrderResponseSchema = z
  .object({
    imageIds: z
      .array(z.string().min(1))
      .openapi({ example: ["image_2", "image_1"] }),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
  })
  .openapi("InventoryItemImageOrderResponse");

const inventoryItemMediaNotFoundErrorSchema = z
  .object({
    code: z.literal("NOT_FOUND").openapi({ example: "NOT_FOUND" }),
    message: z
      .string()
      .min(1)
      .openapi({ example: "Inventory Item Media not found." }),
  })
  .openapi("InventoryItemMediaNotFoundError");

type InventoryItemMediaKind = "asset" | "audio" | "image";

type InventoryItemMediaMetadata = z.infer<
  typeof inventoryItemMediaSchema
>;
type InventoryItemMediaDeleteResponse = z.infer<
  typeof inventoryItemMediaDeleteResponseSchema
>;
type InventoryItemImageOrderResponse = z.infer<
  typeof inventoryItemImageOrderResponseSchema
>;

type InventoryItemMediaFile = {
  filePath: string;
  kind: InventoryItemMediaKind;
  mimeType: string | null;
  originalName: string | null;
};

type InventoryStoredItemMedia = {
  filePath: string;
  kind: InventoryItemMediaKind;
  mimeType: string | null;
  originalName: string | null;
  sizeBytes: number | null;
};

type InventoryItemMediaDeletion = InventoryItemMediaDeleteResponse & {
  filePath: string;
};

type InventoryItemMediaMutationContext = {
  clientId: string;
  idempotencyKey: string;
};

type InventoryItemMediaListRow = {
  assets: Array<{
    id: string;
    mimeType: string | null;
    originalName: string | null;
    sizeBytes: number | null;
  }>;
  audioNotes: Array<{
    id: string;
    mimeType: string | null;
    originalName: string | null;
    sizeBytes: number | null;
  }>;
  images: Array<{
    id: string;
    mimeType: string | null;
    originalName: string | null;
    position: number | null;
    sizeBytes: number | null;
  }>;
};

type InventoryItemMediaMutationRow = {
  assets: Array<{
    filePath: string;
    id: string;
  }>;
  audioNotes: Array<{
    filePath: string;
    id: string;
  }>;
  images: Array<{
    filePath: string;
    id: string;
    position: number | null;
  }>;
};

type InventoryItemMediaRepository = {
  createMedia: (
    itemId: string,
    media: InventoryStoredItemMedia[],
    transaction?: Prisma.TransactionClient,
  ) => Promise<InventoryItemMediaMetadata[] | null>;
  deleteMedia: (
    itemId: string,
    mediaId: string,
    transaction?: Prisma.TransactionClient,
  ) => Promise<InventoryItemMediaDeletion | null>;
  findMediaFile: (
    itemId: string,
    mediaId: string,
    transaction?: Prisma.TransactionClient,
  ) => Promise<InventoryItemMediaFile | null>;
  listMedia: (
    itemId: string,
  ) => Promise<InventoryItemMediaMetadata[] | null>;
  reorderImages: (
    itemId: string,
    imageIds: string[],
    transaction?: Prisma.TransactionClient,
  ) => Promise<InventoryItemImageOrderResponse | null>;
};

type InventoryItemMediaRouteHandlers = {
  deleteMedia: (
    itemId: string,
    mediaId: string,
    mutation: InventoryItemMediaMutationContext,
  ) => Promise<InventoryItemMediaDeleteResponse | null>;
  getMediaFile: (
    itemId: string,
    mediaId: string,
  ) => Promise<InventoryItemMediaFile | null>;
  listMedia: (
    itemId: string,
  ) => Promise<InventoryItemMediaMetadata[] | null>;
  reorderImages: (
    itemId: string,
    imageIds: string[],
    mutation: InventoryItemMediaMutationContext,
  ) => Promise<InventoryItemImageOrderResponse | null>;
  uploadMedia: (
    itemId: string,
    files: File[],
    mutation: InventoryItemMediaMutationContext,
  ) => Promise<InventoryItemMediaMetadata[] | null>;
};

const inventoryItemMediaRepository: InventoryItemMediaRepository = {
  async createMedia(itemId, media, transaction) {
    if (media.length === 0) {
      return [];
    }

    const execute = async (database: Prisma.TransactionClient) => {
      const item = await requireActiveItem(database, itemId);

      if (!item) {
        return null;
      }

      const nextPosition =
        item.images.reduce(
          (maximum, image, index) => Math.max(maximum, image.position ?? index),
          -1,
        ) + 1;
      const created = await createInventoryItemMediaRecords(
        database,
        itemId,
        media,
        nextPosition,
      );

      await queueItemMediaPreprocessing(database, itemId);
      return created;
    };

    return transaction ? execute(transaction) : prisma.$transaction(execute);
  },

  async deleteMedia(itemId, mediaId, transaction) {
    const execute = async (database: Prisma.TransactionClient) => {
      const item = await requireActiveItem(database, itemId);

      if (!item) {
        return null;
      }

      const image = item.images.find((entry) => entry.id === mediaId);

      if (image) {
        await database.inventoryItemImage.delete({ where: { id: image.id } });
        await queueItemMediaPreprocessing(database, itemId);
        return { deletedMediaId: mediaId, filePath: image.filePath };
      }

      const audio = item.audioNotes.find((entry) => entry.id === mediaId);

      if (audio) {
        await database.inventoryItemAudio.delete({ where: { id: audio.id } });
        await queueItemMediaPreprocessing(database, itemId);
        return { deletedMediaId: mediaId, filePath: audio.filePath };
      }

      const asset = item.assets.find((entry) => entry.id === mediaId);

      if (asset) {
        await database.inventoryItemAsset.delete({ where: { id: asset.id } });
        await queueItemMediaPreprocessing(database, itemId);
        return { deletedMediaId: mediaId, filePath: asset.filePath };
      }

      return null;
    };

    return transaction ? execute(transaction) : prisma.$transaction(execute);
  },

  async findMediaFile(itemId, mediaId, transaction) {
    const database = transaction ?? prisma;
    const item = await database.inventoryItem.findUnique({
      select: mediaLookupInclude(mediaId),
      where: { id: itemId },
    });

    const image = item?.images[0];

    if (image) {
      return { ...image, kind: "image" as const };
    }

    const audio = item?.audioNotes[0];

    if (audio) {
      return { ...audio, kind: "audio" as const };
    }

    const asset = item?.assets[0];

    if (asset) {
      return { ...asset, kind: "asset" as const };
    }

    return null;
  },

  async listMedia(itemId) {
    const item = (await prisma.inventoryItem.findUnique({
      select: mediaListInclude,
      where: { id: itemId },
    })) as InventoryItemMediaListRow | null;

    if (!item) {
      return null;
    }

    return [
      ...item.images.map((image) => mapMediaRow("image", image)),
      ...item.audioNotes.map((audio) => mapMediaRow("audio", audio)),
      ...item.assets.map((asset) => mapMediaRow("asset", asset)),
    ];
  },

  async reorderImages(itemId, imageIds, transaction) {
    const execute = async (database: Prisma.TransactionClient) => {
      const item = await requireActiveItem(database, itemId);

      if (!item) {
        return null;
      }

      const currentIds = item.images.map(({ id }) => id).sort();
      const requestedIds = [...new Set(imageIds)].sort();

      if (
        currentIds.length !== requestedIds.length ||
        currentIds.some((id, index) => id !== requestedIds[index])
      ) {
        throw new InventoryItemMediaValidationError(
          "Image order must include every Item Image exactly once.",
        );
      }

      await Promise.all(
        imageIds.map((id, position) =>
          database.inventoryItemImage.update({
            data: { position },
            where: { id },
          }),
        ),
      );

      return { imageIds, itemId };
    };

    return transaction ? execute(transaction) : prisma.$transaction(execute);
  },
};

const mediaListInclude = {
  assets: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      mimeType: true,
      originalName: true,
      sizeBytes: true,
    },
  },
  audioNotes: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      mimeType: true,
      originalName: true,
      sizeBytes: true,
    },
  },
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      mimeType: true,
      originalName: true,
      position: true,
      sizeBytes: true,
    },
  },
} satisfies Prisma.InventoryItemSelect;

function mediaLookupInclude(mediaId: string) {
  return {
    assets: {
      select: {
        filePath: true,
        mimeType: true,
        originalName: true,
      },
      take: 1,
      where: { id: mediaId },
    },
    audioNotes: {
      select: {
        filePath: true,
        mimeType: true,
        originalName: true,
      },
      take: 1,
      where: { id: mediaId },
    },
    images: {
      select: {
        filePath: true,
        mimeType: true,
        originalName: true,
      },
      take: 1,
      where: { id: mediaId },
    },
  } satisfies Prisma.InventoryItemSelect;
}

function mediaMutationInclude() {
  return {
    assets: {
      orderBy: { createdAt: "asc" },
      select: { filePath: true, id: true },
    },
    audioNotes: {
      orderBy: { createdAt: "asc" },
      select: { filePath: true, id: true },
    },
    images: {
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { filePath: true, id: true, position: true },
    },
  } satisfies Prisma.InventoryItemSelect;
}

function createInventoryItemMediaRouteHandlers(
  repository: InventoryItemMediaRepository = inventoryItemMediaRepository,
): InventoryItemMediaRouteHandlers {
  return {
    async deleteMedia(itemId, mediaId, mutation) {
      let deletedFile: { bytes: Buffer | null; filePath: string } | undefined;

      try {
        const result = await runIdempotentCommand<
          Record<string, unknown>,
          Record<string, unknown>
        >({
          clientId: mutation.clientId,
          execute: async (transaction) => {
            const media = await repository.findMediaFile(
              itemId,
              mediaId,
              transaction,
            );

            if (!media) {
              return {
                body: inventoryItemMediaNotFoundBody(),
                kind: "success" as const,
                status: 404,
              };
            }

            assertOriginalWritesEnabled();
            if (isOriginalReference(media.filePath)) {
              await queueOriginalDeletion(media.filePath, transaction);
            } else if (!deletedFile) {
              deletedFile = {
                bytes: await readFileIfPresent(media.filePath),
                filePath: media.filePath,
              };
              const failures = await deleteInventoryStoredFiles([
                media.filePath,
              ]);

              if (failures.length > 0) {
                throw new Error("Could not delete stored Item Media.");
              }
            }

            const deleted = await repository.deleteMedia(
              itemId,
              mediaId,
              transaction,
            );

            if (!deleted) {
              return {
                body: inventoryItemMediaNotFoundBody(),
                kind: "success" as const,
                status: 404,
              };
            }

            return {
              body: { deletedMediaId: deleted.deletedMediaId },
              kind: "success" as const,
              status: 200,
            };
          },
          idempotencyKey: mutation.idempotencyKey,
          operation: "deleteInventoryItemMedia",
          request: { mediaId, itemId },
        });

        if (result.kind === "conflict") {
          throw new InventoryItemMediaIdempotencyConflictError();
        }

        if (result.status === 404) {
          if (deletedFile?.bytes) {
            await writeFile(deletedFile.filePath, deletedFile.bytes);
          }
          return null;
        }

        return result.body as InventoryItemMediaDeleteResponse;
      } catch (error) {
        if (deletedFile?.bytes) {
          await writeFile(deletedFile.filePath, deletedFile.bytes);
        }
        throw error;
      }
    },

    async getMediaFile(itemId, mediaId) {
      return repository.findMediaFile(itemId, mediaId);
    },

    async listMedia(itemId) {
      return repository.listMedia(itemId);
    },

    async reorderImages(itemId, imageIds, mutation) {
      const result = await runIdempotentCommand<
        Record<string, unknown>,
        Record<string, unknown>
      >({
        clientId: mutation.clientId,
        execute: async (transaction) => {
          const response = await repository.reorderImages(
            itemId,
            imageIds,
            transaction,
          );

          return response
            ? {
                body: response,
                kind: "success" as const,
                status: 200,
              }
            : {
                body: inventoryItemMediaNotFoundBody(),
                kind: "success" as const,
                status: 404,
              };
        },
        idempotencyKey: mutation.idempotencyKey,
        operation: "reorderInventoryItemImages",
        request: { imageIds, itemId },
      });

      if (result.kind === "conflict") {
        throw new InventoryItemMediaIdempotencyConflictError();
      }

      return result.status === 404
        ? null
        : (result.body as InventoryItemImageOrderResponse);
    },

    async uploadMedia(itemId, files, mutation) {
      return withOriginalUploadSlot(async () => {
      let storedMedia: InventoryStoredItemMedia[] = [];

      try {
        const result = await runIdempotentCommand<
          Record<string, unknown>,
          Record<string, unknown>
        >({
          clientId: mutation.clientId,
          execute: async (transaction) => {
            if (storedMedia.length === 0) {
              storedMedia = await storeInventoryItemMediaFiles(files, `upload:${mutation.clientId}:${mutation.idempotencyKey}:${itemId}`);
            }

            const created = await repository.createMedia(
              itemId,
              storedMedia,
              transaction,
            );

            return created
              ? {
                  body: { media: created },
                  kind: "success" as const,
                  status: 201,
                }
              : {
                  body: inventoryItemMediaNotFoundBody(),
                  kind: "success" as const,
                  status: 404,
                };
          },
          idempotencyKey: mutation.idempotencyKey,
          operation: "uploadInventoryItemMedia",
          timeoutMs: originalsEnabled() ? 600_000 : undefined,
          request: {
            files: await fingerprintItemMediaFiles(files),
            itemId,
          },
        });

        if (result.kind === "conflict") {
          throw new InventoryItemMediaIdempotencyConflictError();
        }

        if (result.status === 404) {
          await deleteStoredItemMediaOrThrow(storedMedia);
          return null;
        }

        return (result.body as { media: InventoryItemMediaMetadata[] })
          .media;
      } catch (error) {
        await deleteStoredItemMediaOrThrow(storedMedia);
        throw error;
      }
      });
    },
  };
}

const inventoryItemMediaRouteHandlers =
  createInventoryItemMediaRouteHandlers();
const inventoryItemMediaBodyLimit = bodyLimit({
  maxSize: maximumItemMediaRequestSizeBytes,
  onError: (context) =>
    context.json(
      {
        code: "PAYLOAD_TOO_LARGE",
        message: `Item Media requests must be at most ${maximumItemMediaRequestSizeBytes} bytes.`,
      },
      413,
    ),
});

const inventoryItemMediaListRoute = createRoute({
  method: "get",
  operationId: "listInventoryItemMedia",
  path: "/api/v1/inventory-items/{itemId}/media",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
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
          },
          schema: inventoryItemMediaListResponseSchema,
        },
      },
      description: "Inventory Item Media metadata.",
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
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description: "The parent Inventory Item was not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "List Inventory Item Media",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns Item Media metadata after resolving the parent Inventory Item, including an Archived Inventory Item. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId path parameter. Success response: 200 with ordered Item Media metadata for images, audio, and other files. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the parent Item does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryItemMediaUploadRoute = createRoute({
  method: "post",
  middleware: [inventoryItemMediaBodyLimit],
  operationId: "uploadInventoryItemMedia",
  path: "/api/v1/inventory-items/{itemId}/media",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.any().openapi({
            properties: {
              files: {
                items: {
                  format: "binary",
                  type: "string",
                },
                type: "array",
              },
            },
            required: ["files"],
            type: "object",
          }),
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
          },
          schema: inventoryItemMediaListResponseSchema,
        },
      },
      description: "Uploaded Inventory Item Media.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message: "Request validation failed.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The multipart request or Idempotency-Key was invalid.",
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
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description: "The Inventory Item was not found or is archived.",
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
      description: "The Idempotency-Key was reused with different input.",
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
      description: "The multipart request exceeded the transport limit.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Upload Inventory Item Media",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description: `Uploads Item Media directly to the API through multipart form data after resolving the parent Inventory Item. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, 1-${maximumItemMediaFileCount} repeated multipart files fields, and Idempotency-Key header; each file is limited to ${maximumItemMediaFileSizeBytes} bytes, one request to ${maximumItemMediaUploadSizeBytes} file bytes, and the multipart transport to ${maximumItemMediaRequestSizeBytes} bytes. JPEG, PNG, WebP, and GIF image orientation is physically normalized before storage; HEIC and HEIF are rejected. Success response: 201 with created Item Media metadata. Failure responses: 400 when the multipart request, image normalization, or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item is missing or archived, 409 when the key is reused with different input, 413 when the multipart transport is too large. Side effects: stores files, persists Item Media metadata, queues refreshed preprocessing evidence, and appends new image ordering positions. Destructive: no. Retry safety: same Idempotency-Key plus identical file names, types, sizes, order, bytes, and Item replays the original result.`,
});

const inventoryItemMediaContentRoute = createRoute({
  method: "get",
  operationId: "getInventoryItemMediaContent",
  path: "/api/v1/inventory-items/{itemId}/media/{mediaId}",
  request: {
    params: inventoryItemMediaPathParamsSchema,
    query: inventoryItemMediaContentQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
      description: "Authorized Inventory Item Media bytes.",
    },
    206: {
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
      description: "Authorized partial Item Media bytes.",
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
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description:
        "The Inventory Item does not own the requested Item Media.",
    },
    416: {
      content: {
        "application/json": {
          example: {
            code: "RANGE_NOT_SATISFIABLE",
            message: "Requested byte range is not satisfiable.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The requested byte range was not satisfiable.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Item Media content",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns authorized Item Media bytes after resolving the parent Inventory Item, including an Archived Inventory Item. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId and mediaId path parameters; optional Range header for audio and asset content. Success response: 200 or 206 with the requested Item Media bytes. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Item does not own the requested media, 416 when a byte range is unsatisfiable. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryItemPrimaryImageRoute = createRoute({
  method: "get",
  operationId: "getInventoryItemPrimaryImage",
  path: "/api/v1/inventory-items/{itemId}/primary-image",
  request: { params: inventoryItemPathParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            imageUrl:
              "https://dashboard.girke.dev/api/v1/inventory-item-media-preview/opaque-token",
          },
          schema: inventoryItemPrimaryImageResponseSchema,
        },
      },
      description: "A short-lived URL for the Item's primary image preview.",
    },
    401: {
      content: {
        "application/json": {
          example: { code: "UNAUTHENTICATED", message: "Authentication required." },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
    403: {
      content: {
        "application/json": {
          example: { code: "FORBIDDEN", message: "Missing required permission." },
          schema: authorizationErrorSchema,
        },
      },
      description: "The authenticated Client is missing Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description: "The Item has no image media.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Item primary image",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns a five-minute, single-image preview URL for the primary ordered Item Image. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId path parameter. Success response: 200 with imageUrl. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, and 404 when the Item has no image media. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent. Use the URL only to render that Item image; do not retain, share, or transform it.",
});

const inventoryItemMediaPreviewRoute = createRoute({
  method: "get",
  operationId: "getInventoryItemMediaPreview",
  path: "/api/v1/inventory-item-media-preview/{token}",
  request: { params: inventoryItemMediaPreviewTokenParamsSchema },
  responses: {
    200: {
      content: {
        "image/webp": { schema: z.string().openapi({ format: "binary" }) },
      },
      description: "A short-lived authorized Item image preview.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description: "The preview token is invalid, expired, or no longer available.",
    },
  },
  summary: "Get short-lived Inventory Item image preview",
  tags: ["Inventory"],
  security: [],
  "x-destructive": false,
  "x-required-permissions": [],
  description:
    "Renders one image preview. Authentication: none. The opaque URL token authorizes exactly one Item Image for five minutes. Required permissions: none. Inputs: token path parameter. Success response: 200 with WebP preview bytes. Failure responses: 404 when the token is invalid, expired, or the media is unavailable. Side effects: none. Destructive: no. Retry safety: safe to repeat until the token expires.",
});

const inventoryItemMediaDeleteRoute = createRoute({
  method: "delete",
  operationId: "deleteInventoryItemMedia",
  path: "/api/v1/inventory-items/{itemId}/media/{mediaId}",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemMediaPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            deletedMediaId: "image_123",
          },
          schema: inventoryItemMediaDeleteResponseSchema,
        },
      },
      description: "Deleted Inventory Item Media.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message: "Request validation failed.",
          },
          schema: apiErrorSchema,
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
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description:
        "The Inventory Item did not own the requested Item Media.",
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
      description: "The Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Delete Inventory Item Media",
  tags: ["Inventory"],
  "x-destructive": true,
  "x-required-permissions": ["inventory:write"],
  description:
    "Removes Item Media through the parent Inventory Item route. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId and mediaId path parameters plus Idempotency-Key header. Success response: 200 with the deleted Item Media identifier. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item does not own the requested media, 409 when the key is reused with different input. Side effects: deletes Item Media metadata and its stored file with compensating cleanup, then queues refreshed preprocessing evidence. Destructive: yes. Retry safety: same Idempotency-Key plus identical Item and media IDs replays the original result.",
});

const inventoryItemImageOrderRoute = createRoute({
  method: "put",
  operationId: "reorderInventoryItemImages",
  path: "/api/v1/inventory-items/{itemId}/media/image-order",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            imageIds: ["image_2", "image_1"],
          },
          schema: inventoryItemImageOrderRequestSchema,
        },
      },
    },
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            imageIds: ["image_2", "image_1"],
            itemId: "item_123",
          },
          schema: inventoryItemImageOrderResponseSchema,
        },
      },
      description: "Saved Inventory Item image order.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message: "Request validation failed.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The request or Idempotency-Key was invalid.",
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
            message: "Inventory Item Media not found.",
          },
          schema: inventoryItemMediaNotFoundErrorSchema,
        },
      },
      description: "The Inventory Item was not found or is archived.",
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
      description: "The Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Reorder Inventory Item images",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Reorders Item Images through the parent Inventory Item route. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON imageIds array, and Idempotency-Key header. Success response: 200 with the saved image order. Failure responses: 400 when the request or Idempotency-Key is invalid or imageIds is not the complete unique image set, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item is missing or archived, 409 when the key is reused with different input. Side effects: updates persisted image positions. Destructive: no. Retry safety: same Idempotency-Key plus identical Item and ordered image IDs replays the original result.",
});

function inventoryItemMediaNotFoundResponse() {
  return Response.json(
    {
      code: "NOT_FOUND" as const,
      message: "Inventory Item Media not found.",
    },
    { status: 404 },
  );
}

function registerInventoryItemMediaRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  handlers: InventoryItemMediaRouteHandlers,
) {
  app.openapi(inventoryItemMediaListRoute, async (context) => {
    const authorization = authorizeInventoryRead(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const media = await handlers.listMedia(
      requiredRouteParam(context, "itemId"),
    );

    if (!media) {
      return inventoryItemMediaNotFoundResponse();
    }

    return context.json({ media }, 200);
  });

  app.openapi(inventoryItemMediaUploadRoute, async (context) => {
    const authorization = authorizeInventoryWrite(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    let body: Awaited<ReturnType<typeof context.req.parseBody>>;

    try {
      body = await context.req.parseBody({ all: true });
    } catch {
      return jsonApiError(context, {
        code: "INVALID_REQUEST",
        message: "A valid multipart Item Media request is required.",
        status: 400,
      });
    }
    const files = [body.files]
      .flat()
      .filter(
        (value): value is File => value instanceof File && value.size > 0,
      );
    const uploadError = validateItemMediaFiles(files);

    if (uploadError) {
      return jsonApiError(context, {
        code: "INVALID_REQUEST",
        message: uploadError,
        status: 400,
      });
    }

    try {
      const media = await handlers.uploadMedia(
        requiredRouteParam(context, "itemId"),
        files,
        mediaMutationContext(context, authorization.accessContext),
      );

      if (!media) {
        return inventoryItemMediaNotFoundResponse();
      }

      return context.json({ media }, 201);
    } catch (error) {
      return itemMediaMutationErrorResponse(context, error);
    }
  });

  app.openapi(inventoryItemMediaContentRoute, async (context) => {
    const authorization = authorizeInventoryRead(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const media = await handlers.getMediaFile(
      requiredRouteParam(context, "itemId"),
      requiredRouteParam(context, "mediaId"),
    );

    if (!media) {
      return inventoryItemMediaNotFoundResponse();
    }

    try {
      return await inventoryItemMediaFileResponse(
        media,
        context.req.raw,
        new URL(context.req.raw.url).searchParams.get("representation") ??
          undefined,
      );
    } catch (error) {
      if (error instanceof OriginalStorageError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
      return inventoryItemMediaNotFoundResponse();
    }
  });

  app.openapi(inventoryItemPrimaryImageRoute, async (context) => {
    const authorization = authorizeInventoryRead(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const itemId = requiredRouteParam(context, "itemId");
    const media = await handlers.listMedia(itemId);
    const primaryImage = media?.find((entry) => entry.kind === "image");

    if (!primaryImage) {
      return inventoryItemMediaNotFoundResponse();
    }

    const token = createGptImagePreviewToken({
      expiresAt: Date.now() + gptImagePreviewLifetimeMs,
      itemId,
      mediaId: primaryImage.id,
    });
    const url = new URL(context.req.raw.url);
    url.pathname = `/api/v1/inventory-item-media-preview/${token}`;
    url.search = "";

    return context.json({ imageUrl: url.toString() }, 200);
  });

  app.openapi(inventoryItemMediaPreviewRoute, async (context) => {
    const token = parseGptImagePreviewToken(requiredRouteParam(context, "token"));

    if (!token) {
      return inventoryItemMediaNotFoundResponse();
    }

    const media = await handlers.getMediaFile(token.itemId, token.mediaId);

    if (!media || media.kind !== "image") {
      return inventoryItemMediaNotFoundResponse();
    }

    try {
      return await inventoryItemMediaFileResponse(
        media,
        context.req.raw,
        imagePreviewRepresentation,
      );
    } catch (error) {
      if (error instanceof OriginalStorageError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
      return inventoryItemMediaNotFoundResponse();
    }
  });

  app.openapi(inventoryItemMediaDeleteRoute, async (context) => {
    const authorization = authorizeInventoryWrite(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      const deleted = await handlers.deleteMedia(
        requiredRouteParam(context, "itemId"),
        requiredRouteParam(context, "mediaId"),
        mediaMutationContext(context, authorization.accessContext),
      );

      if (!deleted) {
        return inventoryItemMediaNotFoundResponse();
      }

      return context.json(deleted, 200);
    } catch (error) {
      return itemMediaMutationErrorResponse(context, error);
    }
  });

  app.openapi(inventoryItemImageOrderRoute, async (context) => {
    const authorization = authorizeInventoryWrite(context.get("accessContext"));

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      const response = await handlers.reorderImages(
        requiredRouteParam(context, "itemId"),
        (await context.req.json()).imageIds,
        mediaMutationContext(context, authorization.accessContext),
      );

      if (!response) {
        return inventoryItemMediaNotFoundResponse();
      }

      return context.json(response, 200);
    } catch (error) {
      return itemMediaMutationErrorResponse(context, error);
    }
  });
}

async function inventoryItemMediaFileResponse(
  media: InventoryItemMediaFile,
  request: Request,
  representation?: string,
): Promise<Response> {
  const isPreviewRepresentation = representation === imagePreviewRepresentation;

  if (isPreviewRepresentation && media.kind !== "image") {
    throw new Error("Image preview representations require image media.");
  }

  if (isOriginalReference(media.filePath) && !isPreviewRepresentation) {
    const response = await originalFiles.open(media.filePath, request.headers.get("range"));
    const mime = normalizeMediaMimeType(media.mimeType) ?? "application/octet-stream";
    response.headers.set("Content-Disposition", `${contentDisposition(media.kind, mime)}; filename="${safeFilename(media.originalName ?? "original")}"`);
    return response;
  }
  const bytes = isPreviewRepresentation
    ? await imagePreviewBytes(media)
    : await readFile(media.filePath);
  const filename = safeFilename(
    media.originalName ?? path.basename(media.filePath),
  );
  const mimeType =
    isPreviewRepresentation
      ? "image/webp"
      : (normalizeMediaMimeType(media.mimeType) ?? "application/octet-stream");

  if (media.kind === "image") {
    return cachedImageResponse(bytes, request, {
      "Content-Disposition": `${isSafeInlineImageMimeType(mimeType) ? "inline" : "attachment"}; filename="${filename}"`,
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    });
  }

  const range = parseByteRange(request.headers.get("Range"), bytes.byteLength);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": mediaCacheControl,
    "Content-Disposition": `${contentDisposition(media.kind, mimeType)}; filename="${filename}"`,
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
  });

  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${bytes.byteLength}`);
    headers.set("Content-Type", "application/json");
    return Response.json(
      {
        code: "RANGE_NOT_SATISFIABLE",
        message: "Requested byte range is not satisfiable.",
      },
      { headers, status: 416 },
    );
  }

  if (range) {
    const partial = bytes.subarray(range.start, range.end + 1);
    headers.set("Content-Length", String(partial.byteLength));
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    );

    return new Response(Uint8Array.from(partial), { headers, status: 206 });
  }

  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(Uint8Array.from(bytes), { headers });
}

async function imagePreviewBytes(media: InventoryItemMediaFile): Promise<Buffer> {
  if (media.kind !== "image") {
    throw new Error("Image preview representations require image media.");
  }

  if (isOriginalReference(media.filePath)) {
    const pending = pendingImageRepresentations.get(media.filePath);
    if (pending) return pending;
    const generation = (async () => sharp(await readOriginalBytes(media.filePath)).rotate().resize({ fit: "inside", height: imagePreviewSize, width: imagePreviewSize, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer())();
    pendingImageRepresentations.set(media.filePath, generation);
    try { return await generation; } finally { pendingImageRepresentations.delete(media.filePath); }
  }
  const representationPath = imagePreviewRepresentationPath(media.filePath);
  const sourceModifiedAt = await sourceImageModifiedAt(
    media.filePath,
    representationPath,
  );

  try {
    const representation = await stat(representationPath);

    if (representation.mtimeMs >= sourceModifiedAt) {
      return await readFile(representationPath);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  const pending = pendingImageRepresentations.get(representationPath);
  if (pending) return pending;

  const generation = (async () => {
    try {
      const source = await readFile(media.filePath);
      const preview = await sharp(source)
        .rotate()
        .resize({
          fit: "inside",
          height: imagePreviewSize,
          width: imagePreviewSize,
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();
      await writeFile(representationPath, preview);

      try {
        await stat(media.filePath);
      } catch (error) {
        await unlinkIfPresent(representationPath);
        throw error;
      }

      return preview;
    } finally {
      pendingImageRepresentations.delete(representationPath);
    }
  })();

  pendingImageRepresentations.set(representationPath, generation);
  return generation;
}

async function sourceImageModifiedAt(
  sourcePath: string,
  representationPath: string,
): Promise<number> {
  try {
    return (await stat(sourcePath)).mtimeMs;
  } catch (error) {
    if (isMissingFileError(error)) {
      await unlinkIfPresent(representationPath);
    }

    throw error;
  }
}

function cachedImageResponse(
  bytes: Buffer,
  request: Request,
  headers: Record<string, string>,
): Response {
  const etag = `"${createHash("sha256").update(bytes).digest("base64url")}"`;
  const responseHeaders = new Headers({
    ...headers,
    "Cache-Control": imageCacheControl,
    ETag: etag,
  });

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { headers: responseHeaders, status: 304 });
  }

  return new Response(Uint8Array.from(bytes), { headers: responseHeaders });
}

function imagePreviewRepresentationPath(filePath: string): string {
  return `${filePath}.${imagePreviewRepresentation}.webp`;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function requireActiveItem(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItemMediaMutationRow | null> {
  return transaction.inventoryItem.findFirst({
    select: mediaMutationInclude(),
    where: {
      archivedAt: null,
      id: itemId,
    },
  }) as Promise<InventoryItemMediaMutationRow | null>;
}

async function queueItemMediaPreprocessing(
  transaction: Prisma.TransactionClient,
  itemId: string,
) {
  const item = await transaction.inventoryItem.findUnique({
    select: {
      assets: { select: { id: true } },
      audioNotes: { select: { id: true } },
      id: true,
      images: { select: { id: true } },
    },
    where: { id: itemId },
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  return transaction.inventoryPreprocessingJob.create({
    data: {
      maxAttempts: 3,
      sourceRefs: [
        { id: item.id, kind: "item" },
        ...item.images.map(({ id }) => ({ id, kind: "image" })),
        ...item.audioNotes.map(({ id }) => ({ id, kind: "audio" })),
        ...item.assets.map(({ id }) => ({ id, kind: "asset" })),
      ] as Prisma.InputJsonValue,
      targetItemId: item.id,
    },
  });
}

async function createInventoryItemMediaRecords(
  database: Prisma.TransactionClient,
  itemId: string,
  media: InventoryStoredItemMedia[],
  firstImagePosition = 0,
): Promise<InventoryItemMediaMetadata[]> {
  let imageOffset = 0;
  const created: InventoryItemMediaMetadata[] = [];

  for (const entry of media) {
    if (entry.kind === "image") {
      const image = await database.inventoryItemImage.create({
        data: {
          filePath: entry.filePath,
          itemId: itemId,
          mimeType: entry.mimeType,
          originalName: entry.originalName,
          position: firstImagePosition + imageOffset,
          sizeBytes: entry.sizeBytes,
        },
        select: {
          id: true,
          mimeType: true,
          originalName: true,
          position: true,
          sizeBytes: true,
        },
      });
      imageOffset += 1;
      created.push(mapMediaRow("image", image));
      continue;
    }

    if (entry.kind === "audio") {
      const audio = await database.inventoryItemAudio.create({
        data: {
          filePath: entry.filePath,
          itemId: itemId,
          mimeType: entry.mimeType,
          originalName: entry.originalName,
          sizeBytes: entry.sizeBytes,
        },
        select: {
          id: true,
          mimeType: true,
          originalName: true,
          sizeBytes: true,
        },
      });
      created.push(mapMediaRow("audio", audio));
      continue;
    }

    const asset = await database.inventoryItemAsset.create({
      data: {
        filePath: entry.filePath,
        itemId: itemId,
        mimeType: entry.mimeType,
        originalName: entry.originalName,
        sizeBytes: entry.sizeBytes,
      },
      select: {
        id: true,
        mimeType: true,
        originalName: true,
        sizeBytes: true,
      },
    });
    created.push(mapMediaRow("asset", asset));
  }

  return created;
}

async function storeInventoryItemMediaFiles(
  files: File[],
  operationKey: string = randomUUID(),
): Promise<InventoryStoredItemMedia[]> {
  assertOriginalWritesEnabled();
  const candidates = files.filter((file) => file.size > 0);

  if (candidates.length === 0) {
    return [];
  }

  if (candidates.some(isHeicOrHeifFile)) {
    throw new InventoryItemMediaValidationError(
      "HEIC and HEIF images are not supported.",
    );
  }

  const stored: InventoryStoredItemMedia[] = [];

  try {
    for (const [index, file] of candidates.entries()) {
      const kind = inventoryItemMediaKind(file);
      const uploadRoot = uploadRootForMedia(kind);
      const sourceBytes = Buffer.from(await file.arrayBuffer());
      const storedBytes =
        kind === "image"
          ? await normalizeInventoryImage(sourceBytes)
          : sourceBytes;

      if (!originalsEnabled()) await mkdir(uploadRoot, { recursive: true });

      const extension = extensionForFile(file);
      const filename = `${Date.now()}-${randomUUID()}${extension}`;
      const mimeType = normalizeMediaMimeType(kind === "audio" ? audioMimeTypeForFile(file) : file.type);
      const filePath = originalsEnabled()
        ? await originalFiles.put(`inventory:${createHash("sha256").update(operationKey).digest("hex")}:${index}`, storedBytes, mimeType ?? "application/octet-stream", "Inventory", file.name || filename)
        : path.join(uploadRoot, filename);
      const entry = {
        filePath,
        kind,
        mimeType: normalizeMediaMimeType(
          kind === "audio" ? audioMimeTypeForFile(file) : file.type,
        ),
        originalName: file.name || null,
        sizeBytes: storedBytes.byteLength,
      };

      stored.push(entry);
      if (!isOriginalReference(filePath)) await writeFile(filePath, storedBytes);
    }

    return stored;
  } catch (error) {
    await deleteStoredItemMediaOrThrow(stored);
    throw error;
  }
}

async function deleteStoredItemMediaOrThrow(
  media: InventoryStoredItemMedia[],
): Promise<void> {
  const failures = await deleteInventoryStoredFiles(
    // Preserve uncertain remote successes for retry/reconciliation; never erase an original
    // that another concurrent request may have attached to a committed record.
    media.map((entry) => entry.filePath).filter(filePath => !isOriginalReference(filePath)),
  );

  if (failures.length > 0) {
    throw new Error("Could not clean up stored Item Media.");
  }
}

function inventoryItemMediaKind(file: File): InventoryItemMediaKind {
  if (isSupportedImageFile(file)) {
    return "image";
  }

  if (isSupportedAudioFile(file)) {
    return "audio";
  }

  return "asset";
}

function uploadRootForMedia(kind: InventoryItemMediaKind) {
  if (kind === "image") {
    return (
      process.env.INVENTORY_UPLOAD_DIR ??
      path.join(process.cwd(), "storage", "inventory-images")
    );
  }

  if (kind === "audio") {
    return (
      process.env.INVENTORY_AUDIO_UPLOAD_DIR ??
      path.join(process.cwd(), "storage", "inventory-audio")
    );
  }

  return (
    process.env.INVENTORY_ASSET_UPLOAD_DIR ??
    path.join(process.cwd(), "storage", "inventory-assets")
  );
}

function isSupportedImageFile(file: File): boolean {
  if (file.size <= 0) {
    return false;
  }

  if (file.type && file.type !== "application/octet-stream") {
    return isSafeInlineImageMimeType(file.type);
  }

  return /\.(gif|heic|heif|jpe?g|png|webp)$/i.test(file.name);
}

function isSupportedAudioFile(file: File): boolean {
  if (file.size <= 0 || file.type.startsWith("video/")) {
    return false;
  }

  if (file.type.startsWith("audio/")) {
    return true;
  }

  return /\.(aac|flac|m4a|mp3|ogg|opus|wav|webm)$/i.test(file.name);
}

function audioMimeTypeForFile(file: File): string | null {
  if (path.extname(file.name).toLowerCase() === ".webm") {
    return "audio/webm";
  }

  return file.type || null;
}

function normalizeMediaMimeType(value: string | null): string | null {
  const mimeType = value?.trim().toLowerCase() ?? "";

  return mimeType.length <= 255 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
    ? mimeType
    : null;
}

function extensionForFile(file: File): string {
  const extension = path.extname(file.name).toLowerCase();

  if (extension && /^[a-z0-9.]+$/.test(extension)) {
    return extension;
  }

  return extensionByMimeType[file.type] ?? ".bin";
}

function mapMediaRow(
  kind: InventoryItemMediaKind,
  row: {
    id: string;
    mimeType: string | null;
    originalName: string | null;
    position?: number | null;
    sizeBytes: number | null;
  },
): InventoryItemMediaMetadata {
  return {
    contentType: row.mimeType,
    id: row.id,
    kind,
    originalName: row.originalName,
    position: kind === "image" ? (row.position ?? 0) : null,
    sizeBytes: row.sizeBytes,
  };
}

function authorizeInventoryRead(accessContext: AccessContext | null) {
  return authorizeAccessContext(accessContext, {
    action: "read",
    domain: "inventory",
  });
}

function authorizeInventoryWrite(accessContext: AccessContext | null) {
  return authorizeAccessContext(accessContext, {
    action: "write",
    domain: "inventory",
  });
}

function requiredRouteParam(
  context: { req: { param: (name: string) => string | undefined } },
  name: "mediaId" | "itemId" | "token",
) {
  const value = context.req.param(name);

  if (!value) {
    throw new Error(`Route parameter ${name} is required.`);
  }

  return value;
}

type GptImagePreviewToken = {
  expiresAt: number;
  itemId: string;
  mediaId: string;
};

function createGptImagePreviewToken(payload: GptImagePreviewToken): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signGptImagePreviewToken(encoded)}`;
}

function parseGptImagePreviewToken(
  value: string,
): GptImagePreviewToken | null {
  const [encoded, signature, ...rest] = value.split(".");

  if (!encoded || !signature || rest.length > 0 || !hasValidGptImagePreviewSignature(encoded, signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<GptImagePreviewToken>;

    if (
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= Date.now() ||
      typeof payload.itemId !== "string" ||
      payload.itemId.length === 0 ||
      typeof payload.mediaId !== "string" ||
      payload.mediaId.length === 0
    ) {
      return null;
    }

    return {
      expiresAt: payload.expiresAt,
      itemId: payload.itemId,
      mediaId: payload.mediaId,
    };
  } catch {
    return null;
  }
}

function signGptImagePreviewToken(encoded: string): string {
  return createHmac("sha256", resolveAuthSecret())
    .update(`${gptImagePreviewTokenVersion}.${encoded}`)
    .digest("base64url");
}

function hasValidGptImagePreviewSignature(
  encoded: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signGptImagePreviewToken(encoded));
  const actual = Buffer.from(signature);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function contentDisposition(
  kind: InventoryItemMediaKind,
  _mimeType: string,
): "attachment" | "inline" {
  if (kind === "audio") {
    return "inline";
  }

  return "attachment";
}

function isSafeInlineImageMimeType(mimeType: string): boolean {
  return safeInlineImageMimeTypes.has(mimeType.toLowerCase());
}

function parseByteRange(
  value: string | null,
  size: number,
): { end: number; start: number } | "invalid" | null {
  if (!value) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());

  if (!match || size === 0) {
    return "invalid";
  }

  const [, startText, endText] = match;

  if (!startText && !endText) {
    return "invalid";
  }

  if (!startText) {
    const suffixLength = Number(endText);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }

    return {
      end: size - 1,
      start: Math.max(0, size - suffixLength),
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }

  return { end: Math.min(requestedEnd, size - 1), start };
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function inventoryItemMediaNotFoundBody() {
  return {
    code: "NOT_FOUND",
    message: "Inventory Item Media not found.",
  };
}

function mediaMutationContext(
  context: Context,
  accessContext: AccessContext,
): InventoryItemMediaMutationContext {
  return {
    clientId: accessContext.client.id,
    idempotencyKey: context.req.header("idempotency-key")!.trim(),
  };
}

function itemMediaMutationErrorResponse(context: Context, error: unknown) {
  if (error instanceof OriginalStorageError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof InventoryItemMediaIdempotencyConflictError) {
    return jsonApiError(context, {
      code: "IDEMPOTENCY_CONFLICT",
      message: error.message,
      status: 409,
    });
  }

  if (error instanceof InventoryItemMediaValidationError) {
    return jsonApiError(context, {
      code: "INVALID_REQUEST",
      message: error.message,
      status: 400,
    });
  }

  if (error instanceof InventoryImageNormalizationError) {
    return jsonApiError(context, {
      code: "INVALID_REQUEST",
      message: error.message,
      status: 400,
    });
  }

  throw error;
}

function validateItemMediaFiles(files: File[]): string | null {
  if (files.length === 0) {
    return "Choose at least one non-empty Item Media file.";
  }

  if (files.length > maximumItemMediaFileCount) {
    return `Upload at most ${maximumItemMediaFileCount} Item Media files at once.`;
  }

  if (files.some((file) => file.size > maximumItemMediaFileSizeBytes)) {
    return `Each Item Media file must be at most ${maximumItemMediaFileSizeBytes} bytes.`;
  }

  if (files.some(isHeicOrHeifFile)) {
    return "HEIC and HEIF images are not supported.";
  }

  const totalSize = files.reduce((total, file) => total + file.size, 0);

  if (totalSize > maximumItemMediaUploadSizeBytes) {
    return `Item Media files must total at most ${maximumItemMediaUploadSizeBytes} bytes per request.`;
  }

  return null;
}

function isHeicOrHeifFile(file: File): boolean {
  const mimeType = file.type.trim().toLowerCase();

  return (
    mimeType === "image/heic" ||
    mimeType === "image/heif" ||
    /\.(?:heic|heif)$/i.test(file.name)
  );
}

async function fingerprintItemMediaFiles(files: File[]) {
  return Promise.all(
    files.map(async (file) => ({
      contentSha256: createHash("sha256")
        .update(Buffer.from(await file.arrayBuffer()))
        .digest("hex"),
      name: file.name,
      size: file.size,
      type: file.type,
    })),
  );
}

async function readFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

class InventoryItemMediaIdempotencyConflictError extends Error {
  constructor() {
    super(idempotencyConflictMessage);
    this.name = "InventoryItemMediaIdempotencyConflictError";
  }
}

class InventoryItemMediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryItemMediaValidationError";
  }
}

export {
  createInventoryItemMediaRouteHandlers,
  createInventoryItemMediaRecords,
  deleteStoredItemMediaOrThrow,
  fingerprintItemMediaFiles,
  inventoryItemMediaBodyLimit,
  inventoryItemMediaSchema,
  maximumItemMediaFileCount,
  maximumItemMediaFileSizeBytes,
  maximumItemMediaRequestSizeBytes,
  maximumItemMediaUploadSizeBytes,
  inventoryItemMediaRouteHandlers,
  queueItemMediaPreprocessing,
  registerInventoryItemMediaRoutes,
  storeInventoryItemMediaFiles,
  validateItemMediaFiles,
  type InventoryItemMediaMetadata,
  type InventoryStoredItemMedia,
  type InventoryItemMediaRouteHandlers,
};
