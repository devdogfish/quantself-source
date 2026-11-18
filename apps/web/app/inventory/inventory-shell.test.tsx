import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { renderToStaticMarkup } from "react-dom/server";
import type { InventoryEnrichmentJobStatus } from "../../../api/src/inventory-enrichment-service";

const activeCaptureSession = {
  defaultContainer: null,
  defaultContainerLabel: "Travel drawer",
  defaultDestinationLocation: {
    id: "location-office-cabinet",
    kind: "STORAGE" as const,
    name: "Office cabinet",
  },
  defaultOriginLocation: {
    id: "location-entryway-floor",
    kind: "ROOM" as const,
    name: "Entryway floor",
  },
  id: "session-1",
  label: "Apartment reset",
  note: "Keep fast capture moving.",
  startedAt: new Date("2026-07-13T09:00:00.000Z"),
};

const containerVisualPreset = {
  bounds: [
    { x: 0.08, y: 0.2 },
    { x: 0.92, y: 0.2 },
    { x: 0.83, y: 0.94 },
    { x: 0.17, y: 0.94 },
  ],
  backImageUrl: "/inventory/container-visual-catalog/39l/back.webp",
  emptyImageUrl: "/inventory/container-visual-catalog/39l/empty.webp",
  frontImageUrl: "/inventory/container-visual-catalog/39l/front.webp",
  height: 857,
  id: "39L",
  isDefault: true,
  name: "39L",
  shadowImageUrl: "/inventory/container-visual-catalog/39l/shadow.webp",
  width: 1456,
};

const recentInventoryItems = [
  {
    acquisitionSource: null,
    aliases: [],
    audioNotes: [],
    captureSessionId: "session-1",
    captureText: "Passport pouch with charger and pen.",
    capturedAt: new Date("2026-07-13T11:30:00.000Z"),
    category: null,
    container: {
      id: "container-travel-drawer",
      location: {
        id: "location-office-cabinet",
        kind: "STORAGE" as const,
        name: "Office cabinet",
      },
      name: "Travel drawer",
      referenceId: "BIN-0003",
    },
    containerLabel: "Travel drawer",
    costCents: null,
    costCurrency: "CAD",
    id: "item-passport-pouch",
    images: [],
    importance: "HIGH" as const,
    kind: "GROUP" as const,
    locationId: "location-office-cabinet",
    locationName: "Office cabinet",
    metadata: {},
    note: null,
    originLocationId: "location-entryway-floor",
    originLocationName: "Entryway floor",
    searchText: "passport pouch charger pen office cabinet travel drawer",
    status: "KEEP" as const,
    tags: [],
    title: "Passport pouch",
  },
  {
    acquisitionSource: null,
    aliases: [],
    audioNotes: [],
    captureSessionId: "session-1",
    captureText: "Switch dock cables and charger.",
    capturedAt: new Date("2026-07-13T11:10:00.000Z"),
    category: null,
    container: {
      id: "container-blue-bin-4",
      location: {
        id: "location-garage-shelf-a",
        kind: "STORAGE" as const,
        name: "Garage shelf A",
      },
      name: "Blue bin 4",
      referenceId: "BIN-0004",
    },
    containerLabel: "Blue bin 4",
    costCents: null,
    costCurrency: "CAD",
    id: "item-switch-dock-cables",
    images: [],
    importance: "HIGH" as const,
    kind: "GROUP" as const,
    locationId: "location-garage-shelf-a",
    locationName: "Garage shelf A",
    metadata: {},
    note: null,
    originLocationId: "location-living-room-console",
    originLocationName: "Living room console",
    searchText: "switch dock cables charger garage shelf blue bin",
    status: "KEEP" as const,
    tags: [],
    title: "Switch dock cables",
  },
];

const preprocessingJobs = [
  {
    attempts: 0,
    claimedAt: null,
    claimedBy: null,
    createdAt: new Date("2026-07-13T11:31:00.000Z"),
    id: "prep-1",
    leaseExpiresAt: null,
    maxAttempts: 3,
    sourceRefs: [{ id: "item-passport-pouch", kind: "item" as const }],
    status: "QUEUED" as const,
    targetItemId: "item-passport-pouch",
    updatedAt: new Date("2026-07-13T11:31:00.000Z"),
  },
  {
    attempts: 1,
    claimedAt: new Date("2026-07-13T11:12:00.000Z"),
    claimedBy: "preprocessing-worker",
    createdAt: new Date("2026-07-13T11:11:00.000Z"),
    id: "prep-2",
    leaseExpiresAt: new Date("2026-07-13T11:14:00.000Z"),
    maxAttempts: 3,
    sourceRefs: [{ id: "item-switch-dock-cables", kind: "item" as const }],
    status: "PROCESSING" as const,
    targetItemId: "item-switch-dock-cables",
    updatedAt: new Date("2026-07-13T11:12:00.000Z"),
  },
];

