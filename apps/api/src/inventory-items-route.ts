import { queueOriginalDeletions } from "./original-files";
import { assertOriginalWritesEnabled } from "./original-storage";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import type {
  InventoryContainer,
  InventoryEnrichmentJob,
  InventoryEnrichmentSettings as PrismaInventoryEnrichmentSettings,
  InventoryItemAsset,
  InventoryItemAudio,
  InventoryItemImage,
  InventoryLocation,
  InventoryPreprocessingJob,
} from "@quantself/db/generated/prisma/client";
import type { Context } from "hono";
import {
  buildInventoryItemSearchText,
  addInventoryUnits as addInventoryUnitsService,
  defaultInventoryClothingProfileAttributes,
  moveInventoryUnits as moveInventoryUnitsService,
  removeInventoryUnits as removeInventoryUnitsService,
  formatInventoryAcquisitionSourceLabel,
  formatInventoryContainerLabel,
  formatInventoryEstimatedValue,
  formatInventoryPlacementSummary,
  formatInventoryWhere,
  formatInventoryCategoryLabel,
  normalizeInventoryCategory,
  readInventoryItemManualFieldLocks,
  updateInventoryItem as updateInventoryItemService,
  type InventoryContainerRecord,
  type InventoryContainerVisualPresetRecord,
  type InventoryItemAssetRecord,
  type InventoryItemAudioRecord,
  type InventoryItemMutationRepository as InventoryServiceItemMutationRepository,
  type InventoryItemRecord,
  type InventoryItemUpdateRecordInput,
  type InventoryLocationKind,
  type InventoryLocationRecord,
  type InventoryPlacementMutationRepository,
} from "./inventory-service";
import {
  approveInventoryEnrichmentProposal as approveInventoryEnrichmentProposalService,
  getInventoryEnrichmentSettings as getInventoryEnrichmentSettingsService,
  listInventoryEnrichmentProposals as listInventoryEnrichmentProposalsService,
  rejectInventoryEnrichmentProposal as rejectInventoryEnrichmentProposalService,
  retryInventoryEnrichment as retryInventoryEnrichmentService,
  updateInventoryEnrichmentSettings as updateInventoryEnrichmentSettingsService,
  type InventoryEnrichmentFailureDetail,
  type InventoryEnrichmentInputSnapshot,
  type InventoryEnrichmentNewJobRecord,
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentJobStatus,
  type InventoryEnrichmentResultPayload,
  type InventoryEnrichmentSettingsRecord,
  type InventoryEnrichmentRepository,
  InventoryEnrichmentRetryConflictError,
  InventoryEnrichmentRetryNotAllowedError,
  type InventoryEnrichmentRetryRepository,
} from "./inventory-enrichment-service";
import {
  retryInventoryPreprocessing as retryInventoryPreprocessingService,
  InventoryPreprocessingRetryConflictError,
  InventoryPreprocessingRetryNotAllowedError,
  type InventoryPreprocessingJobRecord,
  type InventoryPreprocessingNewJobRecord,
  type InventoryPreprocessingRetryRepository,
} from "./inventory-preprocessing-service";
import {
  getDefaultInventoryContainerVisualCatalogEntry,
  getInventoryContainerVisualCatalogEntry,
} from "../../web/lib/inventory-container-visual-catalog";
import { inventoryRepository } from "./inventory-prisma-repository";
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
import { deleteInventoryStoredFiles } from "./inventory-storage";

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
const inventoryCategoryValues = [
  "food",
  "drink",
  "medical",
  "entertainment",
  "office",
  "sports",
  "clothing",
  "homeopathy",
  "supplement",
  "technology",
  "cosmetics",
  "documents",
  "tools",
  "cleaning",
  "kitchen",
  "household",
  "other",
] as const;
const inventoryClothingStateValues = ["clean", "dirty"] as const;
const remedyIntakeRangeValues = ["7d", "30d", "90d", "all"] as const;
const remedyIntakePageSize = 100;
const inventoryItemPageSize = 24;

const inventoryItemPlacementSchema = z
  .object({
    containerId: z.string().min(1).nullable().openapi({ example: "container_123" }),
    locationId: z.string().min(1).nullable().openapi({ example: "location_123" }),
    locationName: z.string().min(1).nullable().openapi({ example: "Hall closet" }),
    label: z
      .string()
      .min(1)
      .openapi({ example: "Hall closet / Travel drawer (BIN-0003)" }),
    note: z.string().min(1).nullable().openapi({ example: "Loose shelf" }),
    placementId: z.string().min(1).openapi({ example: "placement_123" }),
    quantity: z.int().positive().openapi({ example: 2 }),
  })
  .openapi("InventoryItemPlacement");

const inventoryProcessingEvidenceSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "image_123" }),
    kind: z
      .enum(["photo", "voice", "video", "file", "text"])
      .openapi({ example: "photo" }),
    label: z.string().min(1).openapi({ example: "Item Image" }),
    summary: z.string().min(1).openapi({ example: "Passport and boarding pass visible." }),
  })
  .openapi("InventoryProcessingEvidence");

const inventoryItemPreprocessingStateSchema = z
  .object({
    attempts: z.int().nonnegative().openapi({ example: 2 }),
    failedAt: z.iso.datetime().nullable().openapi({
      example: "2026-07-28T12:03:00.000Z",
    }),
    failedSteps: z.array(z.string().min(1)).openapi({
      example: ["Audio transcription timed out."],
    }),
    failureMessage: z.string().min(1).nullable().openapi({
      example: "Audio transcription timed out.",
    }),
    maxAttempts: z.int().positive().openapi({ example: 3 }),
    mediaTexts: z.array(z.string().min(1)).openapi({
      example: ["OCR: PASSPORT USB-C CHARGER"],
    }),
    status: z
      .enum([
        "CAPTURED",
        "PREPROCESSING",
        "READY_FOR_ENRICHMENT",
        "PARTIAL",
        "NEEDS_REVIEW",
        "FAILED",
      ])
      .openapi({ example: "PREPROCESSING" }),
    summary: z
      .string()
      .min(1)
      .openapi({ example: "Inventory Preprocessing is reading saved evidence." }),
    textBundleAvailable: z.boolean().openapi({ example: true }),
    retryable: z.boolean().openapi({ example: true }),
    updatedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:03:00.000Z" }),
  })
  .openapi("InventoryItemPreprocessingState");

const inventoryItemEnrichmentStateSchema = z
  .object({
    attempts: z.int().nonnegative().openapi({ example: 2 }),
    failedAt: z.iso.datetime().nullable().openapi({
      example: "2026-07-28T12:04:00.000Z",
    }),
    failureMessage: z.string().min(1).nullable().openapi({
      example: "Enrichment provider timed out.",
    }),
    maxAttempts: z.int().positive().openapi({ example: 3 }),
    rationale: z
      .string()
      .min(1)
      .openapi({ example: "OCR and transcript mention passports and chargers." }),
    status: z
      .enum([
        "NOT_STARTED",
        "QUEUED",
        "PROCESSING",
        "PROPOSAL_READY",
        "APPLIED",
        "FAILED",
        "REJECTED",
        "CANCELLED",
      ])
      .openapi({ example: "PROPOSAL_READY" }),
    summary: z
      .string()
      .min(1)
      .openapi({ example: "An Inventory Proposal is waiting for approval." }),
    retryable: z.boolean().openapi({ example: false }),
    updatedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:04:00.000Z" }),
  })
  .openapi("InventoryItemEnrichmentState");

const inventoryItemProposalStateSchema = z
  .object({
    status: z
      .enum(["NONE", "PENDING_APPROVAL", "APPROVED", "REJECTED"])
      .openapi({ example: "PENDING_APPROVAL" }),
    summary: z
      .string()
      .min(1)
      .openapi({ example: "Approval required before derived values change." }),
    updatedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:04:00.000Z" }),
  })
  .openapi("InventoryItemProposalState");

const inventoryItemProcessingHistoryEntrySchema = z
  .object({
    at: z.iso.datetime().openapi({ example: "2026-07-28T12:04:00.000Z" }),
    stage: z.enum(["preprocessing", "enrichment"]).openapi({
      example: "enrichment",
    }),
    status: z.string().min(1).openapi({ example: "FAILED" }),
    summary: z
      .string()
      .min(1)
      .openapi({ example: "Inventory Enrichment failed." }),
  })
  .openapi("InventoryItemProcessingHistoryEntry");

const inventoryItemProcessingSchema = z
  .object({
    currentStep: z.string().min(1).openapi({ example: "Proposal pending approval" }),
    evidence: z.array(inventoryProcessingEvidenceSchema).openapi({
      example: [
        {
          id: "image_123",
          kind: "photo",
          label: "Item Image",
          summary: "Passport and boarding pass visible.",
        },
      ],
    }),
    history: z.array(inventoryItemProcessingHistoryEntrySchema),
    nextAction: z.string().min(1).openapi({ example: "Review Inventory Proposal" }),
    preprocessing: inventoryItemPreprocessingStateSchema,
    enrichment: inventoryItemEnrichmentStateSchema,
    proposal: inventoryItemProposalStateSchema,
    sourceLabel: z.string().min(1).openapi({ example: "photo + voice + text capture" }),
  })
  .openapi("InventoryItemProcessing");

const inventoryClothingProfileAttributesSchema = z
  .object({
    version: z.literal(1).openapi({
      description: "Clothing Profile attribute schema version; always send 1.",
      example: 1,
    }),
    kind: z.string().min(1).optional().openapi({
      description: "Garment kind, such as shirt, trousers, jacket, or shoes.",
      example: "shirt",
    }),
    colors: z.array(z.string().min(1)).optional().openapi({
      description: "Observed garment colors.",
      example: ["blue", "white"],
    }),
    layer: z.string().min(1).optional().openapi({
      description: "Layer role, such as base, mid, outer, or footwear.",
      example: "base",
    }),
    warmth: z.string().min(1).optional().openapi({
      description: "Relative warmth useful for outfit decisions.",
      example: "medium",
    }),
    formality: z.string().min(1).optional().openapi({
      description: "Formality level useful for occasion matching.",
      example: "smart-casual",
    }),
    weather: z.array(z.string().min(1)).optional().openapi({
      description: "Suitable weather conditions.",
      example: ["mild", "cool"],
    }),
    occasionTags: z.array(z.string().min(1)).optional().openapi({
      description: "Suitable activities or occasions.",
      example: ["office", "travel"],
    }),
    material: z.string().min(1).optional().openapi({
      description: "Primary observed material.",
      example: "cotton",
    }),
    fitNotes: z.string().min(1).optional().openapi({
      description: "Owner-specific fit facts.",
      example: "Works well untucked.",
    }),
    decisionNotes: z.string().min(1).optional().openapi({
      description: "Stable facts useful when choosing this Clothing Item.",
      example: "Reliable with dark jeans.",
    }),
  })
  .strict()
  .openapi("InventoryClothingProfileAttributes", {
    description:
      "Complete replacement shape for Clothing Profile attributes. GET and merge the current Profile before PUT so known fields are not lost.",
  });

function inventoryRemedyPotencySchema(description: string) {
  return z.string().trim().min(1).max(32).openapi({
    description,
    example: "30C",
  });
}

const inventoryClothingProfileSchema = z
  .object({
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    dirtyQuantity: z.int().nonnegative().openapi({
      description: "Number of owned units currently dirty.",
      example: 1,
    }),
    isDirty: z.boolean().openapi({ example: false }),
    attributes: inventoryClothingProfileAttributesSchema,
    createdAt: z.iso.datetime().openapi({
      example: "2026-08-03T09:00:00.000Z",
    }),
    updatedAt: z.iso.datetime().openapi({
      example: "2026-08-03T09:00:00.000Z",
    }),
  })
  .openapi("InventoryClothingProfile");

const inventoryRemedyExternalReferenceSchema = z
  .object({
    source: z.string().min(1).openapi({ example: "oorep" }),
    referenceId: z.string().min(1).optional().openapi({ example: "arn" }),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), {
        message: "External reference URL must use HTTPS.",
      })
      .openapi({ example: "https://www.oorep.com/remedy/arn" }),
  })
  .openapi("InventoryRemedyExternalReference");

const inventoryRemedyProfileSchema = z
  .object({
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    substanceId: z.string().min(1).openapi({ example: "substance_123" }),
    potencies: z
      .array(
        inventoryRemedyPotencySchema(
          "One normalized potency owned for this remedy.",
        ),
      )
      .min(1)
      .openapi({
        description:
          "Complete normalized set of all owned potencies on the single Remedy Profile.",
        example: ["30C", "200C"],
      }),
    selectionSummary: z
      .string()
      .nullable()
      .openapi({ example: "Restlessness after midnight." }),
    externalReferences: z
      .array(inventoryRemedyExternalReferenceSchema)
      .openapi({
        example: [
          {
            referenceId: "arn",
            source: "oorep",
            url: "https://www.oorep.com/remedy/arn",
          },
        ],
      }),
    registeredByClientId: z
      .string()
      .nullable()
      .openapi({ example: "research-client" }),
    createdAt: z.iso.datetime().openapi({
      example: "2026-08-03T09:00:00.000Z",
    }),
    updatedAt: z.iso.datetime().openapi({
      example: "2026-08-03T09:00:00.000Z",
    }),
  })
  .openapi("InventoryRemedyProfile");

const inventoryItemSchema = z
  .object({
    acquisitionSource: z
      .enum(inventoryAcquisitionSourceValues)
      .nullable()
      .openapi({ example: "gift" }),
    aliases: z.array(z.string()).openapi({ example: ["travel document pouch"] }),
    archivedAt: z
      .iso.datetime()
      .nullable()
      .openapi({ example: "2026-07-26T12:00:00.000Z" }),
    captureText: z
      .string()
      .nullable()
      .openapi({ example: "Passport, charger, and adapters in black pouch." }),
    capturedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:00:00.000Z" }),
    category: z
      .enum(inventoryCategoryValues)
      .nullable()
      .openapi({ example: "documents" }),
    clothingProfile: inventoryClothingProfileSchema
      .nullable()
      .openapi({
        example: {
          itemId: "item_123",
          isDirty: false,
          attributes: {
            version: 1,
            colors: ["blue", "white"],
            kind: "shirt",
          },
          createdAt: "2026-08-03T09:00:00.000Z",
          updatedAt: "2026-08-03T09:00:00.000Z",
        },
      }),
    remedyProfile: inventoryRemedyProfileSchema
      .nullable()
      .openapi({
        example: {
          itemId: "item_123",
          substanceId: "substance_123",
          potencies: ["30C", "200C"],
          selectionSummary: "Restlessness after midnight.",
          externalReferences: [
            {
              referenceId: "arn",
              source: "oorep",
              url: "https://www.oorep.com/remedy/arn",
            },
          ],
          registeredByClientId: "research-client",
          createdAt: "2026-08-03T09:00:00.000Z",
          updatedAt: "2026-08-03T09:00:00.000Z",
        },
      }),
    containerId: z.string().min(1).nullable().openapi({ example: "container_123" }),
    containerLabel: z
      .string()
      .nullable()
      .openapi({ example: "Travel drawer (BIN-0003)" }),
    costCents: z.int().nonnegative().nullable().openapi({ example: 1250 }),
    costCurrency: z.string().min(3).max(3).openapi({ example: "CAD" }),
    id: z.string().min(1).openapi({ example: "item_123" }),
    importance: z.enum(inventoryImportanceValues).openapi({ example: "HIGH" }),
    imageId: z.string().min(1).nullable().openapi({ example: "image_123" }),
    kind: z.enum(inventoryItemKinds).openapi({ example: "GROUP" }),
    matchExplanation: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "Matched title, search text" }),
    note: z.string().nullable().openapi({ example: "Needs sort" }),
    placementSummary: z
      .string()
      .min(1)
      .openapi({ example: "Total 2 · BIN-0003 2" }),
    placements: z
      .array(inventoryItemPlacementSchema)
      .openapi({
        example: [
          {
            containerId: "container_123",
            label: "Office cabinet / Travel drawer (BIN-0003)",
            locationId: "location_123",
            locationName: "Office cabinet",
            note: null,
            quantity: 2,
          },
        ],
      }),
    processing: inventoryItemProcessingSchema,
    status: z.enum(inventoryItemStatuses).openapi({ example: "KEEP" }),
    tags: z.array(z.string()).openapi({ example: ["documents", "travel"] }),
    title: z.string().min(1).openapi({ example: "Passport pouch" }),
    totalQuantity: z.int().nonnegative().openapi({ example: 2 }),
    where: z
      .string()
      .min(1)
      .openapi({ example: "Office cabinet / Travel drawer (BIN-0003)" }),
  })
  .openapi("InventoryItem");

const inventoryItemsResponseSchema = z
  .object({
    items: z
      .array(inventoryItemSchema)
      .openapi({
        example: [
          {
            acquisitionSource: "gift",
            aliases: ["travel document pouch"],
            archivedAt: null,
            captureText: "Passport, charger, and adapters in black pouch.",
            capturedAt: "2026-07-28T12:00:00.000Z",
            category: "documents",
            clothingProfile: null,
            remedyProfile: null,
            containerId: "container_123",
            containerLabel: "Travel drawer (BIN-0003)",
            costCents: 1250,
            costCurrency: "CAD",
            id: "item_123",
            importance: "HIGH",
            imageId: "image_123",
            kind: "GROUP",
            note: "Needs sort",
            placementSummary: "Total 2 · BIN-0003 2",
            placements: [
              {
                containerId: "container_123",
                label: "Office cabinet / Travel drawer (BIN-0003)",
                locationId: "location_123",
                locationName: "Office cabinet",
                note: null,
                quantity: 2,
              },
            ],
            processing: {
              currentStep: "Proposal pending approval",
              evidence: [
                {
                  id: "image_123",
                  kind: "photo",
                  label: "Item Image",
                  summary: "Passport and boarding pass visible.",
                },
              ],
              history: [],
              enrichment: {
                attempts: 1,
                failedAt: null,
                failureMessage: null,
                maxAttempts: 3,
                rationale: "OCR and transcript mention passports and chargers.",
                retryable: false,
                status: "PROPOSAL_READY",
                summary: "An Inventory Proposal is waiting for approval.",
                updatedAt: "2026-07-28T12:04:00.000Z",
              },
              nextAction: "Review Inventory Proposal",
              preprocessing: {
                attempts: 1,
                failedAt: null,
                failedSteps: [],
                failureMessage: null,
                maxAttempts: 3,
                mediaTexts: ["OCR: PASSPORT USB-C CHARGER"],
                status: "READY_FOR_ENRICHMENT",
                summary: "Inventory Text Bundle is ready for enrichment.",
                textBundleAvailable: true,
                retryable: false,
                updatedAt: "2026-07-28T12:03:00.000Z",
              },
              proposal: {
                status: "PENDING_APPROVAL",
                summary: "Approval required before derived values change.",
                updatedAt: "2026-07-28T12:04:00.000Z",
              },
              sourceLabel: "photo + voice + text capture",
            },
            status: "KEEP",
            tags: ["documents", "travel"],
            title: "Passport pouch",
            totalQuantity: 2,
            where: "Office cabinet / Travel drawer (BIN-0003)",
          },
        ],
      }),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
    }),
    total: z.int().nonnegative(),
  })
  .openapi("InventoryItemsResponse");

const inventoryItemResponseSchema = z
  .object({
    item: inventoryItemSchema,
  })
  .openapi("InventoryItemResponse");

const inventoryClothingProfileResponseSchema = z
  .object({
    clothingProfile: inventoryClothingProfileSchema,
  })
  .openapi("InventoryClothingProfileResponse");

const inventoryClothingWearConfirmationSchema = z
  .object({
    createdAt: z
      .iso.datetime()
      .openapi({ example: "2026-08-03T10:30:00.000Z" }),
    id: z.string().min(1).openapi({ example: "wear_123" }),
    itemIds: z
      .array(z.string().min(1))
      .openapi({ example: ["item_123"] }),
    undoneAt: z.iso.datetime().nullable().openapi({ example: null }),
  })
  .openapi("InventoryClothingWearConfirmation");

const markInventoryClothingItemWornResponseSchema = z
  .object({
    item: inventoryItemSchema,
    wearConfirmation: inventoryClothingWearConfirmationSchema,
  })
  .openapi("MarkInventoryClothingItemWornResponse");

const undoInventoryClothingWearConfirmationResponseSchema = z
  .object({
    items: z.array(inventoryItemSchema),
    wearConfirmation: inventoryClothingWearConfirmationSchema,
  })
  .openapi("UndoInventoryClothingWearConfirmationResponse");

const completeInventoryClothingLaundryRequestSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("all-dirty").openapi({ example: "all-dirty" }),
    }),
    z.object({
      mode: z.literal("selected").openapi({ example: "selected" }),
      itemIds: z
        .array(z.string().min(1))
        .min(1)
        .openapi({ example: ["item_123", "item_456"] }),
    }),
  ])
  .openapi("CompleteInventoryClothingLaundryRequest");

const completeInventoryClothingLaundryResponseSchema = z
  .object({
    cleanedCount: z.int().nonnegative().openapi({ example: 2 }),
    items: z.array(inventoryItemSchema),
  })
  .openapi("CompleteInventoryClothingLaundryResponse");

const inventoryRemedyProfileResponseSchema = z
  .object({
    remedyProfile: inventoryRemedyProfileSchema,
  })
  .openapi("InventoryRemedyProfileResponse");

const remedyIntakeSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "intake_123" }),
    note: z.string().nullable().openapi({ example: "Before bed." }),
    occurredAt: z
      .iso.datetime()
      .openapi({ example: "2026-08-03T22:15:00.000Z" }),
    potency: z.string().min(1).openapi({ example: "200C" }),
    itemArchivedAt: z
      .iso.datetime()
      .nullable()
      .openapi({ example: null }),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    itemTitle: z.string().min(1).openapi({ example: "Arsenicum album" }),
  })
  .openapi("RemedyIntake");

const remedyIntakeProjectionSchema = remedyIntakeSchema
  .extend({
    bucketDate: z.string().date().openapi({ example: "2026-08-03" }),
    colorKey: z.string().min(1).openapi({ example: "remedy-3" }),
  })
  .openapi("RemedyIntakeProjection");

const remedyIntakesResponseSchema = z
  .object({
    intakes: z.array(remedyIntakeProjectionSchema),
    pageInfo: z.object({
      nextCursor: z.string().min(1).nullable().openapi({ example: null }),
    }),
    range: z.enum(remedyIntakeRangeValues).openapi({ example: "30d" }),
  })
  .openapi("RemedyIntakesResponse");

const remedyIntakeSummarySchema = z
  .object({
    archivedAt: z.iso.datetime().nullable().openapi({ example: null }),
    colorKey: z.string().min(1).openapi({ example: "remedy-3" }),
    firstIntakeAt: z.iso.datetime(),
    lastIntakeAt: z.iso.datetime(),
    potencyTotals: z.array(
      z.object({
        potency: z.string().min(1),
        total: z.int().positive(),
      }),
    ),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    itemTitle: z.string().min(1).openapi({ example: "Arsenicum album" }),
    total: z.int().positive(),
  })
  .openapi("RemedyIntakeSummary");

const remedyIntakeSummaryResponseSchema = z
  .object({
    range: z.enum(remedyIntakeRangeValues).openapi({ example: "30d" }),
    remedies: z.array(remedyIntakeSummarySchema),
    totalIntakes: z.int().nonnegative(),
  })
  .openapi("RemedyIntakeSummaryResponse");

const createRemedyIntakeRequestSchema = z
  .object({
    note: z.string().min(1).nullable().optional().openapi({
      example: "Before bed.",
    }),
    occurredAt: z
      .iso.datetime()
      .nullable()
      .optional()
      .openapi({ example: "2026-08-03T22:15:00.000Z" }),
    potency: inventoryRemedyPotencySchema(
      "Potency taken; must match one owned potency on the Item's Remedy Profile.",
    ).openapi({ example: "200C" }),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
  })
  .openapi("CreateRemedyIntakeRequest", {
    description:
      "Logs one Remedy Intake. It records an owned potency and does not decrement Inventory quantity.",
  });

const createRemedyIntakeResponseSchema = z
  .object({
    intake: remedyIntakeSchema,
  })
  .openapi("CreateRemedyIntakeResponse");

const deleteRemedyIntakeResponseSchema = z
  .object({
    deletedIntakeId: z.string().min(1).openapi({ example: "intake_123" }),
  })
  .openapi("DeleteRemedyIntakeResponse");

const updateInventoryClothingProfileRequestSchema = z
  .object({
    isDirty: z.boolean().openapi({
      description: "Current Clothing wear state to persist with the complete Profile.",
      example: false,
    }),
    attributes: inventoryClothingProfileAttributesSchema,
  })
  .openapi("UpdateInventoryClothingProfileRequest", {
    description:
      "Complete replacement of Clothing wear state and attributes. GET, merge, then PUT to preserve known fields.",
  });

const updateInventoryClothingProfileResponseSchema = z
  .object({
    clothingProfile: inventoryClothingProfileSchema,
    item: inventoryItemSchema,
  })
  .openapi("UpdateInventoryClothingProfileResponse");

const updateInventoryRemedyProfileRequestSchema = z
  .object({
    externalReferences: z
      .array(inventoryRemedyExternalReferenceSchema)
      .optional(),
    potencies: z
      .array(
        inventoryRemedyPotencySchema(
          "One potency in the complete replacement owned set.",
        ),
      )
      .min(1)
      .optional()
      .openapi({
        description:
          "When present, replaces the complete owned set. GET the current Remedy Profile and union additions before PUT; values are trimmed, uppercased, deduplicated, and sorted.",
      }),
    selectionSummary: z.string().min(1).nullable().optional(),
  })
  .refine((request) => Object.keys(request).length > 0, {
    message: "Update at least one Inventory Remedy Profile field.",
  })
  .openapi("UpdateInventoryRemedyProfileRequest", {
    description:
      "Updates specialist Remedy facts. Potencies are a complete replacement, not an incremental addition.",
  });

const updateInventoryRemedyProfileResponseSchema = z
  .object({
    remedyProfile: inventoryRemedyProfileSchema,
    item: inventoryItemSchema,
  })
  .openapi("UpdateInventoryRemedyProfileResponse");

const registerInventoryRemedyRequestSchema = z
  .object({
    aliases: z.array(z.string().min(1)).optional(),
    containerId: z.string().min(1).nullable().optional(),
    externalReferences: z
      .array(inventoryRemedyExternalReferenceSchema)
      .optional(),
    locationId: z.string().min(1).nullable().optional(),
    note: z.string().min(1).nullable().optional(),
    placementNote: z.string().min(1).nullable().optional(),
    potencies: z
      .array(
        inventoryRemedyPotencySchema(
          "One potency owned for this remedy Item.",
        ),
      )
      .min(1)
      .openapi({
        description:
          "All owned potencies for the single remedy Item. Values are trimmed, uppercased, deduplicated, and sorted.",
      }),
    quantity: z.int().positive().optional().openapi({
      description:
        "Aggregate physical stock across the remedy Item; not per potency. Defaults to 1.",
      example: 1,
    }),
    selectionSummary: z.string().min(1).nullable().optional(),
    title: z.string().min(1),
  })
  .refine(hasAtMostOnePlacementTarget, {
    message: "Choose exactly one Placement target.",
    path: ["containerId"],
  })
  .openapi("RegisterInventoryRemedyRequest", {
    description:
      "Registers one new remedy Item and its specialist Profile. Search first; add a potency to an existing remedy through Remedy Profile GET/merge/PUT instead of registering a duplicate Item.",
  });

const registerInventoryRemedyResponseSchema = z
  .object({
    item: inventoryItemSchema,
    remedyProfile: inventoryRemedyProfileSchema,
  })
  .openapi("RegisterInventoryRemedyResponse");

const idempotencyKeyHeadersSchema = z.object({
  "Idempotency-Key": z
    .string()
    .trim()
    .min(1)
    .max(255)
    .openapi({
      example: "update-item-018f5f86",
      param: {
        in: "header",
        name: "Idempotency-Key",
      },
    }),
});

const updateInventoryItemRequestSchema = z
  .object({
    acquisitionSource: z
      .enum(inventoryAcquisitionSourceValues)
      .nullable()
      .optional(),
    aliases: z.array(z.string()).optional(),
    captureText: z.string().min(1).nullable().optional(),
    category: z.enum(inventoryCategoryValues).nullable().optional().openapi({
      description:
        "Shared Item category. Setting clothing creates a default Clothing Profile when absent. Never set homeopathy to create a remedy; use POST /api/v1/inventory-remedies.",
    }),
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
    note: z.string().min(1).nullable().optional(),
    status: z.enum(inventoryItemStatuses).nullable().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().min(1).nullable().optional(),
  })
  .refine((request) => Object.keys(request).length > 0, {
    message: "Update at least one Inventory Item field.",
  })
  .openapi("UpdateInventoryItemRequest", {
    description:
      "Updates shared Item facts only. Quantity and Placement use unit operations; specialist facts use Clothing or Remedy Profile operations.",
  });

const addInventoryUnitsRequestSchema = z
  .object({
    containerId: z.string().min(1).nullable().optional(),
    locationId: z.string().min(1).nullable().optional(),
    note: z.string().min(1).nullable().optional(),
    quantity: z.int().positive().optional(),
  })
  .refine(hasAtMostOnePlacementTarget, {
    message: "Choose exactly one Placement target.",
    path: ["containerId"],
  })
  .openapi("AddInventoryItemUnitsRequest");

