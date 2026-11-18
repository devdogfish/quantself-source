import { randomUUID } from "node:crypto";
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
import { runIdempotentCommand, type IdempotentCommandResult } from "./idempotency";

const dateOnlySchema = z.iso.date().openapi({ example: "2026-08-03" });

const publishedBySchema = z
  .object({
    clientId: z.string().min(1).openapi({ example: "client-outfit-writer" }),
    clientKind: z.enum(["api-key", "web"]).openapi({ example: "api-key" }),
    clientName: z.string().min(1).openapi({ example: "Outfit Writer" }),
  })
  .openapi("InventoryClothingRecommendationPublisher");

const recommendationEventSchema = z
  .object({
    label: z.string().min(1).openapi({ example: "Board dinner" }),
    startsAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-04T19:00:00.000Z" }),
  })
  .openapi("InventoryClothingRecommendationEvent");

const recommendationItemSchema = z
  .object({
    archiveState: z
      .enum(["ACTIVE", "ARCHIVED", "DELETED"])
      .openapi({ example: "ACTIVE" }),
    availability: z
      .enum(["AVAILABLE", "UNAVAILABLE"])
      .openapi({ example: "AVAILABLE" }),
    clothingState: z
      .enum(["clean", "dirty"])
      .nullable()
      .openapi({ example: "clean" }),
    id: z.string().min(1).openapi({ example: "item-shirt" }),
    imageId: z.string().min(1).nullable().openapi({ example: "image-shirt" }),
    title: z.string().min(1).openapi({ example: "Blue oxford shirt" }),
    where: z.string().min(1).openapi({ example: "Hall closet / Rail A × 1" }),
  })
  .openapi("InventoryClothingRecommendationItem");

const recommendationOptionSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "option-primary" }),
    items: z.array(recommendationItemSchema).min(1),
    reason: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .openapi({ example: "Breathable layers for a warm meeting day." }),
    slot: z
      .enum(["PRIMARY", "ALTERNATIVE"])
      .openapi({ example: "PRIMARY" }),
  })
  .openapi("InventoryClothingRecommendationOption");

const recommendationSchema = z
  .object({
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-03T09:00:00.000Z" }),
    event: recommendationEventSchema.nullable().openapi({
      example: null,
    }),
    id: z.string().min(1).openapi({ example: "recommendation-1" }),
    kind: z.enum(["DAILY", "EVENT"]).openapi({ example: "DAILY" }),
    options: z.array(recommendationOptionSchema).min(1).max(2),
    publishedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-03T09:00:00.000Z" }),
    publishedBy: publishedBySchema,
    reason: z
      .string()
      .trim()
      .min(1)
      .openapi({
        example: "Client picked a concise outfit for Monday, August 3, 2026.",
      }),
    status: z.enum(["PUBLISHED", "WORN", "DECLINED", "SUPERSEDED"]).openapi({
      example: "PUBLISHED",
    }),
    supersededByRecommendationId: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: null }),
    targetDate: dateOnlySchema,
  })
  .openapi("InventoryClothingRecommendation");

const publishRecommendationOptionSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(24),
  reason: z.string().trim().min(1).max(500).optional(),
});

const publishRecommendationEventSchema = z.object({
  label: z.string().trim().min(1).max(200),
  startsAt: z.string().datetime(),
});

const markRecommendationWornRequestSchema = z
  .object({
    optionId: z.string().trim().min(1).optional(),
  })
  .openapi("MarkInventoryClothingRecommendationWornRequest");

const publishRecommendationRequestSchema = z
  .object({
    alternative: publishRecommendationOptionSchema.optional(),
    event: publishRecommendationEventSchema.optional(),
    kind: z.enum(["DAILY", "EVENT"]).openapi({ example: "DAILY" }),
    primary: publishRecommendationOptionSchema,
    reason: z.string().trim().min(1).max(500),
    supersedesRecommendationId: z.string().trim().min(1).optional(),
    targetDate: dateOnlySchema,
  })
  .superRefine((input, context) => {
    if (input.kind === "DAILY" && input.event) {
      context.addIssue({
        code: "custom",
        message: "Daily Clothing Recommendations cannot include event details.",
        path: ["event"],
      });
    }

    if (input.kind === "EVENT" && !input.event) {
      context.addIssue({
        code: "custom",
        message: "Event Clothing Recommendations require event details.",
        path: ["event"],
      });
    }

    if (
      input.kind === "EVENT" &&
      input.event &&
      input.targetDate !== input.event.startsAt.slice(0, 10)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Event Clothing Recommendation target date must match the event start date.",
        path: ["targetDate"],
      });
    }
  })
  .openapi("PublishInventoryClothingRecommendationRequest");

const listRecommendationsQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    kind: z.enum(["daily", "event"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(["published", "worn", "declined"]).optional(),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .refine(isValidIanaTimeZone, {
        message: "Expected an IANA time zone.",
      })
      .optional()
      .openapi({
        description: "IANA time zone used to resolve the implicit local day.",
        example: "America/Halifax",
        param: { in: "query", name: "timeZone" },
      }),
    to: dateOnlySchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.from && input.to && input.from > input.to) {
      context.addIssue({
        code: "custom",
        message: "`from` must be on or before `to`.",
        path: ["from"],
      });
    }
  });

const recommendationResponseSchema = z
  .object({
    recommendation: recommendationSchema,
  })
  .openapi("InventoryClothingRecommendationResponse");

const recommendationWearConfirmationSchema = z
  .object({
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-03T10:30:00.000Z" }),
    id: z.string().min(1).openapi({ example: "wear_123" }),
    itemIds: z.array(z.string().min(1)).openapi({ example: ["item-shirt"] }),
    undoneAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: null }),
  })
  .openapi("InventoryClothingRecommendationWearConfirmation");

