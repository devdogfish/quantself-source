"use server";

import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { INVENTORY_CONTAINER_VISUAL_KEYS } from "@/lib/inventory-container-visual-catalog";
import {
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  cleanOptional,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_KINDS,
  INVENTORY_ITEM_STATUSES,
  type InventoryAcquisitionSource,
  type InventoryCategory,
  type InventoryImportance,
  type InventoryItemKind,
  type InventoryItemStatus,
} from "@/lib/inventory-client-contract";
import {
  addInventoryItemUnits,
  archiveInventoryItem,
  completeInventoryClothingLaundry,
  captureInventoryItem,
  declineInventoryClothingRecommendation,
  markInventoryClothingItemWorn,
  markInventoryClothingRecommendationWorn,
  createInventoryContainer,
  deleteInventoryContainer,
  deleteInventoryItem,
  moveInventoryItemsToContainer,
  moveInventoryItemUnits,
  removeInventoryItemUnits,
  retryInventoryEnrichment,
  retryInventoryPreprocessing,
  restoreInventoryItem,
  saveInventoryCaptureSessionDefaults,
  type InventoryContainerMutationInput,
  undoInventoryClothingWearConfirmation,
  updateInventoryClothingProfile,
  updateInventoryItem,
  updateInventoryContainer,
} from "@/lib/quantself-api-client";
import type {
  InventoryActionState,
  InventoryContainerActionState,
} from "./action-state";
import { mapContainerOption } from "./container-utils";

const noContainerFormValue = "__none";

export async function saveCaptureSessionAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await saveInventoryCaptureSessionDefaults({
      defaultContainerId: formSelectedContainerId(formData, "defaultContainerId"),
      defaultContainerLabel: formString(formData, "defaultContainerLabel"),
      destinationLocation: formString(formData, "destinationLocation"),
      id: formString(formData, "captureSessionId"),
      label: formString(formData, "label"),
      note: formString(formData, "note"),
      originRoom: formString(formData, "originRoom"),
    });
    revalidateInventoryPaths();

    return {
      status: "success",
      message: "Session defaults saved.",
    };
  } catch (error) {
    return actionError(error, "Could not save session defaults.");
  }
}

export async function createInventorySessionAction(
  state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  return saveCaptureSessionAction(state, formData);
}

export async function createInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  if (formString(formData, "captureMode") === "existing") {
    try {
      const quantity = formNumber(formData, "quantity") ?? 1;
      const itemId = formRequiredString(
        formData,
        "existingItemId",
        "Existing item ID is required.",
      );
      const item = await addInventoryItemUnits(
        itemId,
        {
          containerId: formPlacementContainerId(formData, "containerId"),
          locationId: formPlacementLocationId(formData, "locationId"),
          quantity,
        },
      );
      revalidateInventoryPaths(item.id);

      return {
        status: "success",
        message: `Added ${quantity} · ${formatInventoryItemPlacementSummary(item)}`,
      };
    } catch (error) {
      return actionError(error, "Could not add units.");
    }
  }

  try {
    await captureInventoryItem({
      acquisitionSource: enumValue<InventoryAcquisitionSource>(
        formString(formData, "acquisitionSource"),
        INVENTORY_ACQUISITION_SOURCE_VALUES,
      ),
      captureSessionId: formString(formData, "captureSessionId"),
      captureText:
        formString(formData, "captureText") ?? formString(formData, "itemNote"),
      category: enumValue<InventoryCategory>(
        formString(formData, "category"),
        INVENTORY_CATEGORY_VALUES,
      ),
      containerId: formSelectedContainerId(formData, "containerId"),
      containerLabelOverride: formString(formData, "containerLabelOverride"),
      costCents: formCurrencyCents(formData, "estimatedValue"),
      costCurrency: "CAD",
      importance: enumValue<InventoryImportance>(
        formString(formData, "importance"),
        INVENTORY_IMPORTANCE_VALUES,
      ),
      kind: enumValue<InventoryItemKind>(
        formString(formData, "kind"),
        INVENTORY_ITEM_KINDS,
      ),
      locationId: formSelectedLocationId(formData, "locationId"),
      note: formString(formData, "itemNote"),
      quantity: formNumber(formData, "quantity") ?? 1,
      status: enumValue<InventoryItemStatus>(
        formString(formData, "status"),
        INVENTORY_ITEM_STATUSES,
      ),
      title: formString(formData, "title"),
    });
    revalidateInventoryPaths();

    return {
      status: "success",
      message: "Capture saved. Inventory preprocessing queued.",
    };
  } catch (error) {
    return actionError(error, "Could not save capture.");
  }
}