const moveInventoryUnitsRequestSchema = z
  .object({
    destinationContainerId: z.string().min(1).nullable().optional(),
    destinationLocationId: z.string().min(1).nullable().optional(),
    quantity: z.int().positive().optional(),
    sourceContainerId: z.string().min(1).nullable().optional(),
    sourceLocationId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (request) =>
      hasAtMostOnePlacementTarget({
        containerId: request.sourceContainerId,
        locationId: request.sourceLocationId,
      }),
    {
      message: "Choose exactly one source Placement target.",
      path: ["sourceContainerId"],
    },
  )
  .refine(
    (request) =>
      hasAtMostOnePlacementTarget({
        containerId: request.destinationContainerId,
        locationId: request.destinationLocationId,
      }),
    {
      message: "Choose exactly one destination Placement target.",
      path: ["destinationContainerId"],
    },
  )
  .openapi("MoveInventoryItemUnitsRequest");

const removeInventoryUnitsRequestSchema = z
  .object({
    containerId: z.string().min(1).nullable().optional(),
    locationId: z.string().min(1).nullable().optional(),
    quantity: z.int().positive().optional(),
  })
  .refine(hasAtMostOnePlacementTarget, {
    message: "Choose exactly one Placement target.",
    path: ["containerId"],
  })
  .openapi("RemoveInventoryItemUnitsRequest");


const inventoryItemCollectionQuerySchema = z.object({
  archived: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "Set to true to view Archived Inventory Items instead of active Inventory Items.",
      example: "true",
      param: {
        in: "query",
        name: "archived",
      },
    }),
  q: z
    .string()
    .optional()
    .openapi({
      description:
        "Nonblank search query. Blank or omitted values keep ordinary listing behavior.",
      example: "projector",
      param: {
        in: "query",
        name: "q",
      },
    }),
  category: z
    .enum(inventoryCategoryValues)
    .optional()
    .openapi({
      description:
        "Controlled Inventory Category filter composed with archived and q.",
      example: "food",
      param: {
        in: "query",
        name: "category",
      },
    }),
  clothingState: z
    .enum(inventoryClothingStateValues)
    .optional()
    .openapi({
      description:
        "Optional Clothing Wear State filter. Valid only when category=clothing.",
      example: "dirty",
      param: {
        in: "query",
        name: "clothingState",
      },
    }),
  containerId: z.string().trim().min(1).optional().openapi({
    description: "Restrict results to Items in one Container.",
    example: "container_123",
    param: { in: "query", name: "containerId" },
  }),
  cursor: z.string().trim().min(1).optional().openapi({
    description: "Opaque cursor returned by the preceding matching page.",
    example: "eyJmaWx0ZXJLZXkiOiJ...",
    param: { in: "query", name: "cursor" },
  }),
  evidence: z.enum(["photo", "voice", "text"]).optional().openapi({
    description: "Restrict results to Items with the selected evidence kind.",
    param: { in: "query", name: "evidence" },
  }),
  importance: z.enum(inventoryImportanceValues).optional().openapi({
    description: "Restrict results to one importance value.",
    param: { in: "query", name: "importance" },
  }),
  includeUnready: z.enum(["true", "false"]).optional().openapi({
    description: "Set false to return only workflow-complete Items.",
    param: { in: "query", name: "includeUnready" },
  }),
  kind: z.enum(inventoryItemKinds).optional().openapi({
    description: "Restrict results to individual Items or Item Groups.",
    param: { in: "query", name: "kind" },
  }),
  limit: z
    .union([
      z.literal("all"),
      z.coerce.number().int().min(1).max(inventoryItemPageSize),
    ])
    .optional()
    .openapi({
      description:
        "Page size up to 24, or all for an explicit unpaginated bulk read.",
      param: { in: "query", name: "limit" },
    }),
  status: z.enum(inventoryItemStatuses).optional().openapi({
    description: "Restrict results to one Inventory Item Status.",
    param: { in: "query", name: "status" },
  }),
  workflow: z
    .enum([
      "CAPTURED",
      "PREPROCESSING",
      "ENRICHING",
      "NEEDS_REVIEW",
      "COMPLETE",
    ])
    .optional()
    .openapi({
      description: "Restrict results to one Inventory Workflow Status.",
      param: { in: "query", name: "workflow" },
    }),
});

const inventoryItemPathParamsSchema = z.object({
  itemId: z.string().trim().min(1).openapi({ example: "item_123" }),
});

const remedyIntakeRangeQuerySchema = z.object({
  itemId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .openapi({
      description: "Optional owned remedy Item filter.",
      example: "item_123",
      param: {
        in: "query",
        name: "itemId",
      },
    }),
  range: z.enum(remedyIntakeRangeValues).openapi({
    description: "Owner-local time range.",
    example: "30d",
    param: { in: "query", name: "range" },
  }),
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(isValidIanaTimeZone, {
      message: "Expected an IANA time zone.",
    })
    .openapi({
      description: "IANA time zone used for local day boundaries.",
      example: "America/Toronto",
      param: { in: "query", name: "timeZone" },
    }),
});

const remedyIntakesQuerySchema = remedyIntakeRangeQuerySchema
  .extend({
    cursor: z.string().trim().min(1).optional().openapi({
      description: "Opaque cursor for the next all-time page.",
      example: "intake_123",
      param: { in: "query", name: "cursor" },
    }),
  })
  .refine((input) => !input.cursor || input.range === "all", {
    message: "Cursor is supported only for the all-time range.",
    path: ["cursor"],
  });

const remedyIntakePathParamsSchema = z.object({
  intakeId: z.string().trim().min(1).openapi({ example: "intake_123" }),
});

const inventoryClothingWearConfirmationPathParamsSchema = z.object({
  confirmationId: z.string().trim().min(1).openapi({ example: "wear_123" }),
});

const inventoryItemLifecycleSchema = z
  .object({
    archivedAt: z
      .iso.datetime()
      .nullable()
      .openapi({ example: "2026-07-28T12:00:00.000Z" }),
    id: z.string().min(1).openapi({ example: "item_123" }),
  })
  .openapi("InventoryItemLifecycle");

const inventoryItemLifecycleResponseSchema = z
  .object({
    item: inventoryItemLifecycleSchema,
  })
  .openapi("InventoryItemLifecycleResponse");

const inventoryItemDeleteResponseSchema = z
  .object({
    deletedItemId: z.string().min(1).openapi({ example: "item_123" }),
  })
  .openapi("InventoryItemDeleteResponse");

const inventoryItemNotFoundErrorSchema = z
  .object({
    code: z.literal("NOT_FOUND").openapi({ example: "NOT_FOUND" }),
    message: z
      .string()
      .min(1)
      .openapi({ example: "Inventory Item not found." }),
  })
  .openapi("InventoryItemNotFoundError");

const inventoryProposalDetailDiffSchema = z
  .object({
    current: z.string().min(1).openapi({ example: "Black pouch" }),
    field: z.string().min(1).openapi({ example: "title" }),
    label: z.string().min(1).openapi({ example: "Title" }),
    proposed: z.string().min(1).openapi({ example: "Passport and charger pouch" }),
  })
  .openapi("InventoryProposalDetailDiff");

const inventoryProposalEvidenceSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "image_123" }),
    preview: z.string().min(1).openapi({ example: "PASSPORT USB-C CHARGER" }),
    secondary: z.string().nullable().openapi({ example: "2 OCR lines" }),
  })
  .openapi("InventoryProposalEvidence");

const inventoryProposalSchema = z
  .object({
    captureText: z
      .string()
      .nullable()
      .openapi({ example: "Passport, charger, and travel adapters in black pouch." }),
    capturedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-13T11:00:00.000Z" }),
    confidence: z.number().nullable().openapi({ example: 0.94 }),
    diff: z.array(inventoryProposalDetailDiffSchema),
    failedSteps: z.array(z.string()).openapi({ example: [] }),
    id: z.string().min(1).openapi({ example: "job_123" }),
    ocrEvidence: z.array(inventoryProposalEvidenceSchema),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    itemTitle: z.string().min(1).openapi({ example: "Black pouch" }),
    rationale: z
      .string()
      .nullable()
      .openapi({ example: "OCR and transcript mention passport and charger." }),
    sourceRefsSummary: z
      .string()
      .min(1)
      .openapi({ example: "1 item, 1 image, 1 audio, 0 file" }),
    transcriptEvidence: z.array(inventoryProposalEvidenceSchema),
    updatedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-13T12:00:30.000Z" }),
  })
  .openapi("InventoryProposal");

const inventoryProposalsResponseSchema = z
  .object({
    proposals: z.array(inventoryProposalSchema),
  })
  .openapi("InventoryProposalsResponse");

const inventoryProposalQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      example: 20,
      param: { in: "query", name: "limit" },
    }),
  itemId: z.string().trim().min(1).optional().openapi({
    example: "item_123",
    param: { in: "query", name: "itemId" },
  }),
});

const inventoryProposalPathParamsSchema = z.object({
  proposalId: z.string().min(1).openapi({ example: "job_123" }),
});

const inventoryProposalDecisionSchema = z
  .object({
    decidedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:05:00.000Z" }),
    id: z.string().min(1).openapi({ example: "job_123" }),
    itemId: z.string().min(1).openapi({ example: "item_123" }),
    status: z
      .enum(["APPLIED", "REJECTED"])
      .openapi({ example: "APPLIED" }),
  })
  .openapi("InventoryProposalDecision");

const inventoryProposalDecisionResponseSchema = z
  .object({
    proposal: inventoryProposalDecisionSchema,
  })
  .openapi("InventoryProposalDecisionResponse");

const inventoryEnrichmentSettingsSchema = z
  .object({
    approvalsRequired: z.boolean().openapi({ example: true }),
    updatedAt: z
      .iso.datetime()
      .openapi({ example: "2026-07-28T12:05:00.000Z" }),
  })
  .openapi("InventoryEnrichmentSettings");

const inventoryEnrichmentSettingsResponseSchema = z
  .object({
    settings: inventoryEnrichmentSettingsSchema,
  })
  .openapi("InventoryEnrichmentSettingsResponse");

const updateInventoryEnrichmentSettingsRequestSchema = z
  .object({
    approvalsRequired: z.boolean().openapi({ example: true }),
  })
  .openapi("UpdateInventoryEnrichmentSettingsRequest");

type InventoryItem = z.infer<typeof inventoryItemSchema>;
type InventoryClothingProfile = z.infer<typeof inventoryClothingProfileSchema>;
type InventoryRemedyProfile = z.infer<typeof inventoryRemedyProfileSchema>;
type RemedyIntake = z.infer<typeof remedyIntakeSchema>;
type RemedyIntakeProjection = z.infer<typeof remedyIntakeProjectionSchema>;
type RemedyIntakeRange = (typeof remedyIntakeRangeValues)[number];
type RemedyIntakeSummary = z.infer<typeof remedyIntakeSummarySchema>;
type InventoryItemProcessingHistoryEntry = z.infer<
  typeof inventoryItemProcessingHistoryEntrySchema
>;
type InventoryItemDeleteResponse = z.infer<
  typeof inventoryItemDeleteResponseSchema
>;
type InventoryItemLifecycle = z.infer<
  typeof inventoryItemLifecycleSchema
>;
type InventoryProposal = z.infer<typeof inventoryProposalSchema>;
type InventoryProposalDecision = z.infer<typeof inventoryProposalDecisionSchema>;
type InventoryEnrichmentSettings = z.infer<
  typeof inventoryEnrichmentSettingsSchema
>;
type UpdateInventoryItemRequest = z.infer<
  typeof updateInventoryItemRequestSchema
>;
type UpdateInventoryClothingProfileRequest = z.infer<
  typeof updateInventoryClothingProfileRequestSchema
>;
type InventoryClothingWearConfirmation = z.infer<
  typeof inventoryClothingWearConfirmationSchema
>;
type CompleteInventoryClothingLaundryRequest = z.infer<
  typeof completeInventoryClothingLaundryRequestSchema
>;
type UpdateInventoryRemedyProfileRequest = z.infer<
  typeof updateInventoryRemedyProfileRequestSchema
>;
type RegisterInventoryRemedyRequest = z.infer<
  typeof registerInventoryRemedyRequestSchema
>;
type CreateRemedyIntakeRequest = z.infer<typeof createRemedyIntakeRequestSchema>;
type AddInventoryUnitsRequest = z.infer<typeof addInventoryUnitsRequestSchema>;
type MoveInventoryUnitsRequest = z.infer<typeof moveInventoryUnitsRequestSchema>;
type RemoveInventoryUnitsRequest = z.infer<
  typeof removeInventoryUnitsRequestSchema
>;
type UpdateInventoryEnrichmentSettingsRequest = z.infer<
  typeof updateInventoryEnrichmentSettingsRequestSchema
>;

type InventoryItemRow = {
  category?: (typeof inventoryCategoryValues)[number] | null;
  archivedAt: Date | null;
  captureText: string | null;
  clothingProfile?: {
    attributes: unknown;
    createdAt: Date;
    dirtyQuantity?: number;
    isDirty: boolean;
    updatedAt: Date;
  } | null;
  remedyProfile?: {
    createdAt: Date;
    externalReferences: unknown;
    potencies: string[];
    registeredByClientId: string | null;
    selectionSummary: string | null;
    substance: {
      id: string;
    };
    updatedAt: Date;
  } | null;
  containerId?: string | null;
  containerLabel?: string | null;
  id: string;
  importance?: (typeof inventoryImportanceValues)[number];
  images: Array<{ id: string }>;
  kind?: (typeof inventoryItemKinds)[number];
  locationId?: string | null;
  locationName?: string | null;
  note?: string | null;
  placements: Array<{
    id: string;
    containerId?: string | null;
    container: {
      location?: {
        id: string;
        name: string;
      } | null;
      name: string;
      referenceId: string;
    } | null;
    location?: {
      id: string;
      name: string;
    } | null;
    locationId?: string | null;
    note: string | null;
    quantity: number;
  }>;
  searchText: string;
  status?: (typeof inventoryItemStatuses)[number];
  tags?: string[];
  title: string | null;
  totalQuantity?: number;
};

type InventoryItemLifecycleRow = {
  archivedAt: Date | null;
  id: string;
};

type InventoryItemDeletionRow = InventoryItemLifecycleRow & {
  assets: Array<{ filePath: string }>;
  audioNotes: Array<{ filePath: string }>;
  images: Array<{ filePath: string }>;
};

type ListInventoryItemsInput = {
  archived: boolean;
  category: (typeof inventoryCategoryValues)[number] | null;
  clothingState: (typeof inventoryClothingStateValues)[number] | null;
  containerId?: string | null;
  cursor?: string | null;
  evidence?: "photo" | "voice" | "text" | null;
  importance?: (typeof inventoryImportanceValues)[number] | null;
  includeUnready?: boolean;
  kind?: (typeof inventoryItemKinds)[number] | null;
  limit?: number | "all";
  query: string | null;
  status?: (typeof inventoryItemStatuses)[number] | null;
  workflow?: "CAPTURED" | "PREPROCESSING" | "ENRICHING" | "NEEDS_REVIEW" | "COMPLETE" | null;
};

type InventoryExportInput = Omit<ListInventoryItemsInput, "cursor" | "limit">;
type InventoryExportRow = { id: string; title: string };

type InventoryItemsPage = {
  items: InventoryItem[];
  pageInfo: { nextCursor: string | null };
  total: number;
};

type InventoryItemsRouteHandlers = {
  addUnits: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "addInventoryItemUnits";
    itemId: string;
    request: AddInventoryUnitsRequest;
  }) => Promise<{ item: InventoryItem }>;
  archiveItem: (id: string) => Promise<InventoryItemLifecycle>;
  approveProposal: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "approveInventoryProposal";
    proposalId: string;
  }) => Promise<{ proposal: InventoryProposalDecision }>;
  createRemedyIntake: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "createRemedyIntake";
    request: CreateRemedyIntakeRequest;
  }) => Promise<{ intake: RemedyIntake }>;
  deleteItem: (id: string) => Promise<InventoryItemDeleteResponse>;
  deleteRemedyIntake: (input: {
    clientId: string;
    idempotencyKey: string;
    intakeId: string;
    operation: "deleteRemedyIntake";
  }) => Promise<{ deletedIntakeId: string }>;
  getEnrichmentSettings: () => Promise<InventoryEnrichmentSettings>;
  getClothingProfile: (itemId: string) => Promise<InventoryClothingProfile | null>;
  getRemedyProfile: (itemId: string) => Promise<InventoryRemedyProfile | null>;
  getItem: (id: string) => Promise<InventoryItem | null>;
  listProposals: (input: {
    limit: number;
    itemId: string | null;
  }) => Promise<InventoryProposal[]>;
  exportItems: (input: InventoryExportInput) => Promise<InventoryExportRow[]>;
  listItems: (input: ListInventoryItemsInput) => Promise<InventoryItemsPage>;
  listRemedyIntakes: (input: {
    cursor: string | null;
    itemId: string | null;
    range: RemedyIntakeRange;
    timeZone: string;
  }) => Promise<{
    intakes: RemedyIntakeProjection[];
    pageInfo: { nextCursor: string | null };
    range: RemedyIntakeRange;
  }>;
  summarizeRemedyIntakes: (input: {
    itemId: string | null;
    range: RemedyIntakeRange;
    timeZone: string;
  }) => Promise<{
    range: RemedyIntakeRange;
    remedies: RemedyIntakeSummary[];
    totalIntakes: number;
  }>;
  moveUnits: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "moveInventoryItemUnits";
    itemId: string;
    request: MoveInventoryUnitsRequest;
  }) => Promise<{ item: InventoryItem }>;
  markClothingItemWorn: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "markInventoryClothingItemWorn";
    itemId: string;
  }) => Promise<{
    item: InventoryItem;
    wearConfirmation: InventoryClothingWearConfirmation;
  }>;
  removeUnits: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "removeInventoryItemUnits";
    itemId: string;
    request: RemoveInventoryUnitsRequest;
  }) => Promise<{ item: InventoryItem }>;
  completeClothingLaundry: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "completeInventoryClothingLaundry";
    request: CompleteInventoryClothingLaundryRequest;
  }) => Promise<{
    cleanedCount: number;
    items: InventoryItem[];
  }>;
  rejectProposal: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "rejectInventoryProposal";
    proposalId: string;
  }) => Promise<{ proposal: InventoryProposalDecision }>;
  registerRemedy: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "registerInventoryRemedy";
    request: RegisterInventoryRemedyRequest;
  }) => Promise<{
    item: InventoryItem;
    remedyProfile: InventoryRemedyProfile;
  }>;
  retryEnrichment: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "retryInventoryEnrichment";
    itemId: string;
  }) => Promise<{ item: InventoryItem }>;
  retryPreprocessing: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "retryInventoryPreprocessing";
    itemId: string;
  }) => Promise<{ item: InventoryItem }>;
  restoreItem: (id: string) => Promise<InventoryItemLifecycle>;
  undoClothingWearConfirmation: (input: {
    clientId: string;
    confirmationId: string;
    idempotencyKey: string;
    operation: "undoInventoryClothingWearConfirmation";
  }) => Promise<{
    items: InventoryItem[];
    wearConfirmation: InventoryClothingWearConfirmation;
  }>;
  updateEnrichmentSettings: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "updateInventoryEnrichmentSettings";
    request: UpdateInventoryEnrichmentSettingsRequest;
  }) => Promise<{ settings: InventoryEnrichmentSettings }>;
  updateClothingProfile: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "updateInventoryClothingProfile";
    itemId: string;
    request: UpdateInventoryClothingProfileRequest;
  }) => Promise<{
    clothingProfile: InventoryClothingProfile;
    item: InventoryItem;
  }>;
  updateRemedyProfile: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "updateInventoryRemedyProfile";
    itemId: string;
    request: UpdateInventoryRemedyProfileRequest;
  }) => Promise<{
    remedyProfile: InventoryRemedyProfile;
    item: InventoryItem;
  }>;
  updateItem: (input: {
    clientId: string;
    idempotencyKey: string;
    operation: "updateInventoryItem";
    itemId: string;
    request: UpdateInventoryItemRequest;
  }) => Promise<{ item: InventoryItem }>;
};

type InventoryItemsRepository = {
  deleteItem: (id: string) => Promise<InventoryItemDeletionRow | null>;
  findItemLifecycle: (
    id: string,
  ) => Promise<InventoryItemLifecycleRow | null>;
  transitionItemLifecycle: (
    id: string,
    input: {
      archivedAt: Date | null;
      expectedState: "active" | "archived";
    },
  ) => Promise<InventoryItemLifecycleRow | null>;
};

class InventoryItemNotFoundError extends Error {
  constructor() {
    super("Inventory Item not found.");
    this.name = "InventoryItemNotFoundError";
  }
}

class InventoryItemCursorError extends Error {
  constructor() {
    super("Inventory Item cursor is invalid or expired.");
    this.name = "InventoryItemCursorError";
  }
}

class InventoryProposalNotFoundError extends Error {
  constructor() {
    super("Inventory Proposal not found.");
    this.name = "InventoryProposalNotFoundError";
  }
}

class InventoryProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryProposalConflictError";
  }
}

class InventoryClothingProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryClothingProfileConflictError";
  }
}

class InventoryClothingCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryClothingCommandConflictError";
  }
}

class InventoryRemedyProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryRemedyProfileConflictError";
  }
}

class RemedyIntakeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemedyIntakeConflictError";
  }
}

const inventoryItemInclude = {
  clothingProfile: true,
  remedyProfile: {
    include: {
      substance: {
        select: {
          id: true,
        },
      },
    },
  },
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
} satisfies Prisma.InventoryItemInclude;

const inventoryItemsRepository = {
  async deleteItem(id) {
    return prisma.$transaction(async (transaction) => {
      const item = await transaction.inventoryItem.findUnique({
        select: {
          archivedAt: true,
          assets: {
            select: {
              filePath: true,
            },
          },
          audioNotes: {
            select: {
              filePath: true,
            },
          },
          id: true,
          images: {
            select: {
              filePath: true,
            },
          },
          remedyProfile: {
            select: {
              substance: {
                select: {
                  id: true,
                  intakes: {
                    select: {
                      id: true,
                    },
                    take: 1,
                  },
                },
              },
              substanceId: true,
            },
          },
        },
        where: { id },
      });

      if (!item) {
        return null;
      }

      if ((item.remedyProfile?.substance.intakes.length ?? 0) > 0) {
        throw new RemedyIntakeConflictError(
          "Remedy Intake history blocks permanent deletion.",
        );
      }

      assertOriginalWritesEnabled();
      await queueOriginalDeletions([...item.images, ...item.audioNotes, ...item.assets].map(media => media.filePath), transaction);
      const deletion = await transaction.inventoryItem.deleteMany({
        where: { id },
      });

      if (deletion.count === 1 && item.remedyProfile?.substanceId) {
        await transaction.substance.delete({
          where: {
            id: item.remedyProfile.substanceId,
          },
        });
      }

      return deletion.count === 1 ? item : null;
    });
  },

  findItemLifecycle(id) {
    return prisma.inventoryItem.findUnique({
      select: {
        archivedAt: true,
        id: true,
      },
      where: { id },
    });
  },

  async transitionItemLifecycle(id, input) {
    return prisma.$transaction(async (transaction) => {
      const transition = await transaction.inventoryItem.updateMany({
        data: {
          archivedAt: input.archivedAt,
        },
        where: {
          archivedAt: input.expectedState === "archived" ? { not: null } : null,
          id,
        },
      });

      if (transition.count === 1) {
        await transaction.substance.updateMany({
          data: {
            isActive: input.archivedAt === null,
          },
          where: {
            remedyProfile: {
              is: {
                itemId: id,
              },
            },
          },
        });

        return {
          archivedAt: input.archivedAt,
          id,
        };
      }

      return transaction.inventoryItem.findUnique({
        select: {
          archivedAt: true,
          id: true,
        },
        where: { id },
      });
    });
  },
} satisfies InventoryItemsRepository;

const inventoryContainerInclude = {
  location: true,
} satisfies Prisma.InventoryContainerInclude;

const inventoryCaptureSessionItemInclude = {
  defaultDestinationLocation: true,
  defaultOriginLocation: true,
} satisfies Prisma.InventoryCaptureSessionInclude;