const enrichmentJobs = [
  {
    kind: "INVENTORY_ITEM_ENRICHMENT" as const,
    resultPayload: null,
    status: "PENDING_APPROVAL" as InventoryEnrichmentJobStatus,
    targetItemId: "item-passport-pouch",
    updatedAt: new Date("2026-07-13T11:35:00.000Z"),
  },
];
const apiAuthenticationError = new Error("Authentication required.");
let activeItemsError: Error | null = null;

mock.module("./actions", () => ({
  addInventoryUnitsAction: async () => ({
    message: "Units added.",
    status: "success",
  }),
  archiveInventoryItemAction: async () => ({
    message: "Item archived.",
    status: "success",
  }),
  createInventoryContainerAction: async () => ({
    container: null,
    message: "Container created.",
    status: "success",
  }),
  createInventoryItemAction: async () => ({
    message: "Capture saved. Inventory preprocessing queued.",
    status: "success",
  }),
  deleteInventoryContainerAction: async () => ({
    container: null,
    message: "Container deleted.",
    status: "success",
  }),
  deleteInventoryItemAction: async () => ({
    message: "Item deleted.",
    status: "success",
  }),
  moveInventoryUnitsAction: async () => ({
    message: "Units moved.",
    status: "success",
  }),
  removeInventoryUnitsAction: async () => ({
    message: "Units removed.",
    status: "success",
  }),
  reorderInventoryItemImagesAction: async () => ({
    message: "Image order saved.",
    status: "success",
  }),
  restoreInventoryItemAction: async () => ({
    message: "Item restored.",
    status: "success",
  }),
  updateInventoryContainerAction: async () => ({
    container: null,
    message: "Container updated.",
    status: "success",
  }),
  updateInventoryItemAction: async () => ({
    message: "Item updated.",
    status: "success",
  }),
  uploadInventoryItemImagesAction: async () => ({
    message: "Images added.",
    status: "success",
  }),
}));

mock.module("@/app/settings/inventory-actions", () => ({
  approveInventoryEnrichmentProposalWithStateAction: async () => ({
    message: "",
    status: "idle",
  }),
  rejectInventoryEnrichmentProposalWithStateAction: async () => ({
    message: "",
    status: "idle",
  }),
}));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  usePathname: () => "/inventory",
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/lib/inventory-prisma-repository", () => ({
  getInventoryAssetFile: async () => null,
  getInventoryAudioFile: async () => null,
  getInventoryImageFile: async () => null,
  inventoryRepository: {
    getActiveCaptureSession: async () => activeCaptureSession,
    getInventoryItem: async () => null,
    listContainers: async () => [
      {
        createdAt: new Date("2026-07-13T09:00:00.000Z"),
        id: "container-blue-bin",
        location: {
          id: "location-garage-shelf-a",
          kind: "STORAGE",
          name: "Garage shelf A",
        },
        locationId: "location-garage-shelf-a",
        metadata: {},
        name: "Blue bin 4",
        normalizedName: "blue bin 4",
        photoFilePath: null,
        referenceId: "BIN-0004",
        sizeLiters: 45,
        updatedAt: new Date("2026-07-13T09:00:00.000Z"),
        visualPreset: containerVisualPreset,
        visualPresetKey: containerVisualPreset.id,
      },
    ],
    listContainerSummaries: async () => [
      {
        id: "container-blue-bin",
        itemCount: 2,
        latestCapturedAt: new Date("2026-07-13T11:30:00.000Z"),
        locationName: "Garage shelf A",
        name: "Blue bin 4",
        photoFilePath: "/tmp/blue-bin.jpg",
        referenceId: "BIN-0004",
        sampleImages: [
          {
            alt: "Switch dock cables",
            caption: "Switch dock cables",
            id: "image-switch-dock-cables",
          },
        ],
        sampleItems: [
          {
            audioId: null,
            hasAudio: false,
            id: "item-switch-dock-cables",
            imageId: "image-switch-dock-cables",
            textPreview: null,
            title: "Switch dock cables",
          },
        ],
        sizeLiters: 45,
        visualPreset: containerVisualPreset,
        visualPresetKey: containerVisualPreset.id,
      },
    ],
    listContainerVisualPresets: async () => [containerVisualPreset],
    listAllInventoryItems: async () => recentInventoryItems,
    listInventoryEnrichmentJobs: async () => enrichmentJobs,
    listInventoryPreprocessingJobs: async () => preprocessingJobs,
  },
}));

