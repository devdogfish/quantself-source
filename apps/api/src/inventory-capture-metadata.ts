const inventoryCategoryValues = [
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

type InventoryCategory = (typeof inventoryCategoryValues)[number];

type InventoryCaptureMetadataInput = {
  acquisitionSource: string | null;
  captureText: string | null;
  category: InventoryCategory | null;
  containerLabel: string | null;
  containerLocationName: string | null;
  containerReferenceId: string | null;
  costCents: number | null;
  importance: string;
  kind: string;
  note: string | null;
  status: string;
  title: string | null;
};

type MetadataRule = {
  aliases: string[];
  category: InventoryCategory;
  tags: string[];
  terms: RegExp;
};

const metadataRules: MetadataRule[] = [
  {
    aliases: ["connect laptop to tv", "display cable", "video adapter"],
    category: "technology",
    tags: ["electronics", "adapter", "cable"],
    terms: /\b(hdmi|usb|adapter|dongle|charger|cable|cord|laptop|monitor|tv)\b/iu,
  },
  {
    aliases: ["important papers", "records"],
    category: "documents",
    tags: ["documents", "paper"],
    terms: /\b(document|paper|receipt|manual|passport|record|file|folder)\b/iu,
  },
  {
    aliases: ["repair supplies", "fix kit"],
    category: "tools",
    tags: ["tools", "hardware"],
    terms: /\b(tool|screwdriver|drill|hammer|wrench|hardware|nail|screw)\b/iu,
  },
  {
    aliases: ["cleaning supplies"],
    category: "cleaning",
    tags: ["cleaning", "supplies"],
    terms: /\b(clean|cleaning|spray|soap|detergent|wipe|sponge|brush)\b/iu,
  },
  {
    aliases: ["kitchen supplies"],
    category: "kitchen",
    tags: ["kitchen", "household"],
    terms: /\b(kitchen|pan|pot|lid|plate|bowl|mug|utensil|takeout)\b/iu,
  },
  {
    aliases: ["clothes", "wearables"],
    category: "clothing",
    tags: ["clothing", "soft goods"],
    terms: /\b(shirt|pants|sock|jacket|coat|clothing|clothes|shoe|fabric)\b/iu,
  },
];

function generateInventoryCaptureMetadata(input: InventoryCaptureMetadataInput) {
  const sourceText = [
    input.title,
    input.note,
    input.captureText,
    input.containerLabel,
    input.containerReferenceId,
    input.containerLocationName,
  ]
    .filter(Boolean)
    .join(" ");
  const aliases = new Set<string>();
  const tags = new Set<string>();
  let derivedCategory: InventoryCategory | null = null;

  for (const rule of metadataRules) {
    if (!rule.terms.test(sourceText)) {
      continue;
    }

    derivedCategory ??= rule.category;
    rule.aliases.forEach((alias) => aliases.add(alias));
    rule.tags.forEach((tag) => tags.add(tag));
  }

  const category = input.category ?? derivedCategory;
  const sortedAliases = [...aliases].sort();
  const sortedTags = [...tags].sort();

  return {
    aliases: sortedAliases,
    category,
    metadata: {
      futureHooks: {
        embeddings: "searchText",
        enrichment: "metadata.enrichment",
        ocr: "images.ocrText",
        reindexing: "stored inventory fields",
        speechToText: "captureText",
        visionCaption: "images.caption",
      },
      generator: "local-deterministic-v1",
      schemaVersion: 1,
      sourceFields: [
        "title",
        "note",
        "captureText",
        "containerLabel",
        "container.referenceId",
        "container.locationName",
        "images.originalName",
        "images.caption",
        "images.ocrText",
        "audioNotes.originalName",
        "assets.originalName",
      ],
    },
    searchText: normalizeSearchText([
      input.title,
      input.note,
      input.captureText,
      input.status,
      input.importance,
      input.kind,
      input.containerLabel,
      input.containerReferenceId,
      input.containerLocationName,
      category,
      input.acquisitionSource,
      formatCostSearchText(input.costCents),
      ...sortedTags,
      ...sortedAliases,
    ]),
    tags: sortedTags,
  };
}

function formatCostSearchText(costCents: number | null) {
  if (costCents === null) {
    return null;
  }

  const dollars = Math.floor(costCents / 100);
  const cents = String(costCents % 100).padStart(2, "0");

  return `cad ${dollars}.${cents} ${costCents} cents`;
}

function normalizeSearchText(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export { generateInventoryCaptureMetadata, inventoryCategoryValues };
