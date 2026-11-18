import {
  InventoryAcquisitionSource as PrismaInventoryAcquisitionSource,
  InventoryCategory as PrismaInventoryCategory,
  type InventoryAcquisitionSource as PrismaInventoryAcquisitionSourceValue,
  type InventoryCategory as PrismaInventoryCategoryValue,
} from "@quantself/db/generated/prisma/enums";

export const INVENTORY_ITEM_STATUSES = [
  "KEEP",
  "DONATE",
  "TRASH",
  "UNSURE",
] as const;

export const INVENTORY_IMPORTANCE_VALUES = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

export const INVENTORY_ITEM_KINDS = ["ITEM", "GROUP"] as const;

export const INVENTORY_CATEGORY_VALUES = Object.values(
  PrismaInventoryCategory,
) as readonly PrismaInventoryCategoryValue[];

export const INVENTORY_ACQUISITION_SOURCE_VALUES = Object.values(
  PrismaInventoryAcquisitionSource,
) as readonly PrismaInventoryAcquisitionSourceValue[];

export type InventoryItemStatus = (typeof INVENTORY_ITEM_STATUSES)[number];
export type InventoryImportance = (typeof INVENTORY_IMPORTANCE_VALUES)[number];
export type InventoryItemKind = (typeof INVENTORY_ITEM_KINDS)[number];
export type InventoryCategory = PrismaInventoryCategoryValue;
export type InventoryAcquisitionSource =
  PrismaInventoryAcquisitionSourceValue;

const INVENTORY_CATEGORY_ALIASES = new Map<string, InventoryCategory>([
  ["electronics", "technology"],
]);

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

export function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();

  return cleaned ? cleaned : null;
}

export function normalizeInventoryCategory(
  value: string | null | undefined,
): InventoryCategory | null {
  const normalized = cleanOptional(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) {
    return null;
  }

  const aliased = INVENTORY_CATEGORY_ALIASES.get(normalized);

  if (aliased) {
    return aliased;
  }

  return INVENTORY_CATEGORY_VALUES.includes(normalized as InventoryCategory)
    ? (normalized as InventoryCategory)
    : null;
}

export function normalizeInventoryAcquisitionSource(
  value: string | null | undefined,
): InventoryAcquisitionSource | null {
  const normalized = cleanOptional(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "");

  if (!normalized) {
    return null;
  }

  return (
    INVENTORY_ACQUISITION_SOURCE_VALUES.find(
      (candidate) => candidate.replace(/[\s-]+/g, "") === normalized,
    ) ?? null
  );
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