mock.module("@/lib/inventory-service", () => ({
  INVENTORY_ACQUISITION_SOURCE_VALUES: [
    "online",
    "retail",
    "gift",
    "found",
    "work",
    "secondhand",
    "other",
  ],
  INVENTORY_CATEGORY_VALUES: [
    "food",
    "drink",
    "medical",
    "entertainment",
    "office",
    "sports",
    "clothing",
    "technology",
    "cosmetics",
    "documents",
    "tools",
    "cleaning",
    "kitchen",
    "household",
    "other",
  ],
  INVENTORY_IMPORTANCE_VALUES: ["HIGH", "MEDIUM", "LOW"],
  INVENTORY_ITEM_KINDS: ["ITEM", "GROUP"],
  INVENTORY_ITEM_STATUSES: ["KEEP", "DONATE", "TRASH", "UNSURE"],
  formatInventoryAcquisitionSourceLabel: (value: string | null) =>
    value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : null,
  formatInventoryContainerLabel: (
    container: { name: string; referenceId: string } | null,
    fallback: string | null,
  ) => (container ? `${container.name} (${container.referenceId})` : fallback),
  formatInventoryContainerPickerLabel: (container: {
    name: string;
    referenceId: string;
  }) => `${container.name} (${container.referenceId})`,
  formatInventoryPlacementSummary: () => "Total 0",
  formatInventoryCategoryLabel: (value: string | null) =>
    value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : null,
  formatInventoryEstimatedValue: (
    costCents: number | null,
    costCurrency: string,
  ) =>
    costCents === null
      ? null
      : `${costCurrency} ${(costCents / 100).toFixed(2)}`,
  formatInventoryWhere: (item: {
    container?: { name: string; referenceId: string } | null;
    locationName: string | null;
    containerLabel: string | null;
  }) => {
    if (item.container) {
      const containerLabel = `${item.container.name} (${item.container.referenceId})`;

      return item.locationName
        ? `${item.locationName} / ${containerLabel}`
        : containerLabel;
    }

    return "Unplaced";
  },
  normalizeInventoryAcquisitionSource: (value: string | null | undefined) =>
    value ?? null,
  normalizeInventoryCategory: (value: string | null | undefined) =>
    value ?? null,
  readInventoryItemManualFieldLocks: () => [],
  listRecentInventoryItems: async () =>
    recentInventoryItems.map((item) => ({
      ...item,
      matchExplanation: "Recent capture",
      matchFields: [],
      whereLabel: item.container
        ? `${item.locationName} / ${item.container.name} (${item.container.referenceId})`
        : "Unplaced",
    })),
  searchInventory: async () => [],
}));

function findPreprocessingJob(itemId: string) {
  return preprocessingJobs.find((job) => job.targetItemId === itemId) ?? null;
}

function findEnrichmentJob(itemId: string) {
  return enrichmentJobs.find((job) => job.targetItemId === itemId) ?? null;
}

function buildApiInventoryItem(id: string) {
  const item = recentInventoryItems.find((candidate) => candidate.id === id);

  if (!item) {
    return null;
  }

  const preprocessingJob = findPreprocessingJob(id);
  const enrichmentJob = findEnrichmentJob(id);
  const containerLabel = item.container
    ? `${item.container.name} (${item.container.referenceId})`
    : item.containerLabel;
  const where = item.container
    ? `${item.locationName} / ${containerLabel}`
    : (item.locationName ?? "Unplaced");

  return {
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    archivedAt: null,
    captureText: item.captureText,
    capturedAt: item.capturedAt.toISOString(),
    category: item.category,
    containerId: item.container?.id ?? null,
    containerLabel,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    id: item.id,
    imageId:
      item.images.length > 0
        ? ((item.images[0] as { id?: string | null }).id ?? null)
        : null,
    importance: item.importance,
    kind: item.kind,
    note: item.note,
    placementSummary: `${containerLabel ?? "Unplaced"} × 1`,
    placements: [
      {
        containerId: item.container?.id ?? null,
        label: containerLabel ?? "Unplaced",
        locationId: null,
        locationName: item.container?.location?.name ?? null,
        note: null,
        placementId: `placement-${item.id}`,
        quantity: 1,
      },
    ],
    processing: buildApiItemProcessing(
      item.id,
      preprocessingJob,
      enrichmentJob,
    ),
    status: item.status,
    tags: item.tags,
    title: item.title,
    totalQuantity: 1,
    where,
  };
}

function buildApiProposal(itemId: string) {
  if (itemId !== "item-passport-pouch") {
    return null;
  }

  return {
    captureText: "Passport pouch with charger and pen.",
    capturedAt: "2026-07-13T11:30:00.000Z",
    confidence: 0.94,
    diff: [
      {
        current: "Passport pouch",
        field: "title",
        label: "Title",
        proposed: "Passport pouch",
      },
      {
        current: "None",
        field: "category",
        label: "Category",
        proposed: "Documents",
      },
    ],
    failedSteps: [],
    id: "job-passport-pouch",
    ocrEvidence: [
      {
        id: "image-passport-pouch",
        preview: "PASSPORT CHARGER",
        secondary: "test OCR",
      },
    ],
    itemId,
    itemTitle: "Passport pouch",
    rationale: "OCR and transcript match a travel document pouch.",
    sourceRefsSummary: "1 item, 1 image, 1 audio, 0 file",
    transcriptEvidence: [
      {
        id: "audio-passport-pouch",
        preview: "Passport pouch with charger and pen.",
        secondary: "0.0s-2.0s",
      },
    ],
    updatedAt: "2026-07-13T11:35:00.000Z",
  };
}

