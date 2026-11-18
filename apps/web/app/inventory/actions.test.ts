import { afterEach, describe, expect, mock, test } from "bun:test";
import { initialInventoryActionState } from "./action-state";

const addInventoryUnitsCalls: Array<Record<string, unknown>> = [];
const addInventoryItemUnitsCalls: Array<{
  input: Record<string, unknown>;
  itemId: string;
}> = [];
const archiveInventoryItemCalls: string[] = [];
let lifecycleError: Error | null = null;
const captureInventoryItemCalls: Array<Record<string, unknown>> = [];
const createInventoryContainerCalls: Array<Record<string, unknown>> = [];
const deleteInventoryContainerCalls: Array<Record<string, unknown>> = [];
const deleteInventoryItemCalls: string[] = [];
const completeInventoryClothingLaundryCalls: Array<Record<string, unknown>> = [];
const declineInventoryClothingRecommendationCalls: string[] = [];
const markInventoryClothingItemWornCalls: string[] = [];
const markInventoryClothingRecommendationWornCalls: Array<{
  input: Record<string, unknown>;
  recommendationId: string;
}> = [];
const moveInventoryItemUnitsCalls: Array<{
  input: Record<string, unknown>;
  itemId: string;
}> = [];
const moveInventoryItemsToContainerCalls: Array<{
  containerId: string;
  input: Record<string, unknown>;
}> = [];
const removeInventoryItemUnitsCalls: Array<{
  input: Record<string, unknown>;
  itemId: string;
}> = [];
const retryInventoryEnrichmentCalls: string[] = [];
const retryInventoryPreprocessingCalls: string[] = [];
const restoreInventoryItemCalls: string[] = [];
const undoInventoryClothingWearConfirmationCalls: string[] = [];
const updateInventoryItemCalls: Array<{
  input: Record<string, unknown>;
  itemId: string;
}> = [];
const updateInventoryClothingProfileCalls: Array<{
  input: Record<string, unknown>;
  itemId: string;
}> = [];
const saveInventoryCaptureSessionDefaultsCalls: Array<Record<string, unknown>> =
  [];
const revalidatedPaths: string[] = [];

let updateInventoryItemError: Error | null = null;
let ownerAuthenticated = true;
let ownerSessionChecks = 0;
let redirectAsNextSignal = false;
let redirectTarget: string | null = null;
let existingContainer: Record<string, unknown> | null = {
  createdAt: new Date("2026-07-13T09:00:00.000Z"),
  id: "container-1",
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
  updatedAt: new Date("2026-07-13T09:00:00.000Z"),
  visualPresetKey: "39L",
};

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatedPaths.push(path);
  },
}));

mock.module("next/navigation", () => ({
  redirect: (href: string) => {
    redirectTarget = href;

    if (redirectAsNextSignal) {
      const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
      error.digest = `NEXT_REDIRECT;replace;${href};303;`;
      throw error;
    }

    throw new Error(`Redirect:${href}`);
  },
}));

mock.module("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=test-session" }),
}));

mock.module("@/lib/owner-session-server", () => ({
  assertOwnerActionSession: async () => {
    ownerSessionChecks += 1;
    if (!ownerAuthenticated) {
      throw new Error("Authentication required.");
    }
  },
}));

