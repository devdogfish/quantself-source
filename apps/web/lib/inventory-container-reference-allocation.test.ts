import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextSequenceValue = BigInt(1);
const containers = new Map<string, { id: string; referenceId: string }>();
const allocatedSequenceValues: bigint[] = [];

mock.module("@quantself/db", () => ({
  prisma: {
    $queryRaw: async () => {
      const value = nextSequenceValue;
      nextSequenceValue += BigInt(1);
      allocatedSequenceValues.push(value);
      return [{ value }];
    },
    inventoryContainer: {
      delete: async ({ where }: { where: { id: string } }) => {
        const container = [...containers.values()].find(
          (candidate) => candidate.id === where.id,
        );

        if (container) {
          containers.delete(container.referenceId);
        }
      },
      findUnique: async ({
        where,
      }: {
        select: { id: true };
        where: { referenceId: string };
      }) => containers.get(where.referenceId) ?? null,
    },
  },
}));

describe("persistent inventory container reference allocation", () => {
  beforeEach(() => {
    nextSequenceValue = BigInt(1);
    containers.clear();
    allocatedSequenceValues.length = 0;
  });

  test("hard deletion does not make a reference ID reusable", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    const firstReference =
      await inventoryRepository.allocateContainerReferenceId();
    containers.set(firstReference, {
      id: "container-1",
      referenceId: firstReference,
    });

    await inventoryRepository.deleteContainer("container-1");

    expect(containers.has(firstReference)).toBe(false);
    expect(await inventoryRepository.allocateContainerReferenceId()).toBe(
      "BIN-0002",
    );
    expect(allocatedSequenceValues).toEqual([BigInt(1), BigInt(2)]);
  });

  test("skips an existing reference if sequence state collides", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");
    nextSequenceValue = BigInt(42);
    containers.set("BIN-0042", {
      id: "legacy-container",
      referenceId: "BIN-0042",
    });

    expect(await inventoryRepository.allocateContainerReferenceId()).toBe(
      "BIN-0043",
    );
    expect(allocatedSequenceValues).toEqual([BigInt(42), BigInt(43)]);
  });
});
