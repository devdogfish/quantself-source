import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INVENTORY_CONTAINER_VISUAL_KEY,
  INVENTORY_CONTAINER_VISUAL_CATALOG,
  INVENTORY_CONTAINER_VISUAL_KEYS,
  type InventoryContainerVisualAsset,
  type InventoryContainerVisualCatalogEntry,
  type InventoryContainerVisualRole,
} from "./inventory-container-visual-catalog";

const ROLES: InventoryContainerVisualRole[] = [
  "back",
  "empty",
  "front",
  "shadow",
];

describe("inventory container visual catalog", () => {
  test("defines one validated repository-owned catalog with 6L default", () => {
    expect(INVENTORY_CONTAINER_VISUAL_CATALOG.map((entry) => entry.key)).toEqual(
      [...INVENTORY_CONTAINER_VISUAL_KEYS],
    );

    const uniqueKeys = new Set(
      INVENTORY_CONTAINER_VISUAL_CATALOG.map((entry) => entry.key),
    );
    expect(uniqueKeys.size).toBe(INVENTORY_CONTAINER_VISUAL_CATALOG.length);

    const defaultEntries = INVENTORY_CONTAINER_VISUAL_CATALOG.filter(
      (entry) => entry.isDefault,
    );
    expect(defaultEntries).toHaveLength(1);
    expect(defaultEntries[0]?.key === DEFAULT_INVENTORY_CONTAINER_VISUAL_KEY).toBe(
      true,
    );

    for (const entry of INVENTORY_CONTAINER_VISUAL_CATALOG) {
      expect(entry.name).toBe(entry.key);
      expect(Object.keys(entry.assets).sort()).toEqual([...ROLES].sort());
      validateBounds(entry);

      for (const role of ROLES) {
        validateAsset(entry, role, "pngPath", "image/png");
        validateAsset(entry, role, "webpPath", "image/webp");
      }
    }
  });
});

function validateBounds(entry: InventoryContainerVisualCatalogEntry) {
  expect(entry.itemBounds).toHaveLength(4);

  for (const point of entry.itemBounds) {
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(1);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(1);
  }

  const crossProducts = entry.itemBounds.map((point, index) => {
    const next = entry.itemBounds[(index + 1) % entry.itemBounds.length]!;
    const afterNext =
      entry.itemBounds[(index + 2) % entry.itemBounds.length]!;

    return (
      (next.x - point.x) * (afterNext.y - next.y) -
      (next.y - point.y) * (afterNext.x - next.x)
    );
  });

  for (const crossProduct of crossProducts) {
    expect(crossProduct).toBeGreaterThan(0);
  }
}

function validateAsset(
  entry: InventoryContainerVisualCatalogEntry,
  role: InventoryContainerVisualRole,
  field: keyof InventoryContainerVisualAsset,
  expectedMimeType: "image/png" | "image/webp",
) {
  const publicPath = entry.assets[role][field];
  expect(publicPath.startsWith("/inventory/container-visual-catalog/")).toBe(
    true,
  );
  expect(publicPath.endsWith(expectedMimeType === "image/png" ? ".png" : ".webp")).toBe(
    true,
  );

  const bytes = readFileSync(catalogAssetFilePath(publicPath));
  expect(detectTransparentPresetImageMimeType(bytes)).toBe(expectedMimeType);
  expect(readImageDimensions(bytes, expectedMimeType)).toEqual(entry.dimensions);
}

function catalogAssetFilePath(publicPath: string): string {
  return fileURLToPath(new URL(`../public${publicPath}`, import.meta.url));
}

function detectTransparentPresetImageMimeType(
  bytes: Buffer,
): "image/png" | "image/webp" | null {
  if (
    bytes.length >= 26 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  ) {
    const colorType = bytes[25];
    const hasTransparency =
      colorType === 4 ||
      colorType === 6 ||
      bytes.includes(Buffer.from("tRNS"));

    return hasTransparency ? "image/png" : null;
  }

  if (
    bytes.length >= 25 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const hasAlphaChunk =
      bytes.includes(Buffer.from("ALPH")) ||
      (bytes.toString("ascii", 12, 16) === "VP8X" &&
        bytes.length >= 21 &&
        (bytes[20]! & 0x10) !== 0) ||
      (bytes.toString("ascii", 12, 16) === "VP8L" &&
        bytes[20] === 0x2f &&
        (bytes.readUInt32LE(21) & 0x10000000) !== 0);

    return hasAlphaChunk ? "image/webp" : null;
  }

  return null;
}

function readImageDimensions(
  bytes: Buffer,
  mimeType: "image/png" | "image/webp",
) {
  if (mimeType === "image/png") {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  const webpChunkType = bytes.toString("ascii", 12, 16);

  if (webpChunkType !== "VP8L") {
    throw new Error(`Unsupported WEBP chunk type: ${webpChunkType}`);
  }

  const packed = bytes.readUInt32LE(21);

  return {
    width: (packed & 0x3fff) + 1,
    height: ((packed >> 14) & 0x3fff) + 1,
  };
}
