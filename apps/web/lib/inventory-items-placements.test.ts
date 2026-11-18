import { describe, expect, test } from "bun:test";
import {
  addInventoryUnits,
  moveInventoryUnits,
  removeInventoryUnits,
  reorderInventoryItemImages,
  type InventoryItemRecord,
  type InventoryPlacementMutationRepository,
} from "../../api/src/inventory-service";

describe("Inventory Items and Placements service", () => {
  test("validates positive quantities and distinct move targets", async () => {
    const repository = memoryPlacementRepository([item("duo")]);

    await expect(
      addInventoryUnits(repository, {
        itemId: "duo",
        quantity: 0,
      }),
    ).rejects.toThrow("Quantity must be a positive whole number");

    await expect(
      moveInventoryUnits(repository, {
        destinationContainerId: "R1",
        itemId: "duo",
        quantity: 1,
        sourceContainerId: "R1",
      }),
    ).rejects.toThrow("Choose a different destination Placement");

    await expect(
      addInventoryUnits(repository, {
        containerId: "container-1",
        itemId: "duo",
        locationId: "location-1",
        quantity: 1,
      }),
    ).rejects.toThrow("Choose exactly one Placement target");

    await expect(
      moveInventoryUnits(repository, {
        destinationContainerId: "container-1",
        destinationLocationId: "location-1",
        itemId: "duo",
        quantity: 1,
        sourceContainerId: "source-1",
      }),
    ).rejects.toThrow("Choose exactly one destination Placement target");

    await expect(
      removeInventoryUnits(repository, {
        containerId: "container-1",
        itemId: "duo",
        locationId: "location-1",
        quantity: 1,
      }),
    ).rejects.toThrow("Choose exactly one Placement target");
  });

  test("delegates add, move, and remove with normalized Placement input", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const repository = memoryPlacementRepository([item("duo")], calls);

    await addInventoryUnits(repository, {
      containerId: " B1 ",
      itemId: " duo ",
      note: " Shelf ",
      quantity: 2,
    });
    await moveInventoryUnits(repository, {
      destinationLocationId: "R1",
      itemId: "duo",
      quantity: 1,
      sourceLocationId: "B1",
    });
    await removeInventoryUnits(repository, {
      locationId: "R1",
      itemId: "duo",
      quantity: 1,
    });

    expect(calls).toEqual([
      {
        containerId: "B1",
        itemId: "duo",
        locationId: null,
        note: "Shelf",
        operation: "add",
        quantity: 2,
      },
      {
        destinationContainerId: null,
        destinationLocationId: "R1",
        itemId: "duo",
        operation: "move",
        quantity: 1,
        sourceContainerId: null,
        sourceLocationId: "B1",
      },
      {
        containerId: null,
        itemId: "duo",
        locationId: "R1",
        operation: "remove",
        quantity: 1,
      },
    ]);
  });

  test("passes one exact ordered Item Image list to persistence", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const repository = memoryPlacementRepository([item("duo")], calls);

    await reorderInventoryItemImages(repository, {
      imageIds: ["image-2", "image-1", "image-2"],
      itemId: "duo",
    });

    expect(calls.at(-1)).toEqual({
      imageIds: ["image-2", "image-1"],
      itemId: "duo",
      operation: "reorder",
    });
  });
});

function memoryPlacementRepository(
  items: InventoryItemRecord[],
  calls: Array<Record<string, unknown>> = [],
): InventoryPlacementMutationRepository {
  const byId = new Map(items.map((item) => [item.id, item]));

  return {
    getInventoryItem: async (id) => byId.get(id) ?? null,
    addInventoryUnits: async (input) => {
      calls.push({ operation: "add", ...input });
      return byId.get(input.itemId) as InventoryItemRecord;
    },
    moveInventoryUnits: async (input) => {
      calls.push({ operation: "move", ...input });
      return byId.get(input.itemId) as InventoryItemRecord;
    },
    removeInventoryUnits: async (input) => {
      calls.push({ operation: "remove", ...input });
      return byId.get(input.itemId) as InventoryItemRecord;
    },
    reorderInventoryItemImages: async (input) => {
      calls.push({ operation: "reorder", ...input });
      return byId.get(input.itemId) as InventoryItemRecord;
    },
  };
}

function item(
  id: string,
  overrides: Partial<InventoryItemRecord> = {},
): InventoryItemRecord {
  return {
    acquisitionSource: null,
    aliases: [],
    audioNotes: [],
    captureSessionId: null,
    captureText: null,
    capturedAt: new Date("2026-07-27T12:00:00.000Z"),
    category: null,
    container: null,
    containerId: null,
    containerLabel: null,
    costCents: null,
    costCurrency: "CAD",
    id,
    images: [],
    importance: "MEDIUM",
    kind: "ITEM",
    locationId: null,
    locationName: null,
    metadata: {},
    note: null,
    originLocationId: null,
    originLocationName: null,
    placements: [],
    searchText: "",
    status: "KEEP",
    tags: [],
    title: "Life Solution DUO",
    totalQuantity: 0,
    ...overrides,
  };
}
