import { beforeEach, describe, expect, mock, test } from "bun:test";

type ItemRow = ReturnType<typeof itemRow>;

let rows: ItemRow[] = [];
let updateManyCalls = 0;
const findManyWhere: unknown[] = [];

const transactionClient = {
  inventoryContainer: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === "destination"
        ? {
            id: where.id,
            location: { name: "Basement" },
            name: "Destination tote",
            referenceId: "BIN-0002",
          }
        : null,
  },
  inventoryItem: {
    findMany: async ({
      where,
    }: {
      include?: unknown;
      orderBy?: unknown;
      select?: unknown;
      where: {
        archivedAt?: null;
        id?: string | { in: string[] };
      };
    }) => selectRows(where),
    update: async ({
      data,
      where,
    }: {
      data: { searchText: string };
      where: { id: string };
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id);

      if (!row) {
        throw new Error("Inventory item was not found.");
      }

      row.searchText = data.searchText;
      return row;
    },
  },
  inventoryItemPlacement: {
    create: async ({
      data,
    }: {
      data: { containerId: string; itemId: string; quantity: number };
    }) => {
      const row = rows.find((candidate) => candidate.id === data.itemId);

      if (!row) {
        throw new Error("Inventory item was not found.");
      }

      updateManyCalls += 1;
      row.placements = [
        placementRow(row.id, data.containerId, null, data.quantity),
      ];
      return row.placements[0];
    },
    deleteMany: async ({ where }: { where: { itemId: string } }) => {
      const row = rows.find((candidate) => candidate.id === where.itemId);

      if (row) {
        row.placements = [];
      }

      return { count: row ? 1 : 0 };
    },
  },
};

mock.module("@quantself/db", () => ({
  prisma: {
    $transaction: async <T>(
      operation: (transaction: typeof transactionClient) => Promise<T>,
    ) => operation(transactionClient),
    inventoryItem: {
      findMany: async ({ where }: { where: unknown }) => {
        findManyWhere.push(where);
        return selectRows(where as Parameters<typeof selectRows>[0]);
      },
      update: async ({
        data,
        where,
      }: {
        data: { archivedAt: Date | null };
        where: { id: string };
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);

        if (!row) {
          throw new Error("Inventory item was not found.");
        }

        row.archivedAt = data.archivedAt;
        return row;
      },
    },
  },
}));

describe("inventory Prisma archive visibility", () => {
  beforeEach(resetRows);

  test("normal lists and container contents exclude archived items", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    expect(
      (await inventoryRepository.listRecentItems(8)).map((item) => item.id),
    ).toEqual(["active", "direct-location", "unplaced"]);
    expect(
      (await inventoryRepository.listAllInventoryItems()).map(
        (item) => item.id,
      ),
    ).toEqual(["active", "direct-location", "unplaced"]);
    expect(
      (await inventoryRepository.listItemsForContainer("source")).map(
        (item) => item.id,
      ),
    ).toEqual(["active"]);
    expect(findManyWhere).toEqual([
      { archivedAt: null },
      { archivedAt: null },
      {
        archivedAt: null,
        placements: { some: { containerId: "source" } },
      },
    ]);
  });

  test("archive list is exclusive and restore preserves the last container", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    expect(
      (await inventoryRepository.listArchivedItems()).map((item) => item.id),
    ).toEqual(["archived"]);

    const restored = await inventoryRepository.setItemArchivedAt(
      "archived",
      null,
    );

    expect(restored).toMatchObject({
      archivedAt: null,
      containerId: "source",
      id: "archived",
    });
    expect(
      (await inventoryRepository.listAllInventoryItems()).map(
        (item) => item.id,
      ),
    ).toEqual(["active", "direct-location", "archived", "unplaced"]);
  });
});

