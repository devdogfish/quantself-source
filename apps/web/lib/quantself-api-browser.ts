import type { components, operations } from "./generated/quantself-api-schema";

type CaptureInventoryItemRequest = NonNullable<
  operations["captureInventoryItem"]["requestBody"]
>["content"]["application/json"];

type CaptureInventoryItemResponse =
  components["schemas"]["CaptureInventoryItemResponse"];
type CreateRemedyIntakeRequest =
  components["schemas"]["CreateRemedyIntakeRequest"];
type RemedyIntake = components["schemas"]["RemedyIntake"];
type RemedyIntakeProjection =
  components["schemas"]["RemedyIntakeProjection"];
type RemedyIntakeRange =
  components["schemas"]["RemedyIntakesResponse"]["range"];
export type BrowserInventoryItem = components["schemas"]["InventoryItem"];
export type BrowserInventoryItemPage = components["schemas"]["InventoryItemsResponse"];

export type BrowserInventoryItemMedia =
  components["schemas"]["InventoryItemMedia"];

export function inventoryItemMediaContentPath(
  itemId: string,
  mediaId: string,
  options: { representation?: "preview" } = {},
): string {
  const path = `/api/v1/inventory-items/${encodeURIComponent(itemId)}/media/${encodeURIComponent(mediaId)}`;

  return options.representation
    ? `${path}?representation=${options.representation}`
    : path;
}

type InventoryCollectionFilters = {
  archived?: boolean;
  category?: string;
  clothingState?: "clean" | "dirty";
  containerId?: string;
  evidence?: string;
  importance?: string;
  includeUnready?: boolean;
  kind?: string;
  q?: string;
  status?: string;
  workflow?: string;
};

function inventoryCollectionQuery(
  input: InventoryCollectionFilters & { cursor?: string | null },
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, typeof value === "boolean" ? String(value) : value);
  }
  return params.size ? `?${params}` : "";
}

export async function listInventoryItemsFromBrowser(
  input: InventoryCollectionFilters & { cursor?: string | null },
  options: { signal?: AbortSignal } = {},
): Promise<BrowserInventoryItemPage> {
  return fetchQuantselfApiJson<BrowserInventoryItemPage>(
    `/api/v1/inventory-items${inventoryCollectionQuery(input)}`,
    { method: "GET", signal: options.signal },
  );
}

export async function exportInventoryItemsFromBrowser(
  filters: InventoryCollectionFilters,
  signal?: AbortSignal,
) {
  const response = await fetchQuantselfApiJson<components["schemas"]["InventoryItemsExportResponse"]>(
    `/api/v1/inventory-items/export${inventoryCollectionQuery(filters)}`,
    { method: "GET", signal, cache: "no-store" },
  );
  return response.items;
}

export function inventoryItemMediaFilesSignature(files: File[]): string {
  return JSON.stringify(
    files.map((file) => ({
      lastModified: file.lastModified,
      name: file.name,
      size: file.size,
      type: file.type,
    })),
  );
}

export async function captureInventoryItemFromBrowser(
  input: CaptureInventoryItemRequest,
  files: File[] = [],
  options: { idempotencyKey?: string } = {},
): Promise<CaptureInventoryItemResponse> {
  const body = new FormData();

  body.append("metadata", JSON.stringify(input));
  for (const file of files.filter((entry) => entry.size > 0)) {
    body.append("files", file);
  }

  return fetchQuantselfApiJson<CaptureInventoryItemResponse>(
    "/api/v1/inventory-items/capture",
    {
      body,
      headers: {
        "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
      },
      method: "POST",
    },
  );
}

export async function uploadInventoryItemMediaFromBrowser(
  itemId: string,
  files: File[],
  options: { idempotencyKey?: string } = {},
): Promise<BrowserInventoryItemMedia[]> {
  const formData = new FormData();

  for (const file of files.filter((entry) => entry.size > 0)) {
    formData.append("files", file);
  }

  const response = await fetchQuantselfApiJson<{
    media: BrowserInventoryItemMedia[];
  }>(`/api/v1/inventory-items/${encodeURIComponent(itemId)}/media`, {
    body: formData,
    headers: {
      "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
    },
    method: "POST",
  });

  return response.media;
}

export async function reorderInventoryItemImagesFromBrowser(
  itemId: string,
  imageIds: string[],
  options: { idempotencyKey?: string } = {},
): Promise<void> {
  await fetchQuantselfApiJson(
    `/api/v1/inventory-items/${encodeURIComponent(itemId)}/media/image-order`,
    {
      body: JSON.stringify({ imageIds }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
      },
      method: "PUT",
    },
  );
}

export async function deleteInventoryItemMediaFromBrowser(
  itemId: string,
  mediaId: string,
  options: { idempotencyKey?: string } = {},
): Promise<void> {
  await fetchQuantselfApiJson(
    `/api/v1/inventory-items/${encodeURIComponent(itemId)}/media/${encodeURIComponent(mediaId)}`,
    {
      headers: {
        "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
      },
      method: "DELETE",
    },
  );
}

export async function createRemedyIntakeFromBrowser(
  input: CreateRemedyIntakeRequest,
  options: { idempotencyKey?: string } = {},
): Promise<RemedyIntake> {
  const response = await fetchQuantselfApiJson<{
    intake: RemedyIntake;
  }>("/api/v1/remedy-intakes", {
    body: JSON.stringify(input),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
    },
    method: "POST",
  });

  return response.intake;
}

export async function listRemedyIntakesFromBrowser(input: {
  range: RemedyIntakeRange;
  timeZone: string;
}): Promise<RemedyIntakeProjection[]> {
  const intakes: RemedyIntakeProjection[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      range: input.range,
      timeZone: input.timeZone,
    });
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetchQuantselfApiJson<
      components["schemas"]["RemedyIntakesResponse"]
    >(`/api/v1/remedy-intakes?${params}`, { method: "GET" });
    intakes.push(...response.intakes);
    cursor = response.pageInfo.nextCursor;
  } while (cursor);

  return intakes;
}

export async function deleteRemedyIntakeFromBrowser(
  intakeId: string,
  options: { idempotencyKey?: string } = {},
): Promise<void> {
  await fetchQuantselfApiJson(
    `/api/v1/remedy-intakes/${encodeURIComponent(intakeId)}`,
    {
      headers: {
        "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
      },
      method: "DELETE",
    },
  );
}

async function fetchQuantselfApiJson<T = unknown>(
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(await quantselfApiErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function quantselfApiErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      message?: unknown;
    };

    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {}

  return `Quantself API request failed with HTTP ${response.status}.`;
}