const markRecommendationWornResponseSchema = z
  .object({
    recommendation: recommendationSchema,
    wearConfirmation: recommendationWearConfirmationSchema,
  })
  .openapi("MarkInventoryClothingRecommendationWornResponse");

const recommendationsResponseSchema = z
  .object({
    recommendations: z.array(recommendationSchema),
  })
  .openapi("InventoryClothingRecommendationsResponse");

const idempotencyKeyHeadersSchema = z.object({
  "Idempotency-Key": z
    .string()
    .trim()
    .min(1)
    .max(255)
    .openapi({
      example: "publish-outfit-2026-08-03",
      param: {
        in: "header",
        name: "Idempotency-Key",
      },
    }),
});

type InventoryClothingRecommendation = z.infer<typeof recommendationSchema>;
type InventoryClothingRecommendationItem = z.infer<
  typeof recommendationItemSchema
>;
type PublishInventoryClothingRecommendationRequest = z.infer<
  typeof publishRecommendationRequestSchema
>;
type MarkInventoryClothingRecommendationWornRequest = z.infer<
  typeof markRecommendationWornRequestSchema
>;
type InventoryClothingRecommendationPublisher = z.infer<
  typeof publishedBySchema
>;
type InventoryClothingRecommendationWearConfirmation = z.infer<
  typeof recommendationWearConfirmationSchema
>;

type InventoryClothingRecommendationMutationRunner = <
  TResponse extends Record<string, unknown>,
>(input: {
  clientId: string;
  execute: (transaction: Prisma.TransactionClient) => Promise<{
    body: TResponse;
    kind: "success";
    status: number;
  }>;
  idempotencyKey: string;
  operation: string;
  request: Record<string, unknown>;
}) => Promise<IdempotentCommandResult<TResponse>>;

type InventoryClothingRecommendationsRouteHandlers = {
  declineRecommendation: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "declineInventoryClothingRecommendation";
    recommendationId: string;
  }) => Promise<{ recommendation: InventoryClothingRecommendation }>;
  getRecommendation: (
    recommendationId: string,
  ) => Promise<InventoryClothingRecommendation | null>;
  listRecommendations: (input: {
    from?: string;
    kind?: "DAILY" | "EVENT";
    limit?: number;
    status?: "DECLINED" | "PUBLISHED" | "WORN";
    timeZone?: string;
    to?: string;
  }) => Promise<InventoryClothingRecommendation[]>;
  markRecommendationWorn: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "markInventoryClothingRecommendationWorn";
    recommendationId: string;
    request: MarkInventoryClothingRecommendationWornRequest;
  }) => Promise<{
    recommendation: InventoryClothingRecommendation;
    wearConfirmation: InventoryClothingRecommendationWearConfirmation;
  }>;
  publishRecommendation: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "publishInventoryClothingRecommendation";
    publishedBy: InventoryClothingRecommendationPublisher;
    request: PublishInventoryClothingRecommendationRequest;
  }) => Promise<{ recommendation: InventoryClothingRecommendation }>;
};

