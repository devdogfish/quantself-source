import { describe, expect, test } from "bun:test";
import { testContainerVisualPreset } from "@/app/inventory/container-test-fixtures";
import {
  archiveInventoryItem,
  moveInventoryItems,
  restoreInventoryItem,
  type InventoryArchiveRepository,
  type InventoryContainerRecord,
  type InventoryItemRecord,
  type InventoryRelocationRepository,
} from "../../api/src/inventory-service";

const archivedAt = new Date("2026-07-26T18:30:00.000Z");
const sourceContainer = inventoryContainer("container-source", "Source tote");
const destinationContainer = inventoryContainer(
  "container-destination",
  "Destination tote",
);

describe("inventory item archive lifecycle", () => {
  test("archives and restores without losing its last container", async () => {
    const repository = new MemoryArchiveRepository([
      inventoryItem("item-1", {
        container: sourceContainer,
        containerId: sourceContainer.id,
      }),
    ]);

    const archived = await archiveInventoryItem(
      repository,
      { id: " item-1 " },
      archivedAt,
    );

    expect(archived).toMatchObject({
      id: "item-1",
      archivedAt,
      containerId: sourceContainer.id,
      container: { id: sourceContainer.id },
    });
    expect(repository.archiveWrites).toEqual([
      { id: "item-1", archivedAt },
    ]);

    const restored = await restoreInventoryItem(repository, { id: "item-1" });

    expect(restored).toMatchObject({
      id: "item-1",
      archivedAt: null,
      containerId: sourceContainer.id,
      container: { id: sourceContainer.id },
    });
    expect(repository.archiveWrites).toEqual([
      { id: "item-1", archivedAt },
      { id: "item-1", archivedAt: null },
    ]);
  });

  test("archive and restore are idempotent", async () => {
    const repository = new MemoryArchiveRepository([
      inventoryItem("already-archived", { archivedAt }),
      inventoryItem("already-active"),
    ]);

    const archived = await archiveInventoryItem(
      repository,
      { id: "already-archived" },
      new Date("2026-07-27T00:00:00.000Z"),
    );
    const active = await restoreInventoryItem(repository, {
      id: "already-active",
    });

    expect(archived.archivedAt).toEqual(archivedAt);
    expect(active.archivedAt).toBeNull();
    expect(repository.archiveWrites).toEqual([]);
  });

  test("rejects blank and missing item IDs without mutation", async () => {
    const repository = new MemoryArchiveRepository([]);

    expect(archiveInventoryItem(repository, { id: " " }, archivedAt)).rejects.toThrow(
      "Inventory item ID is required.",
    );
    expect(restoreInventoryItem(repository, { id: "missing" })).rejects.toThrow(
      "Inventory item was not found.",
    );
    expect(repository.archiveWrites).toEqual([]);
  });
});

describe("inventory multi-item relocation", () => {
  test("normalizes a multi-selection and moves placed and unplaced items together", async () => {
    const repository = new MemoryRelocationRepository(
      [sourceContainer, destinationContainer],
      [
        inventoryItem("placed", {
          container: sourceContainer,
          containerId: sourceContainer.id,
        }),
        inventoryItem("unplaced"),
      ],
    );

    const moved = await moveInventoryItems(repository, {
      containerId: ` ${destinationContainer.id} `,
      itemIds: [" placed ", "unplaced", "placed", "", "  "],
    });

    expect(repository.moveCalls).toEqual([
      {
        containerId: destinationContainer.id,
        itemIds: ["placed", "unplaced"],
      },
    ]);
    expect(moved.map((item) => [item.id, item.containerId])).toEqual([
      ["placed", destinationContainer.id],
      ["unplaced", destinationContainer.id],
    ]);
  });

  test("rejects invalid input before requesting a move", async () => {
    const repository = new MemoryRelocationRepository(
      [destinationContainer],
      [inventoryItem("item-1")],
    );

    expect(
      moveInventoryItems(repository, {
        containerId: " ",
        itemIds: ["item-1"],
      }),
    ).rejects.toThrow("Destination container is required.");
    expect(
      moveInventoryItems(repository, {
        containerId: destinationContainer.id,
        itemIds: [" ", ""],
      }),
    ).rejects.toThrow("Select at least one inventory item.");
    expect(
      moveInventoryItems(repository, {
        containerId: "missing-container",
        itemIds: ["item-1"],
      }),
    ).rejects.toThrow("Destination container was not found.");
    expect(repository.moveCalls).toEqual([]);
  });

  test("leaves every item unchanged when any selected item is archived or missing", async () => {
    const repository = new MemoryRelocationRepository(
      [sourceContainer, destinationContainer],
      [
        inventoryItem("active", {
          container: sourceContainer,
          containerId: sourceContainer.id,
        }),
        inventoryItem("archived", {
          archivedAt,
          container: sourceContainer,
          containerId: sourceContainer.id,
        }),
      ],
    );
    const before = repository.containerAssignments();

    expect(
      moveInventoryItems(repository, {
        containerId: destinationContainer.id,
        itemIds: ["active", "archived"],
      }),
    ).rejects.toThrow(
      "One or more selected items were missing or archived. Nothing was moved.",
    );
    expect(repository.containerAssignments()).toEqual(before);

    expect(
      moveInventoryItems(repository, {
        containerId: destinationContainer.id,
        itemIds: ["active", "missing"],
      }),
    ).rejects.toThrow(
      "One or more selected items were missing or archived. Nothing was moved.",
    );
    expect(repository.containerAssignments()).toEqual(before);
  });
});

