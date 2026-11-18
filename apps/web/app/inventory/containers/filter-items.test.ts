import { describe, expect, test } from "bun:test";
import { getInventoryContainerVisualCatalogEntry } from "@/lib/inventory-container-visual-catalog";
import { testContainerVisualPreset } from "../container-test-fixtures";
import {
  countFilteredItems,
  filterContainerItems,
} from "./filter-items";
import type { ContainerShelf } from "./types";

describe("Bento item filtering", () => {
  test("returns every item for a blank query", () => {
    const containers = buildContainers();
    const filtered = filterContainerItems(containers, "   ");

    expect(filtered.get("container-one")).toBe(containers[0].items);
    expect(filtered.get("container-two")).toBe(containers[1].items);
    expect(countFilteredItems(filtered)).toBe(3);
  });

  test("matches all case-insensitive terms across item evidence", () => {
    const filtered = filterContainerItems(
      buildContainers(),
      "PASSPORT typed",
    );

    expect(filtered.get("container-one")?.map((item) => item.id)).toEqual([
      "item-passport",
    ]);
    expect(filtered.get("container-two")).toEqual([]);
    expect(countFilteredItems(filtered)).toBe(1);
  });

  test("supports audio and photo searches while retaining every container", () => {
    const containers = buildContainers();
    const audioMatches = filterContainerItems(containers, "voice");
    const photoMatches = filterContainerItems(containers, "photo");

    expect([...audioMatches.keys()]).toEqual([
      "container-one",
      "container-two",
    ]);
    expect(audioMatches.get("container-two")?.map((item) => item.id)).toEqual([
      "item-keys",
    ]);
    expect(photoMatches.get("container-one")?.map((item) => item.id)).toEqual([
      "item-camera",
    ]);
  });
});

function buildContainers(): ContainerShelf[] {
  return [
    {
      id: "container-one",
      itemCount: 2,
      items: [
        {
          audioId: null,
          hasAudio: false,
          id: "item-passport",
          imageId: null,
          textPreview: "Typed travel note",
          title: "Passport pouch",
        },
        {
          audioId: null,
          hasAudio: false,
          id: "item-camera",
          imageId: "image-camera",
          textPreview: null,
          title: "Camera",
        },
      ],
      location: "Hall closet",
      name: "Travel tote",
      referenceId: "BIN-0001",
      visualPreset: testContainerVisualPreset,
      visualPresetKey: testContainerVisualPreset.id,
    },
    {
      id: "container-two",
      itemCount: 1,
      items: [
        {
          audioId: "audio-keys",
          hasAudio: true,
          id: "item-keys",
          imageId: null,
          textPreview: null,
          title: "Spare keys",
        },
      ],
      location: "Entryway",
      name: "Small drawer",
      referenceId: "BIN-0002",
      visualPreset: buildVisualPreset("6L"),
      visualPresetKey: "6L",
    },
  ];
}

function buildVisualPreset(key: "6L") {
  const preset = getInventoryContainerVisualCatalogEntry(key)!;

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