export async function createInventoryContainerAction(
  _state: InventoryContainerActionState,
  formData: FormData,
): Promise<InventoryContainerActionState> {
  try {
    const container = await createInventoryContainer({
      name: formRequiredString(
        formData,
        "containerName",
        "Container name is required.",
      ),
      locationName: formString(formData, "locationName"),
      sizeLiters: formNumber(formData, "sizeLiters"),
      visualPresetKey: formContainerVisualPresetKey(formData),
    });

    revalidateInventoryPaths();

    return {
      status: "success",
      message: "Container created.",
      container: mapContainerOption(container),
    };
  } catch (error) {
    return {
      ...actionError(error, "Could not create container."),
      container: null,
    };
  }
}

export async function updateInventoryContainerAction(
  _state: InventoryContainerActionState,
  formData: FormData,
): Promise<InventoryContainerActionState> {
  try {
    const id = formString(formData, "containerId");

    if (!id) {
      throw new Error("Container ID is required.");
    }

    const container = await updateInventoryContainer(id, {
      name: formRequiredString(
        formData,
        "containerName",
        "Container name is required.",
      ),
      locationName: formString(formData, "locationName"),
      sizeLiters: formNumber(formData, "sizeLiters"),
      visualPresetKey: formContainerVisualPresetKey(formData),
    });

    revalidateInventoryPaths();

    return {
      status: "success",
      message: "Container updated.",
      container: mapContainerOption(container),
    };
  } catch (error) {
    return {
      ...actionError(error, "Could not update container."),
      container: null,
    };
  }
}

export async function deleteInventoryContainerAction(
  _state: InventoryContainerActionState,
  formData: FormData,
): Promise<InventoryContainerActionState> {
  try {
    const id = formString(formData, "containerId");

    if (!id) {
      throw new Error("Container ID is required.");
    }

    await deleteInventoryContainer(id);

    revalidateInventoryPaths();

    return {
      status: "success",
      message: "Container deleted.",
      container: null,
    };
  } catch (error) {
    return {
      ...actionError(error, "Could not delete container."),
      container: null,
    };
  }
}

export async function updateInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    const item = await updateInventoryItem(itemId, {
      acquisitionSource: enumValue<InventoryAcquisitionSource>(
        formString(formData, "acquisitionSource"),
        INVENTORY_ACQUISITION_SOURCE_VALUES,
      ),
      aliases: formStringList(formData, "aliases"),
      captureText: formString(formData, "captureText"),
      category: enumValue<InventoryCategory>(
        formString(formData, "category"),
        INVENTORY_CATEGORY_VALUES,
      ),
      costCents: formCurrencyCents(formData, "estimatedValue"),
      costCurrency: "CAD",
      importance: enumValue<InventoryImportance>(
        formString(formData, "importance"),
        INVENTORY_IMPORTANCE_VALUES,
      ),
      kind: enumValue<InventoryItemKind>(
        formString(formData, "kind"),
        INVENTORY_ITEM_KINDS,
      ),
      note: formString(formData, "note"),
      status: enumValue<InventoryItemStatus>(
        formString(formData, "status"),
        INVENTORY_ITEM_STATUSES,
      ),
      tags: formStringList(formData, "tags"),
      title: formString(formData, "title"),
    });
    revalidateInventoryPaths(item.id);

    return {
      status: "success",
      message: "Item updated. Enrichment refresh queued.",
    };
  } catch (error) {
    return actionError(error, "Could not update item.");
  }
}

export async function updateInventoryClothingProfileAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    const result = await updateInventoryClothingProfile(itemId, {
      attributes: buildInventoryClothingProfileAttributesInput(formData),
      isDirty: formString(formData, "isDirty") === "true",
    });
    revalidateInventoryPaths(result.item.id);
    revalidatePath("/inventory/clothing");

    return {
      status: "success",
      message: "Clothing profile updated.",
    };
  } catch (error) {
    return actionError(error, "Could not update clothing profile.");
  }
}

export async function addInventoryUnitsAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const quantity = formNumber(formData, "quantity") ?? 1;
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    const item = await addInventoryItemUnits(itemId, {
      containerId: formPlacementContainerId(formData, "containerId"),
      locationId: formPlacementLocationId(formData, "locationId"),
      note: formString(formData, "placementNote"),
      quantity,
    });
    revalidateInventoryPaths(item.id);

    return {
      status: "success",
      message: `Added ${quantity} · ${formatInventoryItemPlacementSummary(item)}`,
    };
  } catch (error) {
    return actionError(error, "Could not add units.");
  }
}

export async function moveInventoryUnitsAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const quantity = formNumber(formData, "quantity") ?? 1;
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    const item = await moveInventoryItemUnits(itemId, {
      destinationContainerId: formPlacementContainerId(
        formData,
        "destinationContainerId",
      ),
      destinationLocationId: formPlacementLocationId(
        formData,
        "destinationLocationId",
      ),
      quantity,
      sourceContainerId: formPlacementContainerId(
        formData,
        "sourceContainerId",
      ),
      sourceLocationId: formPlacementLocationId(
        formData,
        "sourceLocationId",
      ),
    });
    revalidateInventoryPaths(item.id);

    return {
      status: "success",
      message: `Moved ${quantity} · ${formatInventoryItemPlacementSummary(item)}`,
    };
  } catch (error) {
    return actionError(error, "Could not move units.");
  }
}

export async function removeInventoryUnitsAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const quantity = formNumber(formData, "quantity") ?? 1;
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    const item = await removeInventoryItemUnits(itemId, {
      containerId: formPlacementContainerId(formData, "containerId"),
      locationId: formPlacementLocationId(formData, "locationId"),
      quantity,
    });
    revalidateInventoryPaths(item.id);

    return {
      status: "success",
      message: `Removed ${quantity} · ${formatInventoryItemPlacementSummary(item)}`,
    };
  } catch (error) {
    return actionError(error, "Could not remove units.");
  }
}

export async function retryInventoryPreprocessingAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    await retryInventoryPreprocessing(itemId);
    revalidateInventoryPaths(itemId);

    return {
      status: "success",
      message: "Preprocessing retry queued.",
    };
  } catch (error) {
    return actionError(error, "Could not retry preprocessing.");
  }
}

export async function retryInventoryEnrichmentAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formRequiredString(
      formData,
      "itemId",
      "Inventory item ID is required.",
    );
    await retryInventoryEnrichment(itemId);
    revalidateInventoryPaths(itemId);

    return {
      status: "success",
      message: "Enrichment retry queued.",
    };
  } catch (error) {
    return actionError(error, "Could not retry enrichment.");
  }
}

export async function deleteInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formString(formData, "itemId");

    if (!itemId) {
      throw new Error("Inventory item ID is required.");
    }

    const result = await deleteInventoryItem(itemId);
    revalidateInventoryPaths(result.deletedItemId);

    return {
      status: "success",
      message: "Item deleted.",
    };
  } catch (error) {
    return actionError(error, "Could not delete item.");
  }
}