const inventoryItemMutationInclude = {
  assets: {
    orderBy: { createdAt: "asc" },
  },
  audioNotes: {
    orderBy: { createdAt: "asc" },
  },
  captureSession: {
    include: inventoryCaptureSessionItemInclude,
  },
  clothingProfile: true,
  remedyProfile: {
    include: {
      substance: {
        select: {
          id: true,
        },
      },
    },
  },
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
  placements: {
    include: {
      container: {
        include: inventoryContainerInclude,
      },
      location: true,
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.InventoryItemInclude;

type InventoryContainerWithRelations = Prisma.InventoryContainerGetPayload<{
  include: typeof inventoryContainerInclude;
}>;

type InventoryItemWithRelations = Prisma.InventoryItemGetPayload<{
  include: typeof inventoryItemMutationInclude;
}>;

type InventoryItemMutationRepository =
  InventoryServiceItemMutationRepository &
  InventoryPlacementMutationRepository & {
    setItemArchivedAt: (
      id: string,
      value: Date | null,
    ) => Promise<InventoryItemRecord>;
  };

function createInventoryItemMutationRepository(
  transaction: Prisma.TransactionClient,
) {
  return {
    async addInventoryUnits(input: {
      containerId: string | null;
      locationId: string | null;
      itemId: string;
      note: string | null;
      quantity: number;
    }) {
      await requireActiveItemRecord(transaction, input.itemId);
      await requirePlacementContainerRecord(transaction, input.containerId);
      await requirePlacementLocationRecord(transaction, input.locationId);

      const existing = await transaction.inventoryItemPlacement.findFirst({
        where: placementLookupWhere(input),
      });

      if (existing) {
        await transaction.inventoryItemPlacement.update({
          data: {
            note: input.note ?? existing.note,
            quantity: { increment: input.quantity },
          },
          where: { id: existing.id },
        });
      } else {
        await transaction.inventoryItemPlacement.create({
          data: {
            containerId: input.containerId,
            itemId: input.itemId,
            locationId: input.locationId,
            note: input.note,
            quantity: input.quantity,
          },
        });
      }

      return refreshInventoryItemRecord(transaction, input.itemId);
    },
    async enqueueInventoryPreprocessingJobs(
      jobs: InventoryPreprocessingNewJobRecord[],
    ): Promise<InventoryPreprocessingJobRecord[]> {
      return Promise.all(
        jobs.map(async (job) => {
          const created = await transaction.inventoryPreprocessingJob.create({
            data: {
              claimedAt: job.claimedAt,
              claimedBy: job.claimedBy,
              completedAt: null,
              leaseExpiresAt: job.leaseExpiresAt,
              maxAttempts: job.maxAttempts,
              sourceRefs: job.sourceRefs as unknown as Prisma.InputJsonValue,
              targetItemId: job.targetItemId,
            },
          });

          return mapInventoryPreprocessingJob(created, job.sourceRefs);
        }),
      );
    },
    async findInventoryItems() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async getInventoryItem(id: string) {
      const item = await transaction.inventoryItem.findFirst({
        include: inventoryItemMutationInclude,
        where: {
          archivedAt: null,
          id,
        },
      });

      return item ? mapInventoryItemRecord(item as InventoryItemWithRelations) : null;
    },
    async getActiveCaptureSession() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async getCaptureSession() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async listClaimableInventoryPreprocessingJobs() {
      return [];
    },
    async listInventoryPreprocessingJobs(input?: {
      limit?: number;
      targetItemId?: string;
    }) {
      const jobs = await transaction.inventoryPreprocessingJob.findMany({
        orderBy: { updatedAt: "desc" },
        take: input?.limit ?? 50,
        where: input?.targetItemId
          ? { targetItemId: input.targetItemId }
          : undefined,
      });

      return jobs.map((job) => mapInventoryPreprocessingJob(job));
    },
    async listRecentItems() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async moveInventoryUnits(input: {
      destinationContainerId: string | null;
      destinationLocationId: string | null;
      itemId: string;
      quantity: number;
      sourceContainerId: string | null;
      sourceLocationId: string | null;
    }) {
      await requireActiveItemRecord(transaction, input.itemId);
      await requirePlacementContainerRecord(
        transaction,
        input.sourceContainerId,
      );
      await requirePlacementLocationRecord(
        transaction,
        input.sourceLocationId,
      );
      await requirePlacementContainerRecord(
        transaction,
        input.destinationContainerId,
      );
      await requirePlacementLocationRecord(
        transaction,
        input.destinationLocationId,
      );

      const source = await transaction.inventoryItemPlacement.findFirst({
        where: placementLookupWhere({
          containerId: input.sourceContainerId,
          itemId: input.itemId,
          locationId: input.sourceLocationId,
        }),
      });

      if (!source || source.quantity < input.quantity) {
        throw new Error("Move quantity exceeds available units.");
      }

      const destination = await transaction.inventoryItemPlacement.findFirst({
        where: placementLookupWhere({
          containerId: input.destinationContainerId,
          itemId: input.itemId,
          locationId: input.destinationLocationId,
        }),
      });

      if (source.quantity === input.quantity) {
        await transaction.inventoryItemPlacement.delete({
          where: { id: source.id },
        });
      } else {
        await transaction.inventoryItemPlacement.update({
          data: { quantity: { decrement: input.quantity } },
          where: { id: source.id },
        });
      }

      if (destination) {
        await transaction.inventoryItemPlacement.update({
          data: { quantity: { increment: input.quantity } },
          where: { id: destination.id },
        });
      } else {
        await transaction.inventoryItemPlacement.create({
          data: {
            containerId: input.destinationContainerId,
            itemId: input.itemId,
            locationId: input.destinationLocationId,
            quantity: input.quantity,
          },
        });
      }

      return refreshInventoryItemRecord(transaction, input.itemId);
    },
    async removeInventoryUnits(input: {
      containerId: string | null;
      itemId: string;
      locationId: string | null;
      quantity: number;
    }) {
      await requireActiveItemRecord(transaction, input.itemId);
      await requirePlacementContainerRecord(transaction, input.containerId);
      await requirePlacementLocationRecord(transaction, input.locationId);
      const placement = await transaction.inventoryItemPlacement.findFirst({
        where: placementLookupWhere(input),
      });

      if (!placement || placement.quantity < input.quantity) {
        throw new Error("Remove quantity exceeds available units.");
      }

      if (placement.quantity === input.quantity) {
        await transaction.inventoryItemPlacement.delete({
          where: { id: placement.id },
        });
      } else {
        await transaction.inventoryItemPlacement.update({
          data: { quantity: { decrement: input.quantity } },
          where: { id: placement.id },
        });
      }

      const clothingProfile = await transaction.inventoryClothingProfile.findUnique({
        where: { itemId: input.itemId },
      });
      if (clothingProfile) {
        const remaining = await transaction.inventoryItemPlacement.aggregate({
          _sum: { quantity: true },
          where: { itemId: input.itemId },
        });
        const remainingQuantity = remaining._sum.quantity ?? 0;

        if (clothingProfile.dirtyQuantity > remainingQuantity) {
          await transaction.inventoryClothingProfile.update({
            data: {
              dirtyQuantity: remainingQuantity,
              isDirty: remainingQuantity > 0,
              wearStateVersion: { increment: 1 },
            },
            where: { itemId: input.itemId },
          });
        }
      }

      return refreshInventoryItemRecord(transaction, input.itemId);
    },
    async reorderInventoryItemImages() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async setItemArchivedAt(id: string, value: Date | null) {
      await transaction.substance.updateMany({
        data: {
          isActive: value === null,
        },
        where: {
          remedyProfile: {
            is: {
              itemId: id,
            },
          },
        },
      });

      const item = await transaction.inventoryItem.update({
        data: { archivedAt: value },
        include: inventoryItemMutationInclude,
        where: { id },
      });

      return mapInventoryItemRecord(item as InventoryItemWithRelations);
    },
    async createItem() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async deleteItem() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async upsertCaptureSession() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async upsertLocation() {
      throw new Error("Inventory repository operation is not supported here.");
    },
    async updateInventoryPreprocessingJob(job: InventoryPreprocessingJobRecord) {
      return job;
    },
    async updateItem(input: InventoryItemUpdateRecordInput) {
      const item = await transaction.inventoryItem.update({
        data: {
          acquisitionSource:
            input.acquisitionSource as Prisma.InventoryItemUpdateInput["acquisitionSource"],
          aliases: input.aliases,
          assets: updateAssetsInput(input),
          audioNotes: updateAudioNotesInput(input),
          captureText: input.captureText,
          category:
            input.category as Prisma.InventoryItemUpdateInput["category"],
          clothingProfile: input.category === "clothing"
            ? {
                upsert: {
                  create: {
                    attributes:
                      defaultInventoryClothingProfileAttributes() as unknown as Prisma.InputJsonValue,
                    isDirty: false,
                  },
                  update: {},
                },
              }
            : undefined,
          costCents: input.costCents,
          costCurrency: input.costCurrency,
          images: updateImagesInput(input),
          importance: input.importance,
          kind: input.kind,
          metadata: input.metadata as Prisma.InputJsonValue,
          note: input.note,
          searchText: input.searchText,
          status: input.status,
          tags: input.tags,
          title: input.title,
        },
        include: inventoryItemMutationInclude,
        where: { id: input.id },
      });

      return mapInventoryItemRecord(item as InventoryItemWithRelations);
    },
  } satisfies InventoryItemMutationRepository &
    InventoryPlacementMutationRepository & {
      enqueueInventoryPreprocessingJobs: (
        jobs: InventoryPreprocessingNewJobRecord[],
      ) => Promise<InventoryPreprocessingJobRecord[]>;
      listClaimableInventoryPreprocessingJobs: () => Promise<
        InventoryPreprocessingJobRecord[]
      >;
      listInventoryPreprocessingJobs: (input?: {
        limit?: number;
        targetItemId?: string;
      }) => Promise<InventoryPreprocessingJobRecord[]>;
      setItemArchivedAt: (
        id: string,
        value: Date | null,
      ) => Promise<InventoryItemRecord>;
      updateInventoryPreprocessingJob: (
        job: InventoryPreprocessingJobRecord,
      ) => Promise<InventoryPreprocessingJobRecord>;
    };
}

function mapInventoryPreprocessingJob(
  job: InventoryPreprocessingJob,
  sourceRefs?: InventoryPreprocessingNewJobRecord["sourceRefs"],
): InventoryPreprocessingJobRecord {
  return {
    attempts: job.attempts,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    failureDetail:
      job.failureDetail as InventoryPreprocessingJobRecord["failureDetail"],
    id: job.id,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    sourceRefs:
      sourceRefs ??
      (job.sourceRefs as unknown as InventoryPreprocessingJobRecord["sourceRefs"]),
    status: job.status,
    targetItemId: job.targetItemId,
    textBundle:
      job.textBundle as unknown as InventoryPreprocessingJobRecord["textBundle"],
    updatedAt: job.updatedAt,
  };
}

function mapInventoryItemResponseRecord(
  item: InventoryItemRecord,
  input: {
    history?: InventoryItemProcessingHistoryEntry[];
    enrichmentJob?: {
      attempts: number;
      failureDetail: InventoryEnrichmentJobRecord["failureDetail"];
      maxAttempts: number;
      resultPayload: unknown;
      status: string;
      updatedAt: Date;
    } | null;
    preprocessingJob?: {
      attempts: number;
      failureDetail: InventoryPreprocessingJobRecord["failureDetail"];
      maxAttempts: number;
      status: string;
      textBundle: InventoryPreprocessingJobRecord["textBundle"];
      updatedAt: Date;
    } | null;
  } = {},
): InventoryItem {
  const evidence = buildInventoryProcessingEvidence(item);
  const preprocessingStatus = mapInventoryPreprocessingStatus(
    input.preprocessingJob?.status,
  );
  const enrichmentStatus = mapInventoryEnrichmentStatus(
    input.enrichmentJob?.status,
  );
  const proposalStatus = mapInventoryProposalStatus(input.enrichmentJob?.status);
  const preprocessingUpdatedAt =
    input.preprocessingJob?.updatedAt ?? item.capturedAt;
  const enrichmentUpdatedAt =
    input.enrichmentJob?.updatedAt ??
    input.preprocessingJob?.updatedAt ??
    item.capturedAt;

  return {
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    captureText: item.captureText ?? null,
    capturedAt: item.capturedAt.toISOString(),
    category: item.category,
    clothingProfile: item.clothingProfile
      ? mapInventoryClothingProfileRecord(item.id, item.clothingProfile)
      : null,
    remedyProfile: item.remedyProfile
      ? mapInventoryRemedyProfileRecord(item.id, item.remedyProfile)
      : null,
    containerId: item.containerId ?? null,
    containerLabel:
      formatInventoryContainerLabel(item.container ?? null, item.containerLabel) ??
      item.containerLabel,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    id: item.id,
    importance: item.importance,
    imageId: item.images[0]?.id ?? null,
    kind: item.kind,
    note: item.note ?? null,
    placementSummary: formatInventoryPlacementSummary(item),
    placements: (item.placements ?? []).map((placement) => ({
      containerId: placement.containerId ?? null,
      label: inventoryItemPlacementLabel({
        container: placement.container ?? null,
        location: placement.location ?? null,
        note: placement.note,
      }),
      locationId: placement.locationId ?? null,
      locationName:
        placement.location?.name ?? placement.container?.location?.name ?? null,
      note: placement.note ?? null,
      placementId: placement.id,
      quantity: placement.quantity,
    })),
    processing: {
      currentStep: inventoryCurrentStep(
        input.preprocessingJob?.status,
        input.enrichmentJob?.status,
      ),
      enrichment: {
        attempts: input.enrichmentJob?.attempts ?? 0,
        failedAt: input.enrichmentJob?.failureDetail?.failedAt ?? null,
        failureMessage: input.enrichmentJob?.failureDetail?.message ?? null,
        maxAttempts: input.enrichmentJob?.maxAttempts ?? 3,
        rationale: inventoryEnrichmentRationale(
          input.enrichmentJob?.resultPayload,
          input.enrichmentJob?.status,
        ),
        status: enrichmentStatus,
        summary: inventoryEnrichmentSummary(input.enrichmentJob?.status),
        retryable: input.enrichmentJob?.failureDetail?.retryable ?? false,
        updatedAt: enrichmentUpdatedAt.toISOString(),
      },
      evidence,
      history: input.history ?? [],
      nextAction: inventoryNextAction(
        input.preprocessingJob?.status,
        input.enrichmentJob?.status,
      ),
      preprocessing: {
        attempts: input.preprocessingJob?.attempts ?? 0,
        failedAt: input.preprocessingJob?.failureDetail?.failedAt ?? null,
        failedSteps: inventoryPreprocessingFailedSteps(input.preprocessingJob),
        mediaTexts: inventoryPreprocessingMediaTexts(input.preprocessingJob),
        failureMessage: input.preprocessingJob?.failureDetail?.message ?? null,
        maxAttempts: input.preprocessingJob?.maxAttempts ?? 3,
        status: preprocessingStatus,
        summary: inventoryPreprocessingSummary(input.preprocessingJob?.status),
        textBundleAvailable:
          input.preprocessingJob?.textBundle !== null &&
            input.preprocessingJob?.textBundle !== undefined,
        retryable: isInventoryPreprocessingRetryable(input.preprocessingJob),
        updatedAt: preprocessingUpdatedAt.toISOString(),
      },
      proposal: {
        status: proposalStatus,
        summary: inventoryProposalSummary(input.enrichmentJob?.status),
        updatedAt: enrichmentUpdatedAt.toISOString(),
      },
      sourceLabel: inventorySourceLabel(evidence),
    },
    status: item.status,
    tags: item.tags,
    title: item.title ?? item.captureText ?? "Untitled Inventory Item",
    totalQuantity:
      item.totalQuantity ??
      (item.placements ?? []).reduce(
        (total, placement) => total + placement.quantity,
        0,
      ),
    where: formatInventoryWhere(item),
  };
}

function mapInventoryClothingProfileRecord(
  itemId: string,
  profile: NonNullable<InventoryItemRecord["clothingProfile"]>,
): InventoryClothingProfile {
  return {
    itemId,
    dirtyQuantity: profile.dirtyQuantity ?? (profile.isDirty ? 1 : 0),
    isDirty: profile.isDirty,
    attributes: profile.attributes,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function mapInventoryRemedyProfileRecord(
  itemId: string,
  profile: NonNullable<InventoryItemRecord["remedyProfile"]>,
): InventoryRemedyProfile {
  return {
    createdAt: profile.createdAt.toISOString(),
    externalReferences: profile.externalReferences.map((reference) => ({
      referenceId: reference.referenceId,
      source: reference.source,
      url: reference.url,
    })),
    potencies: profile.potencies,
    itemId,
    registeredByClientId: profile.registeredByClientId,
    selectionSummary: profile.selectionSummary,
    substanceId: profile.substanceId,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function mapRemedyIntakeRecord(input: {
  id: string;
  notes: string | null;
  occurredAt: Date;
  potency: string | null;
  itemArchivedAt: Date | null;
  itemId: string;
  itemTitle: string | null;
}): RemedyIntake {
  return {
    id: input.id,
    note: input.notes,
    occurredAt: input.occurredAt.toISOString(),
    potency: input.potency ?? "",
    itemArchivedAt: input.itemArchivedAt?.toISOString() ?? null,
    itemId: input.itemId,
    itemTitle: input.itemTitle ?? "Untitled remedy",
  };
}

function projectRemedyIntake(
  intake: RemedyIntake,
  timeZone: string,
): RemedyIntakeProjection {
  return {
    ...intake,
    bucketDate: remedyLocalDayKey(intake.occurredAt, timeZone),
    colorKey: remedyColorKey(intake.itemId),
  };
}

function filterRemedyIntakeRange(
  intakes: RemedyIntakeProjection[],
  input: {
    now: Date;
    range: RemedyIntakeRange;
    timeZone: string;
  },
): RemedyIntakeProjection[] {
  if (input.range === "all") {
    return intakes;
  }

  const bucketKeys = new Set(
    remedyDayBuckets(input.range, input.now, input.timeZone),
  );
  return intakes.filter((intake) => bucketKeys.has(intake.bucketDate));
}

function summarizeRemedyIntakeProjections(
  intakes: RemedyIntakeProjection[],
): RemedyIntakeSummary[] {
  const summaries = new Map<
    string,
    {
      archivedAt: string | null;
      colorKey: string;
      firstIntakeAt: string;
      lastIntakeAt: string;
      potencyTotals: Map<string, number>;
      itemId: string;
      itemTitle: string;
      total: number;
    }
  >();

  for (const intake of intakes) {
    const existing = summaries.get(intake.itemId) ?? {
      archivedAt: intake.itemArchivedAt,
      colorKey: intake.colorKey,
      firstIntakeAt: intake.occurredAt,
      lastIntakeAt: intake.occurredAt,
      potencyTotals: new Map<string, number>(),
      itemId: intake.itemId,
      itemTitle: intake.itemTitle,
      total: 0,
    };
    existing.archivedAt = intake.itemArchivedAt;
    existing.itemTitle = intake.itemTitle;
    existing.total += 1;
    if (intake.occurredAt < existing.firstIntakeAt) {
      existing.firstIntakeAt = intake.occurredAt;
    }
    if (intake.occurredAt > existing.lastIntakeAt) {
      existing.lastIntakeAt = intake.occurredAt;
    }
    existing.potencyTotals.set(
      intake.potency,
      (existing.potencyTotals.get(intake.potency) ?? 0) + 1,
    );
    summaries.set(intake.itemId, existing);
  }

  return [...summaries.values()]
    .sort((left, right) =>
      left.itemTitle.localeCompare(right.itemTitle) ||
      left.itemId.localeCompare(right.itemId),
    )
    .map((summary) => ({
      ...summary,
      potencyTotals: [...summary.potencyTotals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([potency, total]) => ({ potency, total })),
    }));
}

function paginateRemedyIntakeProjections(
  intakes: RemedyIntakeProjection[],
  input: { cursor: string | null; range: RemedyIntakeRange },
): {
  intakes: RemedyIntakeProjection[];
  pageInfo: { nextCursor: string | null };
  range: RemedyIntakeRange;
} {
  const cursorIndex = input.cursor
    ? intakes.findIndex((intake) => intake.id === input.cursor)
    : -1;

  if (input.cursor && cursorIndex < 0) {
    throw new InventoryItemRequestBodyError();
  }

  const start = cursorIndex + 1;
  const page =
    input.range === "all"
      ? intakes.slice(start, start + remedyIntakePageSize + 1)
      : intakes;
  const hasNextPage = page.length > remedyIntakePageSize;
  const projected = hasNextPage ? page.slice(0, remedyIntakePageSize) : page;

  return {
    intakes: projected,
    pageInfo: {
      nextCursor: hasNextPage ? (projected.at(-1)?.id ?? null) : null,
    },
    range: input.range,
  };
}

function remedyColorKey(itemId: string): string {
  let hash = 2_166_136_261;

  for (const character of itemId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return `remedy-${(hash >>> 0) % 8}`;
}

function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function remedyLocalDayKey(value: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "01";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function remedyDayBuckets(
  range: Exclude<RemedyIntakeRange, "all">,
  now: Date,
  timeZone: string,
): string[] {
  const length = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const [year, month, day] = remedyLocalDayKey(now, timeZone)
    .split("-")
    .map(Number);
  const end = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (length - 1));

  return Array.from({ length }, (_, index) => {
    const bucket = new Date(start);
    bucket.setUTCDate(start.getUTCDate() + index);
    return [
      bucket.getUTCFullYear(),
      String(bucket.getUTCMonth() + 1).padStart(2, "0"),
      String(bucket.getUTCDate()).padStart(2, "0"),
    ].join("-");
  });
}

function buildInventoryProcessingEvidence(
  item: InventoryItemRecord,
): InventoryItem["processing"]["evidence"] {
  return [
    ...item.images.flatMap((image, index) =>
      image.id
        ? [
            {
              id: image.id,
              kind: "photo" as const,
              label: "Item Image",
              summary:
                image.caption ??
                image.originalName ??
                `Inventory photo ${index + 1}`,
            },
          ]
        : [],
    ),
    ...(item.audioNotes ?? []).flatMap((audioNote, index) =>
      audioNote.id
        ? [
            {
              id: audioNote.id,
              kind: "voice" as const,
              label: "Audio note",
              summary: audioNote.originalName ?? `Audio note ${index + 1}`,
            },
          ]
        : [],
    ),
    ...(item.assets ?? []).flatMap((asset, index) =>
      asset.id
        ? [
            {
              id: asset.id,
              kind: asset.mimeType?.startsWith("video/")
                ? ("video" as const)
                : ("file" as const),
              label: asset.mimeType?.startsWith("video/")
                ? "Item Video"
                : "Item File",
              summary: asset.originalName ?? `Item file ${index + 1}`,
            },
          ]
        : [],
    ),
    ...(item.captureText
      ? [
          {
            id: `text-${item.id}`,
            kind: "text" as const,
            label: "Typed capture text",
            summary: item.captureText,
          },
        ]
      : []),
  ];
}

function inventorySourceLabel(
  evidence: InventoryItem["processing"]["evidence"],
): string {
  const kinds = [...new Set(evidence.map((entry) => entry.kind))];

  return kinds.length > 0 ? `${kinds.join(" + ")} capture` : "Inventory capture";
}

function mapInventoryPreprocessingStatus(
  status: string | undefined,
): InventoryItem["processing"]["preprocessing"]["status"] {
  switch (status) {
    case "PROCESSING":
      return "PREPROCESSING";
    case "READY_FOR_ENRICHMENT":
      return "READY_FOR_ENRICHMENT";
    case "PARTIAL":
      return "PARTIAL";
    case "NEEDS_REVIEW":
      return "NEEDS_REVIEW";
    case "FAILED":
      return "FAILED";
    default:
      return "CAPTURED";
  }
}

function mapInventoryEnrichmentStatus(
  status: string | undefined,
): InventoryItem["processing"]["enrichment"]["status"] {
  switch (status) {
    case "QUEUED":
      return "QUEUED";
    case "CLAIMED":
      return "PROCESSING";
    case "PENDING_APPROVAL":
      return "PROPOSAL_READY";
    case "APPLIED":
      return "APPLIED";
    case "FAILED":
      return "FAILED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "NOT_STARTED";
  }
}

function mapInventoryProposalStatus(
  status: string | undefined,
): InventoryItem["processing"]["proposal"]["status"] {
  switch (status) {
    case "PENDING_APPROVAL":
      return "PENDING_APPROVAL";
    case "APPLIED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    default:
      return "NONE";
  }
}

function inventoryPreprocessingSummary(status: string | undefined): string {
  switch (status) {
    case "PROCESSING":
      return "Inventory Preprocessing is reading saved evidence.";
    case "READY_FOR_ENRICHMENT":
      return "Inventory Text Bundle is ready for enrichment.";
    case "PARTIAL":
      return "Some evidence was processed; failed steps need review.";
    case "NEEDS_REVIEW":
      return "No usable text was produced; manual review is needed.";
    case "FAILED":
      return "Inventory Preprocessing failed.";
    default:
      return "Saved evidence is waiting for preprocessing pickup.";
  }
}

function inventoryPreprocessingFailedSteps(
  job:
    | {
        failureDetail: InventoryPreprocessingJobRecord["failureDetail"];
        textBundle: InventoryPreprocessingJobRecord["textBundle"];
      }
    | null
    | undefined,
): string[] {
  return [
    ...(job?.textBundle?.failedSteps.map((step) => step.message) ?? []),
    ...(job?.failureDetail?.message ? [job.failureDetail.message] : []),
  ];
}

function isInventoryPreprocessingRetryable(
  job:
    | {
        failureDetail: InventoryPreprocessingJobRecord["failureDetail"];
        status: string;
        textBundle: InventoryPreprocessingJobRecord["textBundle"];
      }
    | null
    | undefined,
): boolean {
  if (job?.status === "FAILED") {
    return job.failureDetail?.retryable ?? false;
  }

  if (job?.status !== "PARTIAL" && job?.status !== "NEEDS_REVIEW") {
    return false;
  }

  return (
    job.failureDetail?.retryable === true ||
    job.textBundle?.failedSteps.some((step) => step.retryable) === true
  );
}

function inventoryPreprocessingMediaTexts(
  job:
    | {
        textBundle: InventoryPreprocessingJobRecord["textBundle"];
      }
    | null
    | undefined,
): string[] {
  return (
    job?.textBundle?.mediaTexts.flatMap((mediaText) => [
      ...(mediaText.ocrText ? [`OCR: ${mediaText.ocrText}`] : []),
      ...(mediaText.transcript
        ? [`Transcript: ${mediaText.transcript}`]
        : []),
    ]) ?? []
  );
}

function inventoryEnrichmentSummary(status: string | undefined): string {
  switch (status) {
    case "QUEUED":
      return "Inventory Enrichment is queued.";
    case "CLAIMED":
      return "Inventory Enrichment is processing the text bundle.";
    case "PENDING_APPROVAL":
      return "An Inventory Proposal is waiting for approval.";
    case "APPLIED":
      return "Approved derived values were applied.";
    case "FAILED":
      return "Inventory Enrichment failed.";
    case "REJECTED":
      return "The Inventory Proposal was rejected.";
    case "CANCELLED":
      return "Inventory Enrichment was cancelled.";
    default:
      return "Inventory Enrichment has not started.";
  }
}

function inventoryProposalSummary(status: string | undefined): string {
  if (status === "PENDING_APPROVAL") {
    return "Approval required before derived values change.";
  }

  if (status === "APPLIED") {
    return "Approved proposal applied.";
  }

  if (status === "REJECTED") {
    return "Proposal rejected.";
  }

  return "No pending Inventory Proposal.";
}

function inventoryCurrentStep(
  preprocessingStatus: string | undefined,
  enrichmentStatus: string | undefined,
): string {
  if (enrichmentStatus === "PENDING_APPROVAL") {
    return "Proposal pending approval";
  }

  if (enrichmentStatus === "CLAIMED") {
    return "Inventory Enrichment running";
  }

  if (enrichmentStatus === "QUEUED") {
    return "Inventory Enrichment queued";
  }

  if (enrichmentStatus === "APPLIED") {
    return "Approved Inventory Proposal applied";
  }

  if (enrichmentStatus === "FAILED") {
    return "Inventory Enrichment failed";
  }

  if (enrichmentStatus === "REJECTED") {
    return "Inventory Proposal rejected";
  }

  if (enrichmentStatus === "CANCELLED") {
    return "Inventory Enrichment superseded";
  }

  return inventoryPreprocessingSummary(preprocessingStatus);
}

function inventoryNextAction(
  preprocessingStatus: string | undefined,
  enrichmentStatus: string | undefined,
): string {
  if (enrichmentStatus === "PENDING_APPROVAL") {
    return "Review Inventory Proposal";
  }

  if (
    enrichmentStatus === "FAILED" ||
    preprocessingStatus === "FAILED" ||
    preprocessingStatus === "NEEDS_REVIEW" ||
    preprocessingStatus === "PARTIAL"
  ) {
    return enrichmentStatus === "FAILED"
      ? "Review enrichment failure"
      : "Review preprocessing evidence";
  }

  if (
    enrichmentStatus === "APPLIED" ||
    enrichmentStatus === "REJECTED" ||
    enrichmentStatus === "CANCELLED"
  ) {
    return "No action required";
  }

  return "Wait for background processing";
}

function inventoryEnrichmentRationale(
  resultPayload: unknown,
  status: string | undefined,
): string {
  const metadata =
    resultPayload && typeof resultPayload === "object" && !Array.isArray(resultPayload)
      ? (resultPayload as { metadata?: unknown }).metadata
      : null;

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const rationale = (metadata as { rationale?: unknown }).rationale;

    if (typeof rationale === "string" && rationale.trim()) {
      return rationale;
    }
  }

  return inventoryEnrichmentSummary(status);
}

async function requireActiveItemRecord(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItemWithRelations> {
  const item = await transaction.inventoryItem.findFirst({
    include: inventoryItemMutationInclude,
    where: {
      archivedAt: null,
      id: itemId,
    },
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  return item as InventoryItemWithRelations;
}

async function requirePlacementContainerRecord(
  transaction: Prisma.TransactionClient,
  containerId: string | null,
): Promise<void> {
  if (!containerId) {
    return;
  }

  const container = await transaction.inventoryContainer.findUnique({
    select: { id: true },
    where: { id: containerId },
  });

  if (!container) {
    throw new Error("Container was not found.");
  }
}

async function requirePlacementLocationRecord(
  transaction: Prisma.TransactionClient,
  locationId: string | null,
): Promise<void> {
  if (!locationId) {
    return;
  }

  const location = await transaction.inventoryLocation.findUnique({
    select: { id: true },
    where: { id: locationId },
  });

  if (!location) {
    throw new Error("Inventory Location was not found.");
  }
}

function placementLookupWhere(input: {
  containerId: string | null;
  itemId: string;
  locationId: string | null;
}) {
  return {
    containerId: input.containerId,
    itemId: input.itemId,
    locationId: input.locationId,
  };
}

async function refreshInventoryItemRecord(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItemRecord> {
  const item = await transaction.inventoryItem.findUnique({
    include: inventoryItemMutationInclude,
    where: { id: itemId },
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  const mapped = mapInventoryItemRecord(item as InventoryItemWithRelations);
  const searchText = buildInventoryItemSearchText(mapped);

  if (searchText !== mapped.searchText) {
    await transaction.inventoryItem.update({
      data: { searchText },
      where: { id: itemId },
    });
    mapped.searchText = searchText;
  }

  return mapped;
}

async function listLatestInventoryPreprocessingJobs(
  itemIds: string[],
  database: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<
  Map<
    string,
    {
      attempts: number;
      failureDetail: InventoryPreprocessingJobRecord["failureDetail"];
      maxAttempts: number;
      status: string;
      textBundle: InventoryPreprocessingJobRecord["textBundle"];
      updatedAt: Date;
    }
  >
> {
  if (itemIds.length === 0) {
    return new Map();
  }

  const jobs = await database.inventoryPreprocessingJob.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      attempts: true,
      failureDetail: true,
      maxAttempts: true,
      status: true,
      targetItemId: true,
      textBundle: true,
      updatedAt: true,
    },
    where: {
      targetItemId: { in: itemIds },
    },
  });
  const latest = new Map<
    string,
    {
      attempts: number;
      failureDetail: InventoryPreprocessingJobRecord["failureDetail"];
      maxAttempts: number;
      status: string;
      textBundle: InventoryPreprocessingJobRecord["textBundle"];
      updatedAt: Date;
    }
  >();

  for (const job of jobs) {
    if (!latest.has(job.targetItemId)) {
      latest.set(job.targetItemId, {
        attempts: job.attempts,
        failureDetail:
          job.failureDetail as InventoryPreprocessingJobRecord["failureDetail"],
        maxAttempts: job.maxAttempts,
        status: job.status,
        textBundle:
          job.textBundle as unknown as InventoryPreprocessingJobRecord["textBundle"],
        updatedAt: job.updatedAt,
      });
    }
  }

  return latest;
}

async function listInventoryProcessingHistory(
  itemIds: string[],
  database: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, InventoryItemProcessingHistoryEntry[]>> {
  const history = new Map<string, InventoryItemProcessingHistoryEntry[]>();

  if (itemIds.length === 0) {
    return history;
  }

  const [preprocessingJobs, enrichmentJobs] = await Promise.all([
    database.inventoryPreprocessingJob.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        failureDetail: true,
        status: true,
        targetItemId: true,
        updatedAt: true,
      },
      where: { targetItemId: { in: itemIds } },
    }),
    database.inventoryEnrichmentJob.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        failureDetail: true,
        status: true,
        targetItemId: true,
        updatedAt: true,
      },
      where: {
        kind: "INVENTORY_ITEM_ENRICHMENT",
        targetItemId: { in: itemIds },
      },
    }),
  ]);

  for (const job of preprocessingJobs) {
    const failure =
      job.failureDetail as InventoryPreprocessingJobRecord["failureDetail"];
    appendInventoryProcessingHistory(history, job.targetItemId, {
      at: job.updatedAt.toISOString(),
      stage: "preprocessing",
      status: job.status,
      summary: failure?.message ?? inventoryPreprocessingSummary(job.status),
    });
  }

  for (const job of enrichmentJobs) {
    const failure =
      job.failureDetail as InventoryEnrichmentJobRecord["failureDetail"];
    appendInventoryProcessingHistory(history, job.targetItemId, {
      at: job.updatedAt.toISOString(),
      stage: "enrichment",
      status: job.status,
      summary: failure?.message ?? inventoryEnrichmentSummary(job.status),
    });
  }

  for (const entries of history.values()) {
    entries.splice(
      0,
      entries.length,
      ...compactInventoryProcessingHistory(entries),
    );
  }

  return history;
}

function compactInventoryProcessingHistory(
  entries: InventoryItemProcessingHistoryEntry[],
): InventoryItemProcessingHistoryEntry[] {
  return [...entries]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 8);
}

function appendInventoryProcessingHistory(
  history: Map<string, InventoryItemProcessingHistoryEntry[]>,
  itemId: string,
  entry: InventoryItemProcessingHistoryEntry,
): void {
  const entries = history.get(itemId) ?? [];
  entries.push(entry);
  history.set(itemId, entries);
}

async function listLatestInventoryEnrichmentJobs(
  itemIds: string[],
  database: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<
  Map<
    string,
    {
      attempts: number;
      failureDetail: InventoryEnrichmentJobRecord["failureDetail"];
      maxAttempts: number;
      resultPayload: unknown;
      status: string;
      updatedAt: Date;
    }
  >
> {
  if (itemIds.length === 0) {
    return new Map();
  }

  const jobs = await database.inventoryEnrichmentJob.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      attempts: true,
      failureDetail: true,
      maxAttempts: true,
      resultPayload: true,
      status: true,
      targetItemId: true,
      updatedAt: true,
    },
    where: {
      kind: "INVENTORY_ITEM_ENRICHMENT",
      targetItemId: { in: itemIds },
    },
  });
  const latest = new Map<
    string,
    {
      attempts: number;
      failureDetail: InventoryEnrichmentJobRecord["failureDetail"];
      maxAttempts: number;
      resultPayload: unknown;
      status: string;
      updatedAt: Date;
    }
  >();

  for (const job of jobs) {
    if (!latest.has(job.targetItemId)) {
      latest.set(job.targetItemId, {
        attempts: job.attempts,
        failureDetail:
          job.failureDetail as InventoryEnrichmentJobRecord["failureDetail"],
        maxAttempts: job.maxAttempts,
        resultPayload: job.resultPayload,
        status: job.status,
        updatedAt: job.updatedAt,
      });
    }
  }

  return latest;
}

function createInventoryEnrichmentMutationRepository(
  transaction: Prisma.TransactionClient,
): InventoryEnrichmentRepository {
  return {
    async applyInventoryImageEnrichment(input) {
      const existingImage = await transaction.inventoryItemImage.findUnique({
        select: { metadata: true },
        where: { id: input.imageId },
      });

      if (!existingImage) {
        throw new Error("Inventory item image not found.");
      }

      const data: Prisma.InventoryItemImageUpdateInput = {
        caption: input.caption ?? undefined,
        ocrText: input.ocrText ?? undefined,
      };

      if (input.metadata !== null) {
        data.metadata = mergeImageEnrichmentMetadata(
          existingImage.metadata,
          input.metadata,
        );
      }

      await transaction.inventoryItemImage.update({
        data,
        where: { id: input.imageId },
      });
    },

    async applyInventoryItemEnrichment(input) {
      const existingItem = await transaction.inventoryItem.findUnique({
        select: {
          acquisitionSource: true,
          aliases: true,
          category: true,
          costCents: true,
          importance: true,
          metadata: true,
          note: true,
          status: true,
          tags: true,
          title: true,
        },
        where: { id: input.itemId },
      });

      if (!existingItem) {
        throw new Error("Inventory item not found.");
      }

      const existingMetadata = toMetadataRecord(existingItem.metadata);
      const manualFieldLocks = readInventoryItemManualFieldLocks(existingMetadata);
      const isLocked = (field: (typeof manualFieldLocks)[number]) =>
        manualFieldLocks.includes(field);

      const item = await transaction.inventoryItem.update({
        data: {
          acquisitionSource:
            (isLocked("acquisitionSource")
              ? existingItem.acquisitionSource
              : input.acquisitionSource) as Prisma.InventoryItemUpdateInput["acquisitionSource"],
          aliases: isLocked("aliases") ? existingItem.aliases : input.aliases,
          category:
            (isLocked("category")
              ? existingItem.category
              : input.category) as Prisma.InventoryItemUpdateInput["category"],
          costCents: isLocked("costCents")
            ? existingItem.costCents
            : input.costCents,
          importance: isLocked("importance")
            ? existingItem.importance
            : input.importance,
          metadata: {
            ...existingMetadata,
            ...input.metadata,
          } as Prisma.InputJsonValue,
          note: isLocked("note") ? existingItem.note : input.note,
          searchText: input.searchText,
          status: isLocked("status") ? existingItem.status : input.status,
          tags: isLocked("tags") ? existingItem.tags : input.tags,
          title: isLocked("title") ? existingItem.title : input.title,
        },
        include: inventoryItemMutationInclude,
        where: { id: input.itemId },
      });

      return mapInventoryItemRecord(item as InventoryItemWithRelations);
    },

    async enqueueInventoryEnrichmentJobs(
      jobs: InventoryEnrichmentNewJobRecord[],
    ) {
      return Promise.all(
        jobs.map(async (job) => {
          const created = await transaction.inventoryEnrichmentJob.create({
            data: {
              claimedAt: job.claimedAt,
              claimedBy: job.claimedBy,
              decidedAt: job.decidedAt,
              failureDetail:
                job.failureDetail === null
                  ? Prisma.DbNull
                  : (job.failureDetail as Prisma.InputJsonValue),
              inputFingerprint: job.inputFingerprint,
              inputSnapshot:
                job.inputSnapshot as unknown as Prisma.InputJsonValue,
              kind: job.kind,
              leaseExpiresAt: job.leaseExpiresAt,
              maxAttempts: job.maxAttempts,
              resultId: job.resultId,
              resultPayload:
                job.resultPayload === null
                  ? Prisma.DbNull
                  : (job.resultPayload as Prisma.InputJsonValue),
              targetImageId: job.targetImageId,
              targetItemId: job.targetItemId,
            },
          });

          return mapEnrichmentJobRecord(created);
        }),
      );
    },

    async getInventoryEnrichmentJob(id) {
      const job = await transaction.inventoryEnrichmentJob.findUnique({
        where: { id },
      });

      return job ? mapEnrichmentJobRecord(job) : null;
    },

    async getInventoryEnrichmentSettings() {
      const settings = await transaction.inventoryEnrichmentSettings.upsert({
        create: { id: "default" },
        update: {},
        where: { id: "default" },
      });

      return mapEnrichmentSettingsRecord(settings);
    },

    async getInventoryItem(id) {
      const item = await transaction.inventoryItem.findUnique({
        include: inventoryItemMutationInclude,
        where: { id },
      });

      return item ? mapInventoryItemRecord(item as InventoryItemWithRelations) : null;
    },

    async listInventoryEnrichmentJobs(input) {
      const jobs = await transaction.inventoryEnrichmentJob.findMany({
        orderBy: { updatedAt: "desc" },
        take: input?.limit ?? 50,
        where:
          input?.status || input?.targetItemId
            ? {
                status: input.status,
                targetItemId: input.targetItemId,
              }
            : undefined,
      });

      return jobs.map(mapEnrichmentJobRecord);
    },

    async updateInventoryEnrichmentJob(job) {
      const updatedJob = await transaction.inventoryEnrichmentJob.update({
        data: toEnrichmentJobUpdateData(job),
        where: { id: job.id },
      });

      return mapEnrichmentJobRecord(updatedJob);
    },

    async updateInventoryEnrichmentSettings(settings) {
      const updatedSettings = await transaction.inventoryEnrichmentSettings.upsert({
        create: {
          approvalsRequired: settings.approvalsRequired,
          id: "default",
          updatedAt: settings.updatedAt,
        },
        update: {
          approvalsRequired: settings.approvalsRequired,
          updatedAt: settings.updatedAt,
        },
        where: { id: "default" },
      });

      return mapEnrichmentSettingsRecord(updatedSettings);
    },
  } as InventoryEnrichmentRepository;
}

function createInventoryRetryMutationRepository(
  transaction: Prisma.TransactionClient,
): InventoryEnrichmentRetryRepository & InventoryPreprocessingRetryRepository {
  const preprocessingRepository =
    createInventoryItemMutationRepository(transaction);
  const enrichmentRepository =
    createInventoryEnrichmentMutationRepository(transaction);

  return {
    ...preprocessingRepository,
    ...enrichmentRepository,
    getInventoryItem: preprocessingRepository.getInventoryItem,
    listInventoryPreprocessingJobs:
      preprocessingRepository.listInventoryPreprocessingJobs,
  } as InventoryEnrichmentRetryRepository &
    InventoryPreprocessingRetryRepository;
}

function toEnrichmentJobUpdateData(job: InventoryEnrichmentJobRecord) {
  return {
    attempts: job.attempts,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    decidedAt: job.decidedAt,
    failureDetail:
      job.failureDetail === null
        ? Prisma.DbNull
        : (job.failureDetail as Prisma.InputJsonValue),
    inputFingerprint: job.inputFingerprint,
    inputSnapshot: job.inputSnapshot as unknown as Prisma.InputJsonValue,
    kind: job.kind,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    resultId: job.resultId,
    resultPayload:
      job.resultPayload === null
        ? Prisma.DbNull
        : (job.resultPayload as Prisma.InputJsonValue),
    status: job.status,
    targetImageId: job.targetImageId,
    targetItemId: job.targetItemId,
    updatedAt: job.updatedAt,
  };
}

function mapEnrichmentSettingsRecord(
  settings: PrismaInventoryEnrichmentSettings,
): InventoryEnrichmentSettingsRecord {
  return {
    approvalsRequired: settings.approvalsRequired,
    updatedAt: settings.updatedAt,
  };
}

function mapEnrichmentJobRecord(
  job: InventoryEnrichmentJob,
): InventoryEnrichmentJobRecord {
  return {
    attempts: job.attempts,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    createdAt: job.createdAt,
    decidedAt: job.decidedAt,
    failureDetail: job.failureDetail as InventoryEnrichmentFailureDetail | null,
    id: job.id,
    inputFingerprint: job.inputFingerprint,
    inputSnapshot:
      job.inputSnapshot as unknown as InventoryEnrichmentInputSnapshot,
    kind: job.kind,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    resultId: job.resultId,
    resultPayload: job.resultPayload as InventoryEnrichmentResultPayload | null,
    status: job.status as InventoryEnrichmentJobStatus,
    targetImageId: job.targetImageId,
    targetItemId: job.targetItemId,
    updatedAt: job.updatedAt,
  };
}

function mergeImageEnrichmentMetadata(
  metadata: unknown,
  enrichmentMetadata: Record<string, unknown>,
): Prisma.InputJsonValue {
  return {
    ...toMetadataRecord(metadata),
    enrichment: enrichmentMetadata,
  } as Prisma.InputJsonValue;
}

function mapLocation(location: InventoryLocation): InventoryLocationRecord {
  return {
    id: location.id,
    kind: location.kind as InventoryLocationKind,
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
): InventoryContainerVisualPresetRecord {
  const preset =
    getInventoryContainerVisualCatalogEntry(key) ??
    getDefaultInventoryContainerVisualCatalogEntry();

  return {
    backImageUrl: preset.assets.back.webpPath,
    bounds: preset.itemBounds,
    emptyImageUrl: preset.assets.empty.webpPath,
    frontImageUrl: preset.assets.front.webpPath,
    height: preset.dimensions.height,
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

function mapOptionalContainer(
  container: InventoryContainerWithRelations | null,
): InventoryContainerRecord | null {
  return container ? mapContainer(container) : null;
}

function mapInventoryItemRecord(
  item: InventoryItemWithRelations,
): InventoryItemRecord {
  const originLocation = item.captureSession?.defaultOriginLocation ?? null;
  const primaryPlacement = item.placements[0] ?? null;
  const currentLocation =
    primaryPlacement?.location ??
    primaryPlacement?.container?.location ??
    item.captureSession?.defaultDestinationLocation ??
    null;
  const placements = item.placements.map((placement) => ({
    container: mapOptionalContainer(
      placement.container as InventoryContainerWithRelations | null,
    ),
    containerId: placement.containerId,
    location: mapOptionalLocation(placement.location),
    locationId: placement.locationId,
    createdAt: placement.createdAt,
    id: placement.id,
    itemId: placement.itemId,
    note: placement.note,
    quantity: placement.quantity,
    updatedAt: placement.updatedAt,
  }));
  const primaryMappedPlacement = placements[0] ?? null;

  return {
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    archivedAt: item.archivedAt,
    assets: item.assets.map(mapAsset),
    audioNotes: item.audioNotes.map(mapAudioNote),
    captureSessionId: item.captureSessionId,
    captureText: item.captureText,
    capturedAt: item.capturedAt,
    category: item.category,
    clothingProfile: item.clothingProfile
      ? {
          attributes:
            item.clothingProfile.attributes as unknown as NonNullable<
              InventoryItemRecord["clothingProfile"]
            >["attributes"],
          createdAt: item.clothingProfile.createdAt,
          dirtyQuantity: item.clothingProfile.dirtyQuantity,
          isDirty: item.clothingProfile.isDirty,
          updatedAt: item.clothingProfile.updatedAt,
        }
      : null,
    remedyProfile: item.remedyProfile
      ? {
          createdAt: item.remedyProfile.createdAt,
          externalReferences:
            item.remedyProfile.externalReferences as unknown as NonNullable<
              InventoryItemRecord["remedyProfile"]
            >["externalReferences"],
          potencies: item.remedyProfile.potencies,
          registeredByClientId: item.remedyProfile.registeredByClientId,
          selectionSummary: item.remedyProfile.selectionSummary,
          substanceId: item.remedyProfile.substance.id,
          updatedAt: item.remedyProfile.updatedAt,
        }
      : null,
    container: primaryMappedPlacement?.container ?? null,
    containerId: primaryMappedPlacement?.containerId ?? null,
    containerLabel:
      primaryMappedPlacement?.container?.name ??
      primaryMappedPlacement?.note ??
      null,
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

function updateImagesInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemImageUpdateManyWithoutItemNestedInput | undefined {
  if (input.addImages.length === 0 && input.removeImageIds.length === 0) {
    return undefined;
  }

  return {
    create: input.addImages.map((image, index) => ({
      caption: image.caption ?? null,
      filePath: image.filePath,
      height: image.height ?? null,
      metadata: {},
      mimeType: image.mimeType ?? null,
      ocrText: image.ocrText ?? null,
      originalName: image.originalName ?? null,
      position: image.position ?? index,
      sizeBytes: image.sizeBytes ?? null,
      width: image.width ?? null,
    })),
    deleteMany:
      input.removeImageIds.length > 0
        ? { id: { in: input.removeImageIds } }
        : undefined,
  };
}

function updateAudioNotesInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemAudioUpdateManyWithoutItemNestedInput | undefined {
  if (
    input.addAudioNotes.length === 0 &&
    input.removeAudioNoteIds.length === 0
  ) {
    return undefined;
  }

  return {
    create: input.addAudioNotes.map((audioNote) => ({
      filePath: audioNote.filePath,
      metadata: {},
      mimeType: audioNote.mimeType ?? null,
      originalName: audioNote.originalName ?? null,
      sizeBytes: audioNote.sizeBytes ?? null,
    })),
    deleteMany:
      input.removeAudioNoteIds.length > 0
        ? { id: { in: input.removeAudioNoteIds } }
        : undefined,
  };
}

function updateAssetsInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemAssetUpdateManyWithoutItemNestedInput | undefined {
  if (input.addAssets.length === 0 && input.removeAssetIds.length === 0) {
    return undefined;
  }

  return {
    create: input.addAssets.map((asset) => ({
      filePath: asset.filePath,
      metadata: {},
      mimeType: asset.mimeType ?? null,
      originalName: asset.originalName ?? null,
      sizeBytes: asset.sizeBytes ?? null,
    })),
    deleteMany:
      input.removeAssetIds.length > 0
        ? { id: { in: input.removeAssetIds } }
        : undefined,
  };
}

function mapImage(
  image: InventoryItemImage,
): InventoryItemRecord["images"][number] {
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

function mapAudioNote(audioNote: InventoryItemAudio): InventoryItemAudioRecord {
  return {
    filePath: audioNote.filePath,
    id: audioNote.id,
    mimeType: audioNote.mimeType,
    originalName: audioNote.originalName,
    sizeBytes: audioNote.sizeBytes,
  };
}

function mapAsset(asset: InventoryItemAsset): InventoryItemAssetRecord {
  return {
    filePath: asset.filePath,
    id: asset.id,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
    sizeBytes: asset.sizeBytes,
  };
}

function toMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function mapInventoryProposal(proposal: {
  diff: Array<{ after: unknown; before: unknown; field: string }>;
  job: InventoryEnrichmentJobRecord;
  itemTitle: string;
  capturedAt: Date;
}): InventoryProposal {
  const textBundle = inventoryProposalTextBundle(proposal.job.inputSnapshot);

  return {
    captureText: textBundle?.captureText ?? null,
    capturedAt: proposal.capturedAt.toISOString(),
    confidence: inventoryProposalConfidence(proposal.job.resultPayload),
    diff: proposal.diff.map((entry) => ({
      current: formatInventoryProposalDiffValue(entry.field, entry.before),
      field: entry.field,
      label: formatInventoryProposalFieldLabel(entry.field),
      proposed: formatInventoryProposalDiffValue(entry.field, entry.after),
    })),
    failedSteps: textBundle?.failedSteps.map((step) => step.message) ?? [],
    id: proposal.job.id,
    ocrEvidence: listInventoryProposalOcrEvidence(textBundle),
    itemId: proposal.job.targetItemId,
    itemTitle: proposal.itemTitle,
    rationale: inventoryProposalRationale(proposal.job.resultPayload),
    sourceRefsSummary: summarizeInventoryProposalSourceRefs(textBundle),
    transcriptEvidence: listInventoryProposalTranscriptEvidence(textBundle),
    updatedAt: proposal.job.updatedAt.toISOString(),
  };
}

type InventoryProposalTextBundle = NonNullable<
  Extract<InventoryEnrichmentInputSnapshot, { textBundle: unknown }>["textBundle"]
>;

function inventoryProposalTextBundle(
  snapshot: InventoryEnrichmentInputSnapshot,
): InventoryProposalTextBundle | null {
  return "textBundle" in snapshot ? snapshot.textBundle : null;
}

function formatInventoryProposalFieldLabel(field: string): string {
  switch (field) {
    case "acquisitionSource":
      return "Acquisition source";
    case "aliases":
      return "Aliases";
    case "category":
      return "Category";
    case "costCents":
      return "Estimated value";
    case "importance":
      return "Importance";
    case "note":
      return "Note";
    case "status":
      return "Status";
    case "tags":
      return "Tags";
    case "title":
      return "Title";
    default:
      return field;
  }
}

function formatInventoryProposalDiffValue(field: string, value: unknown): string {
  if (field === "category" && typeof value === "string") {
    return formatInventoryCategoryLabel(value as InventoryItemRecord["category"]) ?? "None";
  }

  if (field === "acquisitionSource" && typeof value === "string") {
    return (
      formatInventoryAcquisitionSourceLabel(
        value as InventoryItemRecord["acquisitionSource"],
      ) ?? "None"
    );
  }

  if (field === "costCents" && typeof value === "number") {
    return formatInventoryEstimatedValue(value, "CAD") ?? "None";
  }

  if (value === null || value === undefined) {
    return "None";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "None";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function inventoryProposalRationale(
  resultPayload: InventoryEnrichmentResultPayload | null,
): string | null {
  const metadata = resultPayload?.metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const rationale = (metadata as { rationale?: unknown }).rationale;

  return typeof rationale === "string" && rationale.trim() ? rationale.trim() : null;
}

function inventoryProposalConfidence(
  resultPayload: InventoryEnrichmentResultPayload | null,
): number | null {
  const metadata = resultPayload?.metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const confidence = (metadata as { confidence?: unknown }).confidence;

  return typeof confidence === "number" && Number.isFinite(confidence)
    ? confidence
    : null;
}

function listInventoryProposalOcrEvidence(
  textBundle: InventoryProposalTextBundle | null,
): InventoryProposal["ocrEvidence"] {
  if (!textBundle) {
    return [];
  }

  return textBundle.mediaTexts.flatMap((mediaText: InventoryProposalTextBundle["mediaTexts"][number]) => {
    const preview =
      mediaText.ocrText ?? mediaText.ocrLines?.join(" | ") ?? null;

    if (!preview) {
      return [];
    }

    return [
      {
        id: mediaText.mediaId,
        preview,
        secondary:
          mediaText.ocrLines && mediaText.ocrLines.length > 0
            ? `${mediaText.ocrLines.length} OCR lines`
            : null,
      },
    ];
  });
}

function listInventoryProposalTranscriptEvidence(
  textBundle: InventoryProposalTextBundle | null,
): InventoryProposal["transcriptEvidence"] {
  if (!textBundle) {
    return [];
  }

  return textBundle.mediaTexts.flatMap((mediaText: InventoryProposalTextBundle["mediaTexts"][number]) => {
    const preview =
      mediaText.transcript ??
      mediaText.transcriptSegments
        ?.map(
          (
            segment: NonNullable<
              InventoryProposalTextBundle["mediaTexts"][number]["transcriptSegments"]
            >[number],
          ) => segment.text,
        )
        .join(" ") ??
      null;

    if (!preview) {
      return [];
    }

    return [
      {
        id: mediaText.mediaId,
        preview,
        secondary:
          mediaText.transcriptSegments &&
          mediaText.transcriptSegments.length > 0
            ? `${mediaText.transcriptSegments.length} transcript segments`
            : null,
      },
    ];
  });
}

function summarizeInventoryProposalSourceRefs(
  textBundle: InventoryProposalTextBundle | null,
): string {
  if (!textBundle) {
    return "Unknown";
  }

  const counts = {
    asset: 0,
    audio: 0,
    image: 0,
    item: 0,
  };

  for (const sourceRef of textBundle.sourceRefs) {
    counts[sourceRef.kind] += 1;
  }

  return `${counts.item} item, ${counts.image} image, ${counts.audio} audio, ${counts.asset} file`;
}

function inventoryLifecycleWhere(
  archived: boolean,
): Pick<Prisma.InventoryItemWhereInput, "archivedAt"> {
  return {
    archivedAt: archived ? { not: null } : null,
  };
}

function buildInventoryItemsFindManyArgs(input: ListInventoryItemsInput) {
  const where: Prisma.InventoryItemWhereInput = inventoryLifecycleWhere(
    input.archived,
  );
  const queryWhere = buildInventoryItemQueryWhere(input.query);

  if (input.category) {
    where.category = input.category;
  }

  if (queryWhere) {
    where.AND = [queryWhere];
  }

  return {
    include: inventoryItemMutationInclude,
    orderBy: input.archived
      ? [{ archivedAt: "desc" }, { capturedAt: "desc" }, { id: "desc" }]
      : [{ capturedAt: "desc" }, { id: "desc" }],
    where,
  } satisfies Prisma.InventoryItemFindManyArgs;
}

function filterInventoryItemsByClothingState(
  items: InventoryItem[],
  clothingState: "clean" | "dirty" | null,
): InventoryItem[] {
  if (!clothingState) {
    return items;
  }

  return items.filter((item) => {
    const dirtyQuantity =
      item.clothingProfile?.dirtyQuantity ??
      (item.clothingProfile?.isDirty ? item.totalQuantity : 0);

    return clothingState === "dirty"
      ? dirtyQuantity > 0
      : dirtyQuantity < item.totalQuantity;
  });
}

function filterInventoryItemCollection(
  items: InventoryItem[],
  input: ListInventoryItemsInput,
): InventoryItem[] {
  return items.filter((item) => {
    const workflow = inventoryItemWorkflowStatus(item);

    return (
      (input.includeUnready !== false || workflow === "COMPLETE") &&
      (!input.containerId ||
        item.placements.some(
          (placement) => placement.containerId === input.containerId,
        ) ||
        item.containerId === input.containerId) &&
      (!input.status || item.status === input.status) &&
      (!input.importance || item.importance === input.importance) &&
      (!input.kind || item.kind === input.kind) &&
      (!input.workflow || workflow === input.workflow) &&
      (!input.evidence || item.processing.evidence.some((entry) => entry.kind === input.evidence))
    );
  });
}

function inventoryItemWorkflowStatus(
  item: {
    processing: {
      preprocessing: Pick<InventoryItem["processing"]["preprocessing"], "status">;
      enrichment: Pick<InventoryItem["processing"]["enrichment"], "status">;
      proposal: Pick<InventoryItem["processing"]["proposal"], "status">;
    };
  },
): "CAPTURED" | "PREPROCESSING" | "ENRICHING" | "NEEDS_REVIEW" | "COMPLETE" {
  if (
    item.processing.proposal.status === "PENDING_APPROVAL" ||
    item.processing.enrichment.status === "PROPOSAL_READY" ||
    item.processing.enrichment.status === "FAILED" ||
    item.processing.preprocessing.status === "PARTIAL" ||
    item.processing.preprocessing.status === "NEEDS_REVIEW"
  ) {
    return "NEEDS_REVIEW";
  }
  if (
    item.processing.enrichment.status === "APPLIED" ||
    item.processing.proposal.status === "APPROVED"
  ) {
    return "COMPLETE";
  }
  if (
    item.processing.enrichment.status === "QUEUED" ||
    item.processing.enrichment.status === "PROCESSING"
  ) {
    return "ENRICHING";
  }
  if (
    item.processing.preprocessing.status === "PREPROCESSING" ||
    item.processing.preprocessing.status === "READY_FOR_ENRICHMENT"
  ) {
    return "PREPROCESSING";
  }
  return "CAPTURED";
}

function inventoryItemFilterKey(input: ListInventoryItemsInput): string {
  // Keep the field order used by existing opaque collection cursors.
  return JSON.stringify({
    archived: input.archived,
    category: input.category,
    clothingState: input.clothingState,
    containerId: input.containerId,
    cursor: null,
    evidence: input.evidence,
    importance: input.importance,
    includeUnready: input.includeUnready,
    kind: input.kind,
    limit: null,
    query: input.query,
    status: input.status,
    workflow: input.workflow,
  });
}

function paginateInventoryItems(
  items: InventoryItem[],
  input: { cursor: string | null; filterKey: string; limit: number | "all" },
): InventoryItemsPage {
  if (input.limit === "all") {
    if (input.cursor) {
      throw new InventoryItemCursorError();
    }
    return { items, pageInfo: { nextCursor: null }, total: items.length };
  }

  let start = 0;
  if (input.cursor) {
    const cursor = parseInventoryItemCursor(input.cursor);
    if (cursor.filterKey !== input.filterKey) {
      throw new InventoryItemCursorError();
    }
    const index = items.findIndex((item) => item.id === cursor.itemId);
    if (index < 0) {
      throw new InventoryItemCursorError();
    }
    start = index + 1;
  }
  const pageItems = items.slice(start, start + input.limit);
  const lastItem = pageItems.at(-1);
  return {
    items: pageItems,
    pageInfo: {
      nextCursor:
        lastItem && start + pageItems.length < items.length
          ? createInventoryItemCursor(lastItem.id, input.filterKey)
          : null,
    },
    total: items.length,
  };
}

function createInventoryItemCursor(itemId: string, filterKey: string): string {
  return Buffer.from(JSON.stringify({ filterKey, itemId }), "utf8").toString("base64url");
}

function parseInventoryItemCursor(cursor: string): { filterKey: string; itemId: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { filterKey?: unknown; itemId?: unknown };
    if (typeof value.filterKey === "string" && typeof value.itemId === "string") {
      return { filterKey: value.filterKey, itemId: value.itemId };
    }
  } catch {}
  throw new InventoryItemCursorError();
}

function buildInventoryItemQueryWhere(
  query: string | null,
): Prisma.InventoryItemWhereInput | null {
  const terms = inventorySearchTerms(query);

  if (terms.length === 0) {
    return null;
  }

  return {
    AND: terms.map((term) => ({
      OR: [
        { searchText: { contains: term, mode: "insensitive" } },
        { title: { contains: term, mode: "insensitive" } },
        { captureText: { contains: term, mode: "insensitive" } },
        {
          placements: {
            some: {
              OR: [
                { note: { contains: term, mode: "insensitive" } },
                {
                  location: {
                    is: {
                      name: {
                        contains: term,
                        mode: "insensitive",
                      },
                    },
                  },
                },
                {
                  container: {
                    is: {
                      OR: [
                        {
                          name: {
                            contains: term,
                            mode: "insensitive",
                          },
                        },
                        {
                          referenceId: {
                            contains: term,
                            mode: "insensitive",
                          },
                        },
                        {
                          location: {
                            is: {
                              name: {
                                contains: term,
                                mode: "insensitive",
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    })),
  };
}

function inventoryItemPlacementLabel(placement: {
  container: {
    location?: {
      name: string;
    } | null;
    name: string;
    referenceId: string;
  } | null;
  location?: {
    name: string;
  } | null;
  note: string | null;
}): string {
  const containerLabel = placement.container
    ? `${placement.container.name} (${placement.container.referenceId})`
    : null;
  const locationName =
    placement.location?.name ?? placement.container?.location?.name ?? null;

  if (locationName && containerLabel) {
    return `${locationName} / ${containerLabel}`;
  }

  return locationName ?? containerLabel ?? placement.note ?? "Unplaced";
}

function mapInventoryItem(item: InventoryItemRow): InventoryItem {
  const placements = item.placements.map((placement) => ({
    containerId: placement.containerId ?? null,
    label: inventoryItemPlacementLabel(placement),
    locationId: placement.locationId ?? null,
    locationName:
      placement.location?.name ?? placement.container?.location?.name ?? null,
    note: placement.note ?? null,
    placementId: placement.id,
    quantity: placement.quantity,
  }));
  const totalQuantity = item.placements.reduce(
    (total, placement) => total + placement.quantity,
    0,
  );
  const primaryPlacement = placements[0] ?? null;

  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: item.archivedAt?.toISOString() ?? null,
    captureText: item.captureText ?? null,
    capturedAt: new Date(0).toISOString(),
    category: item.category ?? null,
    clothingProfile: item.clothingProfile
      ? mapInventoryClothingProfileRecord(item.id, {
          ...item.clothingProfile,
          attributes: item.clothingProfile.attributes as unknown as NonNullable<
            InventoryItemRecord["clothingProfile"]
          >["attributes"],
        })
      : null,
    remedyProfile: item.remedyProfile
      ? mapInventoryRemedyProfileRecord(item.id, {
          createdAt: item.remedyProfile.createdAt,
          externalReferences:
            item.remedyProfile.externalReferences as unknown as NonNullable<
              InventoryItemRecord["remedyProfile"]
            >["externalReferences"],
          potencies: item.remedyProfile.potencies,
          registeredByClientId: item.remedyProfile.registeredByClientId,
          selectionSummary: item.remedyProfile.selectionSummary,
          substanceId: item.remedyProfile.substance.id,
          updatedAt: item.remedyProfile.updatedAt,
        })
      : null,
    containerId: item.containerId ?? primaryPlacement?.containerId ?? null,
    containerLabel: item.containerLabel ?? primaryPlacement?.label ?? null,
    costCents: null,
    costCurrency: "CAD",
    id: item.id,
    importance: item.importance ?? "MEDIUM",
    imageId: item.images[0]?.id ?? null,
    kind: item.kind ?? "ITEM",
    note: item.note ?? null,
    placementSummary:
      placements.length > 0
        ? `Total ${totalQuantity} · ${placements
            .map((placement) => `${placement.label} ${placement.quantity}`)
            .join(" · ")}`
        : "Unplaced",
    placements,
    processing: {
      currentStep: "Wait for background processing",
      enrichment: {
        attempts: 0,
        failedAt: null,
        failureMessage: null,
        maxAttempts: 3,
        rationale: "Inventory Enrichment has not started.",
        retryable: false,
        status: "NOT_STARTED",
        summary: "Inventory Enrichment has not started.",
        updatedAt: new Date(0).toISOString(),
      },
      evidence: [],
      history: [],
      nextAction: "Wait for background processing",
      preprocessing: {
        attempts: 0,
        failedAt: null,
        failedSteps: [],
        failureMessage: null,
        maxAttempts: 3,
        mediaTexts: [],
        status: "CAPTURED",
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        retryable: false,
        updatedAt: new Date(0).toISOString(),
      },
      proposal: {
        status: "NONE",
        summary: "No pending Inventory Proposal.",
        updatedAt: new Date(0).toISOString(),
      },
      sourceLabel: "Inventory capture",
    },
    status: item.status ?? "UNSURE",
    tags: item.tags ?? [],
    title: item.title ?? item.captureText ?? "Untitled Inventory Item",
    totalQuantity: item.totalQuantity || totalQuantity,
    where:
      placements.length > 0
        ? `${placements[0]?.label ?? "Unplaced"} × ${placements[0]?.quantity ?? 0}`
        : item.locationName && item.containerLabel
          ? `${item.locationName} / ${item.containerLabel}`
          : item.locationName ??
            item.containerLabel ??
            "Unplaced",
  };
}

function mapInventoryItemLifecycle(
  item: InventoryItemLifecycleRow,
): InventoryItemLifecycle {
  return {
    archivedAt: item.archivedAt?.toISOString() ?? null,
    id: item.id,
  };
}

function inventoryItemScore(item: InventoryItemRow, query: string) {
  return inventoryItemMatch(item, query).score;
}

function inventoryItemMatchExplanation(
  item: InventoryItemRow,
  query: string,
): string {
  const match = inventoryItemMatch(item, query);

  return `Matched ${match.reasons.join(", ") || "search text"}`;
}

function inventoryItemMatch(
  item: Pick<InventoryItemRow, "title" | "captureText" | "searchText"> & {
    placements: Array<{
      note: string | null;
      location?: { name: string } | null;
      container: { name: string; referenceId: string; location?: { name: string } | null } | null;
    }>;
  },
  query: string,
): { reasons: string[]; score: number } {
  const terms = inventorySearchTerms(query);

  if (terms.length === 0) {
    return { reasons: [], score: 1 };
  }

  const fields = [
    { name: "title", value: item.title },
    { name: "capture", value: item.captureText },
    { name: "search", value: item.searchText },
    {
      name: "placement",
      value: item.placements
        .flatMap((placement) => [
          placement.note,
          placement.location?.name,
          placement.container?.name,
          placement.container?.referenceId,
          placement.container?.location?.name,
        ])
        .filter(Boolean)
        .join(" "),
    },
  ];
  const searchable = buildInventorySearchCorpus(
    fields.map((field) => field.value),
  );

  if (!matchesInventorySearchQuery(searchable, query)) {
    return { reasons: [], score: 0 };
  }

  const normalizedQuery = normalizeInventorySearchText(query);
  const reasons = new Set<string>();
  let score = 0;

  for (const field of fields) {
    const normalizedField = normalizeInventorySearchText(field.value);

    if (!normalizedField) {
      continue;
    }

    if (normalizedField.includes(normalizedQuery)) {
      score += field.name === "title" ? 100 : 40;
      reasons.add(field.name);
      continue;
    }

    const termMatches = terms.filter((term) =>
      normalizedField.includes(term),
    ).length;

    if (termMatches > 0) {
      score += termMatches * (field.name === "title" ? 18 : 8);
      reasons.add(field.name);
    }
  }

  return {
    reasons: [...reasons].map((reason) =>
      reason === "capture"
        ? "capture text"
        : reason === "search"
          ? "search text"
          : reason,
    ),
    score,
  };
}

async function requireInventoryItemLifecycle(
  repository: InventoryItemsRepository,
  id: string,
): Promise<InventoryItemLifecycleRow> {
  const item = await repository.findItemLifecycle(id);

  if (!item) {
    throw new InventoryItemNotFoundError();
  }

  return item;
}

function sanitizeUpdateInventoryItemRequest(
  request: UpdateInventoryItemRequest,
): UpdateInventoryItemRequest {
  return {
    acquisitionSource:
      request.acquisitionSource === undefined
        ? undefined
        : request.acquisitionSource,
    aliases:
      request.aliases === undefined
        ? undefined
        : sanitizeInventoryStringList(request.aliases),
    captureText: cleanOptionalUpdate(request.captureText),
    category: request.category === undefined ? undefined : request.category,
    costCents: request.costCents === undefined ? undefined : request.costCents,
    costCurrency:
      request.costCurrency === undefined
        ? undefined
        : (cleanOptional(request.costCurrency) ?? "CAD").toUpperCase(),
    importance:
      request.importance === undefined ? undefined : request.importance,
    kind: request.kind === undefined ? undefined : request.kind,
    note: cleanOptionalUpdate(request.note),
    status: request.status === undefined ? undefined : request.status,
    tags:
      request.tags === undefined
        ? undefined
        : sanitizeInventoryStringList(request.tags),
    title: cleanOptionalUpdate(request.title),
  };
}

function sanitizeAddInventoryUnitsRequest(
  request: AddInventoryUnitsRequest,
): AddInventoryUnitsRequest {
  const target = sanitizePlacementTarget(request);

  return {
    containerId: target.containerId,
    locationId: target.locationId,
    note: cleanOptional(request.note),
    quantity: request.quantity ?? 1,
  };
}

function sanitizeMoveInventoryUnitsRequest(
  request: MoveInventoryUnitsRequest,
): MoveInventoryUnitsRequest {
  const source = sanitizePlacementTarget({
    containerId: request.sourceContainerId,
    locationId: request.sourceLocationId,
  });
  const destination = sanitizePlacementTarget({
    containerId: request.destinationContainerId,
    locationId: request.destinationLocationId,
  });

  return {
    destinationContainerId: destination.containerId,
    destinationLocationId: destination.locationId,
    quantity: request.quantity ?? 1,
    sourceContainerId: source.containerId,
    sourceLocationId: source.locationId,
  };
}

function sanitizeRemoveInventoryUnitsRequest(
  request: RemoveInventoryUnitsRequest,
): RemoveInventoryUnitsRequest {
  const target = sanitizePlacementTarget(request);

  return {
    containerId: target.containerId,
    locationId: target.locationId,
    quantity: request.quantity ?? 1,
  };
}

function sanitizePlacementTarget(input: {
  containerId?: string | null;
  locationId?: string | null;
}) {
  return {
    containerId: cleanOptional(input.containerId),
    locationId: cleanOptional(input.locationId),
  };
}

function hasAtMostOnePlacementTarget(input: {
  containerId?: string | null;
  locationId?: string | null;
}): boolean {
  return !(input.containerId && input.locationId);
}

function sanitizeInventoryStringList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => cleanOptional(value))
        .filter((value): value is string => value !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function sanitizeCompleteInventoryClothingLaundryRequest(
  request: CompleteInventoryClothingLaundryRequest,
): CompleteInventoryClothingLaundryRequest {
  if (request.mode === "all-dirty") {
    return request;
  }

  const itemIds = [
    ...new Set(
      request.itemIds
        .map((itemId) => cleanOptional(itemId))
        .filter((itemId): itemId is string => itemId !== null),
    ),
  ];

  if (itemIds.length === 0) {
    throw new InventoryItemRequestBodyError();
  }

  return {
    mode: "selected",
    itemIds,
  };
}

function sanitizeInventoryRemedyPotencies(values: string[]): string[] {
  const normalized: string[] = [];

  for (const value of values) {
    const potency = cleanOptional(value)?.toUpperCase();

    if (!potency || potency.length > 32) {
      throw new InventoryItemRequestBodyError();
    }

    normalized.push(potency);
  }

  if (normalized.length === 0) {
    throw new InventoryItemRequestBodyError();
  }

  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function sanitizeInventoryRemedyExternalReferences(
  values: Array<{
    source: string;
    url: string;
    referenceId?: string;
  }> | undefined,
) {
  return (values ?? []).map((value) => {
    const source = cleanOptional(value.source)?.toLowerCase();
    const referenceId = cleanOptional(value.referenceId);
    const url = cleanOptional(value.url);

    if (!source || !url) {
      throw new InventoryItemRequestBodyError();
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InventoryItemRequestBodyError();
    }

    if (parsed.protocol !== "https:") {
      throw new InventoryItemRequestBodyError();
    }

    return {
      referenceId: referenceId ?? undefined,
      source,
      url: parsed.toString(),
    };
  });
}

function sanitizeRegisterInventoryRemedyRequest(
  request: RegisterInventoryRemedyRequest,
) {
  const target = sanitizePlacementTarget(request);
  const title = cleanOptional(request.title);

  if (!title) {
    throw new InventoryItemRequestBodyError();
  }

  return {
    aliases:
      request.aliases === undefined
        ? []
        : sanitizeInventoryStringList(request.aliases),
    containerId: target.containerId,
    externalReferences: sanitizeInventoryRemedyExternalReferences(
      request.externalReferences,
    ),
    locationId: target.locationId,
    note: cleanOptional(request.note),
    placementNote: cleanOptional(request.placementNote),
    potencies: sanitizeInventoryRemedyPotencies(request.potencies),
    quantity: request.quantity ?? 1,
    selectionSummary: cleanOptional(request.selectionSummary),
    title,
  };
}

function sanitizeUpdateInventoryRemedyProfileRequest(
  request: UpdateInventoryRemedyProfileRequest,
) {
  const result = {
    externalReferences:
      request.externalReferences === undefined
        ? undefined
        : sanitizeInventoryRemedyExternalReferences(request.externalReferences),
    potencies:
      request.potencies === undefined
        ? undefined
        : sanitizeInventoryRemedyPotencies(request.potencies),
    selectionSummary: cleanOptionalUpdate(request.selectionSummary),
  };

  if (Object.values(result).every((value) => value === undefined)) {
    throw new InventoryItemRequestBodyError();
  }

  return result;
}

function sanitizeCreateRemedyIntakeRequest(
  request: CreateRemedyIntakeRequest,
) {
  const itemId = cleanOptional(request.itemId);
  const potency = cleanOptional(request.potency)?.toUpperCase();
  const note = cleanOptional(request.note);
  const occurredAt = cleanOptional(request.occurredAt);

  if (!itemId || !potency || potency.length > 32) {
    throw new InventoryItemRequestBodyError();
  }

  if (!occurredAt) {
    return {
      note,
      occurredAt: null,
      potency,
      itemId,
    };
  }

  let parsed: Date;
  try {
    parsed = new Date(occurredAt);
  } catch {
    throw new InventoryItemRequestBodyError();
  }

  if (Number.isNaN(parsed.getTime())) {
    throw new InventoryItemRequestBodyError();
  }

  return {
    note,
    occurredAt: parsed.toISOString(),
    potency,
    itemId,
  };
}

function buildInventoryRemedySearchText(input: {
  aliases: string[];
  externalReferences: Array<{
    source: string;
    url: string;
    referenceId?: string;
  }>;
  note: string | null;
  placements: InventoryItemRecord["placements"];
  potencies: string[];
  selectionSummary: string | null;
  title: string;
}) {
  return [
    buildInventoryItemSearchText({
      acquisitionSource: null,
      aliases: input.aliases,
      assets: [],
      audioNotes: [],
      captureText: input.selectionSummary,
      category: "homeopathy",
      costCents: null,
      images: [],
      importance: "MEDIUM",
      kind: "ITEM",
      note: input.note,
      placements: input.placements ?? [],
      status: "KEEP",
      tags: [],
      title: input.title,
    }),
    ...input.potencies,
    ...input.externalReferences.flatMap((reference) => [
      reference.source,
      reference.referenceId,
      reference.url,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function cleanOptional(value: string | null | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function normalizeInventoryClothingState(
  value: string | null | undefined,
): (typeof inventoryClothingStateValues)[number] | null {
  const cleaned = cleanOptional(value);

  return cleaned === "clean" || cleaned === "dirty" ? cleaned : null;
}

function cleanOptionalUpdate(
  value: string | null | undefined,
): string | null | undefined {
  return value === undefined ? undefined : cleanOptional(value);
}

class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

class InventoryItemWriteNotFoundError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_CLOTHING_PROFILE_NOT_FOUND"
      | "INVENTORY_CLOTHING_WEAR_CONFIRMATION_NOT_FOUND"
      | "INVENTORY_REMEDY_INTAKE_NOT_FOUND"
      | "INVENTORY_REMEDY_PROFILE_NOT_FOUND"
      | "INVENTORY_CONTAINER_NOT_FOUND"
      | "INVENTORY_LOCATION_NOT_FOUND"
      | "INVENTORY_ITEM_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "InventoryItemWriteNotFoundError";
  }
}

class InventoryItemRequestBodyError extends Error {
  constructor() {
    super("Request validation failed.");
    this.name = "InventoryItemRequestBodyError";
  }
}

async function readInventoryItemRequest<T>(context: Context): Promise<T> {
  try {
    return (await context.req.json()) as T;
  } catch {
    throw new InventoryItemRequestBodyError();
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

function mapInventoryClothingWearConfirmationRecord(input: {
  createdAt: Date;
  id: string;
  items: Array<{ productId: string }>;
  undoneAt: Date | null;
}): InventoryClothingWearConfirmation {
  return {
    createdAt: input.createdAt.toISOString(),
    id: input.id,
    itemIds: input.items.map(({ productId }) => productId),
    undoneAt: input.undoneAt?.toISOString() ?? null,
  };
}

async function requireActiveClothingItemForWear(
  transaction: Prisma.TransactionClient,
  itemId: string,
) {
  const item = await transaction.inventoryItem.findFirst({
    include: {
      clothingProfile: true,
      placements: {
        select: { quantity: true },
      },
    },
    where: {
      archivedAt: null,
      id: itemId,
    },
  });

  if (!item) {
    throw new InventoryItemWriteNotFoundError(
      "INVENTORY_ITEM_NOT_FOUND",
      "Inventory Item was not found.",
    );
  }

  if (item.category !== "clothing" || !item.clothingProfile) {
    throw new InventoryClothingCommandConflictError(
      "Inventory Item must be an active Clothing Item.",
    );
  }

  return item;
}

async function mapInventoryItemsWithState(
  items: InventoryItemWithRelations[],
  database: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<InventoryItem[]> {
  const itemIds = items.map((item) => item.id);
  const [preprocessingJobs, enrichmentJobs, histories] = await Promise.all([
    listLatestInventoryPreprocessingJobs(itemIds, database),
    listLatestInventoryEnrichmentJobs(itemIds, database),
    listInventoryProcessingHistory(itemIds, database),
  ]);

  return items.map((item) =>
    mapInventoryItemResponseRecord(mapInventoryItemRecord(item), {
      enrichmentJob: enrichmentJobs.get(item.id) ?? null,
      history: histories.get(item.id) ?? [],
      preprocessingJob: preprocessingJobs.get(item.id) ?? null,
    }),
  );
}

async function archiveEmptyInventoryItem(
  repository: InventoryItemMutationRepository,
  item: InventoryItemRecord,
  now: () => Date,
): Promise<InventoryItemRecord> {
  if ((item.totalQuantity ?? 0) > 0 || item.archivedAt) {
    return item;
  }

  return repository.setItemArchivedAt(item.id, now());
}

async function mapTransactionInventoryItem(
  transaction: Prisma.TransactionClient,
  item: InventoryItemRecord,
): Promise<InventoryItem> {
  const inventoryItemModel = (
    transaction as Prisma.TransactionClient & {
      inventoryItem?: {
        findUniqueOrThrow?: (
          args: unknown,
        ) => Promise<InventoryItemWithRelations>;
      };
    }
  ).inventoryItem;

  if (!inventoryItemModel?.findUniqueOrThrow) {
    return mapInventoryItemResponseRecord(item);
  }

  const [mappedItem] = await mapInventoryItemsWithState(
    [
      {
        ...(await inventoryItemModel.findUniqueOrThrow({
          include: inventoryItemMutationInclude,
          where: { id: item.id },
        })),
      } as InventoryItemWithRelations,
    ],
    transaction,
  );

  return mappedItem ?? mapInventoryItemResponseRecord(item);
}

async function requireTransactionInventoryItem(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItem> {
  const itemRecord = await transaction.inventoryItem.findUnique({
    include: inventoryItemMutationInclude,
    where: { id: itemId },
  });

  if (!itemRecord) {
    throw new InventoryItemNotFoundError();
  }

  const [item] = await mapInventoryItemsWithState(
    [itemRecord as InventoryItemWithRelations],
    transaction,
  );

  if (!item) {
    throw new InventoryItemNotFoundError();
  }

  return item;
}

function createInventoryItemsRouteHandlers(
  input: {
    createMutationRepository?: (
      transaction: Prisma.TransactionClient,
    ) => InventoryItemMutationRepository;
    deleteStoredFiles?: typeof deleteInventoryStoredFiles;
    now?: () => Date;
    exportDatabase?: Pick<typeof prisma, "inventoryItem">;
    repository?: InventoryItemsRepository;
    runCommand?: typeof runIdempotentCommand;
  } = {},
): InventoryItemsRouteHandlers {
  const createMutationRepository: (
    transaction: Prisma.TransactionClient,
  ) => InventoryItemMutationRepository =
    input.createMutationRepository ?? createInventoryItemMutationRepository;
  const deleteStoredFiles =
    input.deleteStoredFiles ?? deleteInventoryStoredFiles;
  const now = input.now ?? (() => new Date());
  const repository = input.repository ?? inventoryItemsRepository;
  const runCommand = input.runCommand ?? runIdempotentCommand;
  const exportDatabase = input.exportDatabase ?? prisma;

  async function loadRemedyIntakeProjections(
    query: {
      cursor?: string | null;
      itemId: string | null;
      range: RemedyIntakeRange;
      timeZone: string;
    },
    options: { paginateAllTime?: boolean } = {},
  ): Promise<RemedyIntakeProjection[]> {
    const queryNow = now();
    const rangeDays =
      query.range === "7d" ? 7 : query.range === "30d" ? 30 : 90;
    const where: Prisma.SubstanceIntakeWhereInput = {
      occurredAt:
        query.range === "all"
          ? undefined
          : {
              gte: new Date(
                queryNow.getTime() - (rangeDays + 1) * 24 * 60 * 60 * 1_000,
              ),
              lte: new Date(queryNow.getTime() + 2 * 24 * 60 * 60 * 1_000),
            },
      substance: {
        is: {
          remedyProfile: {
            is: query.itemId ? { itemId: query.itemId } : {},
          },
        },
      },
    };

    if (options.paginateAllTime && query.cursor) {
      const cursorExists = await prisma.substanceIntake.findFirst({
        select: { id: true },
        where: { ...where, id: query.cursor },
      });
      if (!cursorExists) {
        throw new InventoryItemRequestBodyError();
      }
    }

    const intakes = await prisma.substanceIntake.findMany({
      ...(options.paginateAllTime
        ? {
            cursor: query.cursor ? { id: query.cursor } : undefined,
            skip: query.cursor ? 1 : undefined,
            take: remedyIntakePageSize + 1,
          }
        : {}),
      orderBy: [
        { occurredAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: {
        id: true,
        notes: true,
        occurredAt: true,
        potency: true,
        substance: {
          select: {
            remedyProfile: {
              select: {
                item: {
                  select: {
                    archivedAt: true,
                    captureText: true,
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        },
      },
      where,
    });
    const projections = intakes.flatMap((intake) => {
      const item = intake.substance.remedyProfile?.item;

      return item
        ? [
            projectRemedyIntake(
              mapRemedyIntakeRecord({
                id: intake.id,
                notes: intake.notes,
                occurredAt: intake.occurredAt,
                potency: intake.potency,
                itemArchivedAt: item.archivedAt,
                itemId: item.id,
                itemTitle: item.title ?? item.captureText,
              }),
              query.timeZone,
            ),
          ]
        : [];
    });

    return filterRemedyIntakeRange(projections, {
      now: queryNow,
      range: query.range,
      timeZone: query.timeZone,
    });
  }

  return {
    async addUnits(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeAddInventoryUnitsRequest(input.request);
          const mutationRepository = createMutationRepository(transaction);
          const item = await addInventoryUnitsService(mutationRepository, {
            containerId: request.containerId,
            itemId: input.itemId,
            locationId: request.locationId,
            note: request.note,
            quantity: request.quantity,
          });

          return {
            body: {
              item: await mapTransactionInventoryItem(transaction, item),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          itemId: input.itemId,
          ...sanitizeAddInventoryUnitsRequest(input.request),
        },
      });

      return readIdempotentRouteResult(result);
    },

    async moveUnits(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeMoveInventoryUnitsRequest(input.request);
          const mutationRepository = createMutationRepository(transaction);
          const item = await moveInventoryUnitsService(mutationRepository, {
            destinationContainerId: request.destinationContainerId,
            destinationLocationId: request.destinationLocationId,
            itemId: input.itemId,
            quantity: request.quantity,
            sourceContainerId: request.sourceContainerId,
            sourceLocationId: request.sourceLocationId,
          });

          return {
            body: {
              item: await mapTransactionInventoryItem(transaction, item),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          itemId: input.itemId,
          ...sanitizeMoveInventoryUnitsRequest(input.request),
        },
      });

      return readIdempotentRouteResult(result);
    },

    async removeUnits(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeRemoveInventoryUnitsRequest(input.request);
          const mutationRepository = createMutationRepository(transaction);
          const removed = await removeInventoryUnitsService(mutationRepository, {
            containerId: request.containerId,
            itemId: input.itemId,
            locationId: request.locationId,
            quantity: request.quantity,
          });
          const item = await archiveEmptyInventoryItem(
            mutationRepository,
            removed,
            now,
          );

          return {
            body: {
              item: await mapTransactionInventoryItem(transaction, item),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          itemId: input.itemId,
          ...sanitizeRemoveInventoryUnitsRequest(input.request),
        },
      });

      return readIdempotentRouteResult(result);
    },

    async archiveItem(id) {
      const item = await requireInventoryItemLifecycle(repository, id);

      if (item.archivedAt) {
        return mapInventoryItemLifecycle(item);
      }

      const transitioned = await repository.transitionItemLifecycle(id, {
        archivedAt: now(),
        expectedState: "active",
      });

      if (!transitioned) {
        throw new InventoryItemNotFoundError();
      }

      return mapInventoryItemLifecycle(transitioned);
    },

    async deleteItem(id) {
      const item = await repository.deleteItem(id);

      if (!item) {
        throw new InventoryItemNotFoundError();
      }

      const cleanupFailures = await deleteStoredFiles([
        ...item.images.map(({ filePath }) => filePath),
        ...item.audioNotes.map(({ filePath }) => filePath),
        ...item.assets.map(({ filePath }) => filePath),
      ]);

      if (cleanupFailures.length > 0) {
        console.error(
          `Inventory Item ${id} deleted with ${cleanupFailures.length} file cleanup failure(s).`,
        );
      }

      return {
        deletedItemId: item.id,
      };
    },

    async getEnrichmentSettings() {
      const settings = await getInventoryEnrichmentSettingsService(
        inventoryRepository,
      );

      return {
        approvalsRequired: settings.approvalsRequired,
        updatedAt: settings.updatedAt.toISOString(),
      };
    },

    async getClothingProfile(itemId) {
      const item = await this.getItem(itemId);

      return item?.clothingProfile ?? null;
    },

    async getRemedyProfile(itemId) {
      const item = await this.getItem(itemId);

      return item?.remedyProfile ?? null;
    },

    async getItem(id) {
      const item = await prisma.inventoryItem.findUnique({
        include: inventoryItemMutationInclude,
        where: { id },
      });

      if (!item) {
        return null;
      }

      const [mappedItem] = await mapInventoryItemsWithState(
        [item as InventoryItemWithRelations],
      );

      return mappedItem ?? null;
    },

    async listProposals(input) {
      const proposals = await listInventoryEnrichmentProposalsService(
        inventoryRepository,
        {
          limit: input.limit,
          targetItemId: input.itemId ?? undefined,
        },
      );

      return proposals.map((proposal) =>
        mapInventoryProposal({
          ...proposal,
          capturedAt: proposal.job.inputSnapshot.target.kind === "ITEM"
            ? new Date(
                "item" in proposal.job.inputSnapshot
                  ? proposal.job.inputSnapshot.item.capturedAt
                  : proposal.job.updatedAt.toISOString(),
              )
            : proposal.job.updatedAt,
          itemTitle:
            ("item" in proposal.job.inputSnapshot
              ? proposal.job.inputSnapshot.item.title
              : proposal.job.inputSnapshot.textBundle.item.title) ??
            "Untitled item",
        }),
      );
    },

    async exportItems(input) {
      const query = normalizeOptionalQuery(input.query);
      const { orderBy, where } = buildInventoryItemsFindManyArgs({ ...input, query });
      const conditions: Prisma.InventoryItemWhereInput[] = [where];
      if (input.status) conditions.push({ status: input.status });
      if (input.importance) conditions.push({ importance: input.importance });
      if (input.kind) conditions.push({ kind: input.kind });
      if (input.containerId)
        conditions.push({ placements: { some: { containerId: input.containerId } } });
      if (input.evidence === "photo") conditions.push({ images: { some: { id: { not: "" } } } });
      if (input.evidence === "voice") conditions.push({ audioNotes: { some: { id: { not: "" } } } });
      if (input.evidence === "text")
        conditions.push({ captureText: { not: null } }, { captureText: { not: "" } });

      const needsWorkflow = input.includeUnready === false || Boolean(input.workflow);
      const select = {
        id: true,
        title: true,
        captureText: true,
        clothingProfile: input.clothingState
          ? { select: { dirtyQuantity: true, isDirty: true } }
          : false,
        preprocessingJobs: needsWorkflow
          ? { orderBy: { updatedAt: "desc" }, take: 1, select: { status: true } }
          : false,
        enrichmentJobs: needsWorkflow
          ? {
              where: { kind: "INVENTORY_ITEM_ENRICHMENT" },
              orderBy: { updatedAt: "desc" },
              take: 1,
              select: { status: true },
            }
          : false,
      } satisfies Prisma.InventoryItemSelect;
      const args = { orderBy, where: { AND: conditions } };
      const rows = query
        ? await exportDatabase.inventoryItem.findMany({
            ...args,
            select: {
              ...select,
              searchText: true,
              placements: {
                select: {
                  quantity: Boolean(input.clothingState),
                  note: true,
                  location: { select: { name: true } },
                  container: {
                    select: {
                      name: true,
                      referenceId: true,
                      location: { select: { name: true } },
                    },
                  },
                },
              },
            },
          })
        : await exportDatabase.inventoryItem.findMany({
            ...args,
            select: {
              ...select,
              placements: input.clothingState
                ? { select: { quantity: true } }
                : false,
            },
          });
      const matches = rows.flatMap((row) => {
        if (input.clothingState) {
          const dirty = row.clothingProfile?.dirtyQuantity ?? (row.clothingProfile?.isDirty ? 1 : 0);
          const quantity = row.placements.reduce((sum, placement) => sum + placement.quantity, 0);
          const matchesClothing = input.clothingState === "dirty"
            ? dirty > 0
            : dirty < quantity;
          if (!matchesClothing) return [];
        }
        if (needsWorkflow) {
          const enrichmentStatus = row.enrichmentJobs[0]?.status;
          const workflow = inventoryItemWorkflowStatus({
            processing: {
              preprocessing: { status: mapInventoryPreprocessingStatus(row.preprocessingJobs[0]?.status) },
              enrichment: { status: mapInventoryEnrichmentStatus(enrichmentStatus) },
              proposal: { status: mapInventoryProposalStatus(enrichmentStatus) },
            },
          });
          if (input.includeUnready === false && workflow !== "COMPLETE") return [];
          if (input.workflow && workflow !== input.workflow) return [];
        }
        const score = query && "searchText" in row
          ? inventoryItemMatch(row, query).score
          : 1;
        if (score === 0) return [];
        return [{
          score,
          item: { id: row.id, title: row.title ?? row.captureText ?? "Untitled Inventory Item" },
        }];
      });
      if (query) matches.sort((left, right) => right.score - left.score);
      return matches.map(({ item }) => item);
    },

    async listItems(input) {
      const normalizedQuery = normalizeOptionalQuery(input.query);
      const rows = await prisma.inventoryItem.findMany(
        buildInventoryItemsFindManyArgs({
          archived: input.archived,
          category: input.category,
          clothingState: input.clothingState,
          query: normalizedQuery,
        }),
      );

      if (!normalizedQuery) {
        const items = filterInventoryItemCollection(
          filterInventoryItemsByClothingState(await mapInventoryItemsWithState(
            rows as InventoryItemWithRelations[],
          ), input.clothingState),
          input,
        );
        return paginateInventoryItems(items, {
          cursor: input.cursor ?? null,
          filterKey: inventoryItemFilterKey(input),
          limit: input.limit ?? inventoryItemPageSize,
        });
      }

      const rankedRows = rows
        .map((row) => ({
          matchExplanation: inventoryItemMatchExplanation(
            row as unknown as InventoryItemRow,
            normalizedQuery,
          ),
          row,
          score: inventoryItemScore(
            row as unknown as InventoryItemRow,
            normalizedQuery,
          ),
        }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }

          if (input.archived) {
            return (
              (right.row.archivedAt?.getTime() ?? 0) -
              (left.row.archivedAt?.getTime() ?? 0)
            );
          }

          return 0;
        });
      const items = await mapInventoryItemsWithState(
        rankedRows.map(({ row }) => row as InventoryItemWithRelations),
      );

      const filteredItems = filterInventoryItemCollection(
        filterInventoryItemsByClothingState(
          items.map((item, index) => ({
            ...item,
            matchExplanation: rankedRows[index]?.matchExplanation,
          })),
          input.clothingState,
        ),
        input,
      );
      return paginateInventoryItems(filteredItems, {
        cursor: input.cursor ?? null,
        filterKey: inventoryItemFilterKey(input),
        limit: input.limit ?? inventoryItemPageSize,
      });
    },

    async listRemedyIntakes(input) {
      const filtered = await loadRemedyIntakeProjections(input, {
        paginateAllTime: input.range === "all",
      });
      return paginateRemedyIntakeProjections(filtered, {
        cursor: input.range === "all" ? null : input.cursor,
        range: input.range,
      });
    },

    async summarizeRemedyIntakes(input) {
      const intakes = await loadRemedyIntakeProjections(input);

      return {
        range: input.range,
        remedies: summarizeRemedyIntakeProjections(intakes),
        totalIntakes: intakes.length,
      };
    },

    async createRemedyIntake(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeCreateRemedyIntakeRequest(input.request);
          const item = await transaction.inventoryItem.findUnique({
            select: {
              archivedAt: true,
              captureText: true,
              category: true,
              id: true,
              remedyProfile: {
                select: {
                  potencies: true,
                  substance: {
                    select: {
                      id: true,
                      isActive: true,
                    },
                  },
                },
              },
              title: true,
            },
            where: {
              id: request.itemId,
            },
          });

          if (!item || item.category !== "homeopathy" || !item.remedyProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
              "Inventory Remedy Profile was not found.",
            );
          }

          if (item.archivedAt || !item.remedyProfile.substance.isActive) {
            throw new RemedyIntakeConflictError(
              "Remedy Intake requires an active owned remedy.",
            );
          }

          if (!item.remedyProfile.potencies.includes(request.potency)) {
            throw new RemedyIntakeConflictError(
              "Remedy Intake potency must match one owned remedy potency.",
            );
          }

          const intake = await transaction.substanceIntake.create({
            data: {
              notes: request.note,
              occurredAt: request.occurredAt
                ? new Date(request.occurredAt)
                : now(),
              potency: request.potency,
              substanceId: item.remedyProfile.substance.id,
            },
            select: {
              id: true,
              notes: true,
              occurredAt: true,
              potency: true,
            },
          });

          return {
            body: {
              intake: mapRemedyIntakeRecord({
                id: intake.id,
                notes: intake.notes,
                occurredAt: intake.occurredAt,
                potency: intake.potency,
                itemArchivedAt: item.archivedAt,
                itemId: item.id,
                itemTitle: item.title ?? item.captureText,
              }),
            },
            kind: "success" as const,
            status: 201,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: sanitizeCreateRemedyIntakeRequest(input.request),
      });

      return readIdempotentRouteResult(result);
    },

    async deleteRemedyIntake(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const intake = await transaction.substanceIntake.findUnique({
            select: {
              id: true,
              substance: {
                select: {
                  remedyProfile: {
                    select: {
                      itemId: true,
                    },
                  },
                },
              },
            },
            where: {
              id: input.intakeId,
            },
          });

          if (!intake?.substance.remedyProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_REMEDY_INTAKE_NOT_FOUND",
              "Remedy Intake was not found.",
            );
          }

          await transaction.substanceIntake.delete({
            where: {
              id: input.intakeId,
            },
          });

          return {
            body: {
              deletedIntakeId: input.intakeId,
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          intakeId: input.intakeId,
        },
      });

      return readIdempotentRouteResult(result);
    },

    async markClothingItemWorn(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const item = await requireActiveClothingItemForWear(
            transaction,
            input.itemId,
          );
          const clothingProfile = item.clothingProfile;

          if (!clothingProfile) {
            throw new InventoryClothingCommandConflictError(
              "Inventory Item must be an active Clothing Item.",
            );
          }

          const totalQuantity = item.placements.reduce(
            (total, placement) => total + placement.quantity,
            0,
          );

          if (clothingProfile.dirtyQuantity >= totalQuantity) {
            throw new InventoryClothingCommandConflictError(
              "All owned units of this Clothing Item are already dirty.",
            );
          }

          const wearConfirmation =
            await transaction.inventoryClothingWearConfirmation.create({
              data: {
                confirmedByClientId: input.clientId,
                items: {
                  create: {
                    itemId: input.itemId,
                    productId: input.itemId,
                    productTitle:
                      item.title ??
                      item.captureText ??
                      "Untitled Clothing Item",
                    wearStateVersionAfter: clothingProfile.wearStateVersion + 1,
                  },
                },
              },
              include: {
                items: {
                  select: {
                    productId: true,
                  },
                },
              },
            });

          await transaction.inventoryClothingProfile.update({
            data: {
              dirtyQuantity: {
                increment: 1,
              },
              isDirty: true,
              wearStateVersion: {
                increment: 1,
              },
            },
            where: {
              itemId: input.itemId,
            },
          });

          return {
            body: {
              item: await requireTransactionInventoryItem(
                transaction,
                input.itemId,
              ),
              wearConfirmation: mapInventoryClothingWearConfirmationRecord(
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
          itemId: input.itemId,
        },
      });

      return readIdempotentRouteResult(result);
    },

    async undoClothingWearConfirmation(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const wearConfirmation =
            await transaction.inventoryClothingWearConfirmation.findUnique({
              include: {
                items: {
                  include: {
                    item: {
                      include: {
                        clothingProfile: true,
                      },
                    },
                  },
                },
                recommendation: {
                  select: {
                    eventLabel: true,
                    eventStartsAt: true,
                    id: true,
                    kind: true,
                    status: true,
                    targetDate: true,
                  },
                },
              },
              where: {
                id: input.confirmationId,
              },
            });

          if (!wearConfirmation) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_CLOTHING_WEAR_CONFIRMATION_NOT_FOUND",
              "Inventory Clothing Wear Confirmation was not found.",
            );
          }

          if (wearConfirmation.undoneAt) {
            throw new InventoryClothingCommandConflictError(
              "Clothing Wear Confirmation was already undone.",
            );
          }

          if (
            wearConfirmation.recommendation &&
            wearConfirmation.recommendation.status !== "WORN"
          ) {
            throw new InventoryClothingCommandConflictError(
              "Clothing Wear Confirmation can no longer be safely undone.",
            );
          }

          if (wearConfirmation.recommendation) {
            const conflictingPublishedRecommendation =
              await transaction.inventoryClothingRecommendation.findFirst({
                select: {
                  id: true,
                },
                where: {
                  id: {
                    not: wearConfirmation.recommendation.id,
                  },
                  ...(wearConfirmation.recommendation.kind === "DAILY"
                    ? {
                        kind: "DAILY" as const,
                        targetDate: wearConfirmation.recommendation.targetDate,
                      }
                    : {
                        eventLabel: wearConfirmation.recommendation.eventLabel,
                        eventStartsAt:
                          wearConfirmation.recommendation.eventStartsAt,
                        kind: "EVENT" as const,
                      }),
                  status: "PUBLISHED",
                },
              });

            if (conflictingPublishedRecommendation) {
              throw new InventoryClothingCommandConflictError(
                "Clothing Wear Confirmation can no longer be safely undone.",
              );
            }
          }

          for (const item of wearConfirmation.items) {
            if (
              !item.item ||
              item.item.archivedAt !== null ||
              item.item.category !== "clothing" ||
              !item.item.clothingProfile ||
              item.item.clothingProfile.dirtyQuantity < 1 ||
              item.item.clothingProfile.wearStateVersion !==
                item.wearStateVersionAfter
            ) {
              throw new InventoryClothingCommandConflictError(
                "Clothing Wear Confirmation can no longer be safely undone.",
              );
            }
          }

          const liveItems = wearConfirmation.items.flatMap((history) =>
            history.item && history.itemId
              ? [{ item: history.item, itemId: history.itemId }]
              : [],
          );

          for (const item of liveItems) {
            await transaction.inventoryClothingProfile.update({
              data: {
                dirtyQuantity: {
                  decrement: 1,
                },
                isDirty: item.item.clothingProfile!.dirtyQuantity > 1,
                wearStateVersion: {
                  increment: 1,
                },
              },
              where: {
                itemId: item.itemId,
              },
            });
          }

          if (wearConfirmation.recommendation?.id) {
            await transaction.inventoryClothingRecommendation.update({
              data: {
                status: "PUBLISHED",
              },
              where: {
                id: wearConfirmation.recommendation.id,
              },
            });
          }

          const updatedConfirmation =
            await transaction.inventoryClothingWearConfirmation.update({
              data: {
                undoneAt: now(),
                undoneByClientId: input.clientId,
              },
              include: {
                items: {
                  select: {
                    productId: true,
                  },
                },
              },
              where: {
                id: input.confirmationId,
              },
            });

          return {
            body: {
              items: await Promise.all(
                liveItems.map(({ itemId }) =>
                  requireTransactionInventoryItem(transaction, itemId)
                ),
              ),
              wearConfirmation: mapInventoryClothingWearConfirmationRecord(
                updatedConfirmation,
              ),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          confirmationId: input.confirmationId,
        },
      });

      return readIdempotentRouteResult(result);
    },

    async completeClothingLaundry(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeCompleteInventoryClothingLaundryRequest(
            input.request,
          );
          let targetItemIds: string[] = [];

          if (request.mode === "all-dirty") {
            const dirtyItems = await transaction.inventoryItem.findMany({
              select: {
                id: true,
              },
              where: {
                archivedAt: null,
                category: "clothing",
                clothingProfile: {
                  is: {
                    dirtyQuantity: { gt: 0 },
                  },
                },
              },
            });

            targetItemIds = dirtyItems.map(({ id }) => id);
          } else {
            const items = await transaction.inventoryItem.findMany({
              include: {
                clothingProfile: true,
              },
              where: {
                archivedAt: null,
                id: {
                  in: request.itemIds,
                },
              },
            });
            const foundIds = new Set(items.map(({ id }) => id));
            const missingId = request.itemIds.find((id) => !foundIds.has(id));

            if (missingId) {
              throw new InventoryItemWriteNotFoundError(
                "INVENTORY_ITEM_NOT_FOUND",
                "Inventory Item was not found.",
              );
            }

            for (const item of items) {
              if (item.category !== "clothing" || !item.clothingProfile) {
                throw new InventoryClothingCommandConflictError(
                  "Laundry supports Clothing Items only.",
                );
              }
            }

            targetItemIds = items.map(({ id }) => id);
          }

          const dirtyProfiles =
            targetItemIds.length === 0
              ? []
              : await transaction.inventoryClothingProfile.findMany({
                  select: {
                    dirtyQuantity: true,
                    itemId: true,
                  },
                  where: {
                    dirtyQuantity: { gt: 0 },
                    itemId: {
                      in: targetItemIds,
                    },
                  },
                });

          if (targetItemIds.length > 0) {
            if (request.mode === "all-dirty") {
              await transaction.inventoryClothingProfile.updateMany({
                data: {
                  dirtyQuantity: 0,
                  isDirty: false,
                  wearStateVersion: { increment: 1 },
                },
                where: {
                  dirtyQuantity: { gt: 0 },
                  itemId: { in: targetItemIds },
                },
              });
            } else {
              await Promise.all(
                dirtyProfiles.map((profile) =>
                  transaction.inventoryClothingProfile.update({
                    data: {
                      dirtyQuantity: { decrement: 1 },
                      isDirty: profile.dirtyQuantity > 1,
                      wearStateVersion: { increment: 1 },
                    },
                    where: { itemId: profile.itemId },
                  }),
                ),
              );
            }
          }

          return {
            body: {
              cleanedCount:
                request.mode === "all-dirty"
                  ? dirtyProfiles.reduce(
                      (total, profile) => total + profile.dirtyQuantity,
                      0,
                    )
                  : dirtyProfiles.length,
              items: await Promise.all(
                targetItemIds.map((itemId) =>
                  requireTransactionInventoryItem(transaction, itemId)
                ),
              ),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: sanitizeCompleteInventoryClothingLaundryRequest(input.request),
      });

      return readIdempotentRouteResult(result);
    },

    async registerRemedy(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeRegisterInventoryRemedyRequest(input.request);
          await requirePlacementContainerRecord(transaction, request.containerId);
          await requirePlacementLocationRecord(transaction, request.locationId);

          const createdItem = await transaction.inventoryItem.create({
            data: {
              aliases: request.aliases,
              archivedAt: null,
              captureText: null,
              category: "homeopathy",
              costCents: null,
              costCurrency: "CAD",
              importance: "MEDIUM",
              kind: "ITEM",
              metadata: {},
              note: request.note,
              placements: {
                create: {
                  containerId: request.containerId,
                  locationId: request.locationId,
                  note: request.placementNote,
                  quantity: request.quantity,
                },
              },
              searchText: "",
              status: "KEEP",
              tags: [],
              title: request.title,
            },
            include: inventoryItemMutationInclude,
          });

          const substance = await transaction.substance.create({
            data: {
              category: "HOMEOPATHY",
              isActive: true,
              metadata: {
                linkedInventoryItemId: createdItem.id,
              } as Prisma.InputJsonValue,
              name: `__remedy__:${createdItem.id}`,
            },
          });

          await transaction.inventoryRemedyProfile.create({
            data: {
              externalReferences:
                request.externalReferences as unknown as Prisma.InputJsonValue,
              itemId: createdItem.id,
              potencies: request.potencies,
              registeredByClientId: input.clientId,
              selectionSummary: request.selectionSummary,
              substanceId: substance.id,
            },
          });

          await transaction.inventoryItem.update({
            data: {
              searchText: buildInventoryRemedySearchText({
                aliases: request.aliases,
                externalReferences: request.externalReferences,
                note: request.note,
                placements: [
                  {
                    container: createdItem.placements[0]?.container
                      ? mapContainer(
                          createdItem.placements[0].container as InventoryContainerWithRelations,
                        )
                      : null,
                    containerId: request.containerId,
                    createdAt: createdItem.placements[0]?.createdAt ?? now(),
                    id: createdItem.placements[0]?.id ?? "placement",
                    itemId: createdItem.id,
                    location: createdItem.placements[0]?.location
                      ? mapLocation(createdItem.placements[0].location)
                      : null,
                    locationId: request.locationId,
                    note: request.placementNote,
                    quantity: request.quantity,
                    updatedAt: createdItem.placements[0]?.updatedAt ?? now(),
                  },
                ],
                potencies: request.potencies,
                selectionSummary: request.selectionSummary,
                title: request.title,
              }),
            },
            where: { id: createdItem.id },
          });

          const item = await requireTransactionInventoryItem(
            transaction,
            createdItem.id,
          );

          if (!item.remedyProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
              "Inventory Remedy Profile was not found.",
            );
          }

          return {
            body: {
              item,
              remedyProfile: item.remedyProfile,
            },
            kind: "success" as const,
            status: 201,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: sanitizeRegisterInventoryRemedyRequest(input.request),
      });

      return readIdempotentRouteResult(result);
    },

    async approveProposal(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const enrichmentRepository =
            createInventoryEnrichmentMutationRepository(transaction);

          try {
            const proposal = await approveInventoryEnrichmentProposalService(
              enrichmentRepository,
              {
                jobId: input.proposalId,
                now: now(),
              },
            );

            return {
              body: {
                proposal: {
                  decidedAt: (proposal.decidedAt ?? now()).toISOString(),
                  id: proposal.id,
                  itemId: proposal.targetItemId,
                  status: "APPLIED" as const,
                },
              },
              kind: "success" as const,
              status: 200,
            };
          } catch (error) {
            if (error instanceof Error) {
              if (error.message === "Inventory enrichment job not found.") {
                throw new InventoryProposalNotFoundError();
              }

              if (
                error.message ===
                  "Inventory enrichment job is not pending approval." ||
                error.message ===
                  "Inventory enrichment result is stale for current inventory input."
              ) {
                throw new InventoryProposalConflictError(error.message);
              }
            }

            throw error;
          }
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: { proposalId: input.proposalId },
      });

      return readIdempotentRouteResult(result);
    },

    async rejectProposal(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const enrichmentRepository =
            createInventoryEnrichmentMutationRepository(transaction);

          try {
            const proposal = await rejectInventoryEnrichmentProposalService(
              enrichmentRepository,
              {
                jobId: input.proposalId,
                now: now(),
              },
            );

            return {
              body: {
                proposal: {
                  decidedAt: (proposal.decidedAt ?? now()).toISOString(),
                  id: proposal.id,
                  itemId: proposal.targetItemId,
                  status: "REJECTED" as const,
                },
              },
              kind: "success" as const,
              status: 200,
            };
          } catch (error) {
            if (error instanceof Error) {
              if (error.message === "Inventory enrichment job not found.") {
                throw new InventoryProposalNotFoundError();
              }

              if (
                error.message ===
                "Inventory enrichment job is not pending approval."
              ) {
                throw new InventoryProposalConflictError(error.message);
              }
            }

            throw error;
          }
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: { proposalId: input.proposalId },
      });

      return readIdempotentRouteResult(result);
    },

    async retryEnrichment(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const retryRepository = createInventoryRetryMutationRepository(
            transaction,
          );
          await retryInventoryEnrichmentService(retryRepository, {
            targetItemId: input.itemId,
          });
          const item = await requireTransactionInventoryItem(
            transaction,
            input.itemId,
          );

          return {
            body: { item },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: { itemId: input.itemId },
      });

      return readIdempotentRouteResult(result);
    },

    async retryPreprocessing(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const retryRepository = createInventoryRetryMutationRepository(
            transaction,
          );
          await retryInventoryPreprocessingService(retryRepository, {
            targetItemId: input.itemId,
          });
          const item = await requireTransactionInventoryItem(
            transaction,
            input.itemId,
          );

          return {
            body: { item },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: { itemId: input.itemId },
      });

      return readIdempotentRouteResult(result);
    },

    async restoreItem(id) {
      const item = await requireInventoryItemLifecycle(repository, id);

      if (!item.archivedAt) {
        return mapInventoryItemLifecycle(item);
      }

      const transitioned = await repository.transitionItemLifecycle(id, {
        archivedAt: null,
        expectedState: "archived",
      });

      if (!transitioned) {
        throw new InventoryItemNotFoundError();
      }

      return mapInventoryItemLifecycle(transitioned);
    },

    async updateItem(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeUpdateInventoryItemRequest(input.request);
          const mutationRepository = createMutationRepository(transaction);
          const update = await updateInventoryItemService(
            mutationRepository,
            {
              acquisitionSource: request.acquisitionSource,
              aliases: request.aliases,
              captureText: request.captureText,
              category: request.category,
              costCents: request.costCents,
              costCurrency: request.costCurrency,
              id: input.itemId,
              importance: request.importance,
              kind: request.kind,
              note: request.note,
              status: request.status,
              tags: request.tags,
              title: request.title,
            },
          );

          return {
            body: {
              item: await mapTransactionInventoryItem(
                transaction,
                update.item,
              ),
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: sanitizeUpdateInventoryItemRequest(input.request),
      });

      return readIdempotentRouteResult(result);
    },

    async updateClothingProfile(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const itemRecord = await transaction.inventoryItem.findFirst({
            include: inventoryItemMutationInclude,
            where: {
              archivedAt: null,
              id: input.itemId,
            },
          });

          if (!itemRecord) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_ITEM_NOT_FOUND",
              "Inventory Item was not found.",
            );
          }

          if (itemRecord.category !== "clothing") {
            throw new InventoryClothingProfileConflictError(
              "Inventory Clothing Profile requires category clothing.",
            );
          }

          if (!itemRecord.clothingProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_CLOTHING_PROFILE_NOT_FOUND",
              "Inventory Clothing Profile was not found.",
            );
          }

          await transaction.inventoryClothingProfile.update({
            data: {
              attributes: input.request.attributes as Prisma.InputJsonValue,
              dirtyQuantity: input.request.isDirty
                ? itemRecord.placements.reduce(
                    (total, placement) => total + placement.quantity,
                    0,
                  )
                : 0,
              isDirty: input.request.isDirty,
              ...(itemRecord.clothingProfile.isDirty !== input.request.isDirty
                ? {
                    wearStateVersion: {
                      increment: 1,
                    },
                  }
                : {}),
            },
            where: {
              itemId: input.itemId,
            },
          });

          const item = await requireTransactionInventoryItem(
            transaction,
            input.itemId,
          );

          if (!item.clothingProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_CLOTHING_PROFILE_NOT_FOUND",
              "Inventory Clothing Profile was not found.",
            );
          }

          return {
            body: {
              clothingProfile: item.clothingProfile,
              item,
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          itemId: input.itemId,
          ...input.request,
        },
      });

      return readIdempotentRouteResult(result);
    },

    async updateEnrichmentSettings(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const enrichmentRepository =
            createInventoryEnrichmentMutationRepository(transaction);
          const settings = await updateInventoryEnrichmentSettingsService(
            enrichmentRepository,
            {
              approvalsRequired: input.request.approvalsRequired,
              now: now(),
            },
          );

          return {
            body: {
              settings: {
                approvalsRequired: settings.approvalsRequired,
                updatedAt: settings.updatedAt.toISOString(),
              },
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: input.request,
      });

      return readIdempotentRouteResult(result);
    },

    async updateRemedyProfile(input) {
      const result = await runCommand({
        clientId: input.clientId,
        execute: async (transaction) => {
          const request = sanitizeUpdateInventoryRemedyProfileRequest(
            input.request,
          );
          const itemRecord = await transaction.inventoryItem.findFirst({
            include: inventoryItemMutationInclude,
            where: {
              archivedAt: null,
              id: input.itemId,
            },
          });

          if (!itemRecord) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_ITEM_NOT_FOUND",
              "Inventory Item was not found.",
            );
          }

          if (itemRecord.category !== "homeopathy") {
            throw new InventoryRemedyProfileConflictError(
              "Inventory Remedy Profile requires category homeopathy.",
            );
          }

          if (!itemRecord.remedyProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
              "Inventory Remedy Profile was not found.",
            );
          }

          const nextPotencies =
            request.potencies ?? itemRecord.remedyProfile.potencies;
          const nextSelectionSummary =
            request.selectionSummary === undefined
              ? itemRecord.remedyProfile.selectionSummary
              : request.selectionSummary;
          const nextExternalReferences =
            request.externalReferences ??
            (itemRecord.remedyProfile.externalReferences as unknown as InventoryRemedyProfile["externalReferences"]);

          await transaction.inventoryRemedyProfile.update({
            data: {
              externalReferences:
                nextExternalReferences as unknown as Prisma.InputJsonValue,
              potencies: nextPotencies,
              selectionSummary: nextSelectionSummary,
            },
            where: { itemId: itemRecord.id },
          });

          await transaction.inventoryItem.update({
            data: {
              searchText: buildInventoryRemedySearchText({
                aliases: itemRecord.aliases,
                externalReferences: nextExternalReferences,
                note: itemRecord.note,
                placements: itemRecord.placements.map((placement) => ({
                  container: placement.container
                    ? mapContainer(
                        placement.container as InventoryContainerWithRelations,
                      )
                    : null,
                  containerId: placement.containerId,
                  createdAt: placement.createdAt,
                  id: placement.id,
                  itemId: placement.itemId,
                  location: placement.location
                    ? mapLocation(placement.location)
                    : null,
                  locationId: placement.locationId,
                  note: placement.note,
                  quantity: placement.quantity,
                  updatedAt: placement.updatedAt,
                })),
                potencies: nextPotencies,
                selectionSummary: nextSelectionSummary,
                title: itemRecord.title ?? "Untitled Inventory Item",
              }),
            },
            where: { id: itemRecord.id },
          });

          const item = await requireTransactionInventoryItem(
            transaction,
            itemRecord.id,
          );

          if (!item.remedyProfile) {
            throw new InventoryItemWriteNotFoundError(
              "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
              "Inventory Remedy Profile was not found.",
            );
          }

          return {
            body: {
              item,
              remedyProfile: item.remedyProfile,
            },
            kind: "success" as const,
            status: 200,
          };
        },
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        request: {
          itemId: input.itemId,
          ...sanitizeUpdateInventoryRemedyProfileRequest(input.request),
        },
      });

      return readIdempotentRouteResult(result);
    },
  };
}

const inventoryItemsRouteHandlers = createInventoryItemsRouteHandlers();

const inventoryItemsRoute = createRoute({
  method: "get",
  operationId: "listInventoryItems",
  path: "/api/v1/inventory-items",
  request: {
    query: inventoryItemCollectionQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            items: [
              {
                archivedAt: null,
                id: "item_123",
                imageId: "image_123",
                placements: [
                  { label: "Travel drawer (BIN-0003)", quantity: 2 },
                ],
                title: "Passport pouch",
                totalQuantity: 2,
              },
            ],
            pageInfo: { nextCursor: null },
            total: 1,
          },
          schema: inventoryItemsResponseSchema,
        },
      },
      description: "Inventory Items in the requested lifecycle view.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_INVENTORY_ITEM_QUERY",
            message:
              "clothingState is only valid when category=clothing.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Item query string is invalid.",
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
  summary: "List Inventory Items",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns a stable page of Inventory Items after lifecycle selection, search ranking, and collection filters. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: archived=true selects Archived Inventory Items, otherwise active Inventory Items are listed; optional filters compose before pagination; nonblank q performs ranked search; the default limit is 24 and limit=all explicitly requests the complete matching collection. Success response: 200 with matching Items, total count, and an opaque next cursor. Failure responses: 400 for invalid filters or cursors, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryItemsExportRoute = createRoute({
  method: "get",
  operationId: "exportInventoryItems",
  path: "/api/v1/inventory-items/export",
  request: {
    query: inventoryItemCollectionQuerySchema.omit({ cursor: true, limit: true }).strict(),
  },
  responses: {
    400: inventoryItemsRoute.responses[400],
    401: inventoryItemsRoute.responses[401],
    403: inventoryItemsRoute.responses[403],
    200: {
      content: {
        "application/json": {
          example: { items: [{ id: "item_123", title: "Passport pouch" }] },
          schema: z.object({
            items: z.array(z.object({ id: z.string(), title: z.string() })),
          }).openapi("InventoryItemsExportResponse"),
        },
      },
      description: "IDs and titles of all matching Inventory Items.",
    },
  },
  security: inventoryItemsRoute.security,
  summary: "Export matching Inventory Item IDs and titles",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Exports IDs and titles for all matching Inventory Items in list order. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: the same lifecycle, search, and collection filters as the list, without pagination. Success response: 200 with matching Item IDs and titles. Failure responses: 400 for invalid filters, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryItemRoute = createRoute({
  method: "get",
  operationId: "getInventoryItem",
  path: "/api/v1/inventory-items/{itemId}",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: "2026-07-26T12:00:00.000Z",
              id: "item_123",
              imageId: "image_123",
              placements: [
                { label: "Travel drawer (BIN-0003)", quantity: 2 },
              ],
              title: "Passport pouch",
              totalQuantity: 2,
            },
          },
          schema: inventoryItemResponseSchema,
        },
      },
      description: "Inventory Item detail, including Archived Items.",
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
            message: "Inventory Item not found.",
          },
          schema: inventoryItemNotFoundErrorSchema,
        },
      },
      description: "The Inventory Item does not exist.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Item",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns one Inventory Item by identifier, including Archived Inventory Items. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId path parameter. Success response: 200 with one Inventory Item. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Inventory Item does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryClothingProfileRoute = createRoute({
  method: "get",
  operationId: "getInventoryClothingProfile",
  path: "/api/v1/inventory-items/{itemId}/clothing-profile",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            clothingProfile: {
              itemId: "item_123",
              isDirty: false,
              attributes: { version: 1, kind: "shirt" },
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T09:00:00.000Z",
            },
          },
          schema: inventoryClothingProfileResponseSchema,
        },
      },
      description: "Inventory Clothing Profile for one Item.",
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
            code: "INVENTORY_CLOTHING_PROFILE_NOT_FOUND",
            message: "Inventory Clothing Profile was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Item or Clothing Profile was not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Clothing Profile",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns the Clothing Profile for one Clothing Item. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId path parameter. Success response: 200 with the Clothing Profile. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Item or Clothing Profile does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const inventoryRemedyProfileRoute = createRoute({
  method: "get",
  operationId: "getInventoryRemedyProfile",
  path: "/api/v1/inventory-items/{itemId}/remedy-profile",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            remedyProfile: {
              itemId: "item_123",
              substanceId: "substance_123",
              potencies: ["30C", "200C"],
              selectionSummary: "Restlessness after midnight.",
              externalReferences: [
                {
                  referenceId: "arn",
                  source: "oorep",
                  url: "https://www.oorep.com/remedy/arn",
                },
              ],
              registeredByClientId: "research-client",
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T09:00:00.000Z",
            },
          },
          schema: inventoryRemedyProfileResponseSchema,
        },
      },
      description: "Inventory Remedy Profile for one Item.",
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
            code: "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
            message: "Inventory Remedy Profile was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Item or Remedy Profile was not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory Remedy Profile",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns the Remedy Profile for one owned remedy Item. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: itemId path parameter. Success response: 200 with the Remedy Profile. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing, 404 when the Item or Remedy Profile does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const remedyIntakesRoute = createRoute({
  method: "get",
  operationId: "listRemedyIntakes",
  path: "/api/v1/remedy-intakes",
  request: {
    query: remedyIntakesQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            intakes: [
              {
                bucketDate: "2026-08-03",
                colorKey: "remedy-3",
                id: "intake_123",
                note: "Before bed.",
                occurredAt: "2026-08-03T22:15:00.000Z",
                potency: "200C",
                itemArchivedAt: null,
                itemId: "item_123",
                itemTitle: "Arsenicum album",
              },
            ],
            pageInfo: { nextCursor: null },
            range: "30d",
          },
          schema: remedyIntakesResponseSchema,
        },
      },
      description: "Recorded Remedy Intakes.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message: "Request input is invalid.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "Range, time zone, Item filter, or cursor is invalid.",
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
      description:
        "The authenticated Client is missing Health Read or Inventory Read.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "List Remedy Intakes",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["health:read", "inventory:read"],
  description:
    "Returns recorded Remedy Intakes. Authentication: X-API-Key or trusted Owner ingress. Required permissions: health:read, inventory:read. Inputs: required range and IANA timeZone, optional itemId, and an all-time cursor. Success response: 200 with owner-local bucket dates and Remedy Intakes ordered newest first; all-time results use stable cursor pagination. Failure responses: 400 for invalid query input, 401 when no valid Owner ingress proof or API Key is present, 403 when Health Read or Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const remedyIntakeSummaryRoute = createRoute({
  method: "get",
  operationId: "summarizeRemedyIntakes",
  path: "/api/v1/remedy-intakes/summary",
  request: {
    query: remedyIntakeRangeQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            range: "30d",
            remedies: [
              {
                archivedAt: null,
                colorKey: "remedy-3",
                firstIntakeAt: "2026-08-01T20:00:00.000Z",
                lastIntakeAt: "2026-08-03T22:15:00.000Z",
                potencyTotals: [
                  { potency: "30C", total: 1 },
                  { potency: "200C", total: 2 },
                ],
                itemId: "item_123",
                itemTitle: "Arsenicum album",
                total: 3,
              },
            ],
            totalIntakes: 3,
          },
          schema: remedyIntakeSummaryResponseSchema,
        },
      },
      description: "Derived Remedy Intake totals for the selected range.",
    },
    400: {
      content: {
        "application/json": {
          example: {
            code: "INVALID_REQUEST",
            message: "Request input is invalid.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "Range, time zone, or Item filter is invalid.",
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
      description:
        "The authenticated Client is missing Health Read or Inventory Read.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Summarize Remedy Intakes",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["health:read", "inventory:read"],
  description:
    "Returns per-Remedy and per-potency totals derived for a required owner-local range and IANA time zone. Authentication: X-API-Key or trusted Owner ingress. Required permissions: health:read, inventory:read. Inputs: required range and timeZone plus optional itemId. Success response: 200 with total Intakes and per-Remedy totals. Failure responses: 400/401/403. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const createRemedyIntakeRoute = createRoute({
  method: "post",
  operationId: "createRemedyIntake",
  path: "/api/v1/remedy-intakes",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            note: "Before bed.",
            occurredAt: "2026-08-03T22:15:00.000Z",
            potency: "200C",
            itemId: "item_123",
          },
          schema: createRemedyIntakeRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            intake: {
              id: "intake_123",
              note: "Before bed.",
              occurredAt: "2026-08-03T22:15:00.000Z",
              potency: "200C",
              itemArchivedAt: null,
              itemId: "item_123",
              itemTitle: "Arsenicum album",
            },
          },
          schema: createRemedyIntakeResponseSchema,
        },
      },
      description: "Created Remedy Intake.",
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
      description:
        "The authenticated Client is missing Health Write or Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
            message: "Inventory Remedy Profile was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Item or Remedy Profile was not found.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "REMEDY_INTAKE_CONFLICT",
            message: "Remedy Intake requires an active owned remedy.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The Remedy state or potency conflicts, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Create Remedy Intake",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["health:write", "inventory:read"],
  description:
    "Creates one Remedy Intake against an owned remedy's linked HOMEOPATHY Substance. Authentication: X-API-Key or trusted Owner ingress. Required permissions: health:write, inventory:read. Inputs: JSON body with itemId, owned potency, optional occurredAt, optional note, and Idempotency-Key header. Success response: 201 with the created Remedy Intake. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Health Write or Inventory Read is missing, 404 when the Item or Remedy Profile does not exist, and 409 when the remedy is inactive, potency is not owned, or the key is reused with different input. Side effects: creates one Substance Intake and never changes Inventory quantity. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const deleteRemedyIntakeRoute = createRoute({
  method: "delete",
  operationId: "deleteRemedyIntake",
  path: "/api/v1/remedy-intakes/{intakeId}",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: remedyIntakePathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            deletedIntakeId: "intake_123",
          },
          schema: deleteRemedyIntakeResponseSchema,
        },
      },
      description: "Deleted Remedy Intake identifier.",
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
      description: "The Idempotency-Key is invalid.",
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
      description:
        "The authenticated Client is missing Health Delete or Inventory Read.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_REMEDY_INTAKE_NOT_FOUND",
            message: "Remedy Intake was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Remedy Intake was not found.",
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
  summary: "Delete Remedy Intake",
  tags: ["Inventory"],
  "x-destructive": true,
  "x-required-permissions": ["health:delete", "inventory:read"],
  description:
    "Deletes one recorded Remedy Intake. Authentication: X-API-Key or trusted Owner ingress. Required permissions: health:delete, inventory:read. Inputs: intakeId path parameter and Idempotency-Key header. Success response: 200 with the deleted Remedy Intake identifier. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Health Delete or Inventory Read is missing, 404 when the Remedy Intake does not exist, and 409 when the key is reused with different input. Side effects: deletes one Substance Intake and never changes Inventory quantity. Destructive: yes. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