const recommendationItemInclude = {
  clothingProfile: true,
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
  placements: {
    include: {
      container: {
        include: {
          location: true,
        },
      },
      location: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  },
} satisfies Prisma.InventoryItemInclude;

const recommendationInclude = {
  options: {
    include: {
      items: {
        include: {
          item: {
            include: recommendationItemInclude,
          },
        },
        orderBy: {
          position: "asc",
        },
      },
    },
  },
} satisfies Prisma.InventoryClothingRecommendationInclude;

type RecommendationRecord = Prisma.InventoryClothingRecommendationGetPayload<{
  include: typeof recommendationInclude;
}>;

class InventoryClothingRecommendationNotFoundError extends Error {
  constructor(message = "Inventory Clothing Recommendation was not found.") {
    super(message);
    this.name = "InventoryClothingRecommendationNotFoundError";
  }
}

class InventoryClothingRecommendationConflictError extends Error {
  code: string;

  constructor(
    message: string,
    code = "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
  ) {
    super(message);
    this.code = code;
    this.name = "InventoryClothingRecommendationConflictError";
  }
}

const recommendationPathParamsSchema = z.object({
  recommendationId: z
    .string()
    .trim()
    .min(1)
    .openapi({ example: "recommendation-1" }),
});

const listInventoryClothingRecommendationsRoute = createRoute({
  method: "get",
  operationId: "listInventoryClothingRecommendations",
  path: "/api/v1/inventory-clothing/outfit-recommendations",
  request: {
    query: listRecommendationsQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            recommendations: [
              {
                createdAt: "2026-08-03T09:00:00.000Z",
                event: null,
                id: "recommendation-1",
                kind: "DAILY",
                options: [
                  {
                    id: "option-primary",
                    items: [
                      {
                        archiveState: "ACTIVE",
                        availability: "AVAILABLE",
                        clothingState: "clean",
                        id: "item-shirt",
                        imageId: "image-shirt",
                        title: "Blue oxford shirt",
                        where: "Hall closet / Rail A × 1",
                      },
                    ],
                    reason: "Breathable layers for a warm meeting day.",
                    slot: "PRIMARY",
                  },
                ],
                publishedAt: "2026-08-03T09:00:00.000Z",
                publishedBy: {
                  clientId: "client-outfit-writer",
                  clientKind: "api-key",
                  clientName: "Outfit Writer",
                },
                reason:
                  "Client picked a concise outfit for Monday, August 3, 2026.",
                status: "PUBLISHED",
                supersededByRecommendationId: null,
                targetDate: "2026-08-03",
              },
            ],
          },
          schema: recommendationsResponseSchema,
        },
      },
      description: "Hydrated Clothing Recommendations in stable publish order.",
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
      description: "The recommendation filters are invalid.",
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
  summary: "List Clothing Recommendations",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Lists hydrated Clothing Recommendations for the Clothing page and auditable worn or declined history. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: optional kind=daily|event, status=published|worn|declined, from/to target-date bounds, and limit up to 100. Without explicit status or date filters, the default result is today's published daily outfit plus future published event outfits. Success response: 200 with current Item title, image, retrieval, archive state, Clothing wear state, computed availability, and nullable event details. Failure responses: 400 when filters are invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const publishInventoryClothingRecommendationRoute = createRoute({
  method: "post",
  operationId: "publishInventoryClothingRecommendation",
  path: "/api/v1/inventory-clothing/outfit-recommendations",
  request: {
    headers: idempotencyKeyHeadersSchema,
    body: {
      content: {
        "application/json": {
          example: {
            event: {
              label: "Board dinner",
              startsAt: "2026-08-04T19:00:00.000Z",
            },
            kind: "EVENT",
            primary: {
              itemIds: ["item-blazer", "item-trousers"],
              reason: "Formal enough for dinner without overheating.",
            },
            reason: "Client picked a concise outfit for the board dinner.",
            targetDate: "2026-08-04",
          },
          schema: publishRecommendationRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            recommendation: {
              createdAt: "2026-08-03T09:00:00.000Z",
              event: {
                label: "Board dinner",
                startsAt: "2026-08-04T19:00:00.000Z",
              },
              id: "recommendation-event-1",
              kind: "EVENT",
              options: [
                {
                  id: "option-primary",
                  items: [
                    {
                      archiveState: "ACTIVE",
                      availability: "AVAILABLE",
                      clothingState: "clean",
                      id: "item-blazer",
                      imageId: "image-blazer",
                      title: "Navy blazer",
                      where: "Bedroom closet / Rail C × 1",
                    },
                  ],
                  reason: "Formal enough for dinner without overheating.",
                  slot: "PRIMARY",
                },
              ],
              publishedAt: "2026-08-03T09:00:00.000Z",
              publishedBy: {
                clientId: "client-outfit-writer",
                clientKind: "api-key",
                clientName: "Outfit Writer",
              },
              reason: "Client picked a concise outfit for the board dinner.",
              status: "PUBLISHED",
              supersededByRecommendationId: null,
              targetDate: "2026-08-04",
            },
          },
          schema: recommendationResponseSchema,
        },
      },
      description: "Published daily Clothing Recommendation.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message:
              "Idempotency-Key header is required and must not exceed 255 characters.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The request body or Idempotency-Key is invalid.",
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
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The explicit superseded recommendation was not found.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
            message: "Daily Clothing Recommendation already exists for target date.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The daily slot or event slot, Item references, or Idempotency-Key conflicts with current state.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Publish Clothing Recommendation",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Publishes one daily or event Clothing Recommendation with one required primary outfit and at most one alternative. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with kind, targetDate, concise reason, ordered primary Item IDs, optional alternative Item IDs, optional event label/start time for kind=EVENT, optional per-option reasons, optional supersedesRecommendationId, and Idempotency-Key header. Success response: 201 with the persisted and hydrated recommendation. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the explicit superseded recommendation is missing, 409 when the requested slot already exists, Item references are duplicate, dirty, archived, missing-profile, non-clothing, or the Idempotency-Key is reused with different input. Side effects: persists the recommendation, options, ordered item references, publisher provenance, and optional event metadata; explicit supersession marks the replaced recommendation superseded. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const getInventoryClothingRecommendationRoute = createRoute({
  method: "get",
  operationId: "getInventoryClothingRecommendation",
  path: "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}",
  request: {
    params: recommendationPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            recommendation: {
              createdAt: "2026-08-03T09:00:00.000Z",
              event: null,
              id: "recommendation-1",
              kind: "DAILY",
              options: [
                {
                  id: "option-primary",
                  items: [
                    {
                      archiveState: "ACTIVE",
                      availability: "AVAILABLE",
                      clothingState: "clean",
                      id: "item-shirt",
                      imageId: "image-shirt",
                      title: "Blue oxford shirt",
                      where: "Hall closet / Rail A × 1",
                    },
                  ],
                  reason: "Breathable layers for a warm meeting day.",
                  slot: "PRIMARY",
                },
              ],
              publishedAt: "2026-08-03T09:00:00.000Z",
              publishedBy: {
                clientId: "client-outfit-writer",
                clientKind: "api-key",
                clientName: "Outfit Writer",
              },
              reason:
                "Client picked a concise outfit for Monday, August 3, 2026.",
              status: "PUBLISHED",
              supersededByRecommendationId: null,
              targetDate: "2026-08-03",
            },
          },
          schema: recommendationResponseSchema,
        },
      },
      description: "Hydrated Clothing Recommendation.",
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
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Clothing Recommendation was not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Clothing Recommendation",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Reads one hydrated Clothing Recommendation by identifier. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: recommendationId path parameter. Success response: 200 with the recommendation, current Item imagery, retrieval facts, archive state, wear state, and computed availability. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the recommendation does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const declineInventoryClothingRecommendationRoute = createRoute({
  method: "post",
  operationId: "declineInventoryClothingRecommendation",
  path: "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}/decline",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: recommendationPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            recommendation: {
              createdAt: "2026-08-03T09:00:00.000Z",
              event: null,
              id: "recommendation-1",
              kind: "DAILY",
              options: [
                {
                  id: "option-primary",
                  items: [
                    {
                      archiveState: "ACTIVE",
                      availability: "AVAILABLE",
                      clothingState: "clean",
                      id: "item-shirt",
                      imageId: "image-shirt",
                      title: "Blue oxford shirt",
                      where: "Hall closet / Rail A × 1",
                    },
                  ],
                  reason: "Breathable layers for a warm meeting day.",
                  slot: "PRIMARY",
                },
              ],
              publishedAt: "2026-08-03T09:00:00.000Z",
              publishedBy: {
                clientId: "client-outfit-writer",
                clientKind: "api-key",
                clientName: "Outfit Writer",
              },
              reason: "Client picked a concise outfit for Monday, August 3, 2026.",
              status: "DECLINED",
              supersededByRecommendationId: null,
              targetDate: "2026-08-03",
            },
          },
          schema: recommendationResponseSchema,
        },
      },
      description: "Declined one published Clothing Recommendation.",
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
      description: "The command is missing an Idempotency-Key.",
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
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Clothing Recommendation does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
            message: "Only published Clothing Recommendations can be declined.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The recommendation is not currently published, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Decline one Clothing Recommendation",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Declines one currently published Clothing Recommendation without mutating any Clothing Profiles or Placements. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: recommendationId path parameter plus Idempotency-Key header. Success response: 200 with the declined recommendation. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the recommendation does not exist, 409 when the recommendation is not currently published or the key is reused with different input. Side effects: marks the recommendation declined. Destructive: no. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