export async function archiveInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formString(formData, "itemId");

    if (!itemId) {
      throw new Error("Inventory item ID is required.");
    }

    const item = await archiveInventoryItem(itemId);
    revalidateArchivePaths(item.id);

    return {
      status: "success",
      message: "Item archived.",
    };
  } catch (error) {
    const state = actionError(error, "Could not archive item.");
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : null;
    // Network/5xx failures may occur after the lifecycle write committed.
    return {
      ...state,
      uncertain: !(typeof status === "number" && status >= 400 && status < 500),
    };
  }
}

export async function restoreInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const itemId = formString(formData, "itemId");

    if (!itemId) {
      throw new Error("Inventory item ID is required.");
    }

    const item = await restoreInventoryItem(itemId);
    revalidateArchivePaths(item.id);

    return {
      status: "success",
      message: "Item restored.",
    };
  } catch (error) {
    const state = actionError(error, "Could not restore item.");
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : null;
    // Network/5xx failures may occur after the lifecycle write committed.
    return {
      ...state,
      uncertain: !(typeof status === "number" && status >= 400 && status < 500),
    };
  }
}

export async function moveInventoryItemsAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    const containerId = formRequiredString(
      formData,
      "containerId",
      "Destination container is required.",
    );
    const movedItemIds = await moveInventoryItemsToContainer(containerId, {
      itemIds: formStringList(formData, "itemIds"),
    });

    revalidateInventoryPaths();
    revalidatePath("/inventory/browse");

    if (containerId) {
      revalidatePath(`/inventory/containers/${containerId}`);
    }

    for (const itemId of movedItemIds) {
      revalidatePath(`/inventory/items/${itemId}`);
    }

    return {
      status: "success",
      message: `${movedItemIds.length} item${movedItemIds.length === 1 ? "" : "s"} moved.`,
    };
  } catch (error) {
    return actionError(error, "Could not move items.");
  }
}

export async function markInventoryClothingItemWornRedirectAction(
  formData: FormData,
): Promise<never> {
  const itemId = formRequiredString(
    formData,
    "itemId",
    "Inventory item ID is required.",
  );
  const returnTo = formInventoryReturnTo(formData);

  try {
    const result = await markInventoryClothingItemWorn(itemId);
    revalidateClothingPaths(result.item.id);
    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "wear-recorded",
        confirmationId: result.wearConfirmation.id,
        itemId,
      }) as Route,
    );
  } catch (error) {
    if (isRedirectSignal(error)) {
      throw error;
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "error",
        message: error instanceof Error ? error.message : "Could not record wear.",
        itemId,
      }) as Route,
    );
  }
}

export async function markInventoryClothingRecommendationWornRedirectAction(
  formData: FormData,
): Promise<never> {
  const recommendationId = formRequiredString(
    formData,
    "recommendationId",
    "Clothing Recommendation ID is required.",
  );
  const optionId = formString(formData, "optionId");
  const returnTo = formInventoryReturnTo(formData);

  try {
    const result = await markInventoryClothingRecommendationWorn(
      recommendationId,
      optionId ? { optionId } : {},
    );

    for (const itemId of result.wearConfirmation.itemIds) {
      revalidateClothingPaths(itemId);
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "wear-recorded",
        confirmationId: result.wearConfirmation.id,
        itemId: result.wearConfirmation.itemIds[0] ?? null,
      }) as Route,
    );
  } catch (error) {
    if (isRedirectSignal(error)) {
      throw error;
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "error",
        message: error instanceof Error ? error.message : "Could not record wear.",
      }) as Route,
    );
  }
}

