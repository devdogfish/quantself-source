import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
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
import { normalizeInventoryLocationName } from "./inventory-service";

const inventoryLocationKindSchema = z.enum([
  "ROOM",
  "STORAGE",
  "SHELF",
  "AREA",
  "OTHER",
]);

const inventoryLocationSchema = z
  .object({
    containerCount: z.int().nonnegative().openapi({ example: 1 }),
    id: z.string().min(1).openapi({ example: "location-pantry" }),
    kind: inventoryLocationKindSchema.openapi({ example: "STORAGE" }),
    name: z.string().min(1).openapi({ example: "Pantry" }),
    note: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "Dry food and shelf-stable supplies." }),
    placementCount: z.int().nonnegative().openapi({ example: 4 }),
  })
  .openapi("InventoryLocationWithUsage");

const listInventoryLocationsQuerySchema = z.object({
  kind: inventoryLocationKindSchema.optional(),
  q: z.string().min(1).optional(),
});

const createInventoryLocationInputSchema = z
  .object({
    kind: inventoryLocationKindSchema.optional(),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .openapi("CreateInventoryLocationInput");

const updateInventoryLocationInputSchema = z
  .object({
    kind: inventoryLocationKindSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "At least one Inventory Location field is required.",
  })
  .openapi("UpdateInventoryLocationInput");

const idempotencyKeyHeadersSchema = z.object({
  "Idempotency-Key": z
    .string()
    .trim()
    .min(1)
    .max(255)
    .openapi({
      example: "inventory-location-018f5f86",
      param: {
        in: "header",
        name: "Idempotency-Key",
      },
    }),
});

const inventoryLocationResponseSchema = z
  .object({
    location: inventoryLocationSchema,
  })
  .openapi("InventoryLocationResponse");

const inventoryLocationsResponseSchema = z
  .object({
    locations: z.array(inventoryLocationSchema),
  })
  .openapi("InventoryLocationsResponse");

type InventoryLocation = z.infer<typeof inventoryLocationSchema>;
type CreateInventoryLocationInput = z.infer<
  typeof createInventoryLocationInputSchema
>;
type UpdateInventoryLocationInput = z.infer<
  typeof updateInventoryLocationInputSchema
>;
type InventoryLocationMutationRunner = (input: {
  clientId: string;
  execute: (transaction: Prisma.TransactionClient) => Promise<{
    body: { location: InventoryLocation };
    kind: "success";
    status: 200 | 201;
  }>;
  idempotencyKey: string;
  operation: string;
  request: Record<string, unknown>;
}) => Promise<IdempotentCommandResult<{ location: InventoryLocation }>>;

type InventoryLocationsRouteHandlers = {
  createLocation: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "createInventoryLocation";
    request: CreateInventoryLocationInput;
  }) => Promise<InventoryLocation>;
  listLocations: (input: {
    kind?: InventoryLocation["kind"];
    query?: string | null;
  }) => Promise<InventoryLocation[]>;
  updateLocation: (input: {
    clientId: string;
    idempotencyKey: string;
    locationId: string;
    operation: "updateInventoryLocation";
    request: UpdateInventoryLocationInput;
  }) => Promise<InventoryLocation>;
};