mock.module("@/lib/quantself-api-client", () => ({
  getActiveInventoryCaptureSession: async () => null,
  isApiAuthenticationError: () => false,
  isApiNotFoundError: () => false,
  listActiveInventoryItems: async () => [],
  listInventoryContainers: async () => [],
  listInventoryContainerVisuals: async () => ({
    editableVisuals: [],
    visualPresets: [],
  }),
  listInventoryItems: async () => [],
  resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
  createInventoryContainer: async (input: Record<string, unknown>) => {
    createInventoryContainerCalls.push(input);

    return {
      createdAt: "2026-07-13T09:00:00.000Z",
      id: input.id ?? `container-${createInventoryContainerCalls.length}`,
      location: input.locationName
        ? {
            id: "location-1",
            kind: "STORAGE",
            name: input.locationName,
          }
        : null,
      locationId: input.locationName ? "location-1" : null,
      metadata: {},
      name: input.name,
      normalizedName: String(input.name).toLowerCase(),
      referenceId: "BIN-0001",
      sizeLiters: input.sizeLiters ?? null,
      updatedAt: "2026-07-13T09:00:00.000Z",
      visualPreset: null,
      visualPresetKey: input.visualPresetKey,
    };
  },
  archiveInventoryItem: async (itemId: string) => {
    archiveInventoryItemCalls.push(itemId);
    if (lifecycleError) throw lifecycleError;

    return {
      archivedAt: "2026-07-28T12:00:00.000Z",
      id: itemId,
    };
  },
  markInventoryClothingItemWorn: async (itemId: string) => {
    markInventoryClothingItemWornCalls.push(itemId);

    return {
      item: {
        id: itemId,
      },
      wearConfirmation: {
        createdAt: "2026-08-03T10:30:00.000Z",
        id: "wear-1",
        itemIds: [itemId],
        undoneAt: null,
      },
    };
  },
  markInventoryClothingRecommendationWorn: async (
    recommendationId: string,
    input: Record<string, unknown>,
  ) => {
    markInventoryClothingRecommendationWornCalls.push({
      input,
      recommendationId,
    });

    return {
      recommendation: {
        id: recommendationId,
      },
      wearConfirmation: {
        createdAt: "2026-08-03T10:30:00.000Z",
        id: "wear-1",
        itemIds: ["item-1", "item-2"],
        undoneAt: null,
      },
    };
  },
  declineInventoryClothingRecommendation: async (recommendationId: string) => {
    declineInventoryClothingRecommendationCalls.push(recommendationId);

    return {
      recommendation: {
        id: recommendationId,
      },
    };
  },
  undoInventoryClothingWearConfirmation: async (confirmationId: string) => {
    undoInventoryClothingWearConfirmationCalls.push(confirmationId);

    return {
      items: [{ id: "item-1" }],
      wearConfirmation: {
        createdAt: "2026-08-03T10:30:00.000Z",
        id: confirmationId,
        itemIds: ["item-1"],
        undoneAt: "2026-08-03T10:35:00.000Z",
      },
    };
  },
  completeInventoryClothingLaundry: async (input: Record<string, unknown>) => {
    completeInventoryClothingLaundryCalls.push(input);

    return {
      cleanedCount: 1,
      items: [{ id: "item-1" }],
    };
  },
  addInventoryItemUnits: async (
    itemId: string,
    input: Record<string, unknown>,
  ) => {
    addInventoryItemUnitsCalls.push({ input, itemId });

    return {
      archivedAt: null,
      id: itemId,
      imageId: null,
      placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
      title: "Travel pouch",
      totalQuantity: 2,
    };
  },
  moveInventoryItemUnits: async (
    itemId: string,
    input: Record<string, unknown>,
  ) => {
    moveInventoryItemUnitsCalls.push({ input, itemId });

    return {
      archivedAt: null,
      id: itemId,
      imageId: null,
      placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
      title: "Travel pouch",
      totalQuantity: 2,
    };
  },
  captureInventoryItem: async (input: Record<string, unknown>) => {
    captureInventoryItemCalls.push(input);

    return {
      item: {
        id: "item-1",
      },
    };
  },
  deleteInventoryItem: async (itemId: string) => {
    deleteInventoryItemCalls.push(itemId);

    return {
      deletedItemId: itemId,
    };
  },
  deleteInventoryContainer: async (id: string) => {
    deleteInventoryContainerCalls.push({ id });

    if (id === "missing-container") {
      throw new Error("Container was not found.");
    }

    return existingContainer;
  },
  moveInventoryItemsToContainer: async (
    containerId: string,
    input: Record<string, unknown>,
  ) => {
    moveInventoryItemsToContainerCalls.push({ containerId, input });

    return ["item-duo", "item-spare"];
  },
  removeInventoryItemUnits: async (
    itemId: string,
    input: Record<string, unknown>,
  ) => {
    removeInventoryItemUnitsCalls.push({ input, itemId });

    return {
      archivedAt: null,
      id: itemId,
      imageId: null,
      placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 1 }],
      title: "Travel pouch",
      totalQuantity: 1,
    };
  },
  retryInventoryEnrichment: async (itemId: string) => {
    retryInventoryEnrichmentCalls.push(itemId);
    return { id: itemId };
  },
  retryInventoryPreprocessing: async (itemId: string) => {
    retryInventoryPreprocessingCalls.push(itemId);
    return { id: itemId };
  },
  getInventoryContainer: async (id: string) => {
    if (id === "missing-container") {
      return null;
    }

    return existingContainer
      ? {
          ...existingContainer,
          createdAt: "2026-07-13T09:00:00.000Z",
          updatedAt: "2026-07-13T09:00:00.000Z",
        }
      : null;
  },
  restoreInventoryItem: async (itemId: string) => {
    restoreInventoryItemCalls.push(itemId);
    if (lifecycleError) throw lifecycleError;

    return {
      archivedAt: null,
      id: itemId,
    };
  },
  saveInventoryCaptureSessionDefaults: async (
    input: Record<string, unknown>,
  ) => {
    saveInventoryCaptureSessionDefaultsCalls.push(input);

    return {
      session: {
        id: "session-1",
      },
    };
  },
  updateInventoryContainer: async (
    id: string,
    input: Record<string, unknown>,
  ) => {
    createInventoryContainerCalls.push({ id, ...input });

    return {
      createdAt: "2026-07-13T09:00:00.000Z",
      id,
      location: input.locationName
        ? {
            id: "location-1",
            kind: "STORAGE",
            name: input.locationName,
          }
        : null,
      locationId: input.locationName ? "location-1" : null,
      metadata: {},
      name: input.name,
      normalizedName: String(input.name).toLowerCase(),
      referenceId: "BIN-0007",
      sizeLiters: input.sizeLiters ?? null,
      updatedAt: "2026-07-13T09:00:00.000Z",
      visualPreset: null,
      visualPresetKey: input.visualPresetKey,
    };
  },
  updateInventoryItem: async (
    itemId: string,
    input: Record<string, unknown>,
  ) => {
    updateInventoryItemCalls.push({ input, itemId });

    if (updateInventoryItemError) {
      throw updateInventoryItemError;
    }

    return {
      archivedAt: null,
      id: itemId,
      imageId: null,
      placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
      title: String(input.title ?? "Travel pouch"),
      totalQuantity: 2,
    };
  },
  updateInventoryClothingProfile: async (
    itemId: string,
    input: Record<string, unknown>,
  ) => {
    updateInventoryClothingProfileCalls.push({ input, itemId });

    return {
      clothingProfile: {
        attributes: input.attributes,
        createdAt: "2026-08-03T09:00:00.000Z",
        isDirty: input.isDirty,
        itemId,
        updatedAt: "2026-08-03T10:00:00.000Z",
      },
      item: {
        archivedAt: null,
        id: itemId,
      },
    };
  },
}));

