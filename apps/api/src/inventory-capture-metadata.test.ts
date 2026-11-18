import { describe, expect, test } from "bun:test";
import { generateInventoryCaptureMetadata } from "./inventory-capture-metadata";

describe("Inventory Item capture metadata", () => {
  test("preserves deterministic capture metadata and search terms", () => {
    const metadata = generateInventoryCaptureMetadata({
      acquisitionSource: "gift",
      captureText: "USB adapter and passport pouch",
      category: null,
      containerLabel: "Travel drawer",
      containerLocationName: "Hall closet",
      containerReferenceId: "BIN-0004",
      costCents: 1299,
      importance: "HIGH",
      kind: "GROUP",
      note: null,
      status: "KEEP",
      title: null,
    });

    expect(metadata.category).toBe("technology");
    expect(metadata.tags).toEqual([
      "adapter",
      "cable",
      "documents",
      "electronics",
      "paper",
    ]);
    expect(metadata.aliases).toEqual([
      "connect laptop to tv",
      "display cable",
      "important papers",
      "records",
      "video adapter",
    ]);
    expect(metadata.searchText).toContain("bin 0004");
    expect(metadata.searchText).toContain("cad 12 99 1299 cents");
    expect(metadata.metadata).toMatchObject({
      generator: "local-deterministic-v1",
      schemaVersion: 1,
    });
  });

  test("keeps an explicitly selected category", () => {
    const metadata = generateInventoryCaptureMetadata({
      acquisitionSource: null,
      captureText: "USB adapter",
      category: "office",
      containerLabel: null,
      containerLocationName: null,
      containerReferenceId: null,
      costCents: null,
      importance: "MEDIUM",
      kind: "GROUP",
      note: null,
      status: "UNSURE",
      title: null,
    });

    expect(metadata.category).toBe("office");
    expect(metadata.tags).toContain("electronics");
    expect(metadata.searchText).toContain("office");
  });
});
