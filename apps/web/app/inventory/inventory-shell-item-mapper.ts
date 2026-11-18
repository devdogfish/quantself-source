import type { BrowserInventoryItem } from "@/lib/quantself-api-browser";
import type { InventoryShellItem } from "./inventory-shell-data";

export function mapInventoryShellItem(
  item: BrowserInventoryItem,
): InventoryShellItem {
  const fallbackLocation = parseLocationName(item.where, item.containerLabel);
  const primaryContainer = parseContainer(
    item.containerId,
    item.containerLabel,
    fallbackLocation,
  );
  const mappedPlacements = item.placements.map((placement) => ({
    container: parseContainer(
      placement.containerId,
      placement.label,
      placement.containerId === item.containerId ? fallbackLocation : null,
    ),
    note: placement.note,
    quantity: placement.quantity,
  }));
  const placements =
    mappedPlacements.length === 1 &&
    mappedPlacements[0]?.container?.id === primaryContainer?.id
      ? []
      : mappedPlacements;
  const evidence = item.processing.evidence.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    summary: entry.summary,
  }));
  const imageEvidence = item.processing.evidence.filter(
    (entry) => entry.kind === "photo",
  );
  const proposalStatus = item.processing.proposal.status;
  const enrichmentStatus = item.processing.enrichment.status;
  const preprocessingStatus = item.processing.preprocessing.status;
  const captureText = item.captureText ?? "";
  const derivedFields = [
    ...(item.title ? [`title: ${item.title}`] : []),
    ...(item.category ? [`category: ${item.category}`] : []),
    ...(item.tags.length > 0 ? [`tags: ${item.tags.join(", ")}`] : []),
  ];

  return {
    acquisitionSource: item.acquisitionSource,
    ageLabel: formatAge(latestProcessingTimestamp(item)),
    captureSession: {
      containerLabel: item.containerLabel ?? "",
      destinationLocation: {
        id: primaryContainer?.location?.id ?? `location-${item.id}`,
        name: primaryContainer?.location?.name ?? "Unplaced",
      },
      id: `capture-${item.id}`,
      label: "Inventory capture",
      note: item.note ?? "",
      originLocation: {
        id: `origin-${item.id}`,
        name: "Unknown origin",
      },
    },
    capturedAt: item.capturedAt,
    category: item.category,
    container: primaryContainer,
    containerLabel: item.containerLabel,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    currentStep: item.processing.currentStep,
    enrichment: {
      derivedFields,
      rationale: item.processing.enrichment.rationale,
      status: enrichmentStatus,
      summary: item.processing.enrichment.summary,
      updatedAt: item.processing.enrichment.updatedAt,
    },
    evidence,
    id: item.id,
    images:
      imageEvidence.length > 0
        ? imageEvidence.map((entry) => ({
            alt: item.title,
            caption: entry.summary,
            id: entry.id,
            ocrText: "",
          }))
        : item.imageId
          ? [
              {
                alt: item.title,
                caption: "",
                id: item.imageId,
                ocrText: "",
              },
            ]
          : [],
    importance: item.importance,
    kind: item.kind,
    nextAction: item.processing.nextAction,
    placements,
    preprocessing: {
      failedSteps: item.processing.preprocessing.failedSteps,
      status: preprocessingStatus,
      summary: item.processing.preprocessing.summary,
      updatedAt: item.processing.preprocessing.updatedAt,
    },
    proposal: {
      diff: [],
      status: proposalStatus,
      summary: item.processing.proposal.summary,
      updatedAt: item.processing.proposal.updatedAt,
    },
    searchCorpus: [
      item.title,
      captureText,
      item.where,
      item.category ?? "",
      item.acquisitionSource ?? "",
      ...item.aliases,
      ...item.tags,
      ...evidence.map((entry) => entry.summary),
    ]
      .filter((value) => value.trim().length > 0)
      .join(" "),
    sourceLabel: item.processing.sourceLabel,
    status: item.status,
    textBundle: {
      captureText,
      failedSteps: item.processing.preprocessing.failedSteps,
      mediaTexts: item.processing.preprocessing.mediaTexts,
      summary: item.processing.preprocessing.textBundleAvailable
        ? "Persisted Inventory Text Bundle."
        : "Inventory Text Bundle not available yet.",
    },
    title: item.title,
    totalQuantity: item.totalQuantity,
    trail: buildTrail(item),
    videoId: evidence.find((entry) => entry.kind === "video")?.id ?? null,
  };
}

function latestProcessingTimestamp(item: BrowserInventoryItem): string {
  const timestamps = [
    item.capturedAt,
    item.processing.preprocessing.updatedAt,
    item.processing.enrichment.updatedAt,
    item.processing.proposal.updatedAt,
  ]
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));

  return new Date(Math.max(...timestamps)).toISOString();
}

function parseContainer(
  id: string | null,
  label: string | null,
  locationName?: string | null,
): InventoryShellItem["container"] {
  if (!id || !label) {
    return null;
  }

  const match = /^(.*?)(?: \(([^)]+)\))?$/.exec(label.trim());
  const name = match?.[1]?.trim() || label;
  const referenceId = match?.[2]?.trim() || label;

  return {
    id,
    location: locationName
      ? {
          id: `${id}-location`,
          name: locationName,
        }
      : null,
    name,
    referenceId,
  };
}

function parseLocationName(
  where: string,
  containerLabel: string | null,
): string | null {
  if (containerLabel && where.endsWith(containerLabel)) {
    const prefix = where
      .slice(0, -containerLabel.length)
      .replace(/ \/ $/, "")
      .trim();

    return prefix.length > 0 ? prefix : null;
  }

  return null;
}

function buildTrail(
  item: BrowserInventoryItem,
): InventoryShellItem["trail"] {
  const trail: InventoryShellItem["trail"] = [
    {
      at: item.capturedAt,
      label: "Inventory Item captured",
    },
    {
      at: item.processing.preprocessing.updatedAt,
      label: item.processing.preprocessing.summary,
    },
  ];

  if (
    item.processing.enrichment.updatedAt !==
    item.processing.preprocessing.updatedAt
  ) {
    trail.push({
      at: item.processing.enrichment.updatedAt,
      label: item.processing.enrichment.summary,
    });
  }

  if (
    item.processing.proposal.updatedAt !==
    item.processing.enrichment.updatedAt
  ) {
    trail.push({
      at: item.processing.proposal.updatedAt,
      label: item.processing.proposal.summary,
    });
  }

  return trail;
}

function formatAge(capturedAt: string): string {
  const capturedMs = Date.parse(capturedAt);

  if (Number.isNaN(capturedMs)) {
    return "0m";
  }

  const minutes = Math.max(0, Math.floor((Date.now() - capturedMs) / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