mock.module("@/lib/inventory-prisma-repository", () => ({
  getInventoryAssetFile: async () => null,
  getInventoryAudioFile: async () => null,
  getInventoryImageFile: async () => null,
  inventoryRepository: {
    getContainer: async () => existingContainer,
    kind: "mock-repository",
  },
}));

mock.module("@/lib/inventory-service", () => ({
  INVENTORY_ACQUISITION_SOURCE_VALUES: [
    "online",
    "retail",
    "gift",
    "found",
    "work",
    "secondhand",
    "other",
  ],
  INVENTORY_CATEGORY_VALUES: [
    "food",
    "drink",
    "medical",
    "entertainment",
    "office",
    "sports",
    "clothing",
    "technology",
    "cosmetics",
    "documents",
    "tools",
    "cleaning",
    "kitchen",
    "household",
    "other",
  ],
  INVENTORY_IMPORTANCE_VALUES: ["HIGH", "MEDIUM", "LOW"],
  INVENTORY_ITEM_KINDS: ["ITEM", "GROUP"],
  INVENTORY_ITEM_STATUSES: ["KEEP", "DONATE", "TRASH", "UNSURE"],
  readInventoryItemManualFieldLocks: () => [],
  addInventoryUnits: async (
    _repository: unknown,
    input: Record<string, unknown>,
  ) => {
    addInventoryUnitsCalls.push(input);
    return {
      id: input.itemId,
      placements: [
        {
          container: { name: "Blue bin 4", referenceId: "BIN-0004" },
          quantity: 2,
        },
      ],
      totalQuantity: 2,
    };
  },
  cleanOptional: (value: string | null | undefined) => {
    const trimmed = value?.trim();

    return trimmed ? trimmed : null;
  },
  archiveInventoryItem: async (
    _repository: unknown,
    input: Record<string, unknown>,
  ) => ({ archivedAt: new Date(), id: input.id }),
  createInventoryContainer: async (
    _repository: unknown,
    input: Record<string, unknown>,
  ) => {
    createInventoryContainerCalls.push(input);

    return {
      createdAt: new Date("2026-07-13T09:00:00.000Z"),
      id: input.id ?? `container-${createInventoryContainerCalls.length}`,
      location: input.locationName
        ? {
            id: "location-1",
            kind: "STORAGE",
            name: input.locationName,
          }
        : null,
      locationId: input.locationName ? "location-1" : null,
      metadata: {},
      name: input.name,
      normalizedName: String(input.name).toLowerCase(),
      referenceId: input.referenceId || "BIN-0001",
      sizeLiters: input.sizeLiters ?? null,
      updatedAt: new Date("2026-07-13T09:00:00.000Z"),
      visualPresetKey: input.visualPresetKey,
    };
  },
  deleteInventoryContainer: async (
    _repository: unknown,
    input: Record<string, unknown>,
  ) => {
    deleteInventoryContainerCalls.push(input);

    if (!input.id) {
      throw new Error("Container ID is required.");
    }

    if (input.id === "missing-container") {
      throw new Error("Container was not found.");
    }

    return existingContainer;
  },
  moveInventoryItems: async (
    _repository: unknown,
    input: { itemIds?: string[] },
  ) => (input.itemIds ?? []).map((id) => ({ id })),
  moveInventoryUnits: async () => ({ id: "item-duo" }),
  removeInventoryUnits: async () => ({ id: "item-duo" }),
  formatInventoryPlacementSummary: (item: {
    placements: Array<{
      container: { referenceId: string };
      quantity: number;
    }>;
    totalQuantity: number;
  }) => {
    const placement = item.placements?.[0];

    return placement
      ? `Total ${item.totalQuantity} · ${placement.container.referenceId} ${placement.quantity}`
      : `Total ${item.totalQuantity ?? 0}`;
  },
  restoreInventoryItem: async (
    _repository: unknown,
    input: Record<string, unknown>,
  ) => ({ archivedAt: null, id: input.id }),
  saveCaptureSession: async () => ({
    defaultContainerLabel: null,
    defaultDestinationLocation: null,
    defaultOriginLocation: null,
    id: "session-1",
    label: "Apartment reset",
    note: null,
    startedAt: new Date("2026-07-13T09:00:00.000Z"),
  }),
}));