function buildApiItemProcessing(
  itemId: string,
  preprocessingJob: (typeof preprocessingJobs)[number] | null,
  enrichmentJob: (typeof enrichmentJobs)[number] | null,
) {
  const preprocessingStatus = mapPreprocessingStatus(preprocessingJob?.status);
  const enrichmentStatus = mapEnrichmentStatus(enrichmentJob?.status);
  const proposalStatus = mapProposalStatus(enrichmentJob?.status);
  const preprocessingSummary =
    preprocessingStatus === "PREPROCESSING"
      ? "Reading evidence"
      : preprocessingStatus === "READY_FOR_ENRICHMENT"
        ? "Inventory Text Bundle is ready for enrichment."
        : "Saved evidence is waiting for preprocessing pickup.";
  const enrichmentSummary =
    enrichmentStatus === "PROPOSAL_READY"
      ? "An Inventory Proposal is waiting for approval."
      : enrichmentStatus === "PROCESSING"
        ? "Inventory Enrichment is processing the text bundle."
        : enrichmentStatus === "FAILED"
          ? "Inventory Enrichment failed."
          : enrichmentStatus === "REJECTED"
            ? "The Inventory Proposal was rejected."
            : enrichmentStatus === "CANCELLED"
              ? "Inventory Enrichment was cancelled."
              : "Inventory Enrichment has not started.";
  const proposalSummary =
    proposalStatus === "PENDING_APPROVAL"
      ? "Approval required before derived values change."
      : proposalStatus === "REJECTED"
        ? "Proposal rejected."
        : "No pending Inventory Proposal.";

  return {
    currentStep:
      proposalStatus === "PENDING_APPROVAL"
        ? "Proposal pending approval"
        : enrichmentStatus === "REJECTED"
          ? "Inventory Proposal rejected"
          : enrichmentStatus === "FAILED"
            ? "Inventory Enrichment failed"
            : enrichmentStatus === "CANCELLED"
              ? "Inventory Enrichment superseded"
              : preprocessingStatus === "PREPROCESSING"
                ? "Reading evidence"
                : "Wait for background processing",
    evidence:
      itemId === "item-passport-pouch"
        ? [
            {
              id: "image-passport-pouch",
              kind: "photo" as const,
              label: "Item Image",
              summary: "Passport pouch capture",
            },
            {
              id: "image-passport-pouch-back",
              kind: "photo" as const,
              label: "Item Image",
              summary: "Passport pouch back",
            },
            {
              id: "audio-passport-pouch",
              kind: "voice" as const,
              label: "Audio note",
              summary: "Passport pouch voice note",
            },
            {
              id: "text-passport-pouch",
              kind: "text" as const,
              label: "Typed capture text",
              summary: "Passport pouch with charger and pen.",
            },
          ]
        : [
            {
              id: `image-${itemId}`,
              kind: "photo" as const,
              label: "Item Image",
              summary: "Switch dock capture",
            },
            {
              id: `audio-${itemId}`,
              kind: "voice" as const,
              label: "Audio note",
              summary: "Switch dock voice note",
            },
          ],
    enrichment: {
      rationale:
        proposalStatus === "PENDING_APPROVAL"
          ? "OCR and transcript mention passports and chargers."
          : enrichmentSummary,
      status: enrichmentStatus,
      summary: enrichmentSummary,
      updatedAt:
        enrichmentJob?.updatedAt.toISOString() ??
        preprocessingJob?.updatedAt.toISOString() ??
        new Date("2026-07-13T11:00:00.000Z").toISOString(),
    },
    nextAction:
      proposalStatus === "PENDING_APPROVAL"
        ? "Review Inventory Proposal"
        : enrichmentStatus === "FAILED"
          ? "Review enrichment failure"
          : enrichmentStatus === "REJECTED" || enrichmentStatus === "CANCELLED"
            ? "No action required"
            : "Wait for background processing",
    preprocessing: {
      failedSteps:
        preprocessingStatus === "PARTIAL" ||
        preprocessingStatus === "NEEDS_REVIEW"
          ? ["Audio transcription timed out."]
          : [],
      mediaTexts:
        itemId === "item-passport-pouch"
          ? [
              "OCR: PASSPORT CHARGER",
              "Transcript: Passport pouch with charger and pen.",
            ]
          : [],
      status: preprocessingStatus,
      summary: preprocessingSummary,
      textBundleAvailable: itemId === "item-passport-pouch",
      updatedAt:
        preprocessingJob?.updatedAt.toISOString() ??
        new Date("2026-07-13T11:00:00.000Z").toISOString(),
    },
    proposal: {
      status: proposalStatus,
      summary: proposalSummary,
      updatedAt:
        enrichmentJob?.updatedAt.toISOString() ??
        preprocessingJob?.updatedAt.toISOString() ??
        new Date("2026-07-13T11:00:00.000Z").toISOString(),
    },
    sourceLabel:
      itemId === "item-passport-pouch"
        ? "OCR and transcript"
        : "Photo + voice capture",
  };
}

