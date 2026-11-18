import type { components } from "./generated/quantself-api-schema";
import type {
  InventoryContainerVisualBounds,
  InventoryContainerVisualKey,
} from "./inventory-container-visual-catalog";

type InventoryItemContract = components["schemas"]["InventoryItem"];

export const INVENTORY_ITEM_STATUSES = [
  "KEEP",
  "DONATE",
  "TRASH",
  "UNSURE",
] as const satisfies readonly InventoryItemStatus[];

export const INVENTORY_IMPORTANCE_VALUES = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const satisfies readonly InventoryImportance[];

export const INVENTORY_ITEM_KINDS = [
  "ITEM",
  "GROUP",
] as const satisfies readonly InventoryItemKind[];

export const INVENTORY_CATEGORY_VALUES = [
  "food",
  "drink",
  "medical",
  "entertainment",
  "office",
  "sports",
  "clothing",
  "homeopathy",
  "supplement",
  "technology",
  "cosmetics",
  "documents",
  "tools",
  "cleaning",
  "kitchen",
  "household",
  "other",
] as const satisfies readonly InventoryCategory[];

export const INVENTORY_ACQUISITION_SOURCE_VALUES = [
  "online",
  "retail",
  "gift",
  "found",
  "work",
  "secondhand",
  "other",
] as const satisfies readonly InventoryAcquisitionSource[];

export type InventoryItemStatus = InventoryItemContract["status"];
export type InventoryImportance = InventoryItemContract["importance"];
export type InventoryItemKind = InventoryItemContract["kind"];
export type InventoryCategory = Exclude<
  InventoryItemContract["category"],
  null
>;
export type InventoryAcquisitionSource = Exclude<
  InventoryItemContract["acquisitionSource"],
  null
>;

export type InventoryLocationRecord = {
  id: string;
  kind: "ROOM" | "STORAGE" | "SHELF" | "AREA" | "OTHER";
  name: string;
};

export type InventoryContainerVisualPresetRecord = {
  backImageUrl: string;
  bounds: InventoryContainerVisualBounds;
  emptyImageUrl: string;
  frontImageUrl: string;
  height: number;
  id: InventoryContainerVisualKey;
  isDefault: boolean;
  name: string;
  shadowImageUrl: string;
  width: number;
};

export function formatInventoryCategoryLabel(
  category: InventoryCategory | null,
): string | null {
  return formatInventoryEnumLabel(category);
}

export function formatInventoryAcquisitionSourceLabel(
  acquisitionSource: InventoryAcquisitionSource | null,
): string | null {
  return formatInventoryEnumLabel(acquisitionSource);
}

export function formatInventoryContainerPickerLabel(container: {
  name: string;
  referenceId: string;
}): string {
  return `${container.name} (${container.referenceId})`;
}

export function formatInventoryContainerLabel(
  container: { name: string; referenceId: string } | null,
  fallbackLabel: string | null = null,
): string | null {
  if (container) {
    return `${container.name} (${container.referenceId})`;
  }

  return fallbackLabel;
}

export function formatInventoryEstimatedValue(
  costCents: number | null,
  costCurrency: string,
): string | null {
  if (costCents === null) {
    return null;
  }

  return `${costCurrency.toUpperCase()} ${(costCents / 100).toFixed(2)}`;
}

export function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();

  return cleaned ? cleaned : null;
}

function formatInventoryEnumLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .split("_")
    .map((segment) =>
      segment ? `${segment[0]!.toUpperCase()}${segment.slice(1)}` : segment,
    )
    .join(" ");
}