export async function declineInventoryClothingRecommendationRedirectAction(
  formData: FormData,
): Promise<never> {
  const recommendationId = formRequiredString(
    formData,
    "recommendationId",
    "Clothing Recommendation ID is required.",
  );
  const returnTo = formInventoryReturnTo(formData);

  try {
    await declineInventoryClothingRecommendation(recommendationId);
    revalidatePath("/inventory/clothing");
    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "recommendation-declined",
      }) as Route,
    );
  } catch (error) {
    if (isRedirectSignal(error)) {
      throw error;
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not decline recommendation.",
      }) as Route,
    );
  }
}

export async function undoInventoryClothingWearConfirmationRedirectAction(
  formData: FormData,
): Promise<never> {
  const confirmationId = formRequiredString(
    formData,
    "confirmationId",
    "Wear confirmation ID is required.",
  );
  const itemId = formString(formData, "itemId");
  const returnTo = formInventoryReturnTo(formData);

  try {
    const result = await undoInventoryClothingWearConfirmation(confirmationId);

    for (const item of result.items) {
      revalidateClothingPaths(item.id);
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "wear-undone",
        itemId: itemId ?? result.items[0]?.id ?? null,
      }) as Route,
    );
  } catch (error) {
    if (isRedirectSignal(error)) {
      throw error;
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "error",
        message: error instanceof Error ? error.message : "Could not undo wear.",
        itemId,
      }) as Route,
    );
  }
}

export async function completeInventoryClothingLaundryRedirectAction(
  formData: FormData,
): Promise<never> {
  const returnTo = formInventoryReturnTo(formData);
  const mode = formRequiredString(
    formData,
    "mode",
    "Laundry mode is required.",
  );
  const itemIds = formStringList(formData, "itemId");
  const firstItemId = itemIds[0] ?? null;

  try {
    const result = await completeInventoryClothingLaundry(
      mode === "all-dirty"
        ? { mode: "all-dirty" }
        : { mode: "selected", itemIds },
    );

    for (const item of result.items) {
      revalidateClothingPaths(item.id);
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "laundry-completed",
        itemId: firstItemId,
      }) as Route,
    );
  } catch (error) {
    if (isRedirectSignal(error)) {
      throw error;
    }

    redirect(
      withClothingActionParams(returnTo, {
        clothingAction: "error",
        message:
          error instanceof Error ? error.message : "Could not complete laundry.",
        itemId: firstItemId,
      }) as Route,
    );
  }
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  return typeof value === "string" ? cleanOptional(value) : null;
}

function formRequiredString(
  formData: FormData,
  key: string,
  message: string,
): string {
  const value = formString(formData, key);

  if (!value) {
    throw new Error(message);
  }

  return value;
}

function formContainerVisualPresetKey(
  formData: FormData,
): InventoryContainerMutationInput["visualPresetKey"] {
  const value = formRequiredString(
    formData,
    "visualPresetKey",
    "Container image is required.",
  );
  const presetKey = INVENTORY_CONTAINER_VISUAL_KEYS.find(
    (candidate) => candidate === value,
  );

  if (!presetKey) {
    throw new Error("Container image must match the repository catalog.");
  }

  return presetKey;
}

function formSelectedContainerId(
  formData: FormData,
  key: string,
): string | null | undefined {
  if (!formData.has(key)) {
    return undefined;
  }

  const value = formString(formData, key);

  if (!value || value === noContainerFormValue) {
    return null;
  }

  return value;
}

function formPlacementContainerId(
  formData: FormData,
  key: string,
): string | null {
  const value = formString(formData, key);

  return !value || value === noContainerFormValue ? null : value;
}

function formPlacementLocationId(
  formData: FormData,
  key: string,
): string | null {
  const value = formString(formData, key);

  return !value || value === noContainerFormValue ? null : value;
}

function formSelectedLocationId(
  formData: FormData,
  key: string,
): string | undefined {
  const value = formString(formData, key);

  return !value || value === noContainerFormValue ? undefined : value;
}

function formNumber(formData: FormData, key: string): number | null {
  const value = formString(formData, key);

  return value === null ? null : Number(value);
}

