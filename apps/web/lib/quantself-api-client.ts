import createClient from "openapi-fetch";
import { headers } from "next/headers";
import { ownerAuthHeaders } from "./owner-auth-headers";
import type {
  components,
  operations,
  paths,
} from "./generated/quantself-api-schema";
import type {
  InventoryContainerVisualPresetRecord,
  InventoryLocationRecord,
} from "./inventory-client-contract";
import type {
  InventoryContainerVisualBounds,
  InventoryContainerVisualKey,
} from "./inventory-container-visual-catalog";

class QuantselfApiError extends Error {
  code: string | null;
  status: number;

  constructor(input: { code?: string | null; message: string; status: number }) {
    super(input.message);
    this.code = input.code ?? null;
    this.name = "QuantselfApiError";
    this.status = input.status;
  }
}

export type InventoryItem = components["schemas"]["InventoryItem"];
export type InventoryClothingProfile =
  components["schemas"]["InventoryClothingProfile"];
export type InventoryClothingWearConfirmation =
  components["schemas"]["InventoryClothingWearConfirmation"];
export type InventoryClothingRecommendation =
  components["schemas"]["InventoryClothingRecommendation"];
export type InventoryRemedyProfile =
  components["schemas"]["InventoryRemedyProfile"];
export type RemedyIntake = components["schemas"]["RemedyIntake"];
export type RemedyIntakeProjection =
  components["schemas"]["RemedyIntakeProjection"];
export type RemedyIntakeSummary = components["schemas"]["RemedyIntakeSummary"];
export type RemedyIntakeRange =
  components["schemas"]["RemedyIntakesResponse"]["range"];
export type RemedyIntakesResult = components["schemas"]["RemedyIntakesResponse"];
export type RemedyIntakeSummaryResult =
  components["schemas"]["RemedyIntakeSummaryResponse"];
export type InventoryCaptureSession =
  components["schemas"]["InventoryCaptureSession"];
export type InventoryItemDeleteResult =
  components["schemas"]["InventoryItemDeleteResponse"];
export type InventoryItemLifecycleResult =
  components["schemas"]["InventoryItemLifecycle"];
export type InventoryItemMedia = components["schemas"]["InventoryItemMedia"];
export type InventoryProposal = components["schemas"]["InventoryProposal"];
export type InventoryEnrichmentSettings =
  components["schemas"]["InventoryEnrichmentSettings"];
export type InventoryLocation =
  components["schemas"]["InventoryLocationWithUsage"];

type RawBounds = Array<{ x: number; y: number }>;
type RawInventoryContainerVisualPreset = Omit<
  components["schemas"]["InventoryContainerVisualPreset"],
  "bounds" | "hoverBounds"
> & {
  bounds: RawBounds;
  hoverBounds: RawBounds;
};
type RawInventoryContainer = Omit<
  components["schemas"]["InventoryContainer"],
  "location" | "visualPreset"
> & {
  location: components["schemas"]["InventoryLocation"] | null;
  visualPreset: RawInventoryContainerVisualPreset;
};
type RawInventoryContainerSummary = Omit<
  components["schemas"]["InventoryContainerSummary"],
  "visualPreset"
> & {
  visualPreset: RawInventoryContainerVisualPreset;
};
type RawEditableInventoryContainerVisual = Omit<
  components["schemas"]["EditableInventoryContainerVisual"],
  "bounds" | "defaultBounds" | "defaultHoverBounds" | "hoverBounds"
> & {
  bounds: RawBounds;
  defaultBounds: RawBounds;
  defaultHoverBounds: RawBounds;
  hoverBounds: RawBounds;
};

type SaveInventoryCaptureSessionDefaultsRequest =
  NonNullable<
    operations["saveInventoryCaptureSessionDefaults"]["requestBody"]
  >["content"]["application/json"];
type CaptureInventoryItemRequest =
  NonNullable<
    operations["captureInventoryItem"]["requestBody"]
  >["content"]["application/json"];
type UpdateInventoryItemRequest =
  NonNullable<
    operations["updateInventoryItem"]["requestBody"]
  >["content"]["application/json"];