const markInventoryClothingRecommendationWornRoute = createRoute({
  method: "post",
  operationId: "markInventoryClothingRecommendationWorn",
  path: "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}/worn",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            optionId: "option-primary",
          },
          schema: markRecommendationWornRequestSchema,
        },
      },
    },
    headers: idempotencyKeyHeadersSchema,
    params: recommendationPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            recommendation: {
              createdAt: "2026-08-03T09:00:00.000Z",
              event: null,
              id: "recommendation-1",
              kind: "DAILY",
              options: [
                {
                  id: "option-primary",
                  items: [
                    {
                      archiveState: "ACTIVE",
                      availability: "UNAVAILABLE",
                      clothingState: "dirty",
                      id: "item-shirt",
                      imageId: "image-shirt",
                      title: "Blue oxford shirt",
                      where: "Hall closet / Rail A × 1",
                    },
                  ],
                  reason: "Breathable layers for a warm meeting day.",
                  slot: "PRIMARY",
                },
              ],
              publishedAt: "2026-08-03T09:00:00.000Z",
              publishedBy: {
                clientId: "client-outfit-writer",
                clientKind: "api-key",
                clientName: "Outfit Writer",
              },
              reason: "Client picked a concise outfit for Monday, August 3, 2026.",
              status: "WORN",
              supersededByRecommendationId: null,
              targetDate: "2026-08-03",
            },
            wearConfirmation: {
              createdAt: "2026-08-03T10:30:00.000Z",
              id: "wear_123",
              itemIds: ["item-shirt"],
              undoneAt: null,
            },
          },
          schema: markRecommendationWornResponseSchema,
        },
      },
      description: "Recorded one Clothing Recommendation as worn.",
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
      description: "The request body or Idempotency-Key is invalid.",
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
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Clothing Recommendation does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
            message: "Selected Clothing Recommendation is no longer available.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The recommendation is not currently wearable, a selected item is unavailable, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Mark one Clothing Recommendation worn",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Confirms actual wear for one currently published Clothing Recommendation, defaults to its primary option, and dirties exactly the selected option in one atomic command. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: recommendationId path parameter, optional optionId JSON body, and Idempotency-Key header. Success response: 200 with the updated recommendation and one Wear Confirmation. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the recommendation does not exist, 409 when the recommendation is not currently wearable, a selected item is unavailable, or the key is reused with different input. Side effects: marks only the selected option's Clothing Profiles dirty, creates one Wear Confirmation, and marks the recommendation worn. Destructive: no. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