function formCurrencyCents(formData: FormData, key: string): number | null {
  const value = formString(formData, key);

  if (value === null) {
    return null;
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Estimated value must be a non-negative CAD amount.");
  }

  return Math.round(Number(value) * 100);
}

function formatInventoryItemPlacementSummary(item: {
  placements: Array<{ label: string; quantity: number }>;
  totalQuantity: number;
}): string {
  const placements = item.placements.map((placement) => {
    const referenceId =
      placement.label.match(/\(([^)]+)\)\s*$/)?.[1] ?? placement.label;

    return `${referenceId} ${placement.quantity}`;
  });

  return [`Total ${item.totalQuantity}`, ...placements].join(" · ");
}

function buildInventoryClothingProfileAttributesInput(formData: FormData) {
  const attributes = {
    version: 1 as const,
    kind: formString(formData, "clothingKind") ?? undefined,
    colors: optionalStringList(formStringList(formData, "clothingColors")),
    layer: formString(formData, "clothingLayer") ?? undefined,
    warmth: formString(formData, "clothingWarmth") ?? undefined,
    formality: formString(formData, "clothingFormality") ?? undefined,
    weather: optionalStringList(formStringList(formData, "clothingWeather")),
    occasionTags: optionalStringList(
      formStringList(formData, "clothingOccasionTags"),
    ),
    material: formString(formData, "clothingMaterial") ?? undefined,
    fitNotes: formString(formData, "clothingFitNotes") ?? undefined,
    decisionNotes: formString(formData, "clothingDecisionNotes") ?? undefined,
  };

  return attributes;
}

function formStringList(formData: FormData, key: string): string[] {
  return [
    ...new Set(
      formData
        .getAll(key)
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => value.split(/[,\n]/u))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function optionalStringList(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

function enumValue<T extends string>(
  value: string | null,
  values: readonly T[],
): T | null {
  return value && values.includes(value as T) ? (value as T) : null;
}

function actionError(error: unknown, fallback: string): InventoryActionState {
  return {
    status: "error",
    message: error instanceof Error ? error.message : fallback,
  };
}

function isRedirectSignal(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Redirect:")) {
    return true;
  }

  return (
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT;")
  );
}

function formInventoryReturnTo(formData: FormData): string {
  return formString(formData, "returnTo") ?? "/inventory/clothing";
}

function withClothingActionParams(
  returnTo: string,
  input: {
    clothingAction:
      | "error"
      | "laundry-completed"
      | "recommendation-declined"
      | "wear-recorded"
      | "wear-undone";
    confirmationId?: string | null;
    message?: string | null;
    itemId?: string | null;
  },
): string {
  const url = new URL(returnTo, "https://quantself.local");

  for (const key of [
    "clothingAction",
    "confirmationId",
    "message",
    "itemId",
  ]) {
    url.searchParams.delete(key);
  }

  url.searchParams.set("clothingAction", input.clothingAction);

  if (input.confirmationId) {
    url.searchParams.set("confirmationId", input.confirmationId);
  }

  if (input.message) {
    url.searchParams.set("message", input.message);
  }

  if (input.itemId) {
    url.searchParams.set("itemId", input.itemId);
  }

  return `${url.pathname}${url.search}`;
}

function revalidateInventoryPaths(itemId?: string) {
  revalidatePath("/inventory");
  revalidatePath("/inventory/containers");

  if (itemId) {
    revalidatePath(`/inventory/items/${itemId}`);
  }
}

function revalidateArchivePaths(itemId: string) {
  revalidateInventoryPaths(itemId);
  revalidatePath("/inventory/archive");
  revalidatePath("/inventory/browse");
  revalidatePath("/inventory/processing");
}

function revalidateClothingPaths(itemId: string) {
  revalidateInventoryPaths(itemId);
  revalidatePath("/inventory/clothing");
}