type UpdateInventoryClothingProfileRequest =
  NonNullable<
    operations["updateInventoryClothingProfile"]["requestBody"]
  >["content"]["application/json"];
type CompleteInventoryClothingLaundryRequest =
  NonNullable<
    operations["completeInventoryClothingLaundry"]["requestBody"]
  >["content"]["application/json"];
type MarkInventoryClothingRecommendationWornRequest =
  NonNullable<
    operations["markInventoryClothingRecommendationWorn"]["requestBody"]
  >["content"]["application/json"];
type PublishInventoryClothingRecommendationRequest =
  NonNullable<
    operations["publishInventoryClothingRecommendation"]["requestBody"]
  >["content"]["application/json"];
type RegisterInventoryRemedyRequest =
  NonNullable<
    operations["registerInventoryRemedy"]["requestBody"]
  >["content"]["application/json"];
type CreateRemedyIntakeRequest =
  NonNullable<
    operations["createRemedyIntake"]["requestBody"]
  >["content"]["application/json"];
type UpdateInventoryRemedyProfileRequest =
  NonNullable<
    operations["updateInventoryRemedyProfile"]["requestBody"]
  >["content"]["application/json"];
type AddInventoryItemUnitsRequest =
  NonNullable<
    operations["addInventoryItemUnits"]["requestBody"]
  >["content"]["application/json"];
type MoveInventoryItemUnitsRequest =
  NonNullable<
    operations["moveInventoryItemUnits"]["requestBody"]
  >["content"]["application/json"];
type RemoveInventoryItemUnitsRequest =
  NonNullable<
    operations["removeInventoryItemUnits"]["requestBody"]
  >["content"]["application/json"];
type UpdateInventoryEnrichmentSettingsRequest =
  NonNullable<
    operations["updateInventoryEnrichmentSettings"]["requestBody"]
  >["content"]["application/json"];
type MoveInventoryItemsToContainerRequest =
  NonNullable<
    operations["moveInventoryItemsToContainer"]["requestBody"]
  >["content"]["application/json"];
export type CreateInventoryLocationInput =
  components["schemas"]["CreateInventoryLocationInput"];
export type UpdateInventoryLocationInput =
  components["schemas"]["UpdateInventoryLocationInput"];

export type InventoryContainerMutationInput =
  components["schemas"]["InventoryContainerMutationInput"];

export type InventoryContainer = {
  createdAt: string;
  id: string;
  location: InventoryLocationRecord | null;
  locationId: string | null;
  locationName: string | null;
  metadata: Record<string, unknown>;
  name: string;
  normalizedName: string;
  referenceId: string;
  sizeLiters: number | null;
  updatedAt: string;
  visualPreset: InventoryContainerVisualPresetRecord;
  visualPresetKey: string;
};

export type InventoryContainerSummary = {
  id: string;
  itemCount: number;
  latestCapturedAt: string | null;
  locationName: string | null;
  name: string;
  referenceId: string;
  sampleImages: Array<{
    alt: string;
    caption: string | null;
    id: string;
  }>;
  sampleItems: InventoryContainerShelfItem[];
  sizeLiters: number | null;
  unitCount: number;
  visualPreset: InventoryContainerVisualPresetRecord;
  visualPresetKey: string;
};

export type InventoryContainerVisualPresetOption = {
  id: components["schemas"]["InventoryContainerVisualPresetOption"]["id"];
  isDefault: boolean;
  name: string;
};