const registerInventoryRemedyRoute = createRoute({
  method: "post",
  operationId: "registerInventoryRemedy",
  path: "/api/v1/inventory-remedies",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            title: "Arsenicum album",
            potencies: ["30C", "200C"],
            quantity: 2,
            locationId: "location_123",
            selectionSummary: "Restlessness after midnight.",
            externalReferences: [
              {
                referenceId: "arn",
                source: "oorep",
                url: "https://www.oorep.com/remedy/arn",
              },
            ],
          },
          schema: registerInventoryRemedyRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
  },
  responses: {
    201: {
      content: {
        "application/json": {
          example: {
            item: {
              id: "item_123",
              category: "homeopathy",
              title: "Arsenicum album",
              totalQuantity: 2,
            },
            remedyProfile: {
              itemId: "item_123",
              substanceId: "substance_123",
              potencies: ["30C", "200C"],
              selectionSummary: "Restlessness after midnight.",
              externalReferences: [
                {
                  referenceId: "arn",
                  source: "oorep",
                  url: "https://www.oorep.com/remedy/arn",
                },
              ],
              registeredByClientId: "research-client",
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T09:00:00.000Z",
            },
          },
          schema: registerInventoryRemedyResponseSchema,
        },
      },
      description: "Created Inventory Item and linked Remedy Profile.",
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
            code: "INVENTORY_LOCATION_NOT_FOUND",
            message: "Inventory Location was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The referenced placement target was not found.",
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
  summary: "Register owned Remedy",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Registers one owned remedy in a single atomic command. Search category=homeopathy first: Quantself keeps one Inventory Item per remedy, with all owned potencies on one Remedy Profile. Add a potency to an existing remedy through Remedy Profile GET/merge/PUT instead of registering a duplicate Item. Potencies are trimmed, uppercased, deduplicated, and sorted; Item quantity is aggregate stock and is not tracked per potency. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with required title and non-empty potencies; optional aliases, local selectionSummary, externalReferences, quantity, note, placementNote, and at most one containerId or locationId, plus Idempotency-Key header. Success response: 201 with the created Inventory Item and linked Remedy Profile. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when a referenced placement target does not exist, and 409 when the key is reused with different input. Side effects: atomically creates the Item, Placement, hidden HOMEOPATHY Substance, and Remedy Profile without preprocessing or enrichment. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const updateInventoryItemRoute = createRoute({
  method: "put",
  operationId: "updateInventoryItem",
  path: "/api/v1/inventory-items/{itemId}",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            aliases: ["passport pouch", "travel pouch"],
            category: "documents",
            costCents: 1995,
            costCurrency: "CAD",
            note: "Keep together",
            tags: ["travel", "documents"],
            title: "Travel pouch",
          },
          schema: updateInventoryItemRequestSchema,
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
            item: {
              archivedAt: null,
              id: "item_123",
              imageId: "image_123",
              placements: [
                { label: "Travel drawer (BIN-0003)", quantity: 2 },
              ],
              title: "Travel pouch",
              totalQuantity: 2,
            },
          },
          schema: inventoryItemResponseSchema,
        },
      },
      description: "Updated Inventory Item facts.",
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
            code: "INVENTORY_ITEM_NOT_FOUND",
            message: "Inventory Item was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Item does not exist or is archived.",
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
  summary: "Update Inventory Item facts",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Updates supported shared Inventory Item facts while preserving canonical validation and manual-field protections. Quantity and Placement changes use the dedicated unit operations; Clothing and Remedy facts use their Profile operations. Setting category=clothing creates a default Clothing Profile when absent. Do not create a remedy by setting category=homeopathy; use POST /api/v1/inventory-remedies. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON body with supported Item fact fields, and Idempotency-Key header. Success response: 200 with the updated Inventory Item summary. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item does not exist, 409 when the key is reused with different input. Side effects: updates Item facts, manual-field locks, search text, creates a default Clothing Profile when category becomes clothing, and queues preprocessing refresh work. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const updateInventoryClothingProfileRoute = createRoute({
  method: "put",
  operationId: "updateInventoryClothingProfile",
  path: "/api/v1/inventory-items/{itemId}/clothing-profile",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            isDirty: true,
            attributes: {
              version: 1,
              colors: ["blue", "white"],
              kind: "shirt",
              occasionTags: ["office"],
            },
          },
          schema: updateInventoryClothingProfileRequestSchema,
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
            clothingProfile: {
              itemId: "item_123",
              isDirty: true,
              attributes: {
                version: 1,
                colors: ["blue", "white"],
                kind: "shirt",
                occasionTags: ["office"],
              },
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T10:00:00.000Z",
            },
            item: {
              acquisitionSource: null,
              aliases: [],
              archivedAt: null,
              captureText: null,
              capturedAt: "2026-08-03T09:00:00.000Z",
              category: "clothing",
              clothingProfile: {
                itemId: "item_123",
                isDirty: true,
                attributes: {
                  version: 1,
                  colors: ["blue", "white"],
                  kind: "shirt",
                  occasionTags: ["office"],
                },
                createdAt: "2026-08-03T09:00:00.000Z",
                updatedAt: "2026-08-03T10:00:00.000Z",
              },
              containerId: null,
              containerLabel: null,
              costCents: null,
              costCurrency: "CAD",
              id: "item_123",
              importance: "MEDIUM",
              imageId: null,
              kind: "ITEM",
              note: null,
              placementSummary: "Unplaced",
              placements: [],
              processing: {
                currentStep: "Wait for background processing",
                evidence: [],
                history: [],
                nextAction: "Wait for background processing",
                preprocessing: {
                  attempts: 0,
                  failedAt: null,
                  failedSteps: [],
                  failureMessage: null,
                  maxAttempts: 3,
                  mediaTexts: [],
                  status: "CAPTURED",
                  summary: "Saved evidence is waiting for preprocessing pickup.",
                  textBundleAvailable: false,
                  retryable: false,
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                enrichment: {
                  attempts: 0,
                  failedAt: null,
                  failureMessage: null,
                  maxAttempts: 3,
                  rationale: "Inventory Enrichment has not started.",
                  retryable: false,
                  status: "NOT_STARTED",
                  summary: "Inventory Enrichment has not started.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                proposal: {
                  status: "NONE",
                  summary: "No pending Inventory Proposal.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                sourceLabel: "Inventory capture",
              },
              status: "KEEP",
              tags: [],
              title: "Blue oxford shirt",
              totalQuantity: 1,
              where: "Unplaced",
            },
          },
          schema: updateInventoryClothingProfileResponseSchema,
        },
      },
      description: "Updated Inventory Clothing Profile and Item summary.",
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
            code: "INVENTORY_CLOTHING_PROFILE_NOT_FOUND",
            message: "Inventory Clothing Profile was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Item or Clothing Profile was not found.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "PROFILE_CATEGORY_CONFLICT",
            message: "Inventory Clothing Profile requires category clothing.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Clothing Profile conflicts with Item category or idempotency input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Update Inventory Clothing Profile",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Replaces one complete Clothing Profile and returns the updated Item summary. GET and merge the current Profile before PUT so known fields are not lost. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, Idempotency-Key header, required isDirty, and complete attributes containing required version=1 plus every known kind, colors, layer, warmth, formality, weather, occasionTags, material, fitNotes, and decisionNotes value. Success response: 200 with the Clothing Profile and Item summary. Failure responses: 400 when the body or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item or Clothing Profile does not exist, 409 when category agreement or idempotency input conflicts. Side effects: replaces Clothing Profile attributes and explicit clean or dirty state. Destructive: no. Retry safety: replay-safe with the same Idempotency-Key and normalized body.",
});