class MemoryArchiveRepository implements InventoryArchiveRepository {
  readonly archiveWrites: Array<{ id: string; archivedAt: Date | null }> = [];

  constructor(private readonly items: InventoryItemRecord[]) {}

  async getInventoryItem(id: string): Promise<InventoryItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async listArchivedItems(): Promise<InventoryItemRecord[]> {
    return this.items.filter((item) => item.archivedAt);
  }

  async setItemArchivedAt(
    id: string,
    value: Date | null,
  ): Promise<InventoryItemRecord> {
    const item = await this.getInventoryItem(id);

    if (!item) {
      throw new Error("Inventory item was not found.");
    }

    item.archivedAt = value;
    this.archiveWrites.push({ id, archivedAt: value });

    return item;
  }
}

class MemoryRelocationRepository implements InventoryRelocationRepository {
  readonly moveCalls: Array<{ containerId: string; itemIds: string[] }> = [];

  constructor(
    private readonly containers: InventoryContainerRecord[],
    private readonly items: InventoryItemRecord[],
  ) {}

  async getContainer(id: string): Promise<InventoryContainerRecord | null> {
    return this.containers.find((container) => container.id === id) ?? null;
  }

  async moveItemsToContainer(input: {
    containerId: string;
    itemIds: string[];
  }): Promise<InventoryItemRecord[]> {
    this.moveCalls.push({
      containerId: input.containerId,
      itemIds: [...input.itemIds],
    });

    const selected = input.itemIds.map((id) =>
      this.items.find((item) => item.id === id),
    );

    if (selected.some((item) => !item || item.archivedAt)) {
      throw new Error(
        "One or more selected items were missing or archived. Nothing was moved.",
      );
    }

    const container = await this.getContainer(input.containerId);

    for (const item of selected as InventoryItemRecord[]) {
      item.containerId = input.containerId;
      item.container = container;
    }

    return selected as InventoryItemRecord[];
  }

  containerAssignments(): Array<[string, string | null]> {
    return this.items.map((item) => [item.id, item.containerId ?? null]);
  }
}

function inventoryContainer(
  id: string,
  name: string,
): InventoryContainerRecord {
  const timestamp = new Date("2026-07-26T12:00:00.000Z");

  return {
    createdAt: timestamp,
    id,
    location: null,
    locationId: null,
    metadata: {},
    name,
    normalizedName: name.toLowerCase(),
    photoFilePath: null,
    referenceId: id.toUpperCase(),
    sizeLiters: null,
    updatedAt: timestamp,
    visualPreset: testContainerVisualPreset,
    visualPresetKey: "39L",
  };
}

function inventoryItem(
  id: string,
  overrides: Partial<InventoryItemRecord> = {},
): InventoryItemRecord {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    assets: [],
    audioNotes: [],
    captureSessionId: null,
    captureText: null,
    capturedAt: new Date("2026-07-26T12:00:00.000Z"),
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
    searchText: id,
    status: "KEEP",
    tags: [],
    title: id,
    ...overrides,
  };
}