export type EditableInventoryContainerVisual = {
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

type InventoryContainerMutationOptions = {
  idempotencyKey?: string;
};

export type InventoryContainerShelfItem = {
  audioId: string | null;
  hasAudio: boolean;
  id: string;
  imageHeight: number | null;
  imageId: string | null;
  imageIds: string[];
  imageWidth: number | null;
  localQuantity: number;
  textPreview: string | null;
  title: string;
  totalQuantity: number;
  videoId: string | null;
};

export type InventoryContainerRetrievalCandidate = {
  id: string;
  title: string;
  where: string;
};

export async function listActiveInventoryItems(): Promise<
  InventoryItem[]
> {
  return listInventoryItems({ limit: "all" });
}

export async function listArchivedInventoryItems(
  query?: string | null,
): Promise<InventoryItem[]> {
  return listInventoryItems({
    archived: true,
    limit: "all",
    query,
  });
}

export async function listInventoryItems(input?: {
  archived?: boolean;
  category?: InventoryItem["category"] | null;
  clothingState?: "clean" | "dirty" | null;
  containerId?: string | null;
  cursor?: string | null;
  evidence?: "photo" | "voice" | "text" | null;
  importance?: InventoryItem["importance"] | null;
  includeUnready?: boolean;
  kind?: InventoryItem["kind"] | null;
  limit?: "all";
  query?: string | null;
  status?: InventoryItem["status"] | null;
  workflow?: "CAPTURED" | "PREPROCESSING" | "ENRICHING" | "NEEDS_REVIEW" | "COMPLETE" | null;
}): Promise<InventoryItem[]> {
  return (
    await listInventoryItemsPage({
      ...input,
      limit: input?.limit ?? "all",
    })
  ).items;
}

export async function listInventoryItemsPage(input?: {
  archived?: boolean;
  category?: InventoryItem["category"] | null;
  clothingState?: "clean" | "dirty" | null;
  containerId?: string | null;
  cursor?: string | null;
  evidence?: "photo" | "voice" | "text" | null;
  importance?: InventoryItem["importance"] | null;
  includeUnready?: boolean;
  kind?: InventoryItem["kind"] | null;
  limit?: "all";
  query?: string | null;
  status?: InventoryItem["status"] | null;
  workflow?: "CAPTURED" | "PREPROCESSING" | "ENRICHING" | "NEEDS_REVIEW" | "COMPLETE" | null;
}): Promise<{ items: InventoryItem[]; pageInfo: { nextCursor: string | null }; total: number }> {
  const category = input?.category ?? undefined;
  const clothingState = input?.clothingState ?? undefined;
  const query = input?.query?.trim();
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-items",
    {
      params: {
        query: {
          archived: input?.archived ? "true" : undefined,
          category: category ? category : undefined,
          clothingState:
            category === "clothing" && clothingState ? clothingState : undefined,
          containerId: input?.containerId ?? undefined,
          cursor: input?.cursor ?? undefined,
          evidence: input?.evidence ?? undefined,
          importance: input?.importance ?? undefined,
          includeUnready: input?.includeUnready === undefined
            ? undefined
            : input.includeUnready ? "true" : "false",
          kind: input?.kind ?? undefined,
          limit: input?.limit,
          q: query ? query : undefined,
          status: input?.status ?? undefined,
          workflow: input?.workflow ?? undefined,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function getInventoryItem(
  itemId: string,
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-items/{itemId}",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function getInventoryClothingProfile(
  itemId: string,
): Promise<InventoryClothingProfile> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-items/{itemId}/clothing-profile",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.clothingProfile;
}

export async function getInventoryRemedyProfile(
  itemId: string,
): Promise<InventoryRemedyProfile> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-items/{itemId}/remedy-profile",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.remedyProfile;
}

export async function listInventoryClothingRecommendations(input?: {
  kind?: InventoryClothingRecommendation["kind"] | null;
  status?: Exclude<
    InventoryClothingRecommendation["status"],
    "SUPERSEDED"
  > | null;
  from?: string | null;
  limit?: number | null;
  timeZone?: string | null;
  to?: string | null;
}): Promise<InventoryClothingRecommendation[]> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-clothing/outfit-recommendations",
    {
      params: {
        query: {
          from: input?.from ?? undefined,
          kind:
            input?.kind === "DAILY"
              ? "daily"
              : input?.kind === "EVENT"
                ? "event"
                : undefined,
          limit: input?.limit ?? undefined,
          status: input?.status?.toLowerCase() as
            | "declined"
            | "published"
            | "worn"
            | undefined,
          timeZone: input?.timeZone ?? undefined,
          to: input?.to ?? undefined,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.recommendations;
}

export async function listRemedyIntakes(input: {
  cursor?: string | null;
  itemId?: string | null;
  range: RemedyIntakeRange;
  timeZone: string;
}): Promise<RemedyIntakesResult> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET("/api/v1/remedy-intakes", {
    params: {
      query: {
        cursor: input.cursor ?? undefined,
        itemId: input.itemId ?? undefined,
        range: input.range,
        timeZone: input.timeZone,
      },
    },
  });

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function summarizeRemedyIntakes(input: {
  itemId?: string | null;
  range: RemedyIntakeRange;
  timeZone: string;
}): Promise<RemedyIntakeSummaryResult> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/remedy-intakes/summary",
    {
      params: {
        query: {
          itemId: input.itemId ?? undefined,
          range: input.range,
          timeZone: input.timeZone,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function getInventoryClothingRecommendation(
  recommendationId: string,
): Promise<InventoryClothingRecommendation> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}",
    {
      params: {
        path: {
          recommendationId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.recommendation;
}

export async function publishInventoryClothingRecommendation(
  input: PublishInventoryClothingRecommendationRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<{ recommendation: InventoryClothingRecommendation }> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-clothing/outfit-recommendations",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function archiveInventoryItem(
  itemId: string,
): Promise<InventoryItemLifecycleResult> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/archive",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function restoreInventoryItem(
  itemId: string,
): Promise<InventoryItemLifecycleResult> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/restore",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function deleteInventoryItem(
  itemId: string,
): Promise<InventoryItemDeleteResult> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.DELETE(
    "/api/v1/inventory-items/{itemId}",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function updateInventoryItem(
  itemId: string,
  input: UpdateInventoryItemRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-items/{itemId}",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function updateInventoryClothingProfile(
  itemId: string,
  input: UpdateInventoryClothingProfileRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  clothingProfile: InventoryClothingProfile;
  item: InventoryItem;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-items/{itemId}/clothing-profile",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function registerInventoryRemedy(
  input: RegisterInventoryRemedyRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  item: InventoryItem;
  remedyProfile: InventoryRemedyProfile;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-remedies",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function createRemedyIntake(
  input: CreateRemedyIntakeRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<RemedyIntake> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST("/api/v1/remedy-intakes", {
    body: input,
    params: {
      header: {
        "Idempotency-Key": resolveIdempotencyKey(options),
      },
    },
  });

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.intake;
}

export async function deleteRemedyIntake(
  intakeId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<{ deletedIntakeId: string }> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.DELETE(
    "/api/v1/remedy-intakes/{intakeId}",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          intakeId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function updateInventoryRemedyProfile(
  itemId: string,
  input: UpdateInventoryRemedyProfileRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  item: InventoryItem;
  remedyProfile: InventoryRemedyProfile;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-items/{itemId}/remedy-profile",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function markInventoryClothingItemWorn(
  itemId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  item: InventoryItem;
  wearConfirmation: InventoryClothingWearConfirmation;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/worn",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function markInventoryClothingRecommendationWorn(
  recommendationId: string,
  input: MarkInventoryClothingRecommendationWornRequest = {},
  options: InventoryContainerMutationOptions = {},
): Promise<{
  recommendation: InventoryClothingRecommendation;
  wearConfirmation: InventoryClothingWearConfirmation;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}/worn",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          recommendationId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function declineInventoryClothingRecommendation(
  recommendationId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  recommendation: InventoryClothingRecommendation;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-clothing/outfit-recommendations/{recommendationId}/decline",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          recommendationId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function undoInventoryClothingWearConfirmation(
  confirmationId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  items: InventoryItem[];
  wearConfirmation: InventoryClothingWearConfirmation;
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-clothing/wear-confirmations/{confirmationId}/undo",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          confirmationId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function completeInventoryClothingLaundry(
  input: CompleteInventoryClothingLaundryRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<{
  cleanedCount: number;
  items: InventoryItem[];
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-clothing/laundry-completed",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function listInventoryItemMedia(
  itemId: string,
): Promise<InventoryItemMedia[]> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-items/{itemId}/media",
    {
      params: {
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.media;
}

export async function addInventoryItemUnits(
  itemId: string,
  input: AddInventoryItemUnitsRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/add-units",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function moveInventoryItemUnits(
  itemId: string,
  input: MoveInventoryItemUnitsRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/move-units",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function removeInventoryItemUnits(
  itemId: string,
  input: RemoveInventoryItemUnitsRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/remove-units",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          itemId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function retryInventoryPreprocessing(
  itemId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/retry-preprocessing",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: { itemId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function retryInventoryEnrichment(
  itemId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryItem> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/{itemId}/retry-enrichment",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: { itemId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.item;
}

export async function listInventoryProposals(input?: {
  limit?: number;
  itemId?: string | null;
}): Promise<InventoryProposal[]> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-proposals",
    {
      params: {
        query: {
          limit: input?.limit,
          itemId: input?.itemId ?? undefined,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.proposals;
}

export async function approveInventoryProposal(
  proposalId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<void> {
  const client = await createQuantselfApiServerClient();
  const { error, response } = await client.POST(
    "/api/v1/inventory-proposals/{proposalId}/approve",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          proposalId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }
}

export async function rejectInventoryProposal(
  proposalId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<void> {
  const client = await createQuantselfApiServerClient();
  const { error, response } = await client.POST(
    "/api/v1/inventory-proposals/{proposalId}/reject",
    {
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: {
          proposalId,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }
}

export async function getInventoryEnrichmentSettings(): Promise<InventoryEnrichmentSettings> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-enrichment-settings",
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.settings;
}

export async function updateInventoryEnrichmentSettings(
  input: UpdateInventoryEnrichmentSettingsRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryEnrichmentSettings> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-enrichment-settings",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.settings;
}

export function inventoryItemMediaContentPath(
  itemId: string,
  mediaId: string,
): string {
  return `/api/v1/inventory-items/${encodeURIComponent(itemId)}/media/${encodeURIComponent(mediaId)}`;
}

export async function getActiveInventoryCaptureSession(): Promise<InventoryCaptureSession | null> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-capture-session",
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.session;
}

export async function saveInventoryCaptureSessionDefaults(
  input: SaveInventoryCaptureSessionDefaultsRequest,
): Promise<InventoryCaptureSession> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-capture-session",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.session;
}

export async function captureInventoryItem(
  input: CaptureInventoryItemRequest,
): Promise<components["schemas"]["CaptureInventoryItemResponse"]> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-items/capture",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data;
}

export async function listInventoryLocations(input?: {
  kind?: InventoryLocation["kind"];
  query?: string | null;
}): Promise<InventoryLocation[]> {
  const client = await createQuantselfApiServerClient();
  const query = input?.query?.trim();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-locations",
    {
      params: {
        query: {
          kind: input?.kind,
          q: query || undefined,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.locations;
}

export async function createInventoryLocation(
  input: CreateInventoryLocationInput,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryLocation> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-locations",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.location;
}

export async function updateInventoryLocation(
  locationId: string,
  input: UpdateInventoryLocationInput,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryLocation> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-locations/{locationId}",
    {
      body: input,
      params: {
        header: {
          "Idempotency-Key": resolveIdempotencyKey(options),
        },
        path: { locationId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.location;
}

export async function listInventoryContainers(): Promise<
  InventoryContainerSummary[]
> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-containers",
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.containers.map(toInventoryContainerSummary);
}

export async function getInventoryContainer(
  containerId: string,
): Promise<InventoryContainer> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-containers/{containerId}",
    {
      params: {
        path: { containerId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toInventoryContainer(data.container);
}

export async function getInventoryContainerContents(
  containerId: string,
): Promise<{
  items: InventoryContainerShelfItem[];
  retrievalCandidates: InventoryContainerRetrievalCandidate[];
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-containers/{containerId}/contents",
    {
      params: {
        path: { containerId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return {
    items: data.items.map((item) => toInventoryContainerShelfItem(item)),
    retrievalCandidates: data.retrievalCandidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      where: candidate.where,
    })),
  };
}

export async function resolveInventoryContainerByReference(
  referenceId: string,
): Promise<InventoryContainer> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-containers/reference/{referenceId}",
    {
      params: {
        path: { referenceId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toInventoryContainer(data.container);
}

export async function listInventoryContainerVisuals(): Promise<{
  editableVisuals: EditableInventoryContainerVisual[];
  visualPresets: InventoryContainerVisualPresetOption[];
}> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.GET(
    "/api/v1/inventory-container-visuals",
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return {
    editableVisuals: data.editableVisuals.map(
      toEditableInventoryContainerVisual,
    ),
    visualPresets: data.visualPresets.map((preset) => ({
      id: preset.id,
      isDefault: preset.isDefault,
      name: preset.name,
    })),
  };
}

export async function createInventoryContainer(
  input: InventoryContainerMutationInput,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryContainer> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-containers",
    {
      body: input,
      params: {
        header: {
          "idempotency-key": resolveIdempotencyKey(options),
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toInventoryContainer(data.container);
}

export async function updateInventoryContainer(
  containerId: string,
  input: InventoryContainerMutationInput,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryContainer> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-containers/{containerId}",
    {
      body: input,
      params: {
        header: {
          "idempotency-key": resolveIdempotencyKey(options),
        },
        path: { containerId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toInventoryContainer(data.container);
}

export async function deleteInventoryContainer(
  containerId: string,
  options: InventoryContainerMutationOptions = {},
): Promise<InventoryContainer> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.DELETE(
    "/api/v1/inventory-containers/{containerId}",
    {
      params: {
        header: {
          "idempotency-key": resolveIdempotencyKey(options),
        },
        path: { containerId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toInventoryContainer(data.container);
}

export async function moveInventoryItemsToContainer(
  containerId: string,
  input: MoveInventoryItemsToContainerRequest,
  options: InventoryContainerMutationOptions = {},
): Promise<string[]> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.POST(
    "/api/v1/inventory-containers/{containerId}/move-items",
    {
      body: input,
      params: {
        header: {
          "idempotency-key": resolveIdempotencyKey(options),
        },
        path: { containerId },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return data.movedItemIds;
}

export async function saveInventoryContainerVisualBounds(
  input: {
    bounds: EditableInventoryContainerVisual["bounds"];
    hoverBounds: EditableInventoryContainerVisual["hoverBounds"];
    presetKey: EditableInventoryContainerVisual["key"];
  },
  options: InventoryContainerMutationOptions = {},
): Promise<EditableInventoryContainerVisual> {
  const client = await createQuantselfApiServerClient();
  const { data, error, response } = await client.PUT(
    "/api/v1/inventory-container-visuals/{presetKey}/bounds",
    {
      body: {
        bounds: [...input.bounds],
        hoverBounds: [...input.hoverBounds],
      },
      params: {
        header: {
          "idempotency-key": resolveIdempotencyKey(options),
        },
        path: {
          presetKey: input.presetKey,
        },
      },
    },
  );

  if (error) {
    throw toQuantselfApiError(response, error);
  }

  return toEditableInventoryContainerVisual(data.editableVisual);
}

export function isApiAuthenticationError(
  error: unknown,
): error is QuantselfApiError {
  return error instanceof QuantselfApiError && error.status === 401;
}

export function isApiNotFoundError(
  error: unknown,
): error is QuantselfApiError {
  return error instanceof QuantselfApiError && error.status === 404;
}

function toQuantselfApiError(
  response: Response,
  payload: unknown,
): QuantselfApiError {
  const failure =
    payload !== null && typeof payload === "object"
      ? (payload as { code?: unknown; message?: unknown })
      : null;

  return new QuantselfApiError({
    code: typeof failure?.code === "string" ? failure.code : null,
    message:
      (typeof failure?.message === "string" && failure.message) ||
      `Quantself API request failed with HTTP ${response.status}.`,
    status: response.status,
  });
}

function quantselfApiInternalOrigin(): string {
  return (
    process.env.QUANTSELF_API_INTERNAL_URL ?? "http://api:3001"
  ).replace(/\/$/, "");
}

async function createQuantselfApiServerClient() {
  const requestHeaders = ownerAuthHeaders(await headers());
  requestHeaders.set("accept", "application/json");

  return createClient<paths>({
    baseUrl: quantselfApiInternalOrigin(),
    cache: "no-store",
    redirect: "error",
    headers: requestHeaders,
  });
}

function resolveIdempotencyKey(
  options: InventoryContainerMutationOptions,
): string {
  if (options.idempotencyKey === undefined) {
    return crypto.randomUUID();
  }

  const key = options.idempotencyKey.trim();

  if (!key) {
    throw new Error("Idempotency-Key is required.");
  }

  if (key.length > 255) {
    throw new Error("Idempotency-Key must be at most 255 characters.");
  }

  return key;
}

function toInventoryContainer(
  container: RawInventoryContainer,
): InventoryContainer {
  return {
    createdAt: container.createdAt,
    id: container.id,
    location: container.location
      ? {
          id: container.location.id,
          kind: container.location.kind,
          name: container.location.name,
        }
      : null,
    locationId: container.locationId,
    locationName: container.location?.name ?? null,
    metadata: container.metadata,
    name: container.name,
    normalizedName: container.normalizedName,
    referenceId: container.referenceId,
    sizeLiters: container.sizeLiters,
    updatedAt: container.updatedAt,
    visualPreset: toVisualPreset(container.visualPreset),
    visualPresetKey: container.visualPresetKey,
  };
}

function toInventoryContainerSummary(
  container: RawInventoryContainerSummary,
): InventoryContainerSummary {
  return {
    id: container.id,
    itemCount: container.itemCount,
    latestCapturedAt: container.latestCapturedAt,
    locationName: container.locationName,
    name: container.name,
    referenceId: container.referenceId,
    sampleImages: container.sampleImages.map((image) => ({
      alt: image.alt,
      caption: image.caption,
      id: image.id,
    })),
    sampleItems: container.sampleItems.map(toInventoryContainerShelfItem),
    sizeLiters: container.sizeLiters,
    unitCount: container.unitCount,
    visualPreset: toVisualPreset(container.visualPreset),
    visualPresetKey: container.visualPresetKey,
  };
}

function toInventoryContainerShelfItem(
  item: components["schemas"]["InventoryContainerShelfItem"],
): InventoryContainerShelfItem {
  return {
    audioId: item.audioId,
    hasAudio: item.hasAudio,
    id: item.id,
    imageHeight: item.imageHeight,
    imageId: item.imageId,
    imageIds: [...item.imageIds],
    imageWidth: item.imageWidth,
    localQuantity: item.localQuantity,
    textPreview: item.textPreview,
    title: item.title,
    totalQuantity: item.totalQuantity,
    videoId: item.videoId,
  };
}

function toVisualPreset(
  preset: RawInventoryContainerVisualPreset,
): InventoryContainerVisualPresetRecord {
  return {
    backImageUrl: preset.backImageUrl,
    bounds: toBounds(preset.bounds),
    emptyImageUrl: preset.emptyImageUrl,
    frontImageUrl: preset.frontImageUrl,
    height: preset.height,
    id: preset.id,
    isDefault: preset.isDefault,
    name: preset.name,
    shadowImageUrl: preset.shadowImageUrl,
    width: preset.width,
  };
}

function toEditableInventoryContainerVisual(
  visual: RawEditableInventoryContainerVisual,
): EditableInventoryContainerVisual {
  return {
    bounds: toBounds(visual.bounds),
    defaultBounds: toBounds(visual.defaultBounds),
    defaultHoverBounds: toBounds(visual.defaultHoverBounds),
    frontImageUrl: visual.frontImageUrl,
    height: visual.height,
    hoverBounds: toBounds(visual.hoverBounds),
    key: visual.key,
    name: visual.name,
    width: visual.width,
  };
}

function toBounds(
  points: ReadonlyArray<{
    x: number;
    y: number;
  }>,
): InventoryContainerVisualBounds {
  if (points.length !== 4) {
    throw new Error("Quantself API returned invalid Container bounds.");
  }

  const [first, second, third, fourth] = points;

  return [{ ...first }, { ...second }, { ...third }, { ...fourth }];
}

export { QuantselfApiError };