const markInventoryClothingItemWornRoute = createRoute({
  method: "post",
  operationId: "markInventoryClothingItemWorn",
  path: "/api/v1/inventory-items/{itemId}/worn",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: null,
              category: "clothing",
              clothingProfile: {
                attributes: {
                  kind: "shirt",
                  version: 1,
                },
                createdAt: "2026-08-03T09:00:00.000Z",
                isDirty: true,
                itemId: "item_123",
                updatedAt: "2026-08-03T10:30:00.000Z",
              },
              id: "item_123",
            },
            wearConfirmation: {
              createdAt: "2026-08-03T10:30:00.000Z",
              id: "wear_123",
              itemIds: ["item_123"],
              undoneAt: null,
            },
          },
          schema: markInventoryClothingItemWornResponseSchema,
        },
      },
      description: "Recorded one Clothing Item as worn.",
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
            code: "INVENTORY_ITEM_NOT_FOUND",
            message: "Inventory Item was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Item does not exist or is archived.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_CONFLICT",
            message: "Clothing Item is already dirty.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The Item is not a clean Clothing Item, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Mark one Clothing Item worn",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Marks one active clean Clothing Item worn and creates one auditable Wear Confirmation. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter plus Idempotency-Key header. Success response: 200 with the updated Item and Wear Confirmation. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item does not exist, 409 when the Item is incompatible or the key is reused with different input. Side effects: marks the Clothing Profile dirty and persists one Wear Confirmation. Destructive: no. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

