export type InventoryBrowseFilterOption = {
  label: string;
  value: string;
};

export const inventoryCategoryValues = [
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
] as const;
export const evidenceValues = ["photo", "voice", "text"] as const;
export const importanceValues = ["HIGH", "MEDIUM", "LOW"] as const;
export const itemKindValues = ["ITEM", "GROUP"] as const;
export const itemStatusValues = ["KEEP", "DONATE", "TRASH", "UNSURE"] as const;
export const workflowValues = [
  "CAPTURED",
  "PREPROCESSING",
  "ENRICHING",
  "NEEDS_REVIEW",
  "COMPLETE",
] as const;

export const categoryOptions: InventoryBrowseFilterOption[] =
  inventoryCategoryValues.map((value) => ({
    label: sentenceCase(value),
    value,
  }));
export const evidenceOptions: InventoryBrowseFilterOption[] = [
  { label: "Photo", value: "photo" },
  { label: "Audio", value: "voice" },
  { label: "Text", value: "text" },
];
export const importanceOptions: InventoryBrowseFilterOption[] = [
  { label: "High", value: "HIGH" },
  { label: "Medium", value: "MEDIUM" },
  { label: "Low", value: "LOW" },
];
export const itemKindOptions: InventoryBrowseFilterOption[] = [
  { label: "Item", value: "ITEM" },
  { label: "Group", value: "GROUP" },
];
export const itemStatusOptions: InventoryBrowseFilterOption[] = [
  { label: "Keep", value: "KEEP" },
  { label: "Unsure", value: "UNSURE" },
  { label: "Donate", value: "DONATE" },
  { label: "Trash", value: "TRASH" },
];
export const workflowOptions: InventoryBrowseFilterOption[] = [
  { label: "Captured", value: "CAPTURED" },
  { label: "Preprocessing", value: "PREPROCESSING" },
  { label: "Enriching", value: "ENRICHING" },
  { label: "Needs review", value: "NEEDS_REVIEW" },
  { label: "Complete", value: "COMPLETE" },
];

export function controlledFilterValue<Values extends readonly string[]>(
  value: string | null | undefined,
  values: Values,
): Values[number] | null {
  return value && values.includes(value) ? (value as Values[number]) : null;
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ").toLowerCase();
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