function createInventoryClothingRecommendationsRouteHandlers(
  options: {
    runCommand?: InventoryClothingRecommendationMutationRunner;
  } = {},
): InventoryClothingRecommendationsRouteHandlers {
  const runCommand = options.runCommand ?? runIdempotentCommand;

  return {
    async declineRecommendation(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const recommendation =
            await transaction.inventoryClothingRecommendation.findUnique({
              include: recommendationInclude,
              where: {
                id: input.recommendationId.trim(),
              },
            });

          if (!recommendation) {
            throw new InventoryClothingRecommendationNotFoundError();
          }

          if (recommendation.status !== "PUBLISHED") {
            throw new InventoryClothingRecommendationConflictError(
              "Only published Clothing Recommendations can be declined.",
            );
          }

          const declined =
            await transaction.inventoryClothingRecommendation.update({
              data: {
                status: "DECLINED",
              },
              include: recommendationInclude,
              where: {
                id: recommendation.id,
              },
            });

          return {
            body: {
              recommendation: mapRecommendation(declined),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          recommendationId: input.recommendationId.trim(),
        },
      });

      return readIdempotentRouteResult(result);
    },

    async listRecommendations(input) {
      const now = new Date();
      const today = parseDateOnly(
        inventoryClothingLocalDayKey(now, input.timeZone ?? "UTC"),
      );
      const hasExplicitStatus = Boolean(input.status);
      const hasExplicitDateWindow = Boolean(input.from || input.to);
      const where: Prisma.InventoryClothingRecommendationWhereInput = {
        ...(input.kind ? { kind: input.kind } : {}),
        status: input.status ?? "PUBLISHED",
        ...(input.from || input.to
          ? {
              targetDate: {
                ...(input.from ? { gte: parseDateOnly(input.from) } : {}),
                ...(input.to ? { lte: parseDateOnly(input.to) } : {}),
              },
            }
          : {}),
      };

      if (!hasExplicitStatus && !hasExplicitDateWindow) {
        if (input.kind === "DAILY") {
          where.targetDate = today;
        } else if (input.kind === "EVENT") {
          where.eventStartsAt = {
            gte: now,
          };
        } else {
          where.OR = [
            {
              kind: "DAILY",
              targetDate: today,
            },
            {
              eventStartsAt: {
                gte: now,
              },
              kind: "EVENT",
            },
          ];
        }
      }

      const rows = await prisma.inventoryClothingRecommendation.findMany({
        include: recommendationInclude,
        orderBy: [
          { targetDate: "asc" },
          { eventStartsAt: { nulls: "first", sort: "asc" } },
          { publishedAt: "desc" },
        ],
        take: input.limit,
        where,
      });

      return rows.sort(sortRecommendationRecords).map(mapRecommendation);
    },

    async getRecommendation(recommendationId) {
      const row = await prisma.inventoryClothingRecommendation.findUnique({
        include: recommendationInclude,
        where: { id: recommendationId.trim() },
      });

      return row ? mapRecommendation(row) : null;
    },

    async markRecommendationWorn(input) {
      const request = sanitizeMarkRecommendationWornRequest(input.request);
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const recommendation =
            await transaction.inventoryClothingRecommendation.findUnique({
              include: recommendationInclude,
              where: {
                id: input.recommendationId.trim(),
              },
            });

          if (!recommendation) {
            throw new InventoryClothingRecommendationNotFoundError();
          }

          if (recommendation.status !== "PUBLISHED") {
            throw new InventoryClothingRecommendationConflictError(
              "Only published Clothing Recommendations can be worn.",
            );
          }

          const selectedOption = request.optionId
            ? recommendation.options.find((option) => option.id === request.optionId)
            : recommendation.options.find((option) => option.slot === "PRIMARY");

          if (!selectedOption) {
            throw new InventoryClothingRecommendationConflictError(
              "Selected Clothing Recommendation option was not found.",
            );
          }

          if (selectedOption.items.some(({ item }) => item === null)) {
            throw new InventoryClothingRecommendationConflictError(
              "Selected Clothing Recommendation contains a deleted Item.",
            );
          }

          const selectedItems = selectedOption.items.flatMap(({ item }) =>
            item ? [item] : [],
          );

          for (const item of selectedItems) {
            if (
              item.archivedAt !== null ||
              item.category !== "clothing" ||
              !item.clothingProfile ||
              !hasCleanClothingUnit(item)
            ) {
              throw new InventoryClothingRecommendationConflictError(
                "Selected Clothing Recommendation is no longer available.",
              );
            }
          }

          const wearConfirmation =
            await transaction.inventoryClothingWearConfirmation.create({
              data: {
                confirmedByClientId: input.clientId,
                items: {
                  create: selectedItems.map((item) => ({
                    itemId: item.id,
                    productId: item.id,
                    productTitle: recommendationSnapshotTitle(item),
                    wearStateVersionAfter:
                      item.clothingProfile!.wearStateVersion + 1,
                  })),
                },
                recommendationId: recommendation.id,
                recommendationOptionId: selectedOption.id,
              },
              include: {
                items: {
                  select: {
                    productId: true,
                  },
                },
              },
            });

          for (const item of selectedItems) {
            await transaction.inventoryClothingProfile.update({
              data: {
                dirtyQuantity: { increment: 1 },
                isDirty: true,
                wearStateVersion: {
                  increment: 1,
                },
              },
              where: {
                itemId: item.id,
              },
            });
          }

          const worn = await transaction.inventoryClothingRecommendation.update({
            data: {
              status: "WORN",
            },
            include: recommendationInclude,
            where: {
              id: recommendation.id,
            },
          });

          return {
            body: {
              recommendation: mapRecommendation(worn),
              wearConfirmation:
                mapInventoryClothingRecommendationWearConfirmation(
                  wearConfirmation,
                ),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          optionId: request.optionId ?? null,
          recommendationId: input.recommendationId.trim(),
        },
      });

      return readIdempotentRouteResult(result);
    },

    async publishRecommendation(input) {
      const request = sanitizePublishRequest(input.request);
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          assertUniqueOptionItemIds(request.primary.itemIds, "primary");
          assertUniqueOptionItemIds(
            request.alternative?.itemIds ?? [],
            "alternative",
          );

          const targetDate = parseDateOnly(request.targetDate);
          const eventStartsAt = request.event
            ? new Date(request.event.startsAt)
            : null;
          const uniqueItemIds = [
            ...new Set([
              ...request.primary.itemIds,
              ...(request.alternative?.itemIds ?? []),
            ]),
          ];
          const items = await transaction.inventoryItem.findMany({
            include: recommendationItemInclude,
            where: {
              id: {
                in: uniqueItemIds,
              },
            },
          });
          const itemsById = new Map(items.map((item) => [item.id, item]));

          if (items.length !== uniqueItemIds.length) {
            throw new InventoryClothingRecommendationConflictError(
              "One or more Clothing Items were missing.",
            );
          }

          for (const itemId of uniqueItemIds) {
            const item = itemsById.get(itemId);

            if (!item) {
              throw new InventoryClothingRecommendationConflictError(
                "One or more Clothing Items were missing.",
              );
            }

            if (item.archivedAt) {
              throw new InventoryClothingRecommendationConflictError(
                "Archived Clothing Items cannot be recommended.",
              );
            }

            if (item.category !== "clothing") {
              throw new InventoryClothingRecommendationConflictError(
                "Only Clothing Items can be recommended.",
              );
            }

            if (!item.clothingProfile) {
              throw new InventoryClothingRecommendationConflictError(
                "Clothing Items require a Clothing Profile before recommendation.",
              );
            }

            if (!hasCleanClothingUnit(item)) {
              throw new InventoryClothingRecommendationConflictError(
                "Clothing Items without a clean unit cannot be recommended.",
              );
            }
          }

          const currentPublished =
            await transaction.inventoryClothingRecommendation.findFirst({
              where: {
                ...(request.kind === "DAILY"
                  ? {
                      kind: "DAILY",
                      targetDate,
                    }
                  : {
                      eventLabel: request.event!.label,
                      eventStartsAt,
                      kind: "EVENT",
                    }),
                status: "PUBLISHED",
              },
            });

          if (request.supersedesRecommendationId) {
            const superseded =
              await transaction.inventoryClothingRecommendation.findUnique({
                where: {
                  id: request.supersedesRecommendationId,
                },
              });

            if (!superseded) {
              throw new InventoryClothingRecommendationNotFoundError();
            }

            if (
              !currentPublished ||
              currentPublished.id !== superseded.id ||
              superseded.kind !== request.kind ||
              superseded.status !== "PUBLISHED" ||
              formatDateOnly(superseded.targetDate) !== request.targetDate ||
              !recommendationSlotMatchesRequest(
                superseded,
                request,
                eventStartsAt,
              )
            ) {
              throw new InventoryClothingRecommendationConflictError(
                "Superseded Clothing Recommendation does not match the published slot.",
              );
            }
          } else if (currentPublished) {
            throw new InventoryClothingRecommendationConflictError(
              request.kind === "DAILY"
                ? "Daily Clothing Recommendation already exists for target date."
                : "Event Clothing Recommendation already exists for label and start time.",
            );
          }

          const recommendationId = randomUUID();

          if (currentPublished) {
            await transaction.inventoryClothingRecommendation.update({
              data: {
                status: "SUPERSEDED",
                supersededByRecommendationId: recommendationId,
              },
              where: {
                id: currentPublished.id,
              },
            });
          }

          await transaction.inventoryClothingRecommendation.create({
            data: {
              eventLabel: request.event?.label ?? null,
              eventStartsAt,
              id: recommendationId,
              kind: request.kind,
              options: {
                create: [
                  {
                    id: randomUUID(),
                    items: {
                      create: request.primary.itemIds.map(
                        (itemId, index) => {
                          const item = itemsById.get(itemId)!;
                          return {
                            id: randomUUID(),
                            itemId,
                            productId: itemId,
                            productTitle: recommendationSnapshotTitle(item),
                            position: index,
                          };
                        },
                      ),
                    },
                    reason: request.primary.reason ?? null,
                    slot: "PRIMARY",
                  },
                  ...(request.alternative
                    ? [
                        {
                          id: randomUUID(),
                          items: {
                            create: request.alternative.itemIds.map(
                              (itemId, index) => {
                                const item = itemsById.get(itemId)!;
                                return {
                                  id: randomUUID(),
                                  itemId,
                                  productId: itemId,
                                  productTitle: recommendationSnapshotTitle(item),
                                  position: index,
                                };
                              },
                            ),
                          },
                          reason: request.alternative.reason ?? null,
                          slot: "ALTERNATIVE" as const,
                        },
                      ]
                    : []),
                ],
              },
              publishedByClientId: input.publishedBy.clientId,
              publishedByClientKind: input.publishedBy.clientKind,
              publishedByClientName: input.publishedBy.clientName,
              reason: request.reason,
              targetDate,
            },
          });

          const created =
            await transaction.inventoryClothingRecommendation.findUnique({
              include: recommendationInclude,
              where: {
                id: recommendationId,
              },
            });

          if (!created) {
            throw new InventoryClothingRecommendationNotFoundError();
          }

          return {
            body: {
              recommendation: mapRecommendation(created),
            },
            kind: "success" as const,
            status: 201,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          ...request,
          publishedBy: input.publishedBy,
        },
      });

      return readIdempotentRouteResult(result);
    },
  };
}