function mapPreprocessingStatus(status: string | undefined) {
  if (status === "PROCESSING") {
    return "PREPROCESSING";
  }

  if (status === "READY_FOR_ENRICHMENT") {
    return "READY_FOR_ENRICHMENT";
  }

  if (status === "PARTIAL") {
    return "PARTIAL";
  }

  if (status === "FAILED" || status === "NEEDS_REVIEW") {
    return "NEEDS_REVIEW";
  }

  return "CAPTURED";
}

function mapEnrichmentStatus(status: InventoryEnrichmentJobStatus | undefined) {
  if (status === "QUEUED") {
    return "QUEUED";
  }

  if (status === "CLAIMED") {
    return "PROCESSING";
  }

  if (status === "PENDING_APPROVAL") {
    return "PROPOSAL_READY";
  }

  if (status === "APPLIED") {
    return "APPLIED";
  }

  if (status === "FAILED") {
    return "FAILED";
  }

  if (status === "REJECTED") {
    return "REJECTED";
  }

  if (status === "CANCELLED") {
    return "CANCELLED";
  }

  return "NOT_STARTED";
}

function mapProposalStatus(status: InventoryEnrichmentJobStatus | undefined) {
  if (status === "PENDING_APPROVAL") {
    return "PENDING_APPROVAL";
  }

  if (status === "APPLIED") {
    return "APPROVED";
  }

  if (status === "REJECTED") {
    return "REJECTED";
  }

  return "NONE";
}

mock.module("@/lib/quantself-api-client", () => ({
  approveInventoryProposal: async () => {},
  getActiveInventoryCaptureSession: async () => ({
    container: null,
    containerLabel: activeCaptureSession.defaultContainerLabel,
    destinationLocation: activeCaptureSession.defaultDestinationLocation.name,
    id: activeCaptureSession.id,
    label: activeCaptureSession.label,
    note: activeCaptureSession.note,
    originRoom: activeCaptureSession.defaultOriginLocation.name,
  }),
  getInventoryItem: async (id: string) => buildApiInventoryItem(id),
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  isApiAuthenticationError: (error: unknown) =>
    error === apiAuthenticationError,
  isApiNotFoundError: () => false,
  listActiveInventoryItems: async () => {
    if (activeItemsError) {
      throw activeItemsError;
    }

    return recentInventoryItems
      .map(({ id }) => buildApiInventoryItem(id))
      .filter((entry) => entry !== null);
  },
  listInventoryItemsPage: async () => {
    if (activeItemsError) {
      throw activeItemsError;
    }
    const items = recentInventoryItems
      .map(({ id }) => buildApiInventoryItem(id))
      .filter((entry) => entry !== null);
    return { items, pageInfo: { nextCursor: null }, total: items.length };
  },
  listInventoryItems: async (input?: { query?: string | null }) => {
    const query = input?.query?.trim().toLowerCase();

    return recentInventoryItems
      .map(({ id }) => buildApiInventoryItem(id))
      .filter((entry) => entry !== null)
      .filter((entry) =>
        query
          ? [
              entry.title,
              entry.captureText,
              entry.where,
              ...entry.aliases,
              ...entry.tags,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query)
          : true,
      );
  },
  listInventoryContainerVisuals: async () => ({
    editableVisuals: [
      {
        bounds: containerVisualPreset.bounds,
        defaultBounds: containerVisualPreset.bounds,
        defaultHoverBounds: containerVisualPreset.bounds,
        frontImageUrl: containerVisualPreset.frontImageUrl,
        height: containerVisualPreset.height,
        hoverBounds: containerVisualPreset.bounds,
        key: containerVisualPreset.id,
        name: containerVisualPreset.name,
        width: containerVisualPreset.width,
      },
    ],
    visualPresets: [containerVisualPreset],
  }),
  listInventoryContainers: async () => [
    {
      createdAt: new Date("2026-07-13T09:00:00.000Z").toISOString(),
      id: "container-blue-bin",
      location: {
        id: "location-garage-shelf-a",
        kind: "STORAGE" as const,
        name: "Garage shelf A",
      },
      locationId: "location-garage-shelf-a",
      locationName: "Garage shelf A",
      metadata: {},
      name: "Blue bin 4",
      normalizedName: "blue bin 4",
      referenceId: "BIN-0004",
      sizeLiters: 45,
      updatedAt: new Date("2026-07-13T09:00:00.000Z").toISOString(),
      visualPreset: containerVisualPreset,
      visualPresetKey: containerVisualPreset.id,
    },
  ],
  listInventoryLocations: async () => [
    {
      containerCount: 1,
      id: "location-garage-shelf-a",
      kind: "STORAGE" as const,
      name: "Garage shelf A",
      note: null,
      placementCount: 0,
    },
  ],
  listInventoryItemMedia: async () => [],
  listInventoryProposals: async (input?: {
    limit?: number;
    itemId?: string;
  }) => {
    const proposal = buildApiProposal(input?.itemId ?? "");

    return proposal ? [proposal].slice(0, input?.limit ?? 1) : [];
  },
  rejectInventoryProposal: async () => {},
  resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
}));