const undoInventoryClothingWearConfirmationRoute = createRoute({
  method: "post",
  operationId: "undoInventoryClothingWearConfirmation",
  path: "/api/v1/inventory-clothing/wear-confirmations/{confirmationId}/undo",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryClothingWearConfirmationPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            items: [
              {
                archivedAt: null,
                category: "clothing",
                clothingProfile: {
                  attributes: {
                    kind: "shirt",
                    version: 1,
                  },
                  createdAt: "2026-08-03T09:00:00.000Z",
                  isDirty: false,
                  itemId: "item_123",
                  updatedAt: "2026-08-03T10:35:00.000Z",
                },
                id: "item_123",
              },
            ],
            wearConfirmation: {
              createdAt: "2026-08-03T10:30:00.000Z",
              id: "wear_123",
              itemIds: ["item_123"],
              undoneAt: "2026-08-03T10:35:00.000Z",
            },
          },
          schema: undoInventoryClothingWearConfirmationResponseSchema,
        },
      },
      description: "Safely undid one Clothing Wear Confirmation.",
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
            code: "INVENTORY_CLOTHING_WEAR_CONFIRMATION_NOT_FOUND",
            message: "Inventory Clothing Wear Confirmation was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Wear Confirmation does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_CONFLICT",
            message: "Clothing Wear Confirmation can no longer be safely undone.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The confirmation was already undone, became ambiguous after later wear or laundry, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Undo one Clothing Wear Confirmation",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Safely undoes one Clothing Wear Confirmation when no later wear or laundry transition makes reversal ambiguous. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: confirmationId path parameter plus Idempotency-Key header. Success response: 200 with the updated Wear Confirmation and affected Items. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Wear Confirmation does not exist, 409 when reversal is unsafe or the key is reused with different input. Side effects: marks exactly the affected Clothing Profiles clean and records the undo time. Destructive: no. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