afterEach(() => {
  lifecycleError = null;
  addInventoryUnitsCalls.length = 0;
  addInventoryItemUnitsCalls.length = 0;
  archiveInventoryItemCalls.length = 0;
  completeInventoryClothingLaundryCalls.length = 0;
  declineInventoryClothingRecommendationCalls.length = 0;
  captureInventoryItemCalls.length = 0;
  createInventoryContainerCalls.length = 0;
  deleteInventoryContainerCalls.length = 0;
  deleteInventoryItemCalls.length = 0;
  markInventoryClothingItemWornCalls.length = 0;
  markInventoryClothingRecommendationWornCalls.length = 0;
  moveInventoryItemUnitsCalls.length = 0;
  moveInventoryItemsToContainerCalls.length = 0;
  removeInventoryItemUnitsCalls.length = 0;
  retryInventoryEnrichmentCalls.length = 0;
  retryInventoryPreprocessingCalls.length = 0;
  restoreInventoryItemCalls.length = 0;
  undoInventoryClothingWearConfirmationCalls.length = 0;
  updateInventoryClothingProfileCalls.length = 0;
  updateInventoryItemCalls.length = 0;
  saveInventoryCaptureSessionDefaultsCalls.length = 0;
  revalidatedPaths.length = 0;
  updateInventoryItemError = null;
  ownerAuthenticated = true;
  ownerSessionChecks = 0;
  redirectAsNextSignal = false;
  redirectTarget = null;
  existingContainer = {
    createdAt: new Date("2026-07-13T09:00:00.000Z"),
    id: "container-1",
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
    updatedAt: new Date("2026-07-13T09:00:00.000Z"),
    visualPresetKey: "39L",
  };
});