const inventoryClothingRecommendationsRouteHandlers =
  createInventoryClothingRecommendationsRouteHandlers();

function registerInventoryClothingRecommendationRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  handlers: InventoryClothingRecommendationsRouteHandlers,
) {
  app.openapi(listInventoryClothingRecommendationsRoute, async (context) => {
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
        recommendations: await handlers.listRecommendations({
          from: query.from,
          kind:
            query.kind === "daily"
              ? "DAILY"
              : query.kind === "event"
                ? "EVENT"
                : undefined,
          limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
          status:
            query.status === "declined"
              ? "DECLINED"
              : query.status === "worn"
                ? "WORN"
                : query.status === "published"
                  ? "PUBLISHED"
                  : undefined,
          ...(query.timeZone ? { timeZone: query.timeZone } : {}),
          to: query.to,
        }),
      },
      200,
    );
  });

  app.openapi(
    publishInventoryClothingRecommendationRoute,
    async (context) => {
      const authorization = authorizeAccessContext(
        context.get("accessContext"),
        {
          action: "write",
          domain: "inventory",
        },
      );

      if (!authorization.ok) {
        return jsonAuthorizationFailure(context, authorization.error);
      }

      const { client } = authorization.accessContext;
      if (client.kind === "agent") {
        return jsonAuthorizationFailure(context, {
          code: "FORBIDDEN",
          message: "Agent Clients cannot publish clothing recommendations.",
        });
      }

      let requestKind: "DAILY" | "EVENT" | undefined;

      try {
        const request =
          (await context.req.json()) as PublishInventoryClothingRecommendationRequest;
        requestKind = request.kind;

        return context.json(
          await handlers.publishRecommendation({
            clientId: client.id,
            idempotencyKey: context.req.header("idempotency-key")?.trim() ?? "",
            operation: "publishInventoryClothingRecommendation",
            publishedBy: {
              clientId: client.id,
              clientKind: client.kind,
              clientName: client.name,
            },
            request,
          }),
          201,
        );
      } catch (error) {
        return normalizeRecommendationRouteError(context, error, requestKind);
      }
    },
  );

  app.openapi(getInventoryClothingRecommendationRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });

    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const recommendationId = context.req.param("recommendationId");

    if (!recommendationId) {
      return jsonApiError(context, {
        code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
        message: "Inventory Clothing Recommendation was not found.",
        status: 404,
      });
    }

    const recommendation = await handlers.getRecommendation(recommendationId);

    if (!recommendation) {
      return jsonApiError(
        context,
        {
          code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
          message: "Inventory Clothing Recommendation was not found.",
          status: 404,
        },
      );
    }

    return context.json({ recommendation }, 200);
  });

  app.openapi(
    declineInventoryClothingRecommendationRoute,
    async (context) => {
      const authorization = authorizeAccessContext(
        context.get("accessContext"),
        {
          action: "write",
          domain: "inventory",
        },
      );

      if (!authorization.ok) {
        return jsonAuthorizationFailure(context, authorization.error);
      }

      try {
        const recommendationId = context.req.param("recommendationId");

        if (!recommendationId) {
          return jsonApiError(context, {
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
            status: 404,
          });
        }

        return context.json(
          await handlers.declineRecommendation({
            clientId: authorization.accessContext.client.id,
            idempotencyKey: context.req.header("idempotency-key")?.trim() ?? "",
            operation: "declineInventoryClothingRecommendation",
            recommendationId,
          }),
          200,
        );
      } catch (error) {
        return normalizeRecommendationRouteError(context, error);
      }
    },
  );

  app.openapi(
    markInventoryClothingRecommendationWornRoute,
    async (context) => {
      const authorization = authorizeAccessContext(
        context.get("accessContext"),
        {
          action: "write",
          domain: "inventory",
        },
      );

      if (!authorization.ok) {
        return jsonAuthorizationFailure(context, authorization.error);
      }

      try {
        const recommendationId = context.req.param("recommendationId");

        if (!recommendationId) {
          return jsonApiError(context, {
            code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
            message: "Inventory Clothing Recommendation was not found.",
            status: 404,
          });
        }

        const request = context.req.raw.body
          ? (await context.req.json()) as MarkInventoryClothingRecommendationWornRequest
          : {};

        return context.json(
          await handlers.markRecommendationWorn({
            clientId: authorization.accessContext.client.id,
            idempotencyKey: context.req.header("idempotency-key")?.trim() ?? "",
            operation: "markInventoryClothingRecommendationWorn",
            recommendationId,
            request,
          }),
          200,
        );
      } catch (error) {
        return normalizeRecommendationRouteError(context, error);
      }
    },
  );
}