const completeInventoryClothingLaundryRoute = createRoute({
  method: "post",
  operationId: "completeInventoryClothingLaundry",
  path: "/api/v1/inventory-clothing/laundry-completed",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            mode: "selected",
            itemIds: ["item_123", "item_456"],
          },
          schema: completeInventoryClothingLaundryRequestSchema,
        },
      },
    },
    headers: idempotencyKeyHeadersSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            cleanedCount: 2,
            items: [
              {
                archivedAt: null,
                category: "clothing",
                clothingProfile: {
                  attributes: {
                    kind: "shirt",
                    version: 1,
                  },
                  createdAt: "2026-08-03T09:00:00.000Z",
                  isDirty: false,
                  itemId: "item_123",
                  updatedAt: "2026-08-03T10:45:00.000Z",
                },
                id: "item_123",
              },
            ],
          },
          schema: completeInventoryClothingLaundryResponseSchema,
        },
      },
      description: "Completed Clothing laundry for the requested scope.",
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
        "The command is missing an Idempotency-Key or the laundry body is invalid.",
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
            code: "INVENTORY_ITEM_NOT_FOUND",
            message: "Inventory Item was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "A selected Inventory Item does not exist or is archived.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_CLOTHING_CONFLICT",
            message: "Laundry supports Clothing Items only.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "A selected Item is not Clothing, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Complete Clothing laundry",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Marks selected Clothing Items or all currently dirty Clothing Items clean in one atomic command. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: discriminated JSON body plus Idempotency-Key header. Success response: 200 with cleanedCount and the affected Items. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when a selected Item does not exist, 409 when a selected Item is incompatible or the key is reused with different input. Side effects: marks only the requested Clothing Profiles clean. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const updateInventoryRemedyProfileRoute = createRoute({
  method: "put",
  operationId: "updateInventoryRemedyProfile",
  path: "/api/v1/inventory-items/{itemId}/remedy-profile",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            potencies: ["30C", "200C"],
            selectionSummary: "Restlessness after midnight.",
            externalReferences: [
              {
                referenceId: "arn",
                source: "oorep",
                url: "https://www.oorep.com/remedy/arn",
              },
            ],
          },
          schema: updateInventoryRemedyProfileRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            remedyProfile: {
              itemId: "item_123",
              substanceId: "substance_123",
              potencies: ["30C", "200C"],
              selectionSummary: "Restlessness after midnight.",
              externalReferences: [
                {
                  referenceId: "arn",
                  source: "oorep",
                  url: "https://www.oorep.com/remedy/arn",
                },
              ],
              registeredByClientId: "research-client",
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T10:00:00.000Z",
            },
            item: {
              id: "item_123",
              category: "homeopathy",
              title: "Arsenicum album",
              totalQuantity: 2,
            },
          },
          schema: updateInventoryRemedyProfileResponseSchema,
        },
      },
      description: "Updated Inventory Remedy Profile and Item summary.",
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
            code: "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
            message: "Inventory Remedy Profile was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Item or Remedy Profile was not found.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "PROFILE_CATEGORY_CONFLICT",
            message: "Inventory Remedy Profile requires category homeopathy.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Remedy Profile conflicts with Item category or idempotency input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Update Inventory Remedy Profile",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Updates one Remedy Profile while preserving the shared Inventory Item detail contract. Potencies, when supplied, replace the complete owned set: GET the current Profile, merge additions, and PUT the full set. Values are trimmed, uppercased, deduplicated, and sorted. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON body with at least one of non-empty potencies, selectionSummary, or externalReferences, and Idempotency-Key header. Success response: 200 with the updated Remedy Profile and Item summary. Failure responses: 400 when the request body or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Item or Remedy Profile does not exist, and 409 when the Profile conflicts with Item category or the Idempotency-Key is reused with different input. Side effects: updates the Remedy Profile and shared Item search text; never changes Item quantity. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const addInventoryItemUnitsRoute = createRoute({
  method: "post",
  operationId: "addInventoryItemUnits",
  path: "/api/v1/inventory-items/{itemId}/add-units",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            locationId: "location_123",
            quantity: 2,
          },
          schema: addInventoryUnitsRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: null,
              id: "item_123",
              imageId: "image_123",
              placements: [
                {
                  containerId: null,
                  label: "Hall closet",
                  locationId: "location_123",
                  locationName: "Hall closet",
                  note: null,
                  placementId: "placement_123",
                  quantity: 4,
                },
              ],
              title: "Travel pouch",
              totalQuantity: 4,
            },
          },
          schema: inventoryItemResponseSchema,
        },
      },
      description: "Inventory Item after units were added.",
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
            message: "Container was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The Inventory Item, Container, or Inventory Location does not exist.",
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
  summary: "Add units to an Inventory Item",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Adds units to an existing Inventory Item and updates Placements atomically. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON body with quantity and mutually exclusive Container or Inventory Location target fields; omitting both targets means unplaced stock. Success response: 200 with the updated Inventory Item summary. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item, Container, or Inventory Location does not exist, 409 when the key is reused with different input. Side effects: creates or increments one Placement, updates Item search text, and preserves transactional placement state. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const moveInventoryItemUnitsRoute = createRoute({
  method: "post",
  operationId: "moveInventoryItemUnits",
  path: "/api/v1/inventory-items/{itemId}/move-units",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            destinationLocationId: "location-wardrobe",
            quantity: 1,
            sourceContainerId: "container-bin",
          },
          schema: moveInventoryUnitsRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    ...addInventoryItemUnitsRoute.responses,
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: null,
              id: "item_123",
              imageId: "image_123",
              placements: [
                {
                  label: "Travel drawer (BIN-0003)",
                  quantity: 2,
                },
              ],
              title: "Travel pouch",
              totalQuantity: 2,
            },
          },
          schema: inventoryItemResponseSchema,
        },
      },
      description: "Inventory Item after units were moved.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_PLACEMENT_CONFLICT",
            message: "Move quantity exceeds available units.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The source Placement has insufficient quantity, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Move Inventory Item units",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Moves units between two Inventory Placements for one Inventory Item in one atomic command. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON body with mutually exclusive Container or Inventory Location fields for each side; omitting both fields on a side means unplaced stock. Success response: 200 with the updated Inventory Item summary. Failure responses: 400 when the request, quantity, targets, or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item, Container, or Inventory Location does not exist, 409 for insufficient source quantity or an Idempotency-Key conflict. Side effects: decrements the source Placement, increments or creates the destination Placement, removes empty source Placements, and preserves transactional placement state. Destructive: no. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const removeInventoryItemUnitsRoute = createRoute({
  method: "post",
  operationId: "removeInventoryItemUnits",
  path: "/api/v1/inventory-items/{itemId}/remove-units",
  request: {
    body: {
      content: {
        "application/json": {
          example: {
            locationId: "location-wardrobe",
            quantity: 1,
          },
          schema: removeInventoryUnitsRequestSchema,
        },
      },
      required: true,
    },
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    ...addInventoryItemUnitsRoute.responses,
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: "2026-07-29T12:00:00.000Z",
              id: "item_123",
              imageId: "image_123",
              placements: [],
              title: "Travel pouch",
              totalQuantity: 0,
            },
          },
          schema: inventoryItemResponseSchema,
        },
      },
      description: "Inventory Item after units were removed.",
    },
    404: {
      ...addInventoryItemUnitsRoute.responses[404],
      description:
        "The Inventory Item, Container, or Inventory Location does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_PLACEMENT_CONFLICT",
            message: "Remove quantity exceeds available units.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The Placement has insufficient quantity, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Remove Inventory Item units",
  tags: ["Inventory"],
  "x-destructive": true,
  "x-required-permissions": ["inventory:write"],
  description:
    "Removes units from one Inventory Placement for an Inventory Item in one atomic command. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter, JSON body with quantity and mutually exclusive Container or Inventory Location target fields; omitting both targets means unplaced stock. Success response: 200 with the updated Inventory Item summary. Failure responses: 400 when the request, quantity, targets, or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item, Container, or Inventory Location does not exist, 409 for insufficient quantity or an Idempotency-Key conflict. Side effects: decrements or removes the targeted Placement and automatically Archives the Inventory Item when total quantity reaches zero inside the same transaction. Destructive: yes. Retry safety: same Idempotency-Key plus identical normalized input replays the original result.",
});

const retryInventoryPreprocessingRoute = createRoute({
  method: "post",
  operationId: "retryInventoryPreprocessing",
  path: "/api/v1/inventory-items/{itemId}/retry-preprocessing",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      ...addInventoryItemUnitsRoute.responses[200],
      description: "Inventory Item with fresh preprocessing queued.",
    },
    400: {
      ...addInventoryItemUnitsRoute.responses[400],
      description: "The command has an invalid Idempotency-Key.",
    },
    401: addInventoryItemUnitsRoute.responses[401],
    403: addInventoryItemUnitsRoute.responses[403],
    404: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_ITEM_NOT_FOUND",
            message: "Inventory Item was not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Item does not exist.",
    },
    409: {
      ...addInventoryItemUnitsRoute.responses[409],
      description:
        "The key conflicts, equivalent work is active, or the latest failure is not retryable.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Retry Inventory preprocessing",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Queues a fresh preprocessing job from the Item's current saved evidence when its latest failure is retryable. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter and Idempotency-Key header. Success response: 200 with the Item and queued processing state. Failure responses: 400 for invalid input, 401 or 403 for access failure, 404 when the Item is missing, and 409 when the failure is not retryable or equivalent work is active. Side effects: creates one preprocessing job. Destructive: no. Retry safety: same Idempotency-Key and Item replay the original result.",
});

const retryInventoryEnrichmentRoute = createRoute({
  method: "post",
  operationId: "retryInventoryEnrichment",
  path: "/api/v1/inventory-items/{itemId}/retry-enrichment",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryItemPathParamsSchema,
  },
  responses: retryInventoryPreprocessingRoute.responses,
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Retry Inventory enrichment",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Queues a fresh item-enrichment job from current Item facts and the latest available Inventory Text Bundle when enrichment never started or its latest failure is retryable. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter and Idempotency-Key header. Success response: 200 with the Item and queued processing state. Failure responses: 400 for invalid input, 401 or 403 for access failure, 404 when the Item is missing, and 409 when the failure is not retryable or equivalent work is active. Side effects: creates one item-enrichment job. Destructive: no. Retry safety: same Idempotency-Key and Item replay the original result.",
});

const inventoryEnrichmentSettingsRoute = createRoute({
  method: "get",
  operationId: "getInventoryEnrichmentSettings",
  path: "/api/v1/inventory-enrichment-settings",
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            settings: {
              approvalsRequired: true,
              updatedAt: "2026-07-28T12:05:00.000Z",
            },
          },
          schema: inventoryEnrichmentSettingsResponseSchema,
        },
      },
      description: "Current Inventory enrichment approval preference.",
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
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get Inventory enrichment settings",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns the current Inventory enrichment approval preference. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: none. Success response: 200 with the current approvalsRequired value. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: initializes the default approval preference when no settings row exists. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const updateInventoryEnrichmentSettingsRoute = createRoute({
  method: "put",
  operationId: "updateInventoryEnrichmentSettings",
  path: "/api/v1/inventory-enrichment-settings",
  request: {
    body: {
      content: {
        "application/json": {
          example: { approvalsRequired: true },
          schema: updateInventoryEnrichmentSettingsRequestSchema,
        },
      },
    },
    headers: idempotencyKeyHeadersSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            settings: {
              approvalsRequired: true,
              updatedAt: "2026-07-28T12:05:00.000Z",
            },
          },
          schema: inventoryEnrichmentSettingsResponseSchema,
        },
      },
      description: "Saved Inventory enrichment approval preference.",
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
      description: "The command is missing an Idempotency-Key or its body is invalid.",
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
      description: "The Idempotency-Key was already used with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Update Inventory enrichment settings",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Updates the Inventory enrichment approval preference. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: JSON body with approvalsRequired plus Idempotency-Key header. Success response: 200 with the saved settings. Failure responses: 400 when the request or Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 409 when the key is reused with different input. Side effects: updates the approval preference and auto-applies pending proposals when approvals are disabled. Destructive: no. Retry safety: same Idempotency-Key plus identical input replays the original result.",
});