const listInventoryLocationsRoute = createRoute({
  method: "get",
  operationId: "listInventoryLocations",
  path: "/api/v1/inventory-locations",
  request: {
    query: listInventoryLocationsQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            locations: [
              {
                containerCount: 1,
                id: "location-pantry",
                kind: "STORAGE",
                name: "Pantry",
                note: "Dry food and shelf-stable supplies.",
                placementCount: 4,
              },
            ],
          },
          schema: inventoryLocationsResponseSchema,
        },
      },
      description: "Inventory Locations in stable name order.",
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
      description: "The query filters are invalid.",
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
  summary: "List Inventory Locations",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Lists Inventory Locations used as direct retrieval destinations. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: optional q and kind filters. Success response: 200 with stable name-ordered locations, notes, and Container/direct Placement usage counts. Failure responses: 400 when filters are invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const createInventoryLocationRoute = createRoute({
  method: "post",
  operationId: "createInventoryLocation",
  path: "/api/v1/inventory-locations",
  request: {
    headers: idempotencyKeyHeadersSchema,
    body: {
      content: {
        "application/json": {
          example: {
            name: "Pantry",
            note: "Dry food and shelf-stable supplies.",
          },
          schema: createInventoryLocationInputSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            location: {
              containerCount: 0,
              id: "location-pantry",
              kind: "OTHER",
              name: "Pantry",
              note: "Dry food and shelf-stable supplies.",
              placementCount: 0,
            },
          },
          schema: inventoryLocationResponseSchema,
        },
      },
      description: "Created Inventory Location.",
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
      description:
        "The Idempotency-Key was already used with different input, or the normalized name already exists.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Create Inventory Location",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Creates one normalized Inventory Location. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with name plus optional kind and note, and Idempotency-Key header. Success response: 201 with the created Location. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 409 when the key is reused with different input or the normalized name already exists. Side effects: creates one Inventory Location and stores an idempotency result. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const updateInventoryLocationRoute = createRoute({
  method: "put",
  operationId: "updateInventoryLocation",
  path: "/api/v1/inventory-locations/{locationId}",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: z.object({
      locationId: z.string().min(1).openapi({ example: "location-pantry" }),
    }),
    body: {
      content: {
        "application/json": {
          example: {
            name: "Kitchen pantry",
          },
          schema: updateInventoryLocationInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            location: {
              containerCount: 1,
              id: "location-pantry",
              kind: "STORAGE",
              name: "Kitchen pantry",
              note: "Dry food and shelf-stable supplies.",
              placementCount: 4,
            },
          },
          schema: inventoryLocationResponseSchema,
        },
      },
      description: "Updated Inventory Location.",
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
            code: "INVENTORY_LOCATION_NOT_FOUND",
            message: "Inventory Location was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The requested Inventory Location does not exist.",
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
      description:
        "The Idempotency-Key was already used with different input, or the normalized name already exists.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Update Inventory Location",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Updates one normalized Inventory Location. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: locationId path parameter, a non-empty JSON subset of name, kind, and note, and Idempotency-Key header. Success response: 200 with the updated Location. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Location does not exist, 409 when the key is reused with different input or the normalized name already exists. Side effects: updates one Inventory Location and stores an idempotency result. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const inventoryLocationsRouteHandlers = createInventoryLocationsRouteHandlers();

function createInventoryLocationsRouteHandlers(
  dependencies: {
    runCommand?: InventoryLocationMutationRunner;
  } = {},
): InventoryLocationsRouteHandlers {
  const runCommand = dependencies.runCommand ?? ((input) => runIdempotentCommand(input));

  return {
    async listLocations(input) {
      const query = cleanOptional(input.query);
      const where = {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: "insensitive" as const } },
                {
                  normalizedName: {
                    contains: normalizeInventoryLocationName(query),
                  },
                },
              ],
            }
          : {}),
      } satisfies Prisma.InventoryLocationWhereInput;
      const locations = await prisma.inventoryLocation.findMany({
        include: {
          _count: {
            select: {
              containers: true,
              placements: true,
            },
          },
        },
        orderBy: [{ name: "asc" }],
        where,
      });

      return locations.map(mapLocation);
    },

    async createLocation(input) {
      const request = sanitizeCreateInput(input.request);
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => ({
          body: {
            location: mapLocation(
              await transaction.inventoryLocation.create({
                data: {
                  kind: request.kind,
                  name: request.name,
                  note: request.note,
                  normalizedName: normalizeInventoryLocationName(request.name),
                },
                include: {
                  _count: {
                    select: {
                      containers: true,
                      placements: true,
                    },
                  },
                },
              }),
            ),
          },
          kind: "success",
          status: 201,
        }),
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request,
      });

      return readIdempotentRouteResult(result).location;
    },

    async updateLocation(input) {
      const request = sanitizeUpdateInput(input.request);
      const locationId = input.locationId.trim();
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => ({
          body: {
            location: mapLocation(
              await transaction.inventoryLocation.update({
                data: {
                  kind: request.kind,
                  name: request.name,
                  note: request.note,
                  ...(request.name
                    ? {
                        normalizedName: normalizeInventoryLocationName(
                          request.name,
                        ),
                      }
                    : {}),
                },
                include: {
                  _count: {
                    select: {
                      containers: true,
                      placements: true,
                    },
                  },
                },
                where: {
                  id: locationId,
                },
              }),
            ),
          },
          kind: "success",
          status: 200,
        }),
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          ...request,
          locationId,
        },
      });

      return readIdempotentRouteResult(result).location;
    },
  };
}

function registerInventoryLocationRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  handlers: InventoryLocationsRouteHandlers,
) {
  app.openapi(listInventoryLocationsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const query = context.req.query();

    return context.json(
      {
        locations: await handlers.listLocations({
          kind: isInventoryLocationKind(query.kind) ? query.kind : undefined,
          query: query.q ?? null,
        }),
      },
      200,
    );
  });

  app.openapi(createInventoryLocationRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      const request = (await context.req.json()) as CreateInventoryLocationInput;

      return context.json(
        {
          location: await handlers.createLocation({
            clientId: authorization.accessContext.client.id,
            idempotencyKey: context.req.header("idempotency-key")?.trim() ?? "",
            operation: "createInventoryLocation",
            request,
          }),
        },
        201,
      );
    } catch (error) {
      return normalizeLocationRouteError(context, error);
    }
  });

  app.openapi(updateInventoryLocationRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      const request = (await context.req.json()) as UpdateInventoryLocationInput;
      const locationId = context.req.param("locationId");

      if (!locationId) {
        throw new InventoryLocationNotFoundError(
          "Inventory Location was not found.",
        );
      }

      return context.json(
        {
          location: await handlers.updateLocation({
            clientId: authorization.accessContext.client.id,
            idempotencyKey: context.req.header("idempotency-key")?.trim() ?? "",
            locationId,
            operation: "updateInventoryLocation",
            request,
          }),
        },
        200,
      );
    } catch (error) {
      return normalizeLocationRouteError(context, error);
    }
  });
}

function sanitizeCreateInput(
  input: CreateInventoryLocationInput,
): Required<CreateInventoryLocationInput> {
  return {
    kind: input.kind ?? "OTHER",
    name: input.name.trim().replace(/\s+/gu, " "),
    note: cleanOptional(input.note),
  };
}

function sanitizeUpdateInput(
  input: UpdateInventoryLocationInput,
): UpdateInventoryLocationInput {
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined
      ? {}
      : { name: input.name.trim().replace(/\s+/gu, " ") }),
    ...(input.note === undefined ? {} : { note: cleanOptional(input.note) }),
  };
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function isInventoryLocationKind(
  value: string | undefined,
): value is InventoryLocation["kind"] {
  return (
    value === "ROOM" ||
    value === "STORAGE" ||
    value === "SHELF" ||
    value === "AREA" ||
    value === "OTHER"
  );
}

function mapLocation(location: {
  _count: {
    containers: number;
    placements: number;
  };
  id: string;
  kind: string;
  name: string;
  note: string | null;
}): InventoryLocation {
  return {
    containerCount: location._count.containers,
    id: location.id,
    kind: location.kind as InventoryLocation["kind"],
    name: location.name,
    note: location.note,
    placementCount: location._count.placements,
  };
}

function readIdempotentRouteResult<T extends Record<string, unknown>>(
  result: IdempotentCommandResult<T>,
) {
  if (result.kind === "conflict") {
    throw new InventoryLocationConflictError(
      result.message ?? idempotencyConflictMessage,
    );
  }

  return result.body;
}

function normalizeLocationRouteError(context: {
  json: (body: { code: string; message: string }, status: 400 | 404 | 409) => Response;
}, error: unknown) {
  if (error instanceof InventoryLocationConflictError) {
    return jsonApiError(context as never, {
      code:
        error.message === idempotencyConflictMessage
          ? "IDEMPOTENCY_CONFLICT"
          : "INVENTORY_LOCATION_CONFLICT",
      message: error.message,
      status: 409,
    });
  }

  if (error instanceof InventoryLocationNotFoundError) {
    return jsonApiError(context as never, {
      code: "INVENTORY_LOCATION_NOT_FOUND",
      message: error.message,
      status: 404,
    });
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  ) {
    return jsonApiError(context as never, {
      code: "INVENTORY_LOCATION_CONFLICT",
      message: "An Inventory Location with that normalized name already exists.",
      status: 409,
    });
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2025"
  ) {
    return jsonApiError(context as never, {
      code: "INVENTORY_LOCATION_NOT_FOUND",
      message: "Inventory Location was not found.",
      status: 404,
    });
  }

  throw error;
}

class InventoryLocationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryLocationConflictError";
  }
}

class InventoryLocationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryLocationNotFoundError";
  }
}

export {
  createInventoryLocationsRouteHandlers,
  inventoryLocationsRouteHandlers,
  registerInventoryLocationRoutes,
  type InventoryLocationsRouteHandlers,
};