afterAll(() => {
  mock.restore();
});

describe("inventory route shell", () => {
  test("keeps core route headers visible while data skeletons load", async () => {
    const [
      { default: CaptureLoading },
      { default: BrowseLoading },
      { default: ProcessingLoading },
      { default: ArchiveLoading },
    ] = await Promise.all([
      import("./loading"),
      import("./browse/loading"),
      import("./processing/loading"),
      import("./archive/loading"),
    ]);
    const pages = [
      [CaptureLoading, "Inventory"],
      [BrowseLoading, "Browse inventory"],
      [ProcessingLoading, "Inventory processing"],
      [ArchiveLoading, "Inventory archive"],
    ] as const;

    for (const [Loading, title] of pages) {
      const html = renderToStaticMarkup(
        <ChakraTestWrapper>
          <Loading />
        </ChakraTestWrapper>,
      );

      expect(html).toContain(`<h1`);
      expect(html).toContain(title);
      expect(html).toContain('aria-label="Inventory routes"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="status"');
    }
  });

  test("renders the real low-friction capture page without prototype variant dependency", async () => {
    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(
      InventoryPage({
        searchParams: Promise.resolve({ variant: "B" }),
      }),
    );

    expect(html).toContain("Inventory");
    expect(html).toContain("Capture Session");
    expect(html).not.toContain("Processing now");
    expect(html).not.toContain(
      "Latest saved captures and whether preprocessing is queued, running, or needs review.",
    );
    expect(html).toContain("Photos");
    expect(html).toContain("Take photo");
    expect(html).toContain("Upload photos");
    expect(html).toContain("Audio notes");
    expect(html).toContain("Record audio");
    expect(html).toContain("Upload audio");
    expect(html).toContain("Typed capture text");
    expect(html).toContain("Container");
    expect(html).not.toContain("Filter containers");
    expect(html).toContain("Details");
    expect(html).toContain("Create item");
    expect(html).toContain('href="/inventory/containers"');
    expect(html).toContain('href="/inventory/processing"');
    expect(html).not.toContain("Recent captures");
    expect(html).not.toContain(">Item detail<");
    expect(html).not.toContain("UI prototype");
    expect(html).not.toContain("Next prototype variant");
    expect(html).not.toContain("mock only");
    expect(html).toContain("Search inventory");
  });

  test("uses the container shelf as the canonical containers route", () => {
    const source = readFileSync(
      new URL("./containers/page.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("listInventoryContainers()");
    expect(source).toContain("<ContainersClient");
    expect(source).not.toContain("<InventoryShellLayout");
  });

  test("renders the processing route shell with inventory pipeline columns", async () => {
    const { default: InventoryProcessingPage } =
      await import("./processing/page");
    const html = await renderStream(InventoryProcessingPage());

    expect(html).toContain("Inventory processing");
    expect(html).not.toContain("Review first");
    expect(html).not.toContain("Fix blocked items first");
    expect(html).toContain("Pipeline");
    expect(html).toContain("Filter");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Captured");
    expect(html).toContain("Preprocessing");
    expect(html).toContain("Enrichment");
    expect(html).toContain("Needs review");
    expect(html).toContain("OCR and transcript");
    expect(html).toContain("Passport pouch");
    expect(html).toContain("Switch dock cables");
    expect(html).toContain("Office cabinet / Travel drawer (BIN-0003)");
    expect(html).toContain("Garage shelf A / Blue bin 4 (BIN-0004)");
    expect(html).not.toContain("Desk lamp kit");
    expect(html).not.toContain("Tool roll");
    expect(html).not.toContain("shadow-[inset_3px_0_0_var(--color-warning)]");
    expect(html).toContain("Reading evidence");
    expect(html).toContain("Approve proposal");
    expect(html).toContain("Next: Review Inventory Proposal");
    expect(html).toContain("Next: Wait for background processing");
    expect(html).toContain(
      'href="/inventory/items/item-passport-pouch?returnTo=%2Finventory%2Fprocessing"',
    );
    expect(html).toContain(
      'href="/inventory/items/item-switch-dock-cables?returnTo=%2Finventory%2Fprocessing"',
    );
  });

  test("routes failed preprocessing to review with an accurate badge", async () => {
    const { InventoryProcessingBoard } =
      await import("./inventory-processing-board");
    const { getInventoryShellProcessingColumns, inventoryShellItems } =
      await import("./inventory-shell-data");
    const source = inventoryShellItems[1]!;
    const failedItem = {
      ...source,
      enrichment: { ...source.enrichment, status: "NOT_STARTED" as const },
      preprocessing: { ...source.preprocessing, status: "FAILED" as const },
      proposal: { ...source.proposal, status: "NONE" as const },
    };
    const columns = getInventoryShellProcessingColumns([failedItem]);
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryProcessingBoard columns={columns} />
      </ChakraTestWrapper>,
    );

    expect(
      columns.find((column) => column.id === "needs-review")?.items,
    ).toContainEqual(failedItem);
    expect(html).toContain("Review preprocessing");
    expect(html).not.toContain("Waiting pickup");
  });

  test("propagates an unauthenticated Browse read", async () => {
    activeItemsError = apiAuthenticationError;

    try {
      const { default: InventoryBrowsePage } = await import("./browse/page");

      await expect(
        renderStream(
          InventoryBrowsePage({
            searchParams: Promise.resolve({}),
          }),
        ),
      ).rejects.toBe(apiAuthenticationError);

    } finally {
      activeItemsError = null;
    }
  });

  test("maps a rejected production proposal to a terminal state", async () => {
    const originalStatus = enrichmentJobs[0]!.status;
    enrichmentJobs[0]!.status = "REJECTED";

    try {
      const { loadInventoryShellItems } =
        await import("./inventory-shell-api-data");
      const {
        getInventoryShellDetailMode,
        getInventoryShellProcessingColumns,
      } = await import("./inventory-shell-data");
      const items = await loadInventoryShellItems();
      const rejectedItem = items.find(
        (item) => item.id === "item-passport-pouch",
      );

      expect(rejectedItem?.enrichment.status).toBe("REJECTED");
      expect(rejectedItem?.proposal.status).toBe("REJECTED");
      expect(rejectedItem?.currentStep).toBe("Inventory Proposal rejected");
      expect(rejectedItem?.nextAction).toBe("No action required");
      expect(rejectedItem && getInventoryShellDetailMode(rejectedItem)).toBe(
        "complete",
      );
      expect(
        getInventoryShellProcessingColumns(items)
          .flatMap((column) => column.items)
          .map((item) => item.id),
      ).not.toContain("item-passport-pouch");
    } finally {
      enrichmentJobs[0]!.status = originalStatus;
    }
  });

  test("maps superseded production enrichment to a terminal state", async () => {
    const originalStatus = enrichmentJobs[0]!.status;
    enrichmentJobs[0]!.status = "CANCELLED";

    try {
      const { loadInventoryShellItems } =
        await import("./inventory-shell-api-data");
      const {
        getInventoryShellDetailMode,
        getInventoryShellProcessingColumns,
      } = await import("./inventory-shell-data");
      const items = await loadInventoryShellItems();
      const supersededItem = items.find(
        (item) => item.id === "item-passport-pouch",
      );

      expect(supersededItem?.enrichment.status).toBe("CANCELLED");
      expect(supersededItem?.currentStep).toBe(
        "Inventory Enrichment superseded",
      );
      expect(supersededItem?.nextAction).toBe("No action required");
      expect(
        supersededItem && getInventoryShellDetailMode(supersededItem),
      ).toBe("complete");
      expect(
        getInventoryShellProcessingColumns(items)
          .flatMap((column) => column.items)
          .map((item) => item.id),
      ).not.toContain("item-passport-pouch");
    } finally {
      enrichmentJobs[0]!.status = originalStatus;
    }
  });

  test("maps failed production enrichment to a review state", async () => {
    const originalStatus = enrichmentJobs[0]!.status;
    enrichmentJobs[0]!.status = "FAILED";

    try {
      const { loadInventoryShellItems } =
        await import("./inventory-shell-api-data");
      const {
        getInventoryShellDetailMode,
        getInventoryShellProcessingColumns,
      } = await import("./inventory-shell-data");
      const items = await loadInventoryShellItems();
      const failedItem = items.find(
        (item) => item.id === "item-passport-pouch",
      );

      expect(failedItem?.enrichment.status).toBe("FAILED");
      expect(failedItem?.currentStep).toBe("Inventory Enrichment failed");
      expect(failedItem?.nextAction).toBe("Review enrichment failure");
      expect(failedItem && getInventoryShellDetailMode(failedItem)).toBe(
        "error",
      );
      expect(
        getInventoryShellProcessingColumns(items)
          .find((column) => column.id === "needs-review")
          ?.items.map((item) => item.id),
      ).toContain("item-passport-pouch");
    } finally {
      enrichmentJobs[0]!.status = originalStatus;
    }
  });

  test("renders proposal detail from API-backed inventory proposal data", async () => {
    const { default: InventoryItemPage } =
      await import("./items/[itemId]/page");
    const html = await renderStream(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-passport-pouch" }),
      }),
    );

    expect(html).toContain("Passport pouch");
    expect(html).toContain("Proposal review");
    expect(html).toContain("Source facts");
    expect(html).toContain("Proposed Inventory Enrichment");
    expect(html).toContain("Approve proposal");
    expect(html).toContain("Reject proposal");
    expect(html).toContain("Inventory Text Bundle");
    expect(html).toContain(">Back</a>");
    expect(html).toContain('href="/inventory/browse"');
    expect(html).toContain('href="/inventory/processing"');
  });

  test("renders real inventory detail for processing-board links", async () => {
    const { default: InventoryItemPage } =
      await import("./items/[itemId]/page");
    const html = await renderStream(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-switch-dock-cables" }),
        searchParams: Promise.resolve({
          returnTo: "/inventory/processing",
        }),
      }),
    );

    expect(html).toContain(">Back</a>");
    expect(html).toContain('href="/inventory/processing"');
    expect(html).toContain("Switch dock cables");
    expect(html).not.toContain(">Inventory item<");
    expect(html).toContain("Stock");
    expect(html).not.toContain("Stored in");
    expect(html).toContain("Media");
    expect(html).not.toContain("Approve proposal");
  });

  test("cuts the processing adapter over to the generated API client", () => {
    const source = readFileSync(
      new URL("./inventory-shell-api-data.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("listActiveInventoryItems");
    expect(source).not.toContain("inventoryRepository");
  });

  test("preserves API media details and single-placement card behavior", async () => {
    const { loadInventoryShellItems } =
      await import("./inventory-shell-api-data");
    const { inventoryShellItemCardModel } =
      await import("./inventory-item-card");
    const items = await loadInventoryShellItems();
    const item = items.find(
      (candidate) => candidate.id === "item-passport-pouch",
    );

    expect(item && inventoryShellItemCardModel(item).placementCount).toBe(1);
    expect(item?.images.map((image) => image.id)).toEqual([
      "image-passport-pouch",
      "image-passport-pouch-back",
    ]);
    expect(item?.textBundle.mediaTexts).toEqual([
      "OCR: PASSPORT CHARGER",
      "Transcript: Passport pouch with charger and pen.",
    ]);
  });

  test("keeps shared mock inventory records rich enough for the shell routes", async () => {
    const { inventoryShellItems } = await import("./inventory-shell-data");

    expect(inventoryShellItems.length).toBeGreaterThanOrEqual(4);
    expect(inventoryShellItems[0]).toEqual(
      expect.objectContaining({
        captureSession: expect.objectContaining({
          id: expect.any(String),
          label: expect.any(String),
        }),
        container: expect.objectContaining({
          id: expect.any(String),
          location: expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
          }),
          name: expect.any(String),
          referenceId: expect.any(String),
        }),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            kind: expect.any(String),
            label: expect.any(String),
          }),
        ]),
        images: expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            alt: expect.any(String),
          }),
        ]),
        preprocessing: expect.objectContaining({
          status: expect.any(String),
          summary: expect.any(String),
        }),
        textBundle: expect.objectContaining({
          summary: expect.any(String),
        }),
        enrichment: expect.objectContaining({
          status: expect.any(String),
          summary: expect.any(String),
        }),
        proposal: expect.objectContaining({
          status: expect.any(String),
          summary: expect.any(String),
        }),
      }),
    );
    expect(inventoryShellItems[0]).not.toHaveProperty("currentLocation");
    expect(inventoryShellItems[0]).not.toHaveProperty("originLocation");
  });

  test("retires the old inventory prototype modules from the active app tree", () => {
    const inventoryDir = dirname(fileURLToPath(import.meta.url));
    const componentsDir = join(inventoryDir, "../../components");

    expect(
      existsSync(join(inventoryDir, "inventory-ui-prototype.tsx")),
    ).toBeFalse();
    expect(existsSync(join(inventoryDir, "PROTOTYPE_NOTES.md"))).toBeFalse();
    expect(
      existsSync(join(componentsDir, "prototype-switcher.tsx")),
    ).toBeFalse();
    expect(
      existsSync(join(componentsDir, "inventory-capture-forms.tsx")),
    ).toBeFalse();
  });
});

async function renderStream(node: ReactNode): Promise<string> {
  let renderError: unknown;
  const stream = await renderToReadableStream(
    <ChakraTestWrapper>{node}</ChakraTestWrapper>,
    {
      onError(error) {
        renderError ??= error;
      },
    },
  );
  await stream.allReady;
  if (renderError) {
    throw renderError;
  }

  return (await new Response(stream).text()).replaceAll("<!-- -->", "");
}