describe("inventory Prisma atomic multi-item relocation", () => {
  beforeEach(resetRows);

  test("moves active placed and unplaced items in one batch", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    const moved = await inventoryRepository.moveItemsToContainer({
      containerId: "destination",
      itemIds: ["active", "unplaced"],
    });

    expect(updateManyCalls).toBe(2);
    expect(moved.map((item) => [item.id, item.containerId])).toEqual([
      ["active", "destination"],
      ["unplaced", "destination"],
    ]);
  });

  test("writes nothing when any selected item is archived", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");
    const before = containerAssignments();

    expect(
      inventoryRepository.moveItemsToContainer({
        containerId: "destination",
        itemIds: ["active", "archived"],
      }),
    ).rejects.toThrow(
      "One or more selected items were missing or archived. Nothing was moved.",
    );

    expect(updateManyCalls).toBe(0);
    expect(containerAssignments()).toEqual(before);
  });

  test("writes nothing when any selected item is missing", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");
    const before = containerAssignments();

    expect(
      inventoryRepository.moveItemsToContainer({
        containerId: "destination",
        itemIds: ["active", "missing"],
      }),
    ).rejects.toThrow(
      "One or more selected items were missing or archived. Nothing was moved.",
    );

    expect(updateManyCalls).toBe(0);
    expect(containerAssignments()).toEqual(before);
  });
});

function resetRows(): void {
  updateManyCalls = 0;
  findManyWhere.length = 0;
  rows = [
    itemRow("active", { containerId: "source" }),
    itemRow("direct-location", { locationId: "location-pantry" }),
    itemRow("archived", {
      archivedAt: new Date("2026-07-26T18:30:00.000Z"),
      containerId: "source",
    }),
    itemRow("unplaced"),
  ];
}

function selectRows(where: {
  archivedAt?: null | { not: null };
  id?: string | { in: string[] };
  placements?: { some: { containerId: string } };
}): ItemRow[] {
  return rows.filter((row) => {
    if (where.archivedAt === null && row.archivedAt !== null) {
      return false;
    }

    if (
      where.archivedAt !== null &&
      typeof where.archivedAt === "object" &&
      where.archivedAt.not === null &&
      row.archivedAt === null
    ) {
      return false;
    }

    if (
      where.placements &&
      !row.placements.some(
        ({ containerId }) =>
          containerId === where.placements?.some.containerId,
      )
    ) {
      return false;
    }

    return (
      !where.id ||
      (typeof where.id === "string"
        ? row.id === where.id
        : where.id.in.includes(row.id))
    );
  });
}

function containerAssignments(): Array<[string, string | null]> {
  return rows.map((row) => [row.id, row.placements[0]?.containerId ?? null]);
}

function itemRow(
  id: string,
  overrides: {
    archivedAt?: Date | null;
    containerId?: string | null;
    locationId?: string | null;
  } = {},
) {
  const timestamp = new Date("2026-07-26T12:00:00.000Z");
  const containerId = overrides.containerId ?? null;
  const locationId = overrides.locationId ?? null;

  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: overrides.archivedAt ?? null,
    assets: [],
    audioNotes: [],
    captureSession: null,
    captureSessionId: null,
    captureText: null,
    capturedAt: timestamp,
    category: null,
    costCents: null,
    costCurrency: "CAD",
    createdAt: timestamp,
    id,
    images: [],
    importance: "MEDIUM",
    kind: "ITEM",
    metadata: {},
    note: null,
    placements: [placementRow(id, containerId, locationId, 1)],
    searchText: id,
    status: "KEEP",
    tags: [],
    title: id,
    updatedAt: timestamp,
  };
}

function placementRow(
  itemId: string,
  containerId: string | null,
  locationId: string | null,
  quantity: number,
) {
  const timestamp = new Date("2026-07-26T12:00:00.000Z");
  const container =
    containerId === null
      ? null
      : {
          createdAt: timestamp,
          id: containerId,
          location: null,
          locationId: null,
          metadata: {},
          name:
            containerId === "destination" ? "Destination tote" : "Source tote",
          normalizedName:
            containerId === "destination" ? "destination tote" : "source tote",
          photoFilePath: null,
          referenceId:
            containerId === "destination" ? "BIN-0002" : "BIN-0001",
          sizeLiters: null,
          updatedAt: timestamp,
          visualPresetKey: "39L",
        };

  const location =
    locationId === null
      ? null
      : {
          id: locationId,
          kind: "STORAGE",
          name: "Pantry",
        };

  return {
    container,
    containerId,
    createdAt: timestamp,
    id: `placement-${itemId}-${containerId ?? locationId ?? "unplaced"}`,
    itemId,
    location,
    locationId,
    note: null,
    quantity,
    updatedAt: timestamp,
  };
}