describe("inventory actions", () => {
  test("saves capture session defaults through the API seam", async () => {
    const { saveCaptureSessionAction } = await import("./actions");
    const formData = new FormData();

    formData.set("captureSessionId", "session-1");
    formData.set("label", "Apartment reset");
    formData.set("originRoom", "Office");
    formData.set("destinationLocation", "Hall closet");
    formData.set("defaultContainerId", "container-1");
    formData.set("defaultContainerLabel", "Blue bin 4");
    formData.set("note", "Keep travel gear together.");

    const result = await saveCaptureSessionAction(
      initialInventoryActionState,
      formData,
    );

    expect(saveInventoryCaptureSessionDefaultsCalls).toEqual([
      {
        defaultContainerId: "container-1",
        defaultContainerLabel: "Blue bin 4",
        destinationLocation: "Hall closet",
        id: "session-1",
        label: "Apartment reset",
        note: "Keep travel gear together.",
        originRoom: "Office",
      },
    ]);
    expect(result).toEqual({
      message: "Session defaults saved.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual(["/inventory", "/inventory/containers"]);
  });

  test("routes existing-item add-units through the API seam without an owner-action precheck", async () => {
    ownerAuthenticated = false;
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("captureMode", "existing");
    formData.set("existingItemId", "item-duo");
    formData.set("containerId", "container-blue-bin");
    formData.set("quantity", "1");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(addInventoryItemUnitsCalls).toEqual([
      {
        input: {
          containerId: "container-blue-bin",
          locationId: null,
          quantity: 1,
        },
        itemId: "item-duo",
      },
    ]);
    expect(addInventoryUnitsCalls).toEqual([]);
    expect(ownerSessionChecks).toBe(0);
    expect(result).toEqual({
      message: "Added 1 · Total 2 · BIN-0004 2",
      status: "success",
    });
  });

  test("adds units to an existing item without uploading or creating shared data", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("captureMode", "existing");
    formData.set("existingItemId", "item-duo");
    formData.set("containerId", "container-blue-bin");
    formData.set("quantity", "1");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(addInventoryItemUnitsCalls).toEqual([
      {
        input: {
          containerId: "container-blue-bin",
          locationId: null,
          quantity: 1,
        },
        itemId: "item-duo",
      },
    ]);
    expect(addInventoryUnitsCalls).toEqual([]);
    expect(ownerSessionChecks).toBe(0);
    expect(result).toEqual({
      message: "Added 1 · Total 2 · BIN-0004 2",
      status: "success",
    });
  });

  test("moves units through the API seam without an owner-action precheck", async () => {
    ownerAuthenticated = false;
    const { moveInventoryUnitsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-duo");
    formData.set("sourceContainerId", "container-source");
    formData.set("destinationContainerId", "container-destination");
    formData.set("quantity", "1");

    const result = await moveInventoryUnitsAction(
      initialInventoryActionState,
      formData,
    );

    expect(moveInventoryItemUnitsCalls).toEqual([
      {
        input: {
          destinationContainerId: "container-destination",
          destinationLocationId: null,
          quantity: 1,
          sourceContainerId: "container-source",
          sourceLocationId: null,
        },
        itemId: "item-duo",
      },
    ]);
    expect(ownerSessionChecks).toBe(0);
    expect(result).toEqual({
      message: "Moved 1 · Total 2 · BIN-0004 2",
      status: "success",
    });
  });

  test("adds units to a direct Inventory Location through the API seam", async () => {
    const { addInventoryUnitsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-duo");
    formData.set("containerId", "__none");
    formData.set("locationId", "location-pantry");
    formData.set("quantity", "2");

    const result = await addInventoryUnitsAction(
      initialInventoryActionState,
      formData,
    );

    expect(addInventoryItemUnitsCalls).toEqual([
      {
        input: {
          containerId: null,
          locationId: "location-pantry",
          note: null,
          quantity: 2,
        },
        itemId: "item-duo",
      },
    ]);
    expect(result).toEqual({
      message: "Added 2 · Total 2 · BIN-0004 2",
      status: "success",
    });
  });

  test("moves units between Inventory Location and Container targets", async () => {
    const { moveInventoryUnitsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-duo");
    formData.set("sourceContainerId", "__none");
    formData.set("sourceLocationId", "location-pantry");
    formData.set("destinationContainerId", "container-destination");
    formData.set("quantity", "1");

    const result = await moveInventoryUnitsAction(
      initialInventoryActionState,
      formData,
    );

    expect(moveInventoryItemUnitsCalls).toEqual([
      {
        input: {
          destinationContainerId: "container-destination",
          destinationLocationId: null,
          quantity: 1,
          sourceContainerId: null,
          sourceLocationId: "location-pantry",
        },
        itemId: "item-duo",
      },
    ]);
    expect(result).toEqual({
      message: "Moved 1 · Total 2 · BIN-0004 2",
      status: "success",
    });
  });

  test("removes units through the API seam without an owner-action precheck", async () => {
    ownerAuthenticated = false;
    const { removeInventoryUnitsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-duo");
    formData.set("containerId", "container-source");
    formData.set("quantity", "1");

    const result = await removeInventoryUnitsAction(
      initialInventoryActionState,
      formData,
    );

    expect(removeInventoryItemUnitsCalls).toEqual([
      {
        input: {
          containerId: "container-source",
          locationId: null,
          quantity: 1,
        },
        itemId: "item-duo",
      },
    ]);
    expect(ownerSessionChecks).toBe(0);
    expect(result).toEqual({
      message: "Removed 1 · Total 1 · BIN-0004 1",
      status: "success",
    });
  });

  test("removes unplaced units through the API seam", async () => {
    const { removeInventoryUnitsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-duo");
    formData.set("containerId", "__none");
    formData.set("locationId", "__none");
    formData.set("quantity", "1");

    const result = await removeInventoryUnitsAction(
      initialInventoryActionState,
      formData,
    );

    expect(removeInventoryItemUnitsCalls).toEqual([
      {
        input: {
          containerId: null,
          locationId: null,
          quantity: 1,
        },
        itemId: "item-duo",
      },
    ]);
    expect(result).toEqual({
      message: "Removed 1 · Total 1 · BIN-0004 1",
      status: "success",
    });
  });

  test("queues processing retries and refreshes the Item", async () => {
    const {
      retryInventoryEnrichmentAction,
      retryInventoryPreprocessingAction,
    } = await import("./actions");
    const formData = new FormData();
    formData.set("itemId", "item-duo");

    expect(
      await retryInventoryPreprocessingAction(
        initialInventoryActionState,
        formData,
      ),
    ).toEqual({ message: "Preprocessing retry queued.", status: "success" });
    expect(
      await retryInventoryEnrichmentAction(
        initialInventoryActionState,
        formData,
      ),
    ).toEqual({ message: "Enrichment retry queued.", status: "success" });
    expect(retryInventoryPreprocessingCalls).toEqual(["item-duo"]);
    expect(retryInventoryEnrichmentCalls).toEqual(["item-duo"]);
    expect(revalidatedPaths).toContain("/inventory/items/item-duo");
  });

  test("moves selected items to a container through the API seam", async () => {
    ownerAuthenticated = false;
    const { moveInventoryItemsAction } = await import("./actions");
    const formData = new FormData();

    formData.set("containerId", "container-destination");
    formData.append("itemIds", "item-duo");
    formData.append("itemIds", "item-spare");

    const result = await moveInventoryItemsAction(
      initialInventoryActionState,
      formData,
    );

    expect(moveInventoryItemsToContainerCalls).toEqual([
      {
        containerId: "container-destination",
        input: {
          itemIds: ["item-duo", "item-spare"],
        },
      },
    ]);
    expect(ownerSessionChecks).toBe(0);
    expect(result).toEqual({
      message: "2 items moved.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/browse",
      "/inventory/containers/container-destination",
      "/inventory/items/item-duo",
      "/inventory/items/item-spare",
    ]);
  });

  test("queues preprocessing feedback for a typed-text-only capture", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("captureSessionId", "session-1");
    formData.set("captureText", "Passport pouch with charger and pen.");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(captureInventoryItemCalls).toEqual([
      {
        acquisitionSource: null,
        category: null,
        captureSessionId: "session-1",
        captureText: "Passport pouch with charger and pen.",
        containerId: undefined,
        containerLabelOverride: null,
        costCents: null,
        costCurrency: "CAD",
        importance: null,
        kind: null,
        locationId: undefined,
        note: null,
        quantity: 1,
        status: null,
        title: null,
      },
    ]);
    expect(result).toEqual({
      message: "Capture saved. Inventory preprocessing queued.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual(["/inventory", "/inventory/containers"]);
  });

  test("passes explicit no-container picker selection as null", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("captureSessionId", "session-1");
    formData.set("captureText", "Loose adapter for later sorting.");
    formData.set("containerId", "__none");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(captureInventoryItemCalls).toHaveLength(1);
    expect(captureInventoryItemCalls[0]?.captureText).toBe(
      "Loose adapter for later sorting.",
    );
    expect(captureInventoryItemCalls[0]?.containerId).toBeNull();
    expect(result.status).toBe("success");
  });

  test("passes a direct Inventory Location without a Container target", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();
    formData.set("captureText", "Oat milk");
    formData.set("category", "food");
    formData.set("containerId", "__none");
    formData.set("locationId", "location-pantry");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(result.status).toBe("success");
    expect(captureInventoryItemCalls).toHaveLength(1);
    expect(captureInventoryItemCalls[0]).toEqual(
      expect.objectContaining({
        category: "food",
        containerId: null,
        locationId: "location-pantry",
      }),
    );
  });

  test("queues structured capture metadata through the API capture route", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("captureSessionId", "session-1");
    formData.set("title", "Travel drawer pouch");
    formData.set("kind", "GROUP");
    formData.set("status", "KEEP");
    formData.set("importance", "HIGH");
    formData.set("category", "documents");
    formData.set("acquisitionSource", "gift");
    formData.set("estimatedValue", "12.50");
    formData.set("containerLabelOverride", "Travel drawer");
    formData.set("itemNote", "Keep travel documents together.");

    const result = await createInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(captureInventoryItemCalls).toEqual([
      {
        acquisitionSource: "gift",
        category: "documents",
        captureSessionId: "session-1",
        captureText: "Keep travel documents together.",
        containerId: undefined,
        containerLabelOverride: "Travel drawer",
        costCents: 1250,
        costCurrency: "CAD",
        importance: "HIGH",
        kind: "GROUP",
        locationId: undefined,
        note: "Keep travel documents together.",
        quantity: 1,
        status: "KEEP",
        title: "Travel drawer pouch",
      },
    ]);
    expect(result.status).toBe("success");
  });

  test("ignores invalid enum values and rejects malformed estimated value input", async () => {
    const { createInventoryItemAction } = await import("./actions");
    const invalidEnumFormData = new FormData();

    invalidEnumFormData.set("captureText", "Loose cables for later sorting.");
    invalidEnumFormData.set("category", "misc electronics");
    invalidEnumFormData.set("acquisitionSource", "borrowed");

    const invalidEnumResult = await createInventoryItemAction(
      initialInventoryActionState,
      invalidEnumFormData,
    );

    expect(invalidEnumResult.status).toBe("success");
    expect(captureInventoryItemCalls).toHaveLength(1);
    expect(captureInventoryItemCalls[0]?.category).toBeNull();
    expect(captureInventoryItemCalls[0]?.acquisitionSource).toBeNull();

    const invalidValueFormData = new FormData();

    invalidValueFormData.set("captureText", "Loose cables for later sorting.");
    invalidValueFormData.set("estimatedValue", "12.345");

    const invalidValueResult = await createInventoryItemAction(
      initialInventoryActionState,
      invalidValueFormData,
    );

    expect(captureInventoryItemCalls).toHaveLength(1);
    expect(invalidValueResult).toEqual({
      message: "Estimated value must be a non-negative CAD amount.",
      status: "error",
    });
  });

  test("creates a container and returns the picker option", async () => {
    const { createInventoryContainerAction } = await import("./actions");
    const formData = new FormData();

    formData.set("containerName", "Blue bin 4");
    formData.set("locationName", "Garage shelf A");
    formData.set("sizeLiters", "45");
    formData.set("visualPresetKey", "39L");

    const result = await createInventoryContainerAction(
      { status: "idle", message: "", container: null },
      formData,
    );

    expect(createInventoryContainerCalls).toEqual([
      {
        locationName: "Garage shelf A",
        name: "Blue bin 4",
        sizeLiters: 45,
        visualPresetKey: "39L",
      },
    ]);
    expect(result).toEqual({
      container: {
        id: "container-1",
        locationName: "Garage shelf A",
        name: "Blue bin 4",
        referenceId: "BIN-0001",
        sizeLiters: 45,
        visualPresetKey: "39L",
      },
      message: "Container created.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual(["/inventory", "/inventory/containers"]);
  });

  test("updates a container and its selected container image", async () => {
    const { updateInventoryContainerAction } = await import("./actions");
    const formData = new FormData();

    formData.set("containerId", "container-1");
    formData.set("containerName", "Blue bin 4 updated");
    formData.set("locationName", "Office closet");
    formData.set("sizeLiters", "80");
    formData.set("visualPresetKey", "80L");

    const result = await updateInventoryContainerAction(
      { status: "idle", message: "", container: null },
      formData,
    );

    expect(createInventoryContainerCalls).toEqual([
      {
        id: "container-1",
        locationName: "Office closet",
        name: "Blue bin 4 updated",
        sizeLiters: 80,
        visualPresetKey: "80L",
      },
    ]);
    expect(result).toEqual({
      container: {
        id: "container-1",
        locationName: "Office closet",
        name: "Blue bin 4 updated",
        referenceId: "BIN-0007",
        sizeLiters: 80,
        visualPresetKey: "80L",
      },
      message: "Container updated.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual(["/inventory", "/inventory/containers"]);
  });

  test("deletes a container through the server action", async () => {
    const { deleteInventoryContainerAction } = await import("./actions");
    const formData = new FormData();

    formData.set("containerId", "container-1");

    const result = await deleteInventoryContainerAction(
      { status: "idle", message: "", container: null },
      formData,
    );

    expect(deleteInventoryContainerCalls).toEqual([{ id: "container-1" }]);
    expect(result).toEqual({
      container: null,
      message: "Container deleted.",
      status: "success",
    });
    expect(revalidatedPaths).toEqual(["/inventory", "/inventory/containers"]);
  });

  test("returns delete errors for missing containers", async () => {
    const { deleteInventoryContainerAction } = await import("./actions");
    const formData = new FormData();

    formData.set("containerId", "missing-container");

    const result = await deleteInventoryContainerAction(
      { status: "idle", message: "", container: null },
      formData,
    );

    expect(result).toEqual({
      container: null,
      message: "Container was not found.",
      status: "error",
    });
    expect(revalidatedPaths).toEqual([]);
  });

  test("updates item facts through the API without a Web auth precheck", async () => {
    ownerAuthenticated = false;
    const { updateInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-1");
    formData.set("title", "Travel pouch");
    formData.set("kind", "ITEM");
    formData.set("status", "KEEP");
    formData.set("importance", "HIGH");
    formData.set("category", "documents");
    formData.set("acquisitionSource", "gift");
    formData.set("estimatedValue", "19.95");
    formData.set("tags", "travel, documents\nimportant");
    formData.set("aliases", "passport pouch, travel pouch");
    formData.set("note", "Keep together");
    formData.set("captureText", "Blue zip pouch");

    const result = await updateInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(updateInventoryItemCalls).toEqual([
      {
        input: {
          acquisitionSource: "gift",
          aliases: ["passport pouch", "travel pouch"],
          captureText: "Blue zip pouch",
          category: "documents",
          costCents: 1995,
          costCurrency: "CAD",
          importance: "HIGH",
          kind: "ITEM",
          note: "Keep together",
          status: "KEEP",
          tags: ["travel", "documents", "important"],
          title: "Travel pouch",
        },
        itemId: "item-1",
      },
    ]);
    expect(ownerSessionChecks).toBe(0);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
    ]);
    expect(result).toEqual({
      message: "Item updated. Enrichment refresh queued.",
      status: "success",
    });
  });

  test("updates Clothing Profiles through the API and refreshes the wardrobe path", async () => {
    const { updateInventoryClothingProfileAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-1");
    formData.set("isDirty", "true");
    formData.set("clothingKind", "shirt");
    formData.set("clothingColors", "blue, white");
    formData.set("clothingLayer", "base");
    formData.set("clothingWarmth", "medium");
    formData.set("clothingFormality", "smart-casual");
    formData.set("clothingWeather", "mild, cool");
    formData.set("clothingOccasionTags", "office, travel");
    formData.set("clothingMaterial", "cotton");
    formData.set("clothingFitNotes", "Works untucked.");
    formData.set("clothingDecisionNotes", "Reliable with dark jeans.");

    const result = await updateInventoryClothingProfileAction(
      initialInventoryActionState,
      formData,
    );

    expect(updateInventoryClothingProfileCalls).toEqual([
      {
        input: {
          attributes: {
            colors: ["blue", "white"],
            decisionNotes: "Reliable with dark jeans.",
            fitNotes: "Works untucked.",
            formality: "smart-casual",
            kind: "shirt",
            layer: "base",
            material: "cotton",
            occasionTags: ["office", "travel"],
            version: 1,
            warmth: "medium",
            weather: ["mild", "cool"],
          },
          isDirty: true,
        },
        itemId: "item-1",
      },
    ]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/clothing",
    ]);
    expect(result).toEqual({
      message: "Clothing profile updated.",
      status: "success",
    });
  });

  test("records Clothing wear, revalidates wardrobe paths, and redirects with undo feedback", async () => {
    const { markInventoryClothingItemWornRedirectAction } = await import(
      "./actions"
    );
    const formData = new FormData();

    formData.set("itemId", "item-1");
    formData.set("returnTo", "/inventory/clothing?state=clean");

    await expect(
      markInventoryClothingItemWornRedirectAction(formData),
    ).rejects.toThrow(
      "Redirect:/inventory/clothing?state=clean&clothingAction=wear-recorded&confirmationId=wear-1&itemId=item-1",
    );
    expect(markInventoryClothingItemWornCalls).toEqual(["item-1"]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/clothing",
    ]);
    expect(redirectTarget).toBe(
      "/inventory/clothing?state=clean&clothingAction=wear-recorded&confirmationId=wear-1&itemId=item-1",
    );
  });

  test("records recommendation wear, revalidates selected Clothing items, and redirects with undo feedback", async () => {
    const { markInventoryClothingRecommendationWornRedirectAction } =
      await import("./actions");
    const formData = new FormData();

    formData.set("recommendationId", "recommendation-1");
    formData.set("optionId", "option-primary");
    formData.set("returnTo", "/inventory/clothing");

    await expect(
      markInventoryClothingRecommendationWornRedirectAction(formData),
    ).rejects.toThrow(
      "Redirect:/inventory/clothing?clothingAction=wear-recorded&confirmationId=wear-1&itemId=item-1",
    );
    expect(markInventoryClothingRecommendationWornCalls).toEqual([
      {
        input: {
          optionId: "option-primary",
        },
        recommendationId: "recommendation-1",
      },
    ]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/clothing",
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-2",
      "/inventory/clothing",
    ]);
    expect(redirectTarget).toBe(
      "/inventory/clothing?clothingAction=wear-recorded&confirmationId=wear-1&itemId=item-1",
    );
  });

  test("declines a Clothing recommendation and redirects with feedback", async () => {
    const { declineInventoryClothingRecommendationRedirectAction } =
      await import("./actions");
    const formData = new FormData();

    formData.set("recommendationId", "recommendation-1");
    formData.set("returnTo", "/inventory/clothing?state=clean");

    await expect(
      declineInventoryClothingRecommendationRedirectAction(formData),
    ).rejects.toThrow(
      "Redirect:/inventory/clothing?state=clean&clothingAction=recommendation-declined",
    );
    expect(declineInventoryClothingRecommendationCalls).toEqual([
      "recommendation-1",
    ]);
    expect(revalidatedPaths).toEqual(["/inventory/clothing"]);
    expect(redirectTarget).toBe(
      "/inventory/clothing?state=clean&clothingAction=recommendation-declined",
    );
  });

  test("undos Clothing wear and redirects back to the current item detail page", async () => {
    const { undoInventoryClothingWearConfirmationRedirectAction } = await import(
      "./actions"
    );
    const formData = new FormData();

    formData.set("confirmationId", "wear-1");
    formData.set("itemId", "item-1");
    formData.set(
      "returnTo",
      "/inventory/items/item-1?returnTo=%2Finventory%2Fclothing",
    );

    await expect(
      undoInventoryClothingWearConfirmationRedirectAction(formData),
    ).rejects.toThrow(
      "Redirect:/inventory/items/item-1?returnTo=%2Finventory%2Fclothing&clothingAction=wear-undone&itemId=item-1",
    );
    expect(undoInventoryClothingWearConfirmationCalls).toEqual(["wear-1"]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/clothing",
    ]);
    expect(redirectTarget).toBe(
      "/inventory/items/item-1?returnTo=%2Finventory%2Fclothing&clothingAction=wear-undone&itemId=item-1",
    );
  });

  test("completes Clothing laundry for selected items and redirects with success feedback", async () => {
    const { completeInventoryClothingLaundryRedirectAction } = await import(
      "./actions"
    );
    const formData = new FormData();

    formData.set("mode", "selected");
    formData.set("itemId", "item-1");
    formData.set("returnTo", "/inventory/clothing?state=dirty");
    redirectAsNextSignal = true;

    await expect(
      completeInventoryClothingLaundryRedirectAction(formData),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(completeInventoryClothingLaundryCalls).toEqual([
      {
        mode: "selected",
        itemIds: ["item-1"],
      },
    ]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/clothing",
    ]);
    expect(redirectTarget).toBe(
      "/inventory/clothing?state=dirty&clothingAction=laundry-completed&itemId=item-1",
    );
  });

  test("permanently deletes through the API without Web auth or storage", async () => {
    const { deleteInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    ownerAuthenticated = false;
    formData.set("itemId", "item-1");

    const result = await deleteInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(deleteInventoryItemCalls).toEqual(["item-1"]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
    ]);
    expect(result).toEqual({
      message: "Item deleted.",
      status: "success",
    });
  });

  test("archives an item through the API client and refreshes archive views", async () => {
    const { archiveInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-1");

    const result = await archiveInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(archiveInventoryItemCalls).toEqual(["item-1"]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/archive",
      "/inventory/browse",
      "/inventory/processing",
    ]);
    expect(result).toEqual({
      message: "Item archived.",
      status: "success",
    });
  });

  test("restores an item through the API client and refreshes archive views", async () => {
    const { restoreInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "item-1");

    const result = await restoreInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(restoreInventoryItemCalls).toEqual(["item-1"]);
    expect(revalidatedPaths).toEqual([
      "/inventory",
      "/inventory/containers",
      "/inventory/items/item-1",
      "/inventory/archive",
      "/inventory/browse",
      "/inventory/processing",
    ]);
    expect(result).toEqual({
      message: "Item restored.",
      status: "success",
    });
  });

  test("lifecycle actions distinguish definite API rejection from ambiguous delivery", async () => {
    const { archiveInventoryItemAction, restoreInventoryItemAction } =
      await import("./actions");
    for (const action of [
      archiveInventoryItemAction,
      restoreInventoryItemAction,
    ]) {
      for (const status of [undefined, 503, 403]) {
        lifecycleError = Object.assign(
          new Error("Delivery failed"),
          status ? { status } : {},
        );
        const form = new FormData();
        form.set("itemId", "item-1");
        const state = await action(initialInventoryActionState, form);
        expect(state.status).toBe("error");
        expect(state.uncertain).toBe(status !== 403);
      }
    }
    expect(revalidatedPaths).toEqual([]);
  });

  test("returns API errors from item update", async () => {
    updateInventoryItemError = new Error("Inventory item was not found.");
    const { updateInventoryItemAction } = await import("./actions");
    const formData = new FormData();

    formData.set("itemId", "missing-item");

    const result = await updateInventoryItemAction(
      initialInventoryActionState,
      formData,
    );

    expect(revalidatedPaths).toEqual([]);
    expect(result).toEqual({
      message: "Inventory item was not found.",
      status: "error",
    });
  });
});