function sanitizePublishRequest(
  input: PublishInventoryClothingRecommendationRequest,
): PublishInventoryClothingRecommendationRequest {
  return {
    alternative: input.alternative
      ? {
          itemIds: input.alternative.itemIds.map((itemId) =>
            itemId.trim(),
          ),
          ...(input.alternative.reason
            ? { reason: input.alternative.reason.trim() }
            : {}),
        }
      : undefined,
    ...(input.event
      ? {
          event: {
            label: input.event.label.trim(),
            startsAt: input.event.startsAt,
          },
        }
      : {}),
    kind: input.kind,
    primary: {
      itemIds: input.primary.itemIds.map((itemId) => itemId.trim()),
      ...(input.primary.reason ? { reason: input.primary.reason.trim() } : {}),
    },
    reason: input.reason.trim(),
    ...(input.supersedesRecommendationId
      ? {
          supersedesRecommendationId:
            input.supersedesRecommendationId.trim(),
        }
      : {}),
    targetDate: input.targetDate,
  };
}

function sanitizeMarkRecommendationWornRequest(
  input: MarkInventoryClothingRecommendationWornRequest,
): MarkInventoryClothingRecommendationWornRequest {
  return input.optionId ? { optionId: input.optionId.trim() } : {};
}

function assertUniqueOptionItemIds(itemIds: string[], label: string) {
  if (new Set(itemIds).size !== itemIds.length) {
    throw new InventoryClothingRecommendationConflictError(
      `Duplicate Clothing Items are not allowed in the ${label} outfit.`,
    );
  }
}

function parseDateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function isValidIanaTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function inventoryClothingLocalDayKey(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "01";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function recommendationSlotMatchesRequest(
  recommendation: Pick<
    RecommendationRecord,
    "eventLabel" | "eventStartsAt" | "kind" | "targetDate"
  >,
  request: PublishInventoryClothingRecommendationRequest,
  eventStartsAt: Date | null,
) {
  if (request.kind === "DAILY") {
    return formatDateOnly(recommendation.targetDate) === request.targetDate;
  }

  return (
    recommendation.eventLabel === request.event?.label &&
    recommendation.eventStartsAt?.toISOString() === eventStartsAt?.toISOString()
  );
}

function sortRecommendationRecords(
  left: RecommendationRecord,
  right: RecommendationRecord,
) {
  const targetDateDifference = left.targetDate.getTime() - right.targetDate.getTime();

  if (targetDateDifference !== 0) {
    return targetDateDifference;
  }

  const leftStart = left.eventStartsAt?.getTime() ?? left.targetDate.getTime() - 1;
  const rightStart =
    right.eventStartsAt?.getTime() ?? right.targetDate.getTime() - 1;
  const startDifference = leftStart - rightStart;

  if (startDifference !== 0) {
    return startDifference;
  }

  return right.publishedAt.getTime() - left.publishedAt.getTime();
}

function mapRecommendation(
  recommendation: RecommendationRecord,
): InventoryClothingRecommendation {
  return {
    createdAt: recommendation.createdAt.toISOString(),
    event:
      recommendation.kind === "EVENT" &&
      recommendation.eventLabel &&
      recommendation.eventStartsAt
        ? {
            label: recommendation.eventLabel,
            startsAt: recommendation.eventStartsAt.toISOString(),
          }
        : null,
    id: recommendation.id,
    kind: recommendation.kind,
    options: [...recommendation.options]
      .sort((left, right) => optionSortValue(left.slot) - optionSortValue(right.slot))
      .map((option) => ({
        id: option.id,
        items: option.items.map(mapRecommendationItem),
        reason: option.reason ?? null,
        slot: option.slot === "PRIMARY" ? "PRIMARY" : "ALTERNATIVE",
      })),
    publishedAt: recommendation.publishedAt.toISOString(),
    publishedBy: {
      clientId: recommendation.publishedByClientId,
      clientKind:
        recommendation.publishedByClientKind === "web" ? "web" : "api-key",
      clientName: recommendation.publishedByClientName,
    },
    reason: recommendation.reason,
    status: recommendation.status,
    supersededByRecommendationId:
      recommendation.supersededByRecommendationId ?? null,
    targetDate: formatDateOnly(recommendation.targetDate),
  };
}

function mapRecommendationItem(
  history: RecommendationRecord["options"][number]["items"][number],
): InventoryClothingRecommendationItem {
  const { item } = history;

  if (!item) {
    return {
      archiveState: "DELETED",
      availability: "UNAVAILABLE",
      clothingState: null,
      id: history.productId,
      imageId: null,
      title: history.productTitle,
      where: "Deleted Item",
    };
  }

  const clothingState = item.clothingProfile
    ? item.clothingProfile.dirtyQuantity > 0
      ? "dirty"
      : "clean"
    : null;

  return {
    archiveState: item.archivedAt ? ("ARCHIVED" as const) : ("ACTIVE" as const),
    availability:
      !item.archivedAt &&
      item.category === "clothing" &&
      item.clothingProfile &&
      hasCleanClothingUnit(item)
        ? ("AVAILABLE" as const)
        : ("UNAVAILABLE" as const),
    clothingState,
    id: item.id,
    imageId: item.images[0]?.id ?? null,
    title: item.title ?? item.captureText ?? "Untitled Clothing Item",
    where: formatRecommendationWhere(item.placements),
  };
}

function hasCleanClothingUnit(item: {
  clothingProfile: { dirtyQuantity: number } | null;
  placements: Array<{ quantity: number }>;
}): boolean {
  if (!item.clothingProfile) {
    return false;
  }

  const totalQuantity = item.placements.reduce(
    (total, placement) => total + placement.quantity,
    0,
  );
  return item.clothingProfile.dirtyQuantity < totalQuantity;
}

function mapInventoryClothingRecommendationWearConfirmation(
  confirmation: {
    createdAt: Date;
    id: string;
    items: Array<{ productId: string }>;
    undoneAt: Date | null;
  },
): InventoryClothingRecommendationWearConfirmation {
  return {
    createdAt: confirmation.createdAt.toISOString(),
    id: confirmation.id,
    itemIds: confirmation.items.map(({ productId }) => productId),
    undoneAt: confirmation.undoneAt?.toISOString() ?? null,
  };
}

function recommendationSnapshotTitle(item: {
  captureText?: string | null;
  title?: string | null;
}) {
  return item.title ?? item.captureText ?? "Untitled Clothing Item";
}

function formatRecommendationWhere(
  placements: Prisma.InventoryItemGetPayload<{
    include: typeof recommendationItemInclude;
  }>["placements"],
) {
  const placement = placements[0];

  if (!placement) {
    return "Unplaced";
  }

  const label = placement.container
    ? placement.container.location
      ? `${placement.container.location.name} / ${placement.container.name} (${placement.container.referenceId})`
      : `${placement.container.name} (${placement.container.referenceId})`
    : placement.location
      ? placement.location.name
      : placement.note?.trim() || "Unplaced";

  return `${label} × ${placement.quantity}`;
}

function optionSortValue(slot: "PRIMARY" | "ALTERNATIVE") {
  return slot === "PRIMARY" ? 0 : 1;
}

function readIdempotentRouteResult<TResponse extends Record<string, unknown>>(
  result: IdempotentCommandResult<TResponse>,
) {
  if (result.kind === "conflict") {
    throw new InventoryClothingRecommendationConflictError(
      result.message,
      result.code,
    );
  }

  return result.body;
}

function normalizeRecommendationRouteError(
  context: Parameters<typeof jsonApiError>[0],
  error: unknown,
  recommendationKind?: "DAILY" | "EVENT",
) {
  if (error instanceof InventoryClothingRecommendationNotFoundError) {
    return jsonApiError(
      context,
      {
        code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
        message: error.message,
        status: 404,
      },
    );
  }

  if (error instanceof InventoryClothingRecommendationConflictError) {
    return jsonApiError(context, {
      code: error.code,
      message: error.message,
      status: 409,
    });
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return jsonApiError(
      context,
      {
        code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
        message:
          recommendationKind === "DAILY"
            ? "Daily Clothing Recommendation already exists for target date."
            : recommendationKind === "EVENT"
              ? "Event Clothing Recommendation already exists for label and start time."
              : "Clothing Recommendation conflicts with current state.",
        status: 409,
      },
    );
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  ) {
    return jsonApiError(context, {
      code: "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT",
      message: "Clothing Recommendation references unavailable data.",
      status: 409,
    });
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    return jsonApiError(
      context,
      {
        code: "INVENTORY_CLOTHING_RECOMMENDATION_NOT_FOUND",
        message: "Inventory Clothing Recommendation was not found.",
        status: 404,
      },
    );
  }

  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "IDEMPOTENCY_CONFLICT" ||
      error.code === "INVENTORY_CLOTHING_RECOMMENDATION_CONFLICT")
  ) {
    return jsonApiError(context, {
      code: error.code,
      message: error.message,
      status: 409,
    });
  }

  throw error;
}

export {
  createInventoryClothingRecommendationsRouteHandlers,
  inventoryClothingRecommendationsRouteHandlers,
  registerInventoryClothingRecommendationRoutes,
  type InventoryClothingRecommendation,
  type InventoryClothingRecommendationsRouteHandlers,
};