const inventoryProposalsRoute = createRoute({
  method: "get",
  operationId: "listInventoryProposals",
  path: "/api/v1/inventory-proposals",
  request: {
    query: inventoryProposalQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            proposals: [
              {
                captureText: "Passport, charger, and travel adapters in black pouch.",
                capturedAt: "2026-07-13T11:00:00.000Z",
                confidence: 0.94,
                diff: [
                  {
                    current: "Black pouch",
                    field: "title",
                    label: "Title",
                    proposed: "Passport and charger pouch",
                  },
                ],
                failedSteps: [],
                id: "job_123",
                ocrEvidence: [
                  {
                    id: "image_123",
                    preview: "PASSPORT USB-C CHARGER",
                    secondary: "2 OCR lines",
                  },
                ],
                itemId: "item_123",
                itemTitle: "Black pouch",
                rationale: "OCR and transcript mention passport and charger.",
                sourceRefsSummary: "1 item, 1 image, 1 audio, 0 file",
                transcriptEvidence: [],
                updatedAt: "2026-07-13T12:00:30.000Z",
              },
            ],
          },
          schema: inventoryProposalsResponseSchema,
        },
      },
      description: "Pending Inventory Proposals waiting for approval.",
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
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "List Inventory Proposals",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns pending Inventory Proposals with review-ready diff and evidence summaries. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:read. Inputs: optional itemId filter and limit query parameters. Success response: 200 with pending proposals. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Read is missing. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const approveInventoryProposalRoute = createRoute({
  method: "post",
  operationId: "approveInventoryProposal",
  path: "/api/v1/inventory-proposals/{proposalId}/approve",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryProposalPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            proposal: {
              decidedAt: "2026-07-28T12:05:00.000Z",
              id: "job_123",
              itemId: "item_123",
              status: "APPLIED",
            },
          },
          schema: inventoryProposalDecisionResponseSchema,
        },
      },
      description: "Approved Inventory Proposal.",
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
      description: "The authenticated Client is missing Inventory Write.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Inventory Proposal not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Proposal does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_PROPOSAL_CONFLICT",
            message: "Inventory enrichment job is not pending approval.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The proposal is no longer approvable, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Approve Inventory Proposal",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Approves one pending Inventory Proposal while preserving manual-field and source-fact protections. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: proposalId path parameter plus Idempotency-Key header. Success response: 200 with the applied proposal decision. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the proposal does not exist, 409 when the proposal state conflicts or the key is reused with different input. Side effects: applies derived values transactionally and marks the proposal decided. Destructive: no. Retry safety: same Idempotency-Key plus identical proposal replays the original result.",
});

const rejectInventoryProposalRoute = createRoute({
  method: "post",
  operationId: "rejectInventoryProposal",
  path: "/api/v1/inventory-proposals/{proposalId}/reject",
  request: {
    headers: idempotencyKeyHeadersSchema,
    params: inventoryProposalPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            proposal: {
              decidedAt: "2026-07-28T12:05:00.000Z",
              id: "job_123",
              itemId: "item_123",
              status: "REJECTED",
            },
          },
          schema: inventoryProposalDecisionResponseSchema,
        },
      },
      description: "Rejected Inventory Proposal.",
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
      description: "The authenticated Client is missing Inventory Write.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Inventory Proposal not found.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "The Inventory Proposal does not exist.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "INVENTORY_PROPOSAL_CONFLICT",
            message: "Inventory enrichment job is not pending approval.",
          },
          schema: apiErrorSchema,
        },
      },
      description:
        "The proposal is no longer rejectable, or the Idempotency-Key was reused with different input.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Reject Inventory Proposal",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Rejects one pending Inventory Proposal. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: proposalId path parameter plus Idempotency-Key header. Success response: 200 with the rejected proposal decision. Failure responses: 400 when the Idempotency-Key is invalid, 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the proposal does not exist, 409 when the proposal state conflicts or the key is reused with different input. Side effects: marks the proposal decided without applying derived values. Destructive: no. Retry safety: same Idempotency-Key plus identical proposal replays the original result.",
});

const archiveInventoryItemRoute = createRoute({
  method: "post",
  operationId: "archiveInventoryItem",
  path: "/api/v1/inventory-items/{itemId}/archive",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: "2026-07-28T12:00:00.000Z",
              id: "item_123",
            },
          },
          schema: inventoryItemLifecycleResponseSchema,
        },
      },
      description: "Archived Inventory Item.",
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
            message: "Inventory Item not found.",
          },
          schema: inventoryItemNotFoundErrorSchema,
        },
      },
      description: "Inventory Item not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Archive one Inventory Item",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Archives one Inventory Item by identifier. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter. Success response: 200 with the archived Inventory Item lifecycle state. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item does not exist. Side effects: sets archived visibility state, removes the Item from active collections, and deactivates a linked remedy Substance without changing or deleting Intake history. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const restoreInventoryItemRoute = createRoute({
  method: "post",
  operationId: "restoreInventoryItem",
  path: "/api/v1/inventory-items/{itemId}/restore",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            item: {
              archivedAt: null,
              id: "item_123",
            },
          },
          schema: inventoryItemLifecycleResponseSchema,
        },
      },
      description: "Restored Inventory Item.",
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
            message: "Inventory Item not found.",
          },
          schema: inventoryItemNotFoundErrorSchema,
        },
      },
      description: "Inventory Item not found.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Restore one Inventory Item",
  tags: ["Inventory"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:write"],
  description:
    "Restores one archived Inventory Item by identifier. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:write. Inputs: itemId path parameter. Success response: 200 with the restored Inventory Item lifecycle state. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Write is missing, 404 when the Inventory Item does not exist. Side effects: returns the Item to active collections and container views and reactivates a linked remedy Substance. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

const deleteInventoryItemRoute = createRoute({
  method: "delete",
  operationId: "deleteInventoryItem",
  path: "/api/v1/inventory-items/{itemId}",
  request: {
    params: inventoryItemPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            deletedItemId: "item_123",
          },
          schema: inventoryItemDeleteResponseSchema,
        },
      },
      description: "Permanently deleted Inventory Item.",
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
      description: "The authenticated Client is missing Inventory Delete.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Inventory Item not found.",
          },
          schema: inventoryItemNotFoundErrorSchema,
        },
      },
      description: "Inventory Item not found.",
    },
    409: {
      content: {
        "application/json": {
          example: {
            code: "REMEDY_HAS_INTAKE_HISTORY",
            message: "Remedy Intake history blocks permanent deletion.",
          },
          schema: apiErrorSchema,
        },
      },
      description: "Historical Remedy Intake data blocks permanent deletion.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Permanently delete one Inventory Item",
  tags: ["Inventory"],
  "x-destructive": true,
  "x-required-permissions": ["inventory:delete"],
  description:
    "Permanently deletes one active or archived Inventory Item by identifier. Authentication: X-API-Key or trusted Owner ingress. Required permissions: inventory:delete. Inputs: itemId path parameter. Success response: 200 with the deleted Inventory Item identifier. Failure responses: 401 when no valid Owner ingress proof or API Key is present, 403 when Inventory Delete is missing, 404 when the Inventory Item does not exist, and 409 when Remedy Intake history blocks permanent deletion. Side effects: removes the Item row, cascaded related records, linked remedy Substance when eligible, and attached stored files. Destructive: yes. Retry safety: use only after explicit user intent; a repeated delete after success may return 404 because the Item no longer exists.",
});

function inventoryItemNotFoundResponse(context: Context) {
  return context.json(
    {
      code: "NOT_FOUND" as const,
      message: "Inventory Item not found.",
    },
    404,
  );
}

function inventoryItemWriteNotFoundResponse(
  context: Context,
  error: InventoryItemWriteNotFoundError,
) {
  return jsonApiError(context, {
    code: error.code,
    message: error.message,
    status: 404,
  });
}

function inventoryItemWriteBadRequestResponse(
  context: Context,
  message: string,
) {
  return jsonApiError(context, {
    code: "INVALID_REQUEST",
    message,
    status: 400,
  });
}

function inventoryPlacementConflictResponse(
  context: Context,
  message: string,
) {
  return jsonApiError(context, {
    code: "INVENTORY_PLACEMENT_CONFLICT",
    message,
    status: 409,
  });
}

function inventoryClothingConflictResponse(
  context: Context,
  message: string,
) {
  return jsonApiError(context, {
    code: "INVENTORY_CLOTHING_CONFLICT",
    message,
    status: 409,
  });
}

function inventoryProfileCategoryConflictResponse(
  context: Context,
  message: string,
) {
  return jsonApiError(context, {
    code: "PROFILE_CATEGORY_CONFLICT",
    message,
    status: 409,
  });
}

function inventoryProcessingRetryErrorResponse(
  context: Context,
  error: unknown,
) {
  if (error instanceof IdempotencyConflictError) {
    return jsonApiError(context, {
      code: "IDEMPOTENCY_CONFLICT",
      message: error.message,
      status: 409,
    });
  }

  if (
    error instanceof InventoryItemNotFoundError ||
    (error instanceof Error && error.message === "Inventory item not found.")
  ) {
    return jsonApiError(context, {
      code: "INVENTORY_ITEM_NOT_FOUND",
      message: "Inventory Item was not found.",
      status: 404,
    });
  }

  if (
    error instanceof InventoryPreprocessingRetryConflictError ||
    error instanceof InventoryEnrichmentRetryConflictError
  ) {
    return jsonApiError(context, {
      code: "INVENTORY_PROCESSING_RETRY_CONFLICT",
      message: error.message,
      status: 409,
    });
  }

  if (
    error instanceof InventoryPreprocessingRetryNotAllowedError ||
    error instanceof InventoryEnrichmentRetryNotAllowedError
  ) {
    return jsonApiError(context, {
      code: "INVENTORY_PROCESSING_NOT_RETRYABLE",
      message: error.message,
      status: 409,
    });
  }

  throw error;
}

function isInventoryPlacementBadRequest(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "Choose a different destination Placement.",
      "Choose exactly one Placement target.",
      "Choose exactly one source Placement target.",
      "Choose exactly one destination Placement target.",
    ].includes(error.message)
  );
}

function isInventoryPlacementConflict(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "Move quantity exceeds available units.",
      "Remove quantity exceeds available units.",
    ].includes(error.message)
  );
}

function inventoryProposalNotFoundResponse(context: Context) {
  return jsonApiError(context, {
    code: "NOT_FOUND",
    message: "Inventory Proposal not found.",
    status: 404,
  });
}

function inventoryProposalConflictResponse(
  context: Context,
  message: string,
) {
  return jsonApiError(context, {
    code: "INVENTORY_PROPOSAL_CONFLICT",
    message,
    status: 409,
  });
}

function inventoryItemIdFromContext(context: Context): string {
  const itemId = context.req.param("itemId");

  if (!itemId) {
    throw new Error("Inventory Item ID is required.");
  }

  return itemId;
}

function inventoryProposalIdFromContext(context: Context): string {
  const proposalId = context.req.param("proposalId");

  if (!proposalId) {
    throw new Error("Inventory Proposal ID is required.");
  }

  return proposalId;
}

function inventoryClothingWearConfirmationIdFromContext(
  context: Context,
): string {
  const confirmationId = context.req.param("confirmationId");

  if (!confirmationId) {
    throw new Error("Inventory Clothing Wear Confirmation ID is required.");
  }

  return confirmationId;
}

function inventoryCollectionFilters(query: Record<string, string>): InventoryExportInput {
  return {
    archived: query.archived === "true",
    category: normalizeInventoryCategory(query.category),
    clothingState: normalizeInventoryClothingState(query.clothingState),
    containerId: query.containerId?.trim() || null,
    evidence: (query.evidence as ListInventoryItemsInput["evidence"]) ?? null,
    importance: (query.importance as ListInventoryItemsInput["importance"]) ?? null,
    includeUnready: query.includeUnready === undefined ? undefined : query.includeUnready === "true",
    kind: (query.kind as ListInventoryItemsInput["kind"]) ?? null,
    query: normalizeOptionalQuery(query.q),
    status: (query.status as ListInventoryItemsInput["status"]) ?? null,
    workflow: (query.workflow as ListInventoryItemsInput["workflow"]) ?? null,
  };
}

function registerInventoryItemRoutes(
  app: OpenAPIHono<{
    Variables: {
      accessContext: AccessContext | null;
    };
  }>,
  handlers: InventoryItemsRouteHandlers,
) {
  app.openapi(inventoryItemsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const query = context.req.query();
    const filters = inventoryCollectionFilters(query);
    if (filters.clothingState && filters.category !== "clothing") {
      return jsonApiError(context, {
        code: "INVALID_INVENTORY_ITEM_QUERY",
        message: "clothingState is only valid when category=clothing.",
        status: 400,
      });
    }

    if (query.cursor && query.limit === "all") {
      return jsonApiError(context, {
        code: "INVALID_INVENTORY_ITEM_QUERY",
        message: "cursor cannot be combined with limit=all.",
        status: 400,
      });
    }

    try {
      const result = await handlers.listItems({
        ...filters,
        cursor: query.cursor?.trim() || null,
        limit: query.limit === "all" ? "all" : Number(query.limit ?? inventoryItemPageSize),
      });
      return context.json(result, 200);
    } catch (error) {
      if (error instanceof InventoryItemCursorError) {
        return jsonApiError(context, {
          code: "INVALID_INVENTORY_ITEM_QUERY",
          message: error.message,
          status: 400,
        });
      }
      throw error;
    }
  });

  app.openapi(inventoryItemsExportRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }
    const filters = inventoryCollectionFilters(context.req.query());
    if (filters.clothingState && filters.category !== "clothing") {
      return jsonApiError(context, {
        code: "INVALID_INVENTORY_ITEM_QUERY",
        message: "clothingState is only valid when category=clothing.",
        status: 400,
      });
    }
    context.header("Cache-Control", "private, no-store");
    return context.json({ items: await handlers.exportItems(filters) }, 200);
  });

  app.openapi(inventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const item = await handlers.getItem(inventoryItemIdFromContext(context));

    if (!item) {
      return inventoryItemNotFoundResponse(context);
    }

    return context.json({ item }, 200);
  });

  app.openapi(inventoryClothingProfileRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const clothingProfile = await handlers.getClothingProfile(
      inventoryItemIdFromContext(context),
    );

    if (!clothingProfile) {
      return jsonApiError(context, {
        code: "INVENTORY_CLOTHING_PROFILE_NOT_FOUND",
        message: "Inventory Clothing Profile was not found.",
        status: 404,
      });
    }

    return context.json({ clothingProfile }, 200);
  });

  app.openapi(inventoryRemedyProfileRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const remedyProfile = await handlers.getRemedyProfile(
      inventoryItemIdFromContext(context),
    );

    if (!remedyProfile) {
      return jsonApiError(context, {
        code: "INVENTORY_REMEDY_PROFILE_NOT_FOUND",
        message: "Inventory Remedy Profile was not found.",
        status: 404,
      });
    }

    return context.json({ remedyProfile }, 200);
  });

  app.openapi(remedyIntakesRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), [
      { action: "read", domain: "health" },
      { action: "read", domain: "inventory" },
    ]);
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.listRemedyIntakes({
          cursor: normalizeOptionalQuery(context.req.query("cursor")),
          itemId: normalizeOptionalQuery(context.req.query("itemId")),
          range: context.req.query("range") as RemedyIntakeRange,
          timeZone: context.req.query("timeZone") ?? "UTC",
        }),
        200,
      );
    } catch (error) {
      if (error instanceof InventoryItemRequestBodyError) {
        return jsonApiError(context, {
          code: "INVALID_REQUEST",
          message: "Request input is invalid.",
          status: 400,
        });
      }

      throw error;
    }
  });

  app.openapi(remedyIntakeSummaryRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), [
      { action: "read", domain: "health" },
      { action: "read", domain: "inventory" },
    ]);
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    return context.json(
      await handlers.summarizeRemedyIntakes({
        itemId: normalizeOptionalQuery(context.req.query("itemId")),
        range: context.req.query("range") as RemedyIntakeRange,
        timeZone: context.req.query("timeZone") ?? "UTC",
      }),
      200,
    );
  });

  app.openapi(createRemedyIntakeRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), [
      { action: "write", domain: "health" },
      { action: "read", domain: "inventory" },
    ]);
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<CreateRemedyIntakeRequest>(context);

      return context.json(
        await handlers.createRemedyIntake({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "createRemedyIntake",
          request,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof RemedyIntakeConflictError) {
        return jsonApiError(context, {
          code: "REMEDY_INTAKE_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      throw error;
    }
  });

  app.openapi(deleteRemedyIntakeRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), [
      { action: "delete", domain: "health" },
      { action: "read", domain: "inventory" },
    ]);
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";
    const intakeId = context.req.param("intakeId") ?? "";

    try {
      return context.json(
        await handlers.deleteRemedyIntake({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          intakeId,
          operation: "deleteRemedyIntake",
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      throw error;
    }
  });

  app.openapi(registerInventoryRemedyRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<RegisterInventoryRemedyRequest>(
          context,
        );

      return context.json(
        await handlers.registerRemedy({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "registerInventoryRemedy",
          request,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(
          context,
          error.message,
        );
      }

      if (
        error instanceof Error &&
        (error.message === "Container was not found." ||
          error.message === "Inventory Location was not found.")
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            error.message === "Container was not found."
              ? "INVENTORY_CONTAINER_NOT_FOUND"
              : "INVENTORY_LOCATION_NOT_FOUND",
            error.message,
          ),
        );
      }

      throw error;
    }
  });

  app.openapi(updateInventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        (await context.req.json()) as UpdateInventoryItemRequest;

      return context.json(
        await handlers.updateItem({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "updateInventoryItem",
          itemId: inventoryItemIdFromContext(context),
          request: sanitizeUpdateInventoryItemRequest(request),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (
        error instanceof InventoryClothingProfileConflictError ||
        error instanceof InventoryRemedyProfileConflictError ||
        (error instanceof Error &&
          (error.message ===
            "Inventory Clothing Profile conflicts with non-clothing category." ||
            error.message ===
              "Inventory Remedy Profile conflicts with non-homeopathy category."))
      ) {
        return inventoryProfileCategoryConflictResponse(
          context,
          error.message,
        );
      }

      if (
        error instanceof Error &&
        (error.message === "Inventory Item was not found." ||
          error.message === "Inventory item was not found.")
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_ITEM_NOT_FOUND",
            "Inventory Item was not found.",
          ),
        );
      }

      throw error;
    }
  });

  app.openapi(updateInventoryClothingProfileRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<UpdateInventoryClothingProfileRequest>(
          context,
        );

      return context.json(
        await handlers.updateClothingProfile({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "updateInventoryClothingProfile",
          itemId: inventoryItemIdFromContext(context),
          request,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryClothingProfileConflictError) {
        return inventoryProfileCategoryConflictResponse(
          context,
          error.message,
        );
      }

      throw error;
    }
  });

  app.openapi(markInventoryClothingItemWornRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.markClothingItemWorn({
          clientId: authorization.accessContext.client.id,
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ?? "",
          operation: "markInventoryClothingItemWorn",
          itemId: inventoryItemIdFromContext(context),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryClothingCommandConflictError) {
        return inventoryClothingConflictResponse(context, error.message);
      }

      throw error;
    }
  });

  app.openapi(undoInventoryClothingWearConfirmationRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.undoClothingWearConfirmation({
          clientId: authorization.accessContext.client.id,
          confirmationId:
            inventoryClothingWearConfirmationIdFromContext(context),
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ?? "",
          operation: "undoInventoryClothingWearConfirmation",
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryClothingCommandConflictError) {
        return inventoryClothingConflictResponse(context, error.message);
      }

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return inventoryClothingConflictResponse(
          context,
          "Clothing Wear Confirmation can no longer be safely undone.",
        );
      }

      throw error;
    }
  });

  app.openapi(completeInventoryClothingLaundryRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      const request =
        await readInventoryItemRequest<CompleteInventoryClothingLaundryRequest>(
          context,
        );

      return context.json(
        await handlers.completeClothingLaundry({
          clientId: authorization.accessContext.client.id,
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ?? "",
          operation: "completeInventoryClothingLaundry",
          request,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryClothingCommandConflictError) {
        return inventoryClothingConflictResponse(context, error.message);
      }

      throw error;
    }
  });

  app.openapi(updateInventoryRemedyProfileRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<UpdateInventoryRemedyProfileRequest>(
          context,
        );

      return context.json(
        await handlers.updateRemedyProfile({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "updateInventoryRemedyProfile",
          itemId: inventoryItemIdFromContext(context),
          request,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryRemedyProfileConflictError) {
        return inventoryProfileCategoryConflictResponse(
          context,
          error.message,
        );
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(
          context,
          error.message,
        );
      }

      throw error;
    }
  });

  app.openapi(addInventoryItemUnitsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<AddInventoryUnitsRequest>(context);

      return context.json(
        await handlers.addUnits({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "addInventoryItemUnits",
          itemId: inventoryItemIdFromContext(context),
          request: sanitizeAddInventoryUnitsRequest(request),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Item was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_ITEM_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Container was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_CONTAINER_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Location was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_LOCATION_NOT_FOUND",
            error.message,
          ),
        );
      }

      throw error;
    }
  });

  app.openapi(moveInventoryItemUnitsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<MoveInventoryUnitsRequest>(context);

      return context.json(
        await handlers.moveUnits({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "moveInventoryItemUnits",
          itemId: inventoryItemIdFromContext(context),
          request: sanitizeMoveInventoryUnitsRequest(request),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (isInventoryPlacementConflict(error)) {
        return inventoryPlacementConflictResponse(context, error.message);
      }

      if (isInventoryPlacementBadRequest(error)) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Item was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_ITEM_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Container was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_CONTAINER_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Location was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_LOCATION_NOT_FOUND",
            error.message,
          ),
        );
      }

      throw error;
    }
  });

  app.openapi(removeInventoryItemUnitsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        await readInventoryItemRequest<RemoveInventoryUnitsRequest>(
          context,
        );

      return context.json(
        await handlers.removeUnits({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "removeInventoryItemUnits",
          itemId: inventoryItemIdFromContext(context),
          request: sanitizeRemoveInventoryUnitsRequest(request),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryItemWriteNotFoundError) {
        return inventoryItemWriteNotFoundResponse(context, error);
      }

      if (error instanceof InventoryItemRequestBodyError) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (isInventoryPlacementConflict(error)) {
        return inventoryPlacementConflictResponse(context, error.message);
      }

      if (isInventoryPlacementBadRequest(error)) {
        return inventoryItemWriteBadRequestResponse(context, error.message);
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Item was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_ITEM_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Container was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_CONTAINER_NOT_FOUND",
            error.message,
          ),
        );
      }

      if (
        error instanceof Error &&
        error.message === "Inventory Location was not found."
      ) {
        return inventoryItemWriteNotFoundResponse(
          context,
          new InventoryItemWriteNotFoundError(
            "INVENTORY_LOCATION_NOT_FOUND",
            error.message,
          ),
        );
      }

      throw error;
    }
  });

  app.openapi(retryInventoryPreprocessingRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.retryPreprocessing({
          clientId: authorization.accessContext.client.id,
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ?? "",
          operation: "retryInventoryPreprocessing",
          itemId: inventoryItemIdFromContext(context),
        }),
        200,
      );
    } catch (error) {
      return inventoryProcessingRetryErrorResponse(context, error);
    }
  });

  app.openapi(retryInventoryEnrichmentRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.retryEnrichment({
          clientId: authorization.accessContext.client.id,
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ?? "",
          operation: "retryInventoryEnrichment",
          itemId: inventoryItemIdFromContext(context),
        }),
        200,
      );
    } catch (error) {
      return inventoryProcessingRetryErrorResponse(context, error);
    }
  });

  app.openapi(inventoryEnrichmentSettingsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "read",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    return context.json(
      {
        settings: await handlers.getEnrichmentSettings(),
      },
      200,
    );
  });

  app.openapi(updateInventoryEnrichmentSettingsRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      const request =
        (await context.req.json()) as UpdateInventoryEnrichmentSettingsRequest;

      return context.json(
        await handlers.updateEnrichmentSettings({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "updateInventoryEnrichmentSettings",
          request,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      throw error;
    }
  });

  app.openapi(inventoryProposalsRoute, async (context) => {
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
        proposals: await handlers.listProposals({
          limit: query.limit ? Number(query.limit) : 50,
          itemId: normalizeOptionalQuery(query.itemId),
        }),
      },
      200,
    );
  });

  app.openapi(approveInventoryProposalRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      return context.json(
        await handlers.approveProposal({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "approveInventoryProposal",
          proposalId: inventoryProposalIdFromContext(context),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryProposalNotFoundError) {
        return inventoryProposalNotFoundResponse(context);
      }

      if (error instanceof InventoryProposalConflictError) {
        return inventoryProposalConflictResponse(context, error.message);
      }

      throw error;
    }
  });

  app.openapi(rejectInventoryProposalRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ?? "";

    try {
      return context.json(
        await handlers.rejectProposal({
          clientId: authorization.accessContext.client.id,
          idempotencyKey,
          operation: "rejectInventoryProposal",
          proposalId: inventoryProposalIdFromContext(context),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonApiError(context, {
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
          status: 409,
        });
      }

      if (error instanceof InventoryProposalNotFoundError) {
        return inventoryProposalNotFoundResponse(context);
      }

      if (error instanceof InventoryProposalConflictError) {
        return inventoryProposalConflictResponse(context, error.message);
      }

      throw error;
    }
  });

  app.openapi(archiveInventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        {
          item: await handlers.archiveItem(
            inventoryItemIdFromContext(context),
          ),
        },
        200,
      );
    } catch (error) {
      if (error instanceof InventoryItemNotFoundError) {
        return inventoryItemNotFoundResponse(context);
      }

      throw error;
    }
  });

  app.openapi(restoreInventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "write",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        {
          item: await handlers.restoreItem(
            inventoryItemIdFromContext(context),
          ),
        },
        200,
      );
    } catch (error) {
      if (error instanceof InventoryItemNotFoundError) {
        return inventoryItemNotFoundResponse(context);
      }

      throw error;
    }
  });

  app.openapi(deleteInventoryItemRoute, async (context) => {
    const authorization = authorizeAccessContext(context.get("accessContext"), {
      action: "delete",
      domain: "inventory",
    });
    if (!authorization.ok) {
      return jsonAuthorizationFailure(context, authorization.error);
    }

    try {
      return context.json(
        await handlers.deleteItem(inventoryItemIdFromContext(context)),
        200,
      );
    } catch (error) {
      if (error instanceof InventoryItemNotFoundError) {
        return inventoryItemNotFoundResponse(context);
      }

      if (
        error instanceof RemedyIntakeConflictError ||
        (error instanceof Error &&
          error.message === "Remedy Intake history blocks permanent deletion.")
      ) {
        return jsonApiError(context, {
          code: "REMEDY_HAS_INTAKE_HISTORY",
          message: error.message,
          status: 409,
        });
      }

      throw error;
    }
  });
}

function normalizeOptionalQuery(query: string | null | undefined) {
  const trimmed = query?.trim();

  return trimmed ? trimmed : null;
}

function normalizeInventorySearchText(
  value: string | null | undefined,
): string {
  return (
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim() ?? ""
  );
}

function inventorySearchTerms(query: string | null | undefined): string[] {
  const normalized = normalizeInventorySearchText(query);

  return normalized ? [...new Set(normalized.split(/\s+/))] : [];
}

function buildInventorySearchCorpus(
  values: Array<string | null | undefined>,
): string {
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
}

function matchesInventorySearchQuery(
  searchable: string | null | undefined,
  query: string | null | undefined,
) {
  const corpus = normalizeInventorySearchText(searchable);

  return inventorySearchTerms(query).every((term) => corpus.includes(term));
}

export {
  archiveInventoryItemRoute,
  buildInventoryProcessingEvidence,
  buildInventoryItemQueryWhere,
  buildInventoryItemsFindManyArgs,
  compactInventoryProcessingHistory,
  createInventoryItemsRouteHandlers,
  deleteInventoryItemRoute,
  filterInventoryItemsByClothingState,
  filterInventoryItemCollection,
  filterRemedyIntakeRange,
  inventoryLifecycleWhere,
  inventoryItemRoute,
  inventoryItemMatchExplanation,
  inventoryItemsRoute,
  inventoryItemsRouteHandlers,
  inventoryItemSchema,
  inventoryItemScore,
  mapInventoryItem,
  mapInventoryItemLifecycle,
  moveInventoryItemUnitsRoute,
  normalizeOptionalQuery,
  paginateInventoryItems,
  paginateRemedyIntakeProjections,
  projectRemedyIntake,
  registerInventoryItemRoutes,
  removeInventoryItemUnitsRoute,
  retryInventoryEnrichmentRoute,
  retryInventoryPreprocessingRoute,
  restoreInventoryItemRoute,
  summarizeRemedyIntakeProjections,
  type InventoryItem,
  type InventoryItemsRepository,
  type InventoryItemsRouteHandlers,
  type RemedyIntake,
  type RemedyIntakeProjection,
  type RemedyIntakeRange,
};
