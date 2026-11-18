export type InventoryShellLocation = {
  id: string;
  name: string;
};

export type InventoryShellContainer = {
  id: string;
  location: InventoryShellLocation | null;
  name: string;
  referenceId: string;
};

export type InventoryShellImage = {
  id: string;
  alt: string;
  caption: string;
  ocrText: string;
};

export type InventoryShellEvidence = {
  id: string;
  kind: "photo" | "voice" | "video" | "file" | "text";
  label: string;
  summary: string;
};

export type InventoryShellPreprocessingStatus =
  | "CAPTURED"
  | "PREPROCESSING"
  | "READY_FOR_ENRICHMENT"
  | "PARTIAL"
  | "NEEDS_REVIEW"
  | "FAILED";

export type InventoryShellEnrichmentStatus =
  | "NOT_STARTED"
  | "QUEUED"
  | "PROCESSING"
  | "PROPOSAL_READY"
  | "APPLIED"
  | "FAILED"
  | "REJECTED"
  | "CANCELLED";

export type InventoryShellProposalStatus =
  | "NONE"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED";

export type InventoryShellProposalDiff = {
  field: string;
  current: string;
  proposed: string;
};

export type InventoryShellTimelineEntry = {
  at: string;
  label: string;
};

export type InventoryShellDetailMode =
  | "proposal"
  | "processing"
  | "error"
  | "complete";

export type InventoryShellItem = {
  id: string;
  title: string;
  sourceLabel: string;
  kind: "ITEM" | "GROUP";
  status: "KEEP" | "DONATE" | "TRASH" | "UNSURE";
  importance: "HIGH" | "MEDIUM" | "LOW";
  category: string | null;
  acquisitionSource: string | null;
  costCents: number | null;
  costCurrency: string;
  capturedAt: string;
  ageLabel: string;
  currentStep: string;
  nextAction: string;
  captureSession: {
    id: string;
    label: string;
    originLocation: InventoryShellLocation;
    destinationLocation: InventoryShellLocation;
    containerLabel: string;
    note: string;
  };
  container: InventoryShellContainer | null;
  containerLabel: string | null;
  placements?: Array<{
    container: InventoryShellContainer | null;
    note: string | null;
    quantity: number;
  }>;
  totalQuantity?: number;
  images: InventoryShellImage[];
  videoId?: string | null;
  evidence: InventoryShellEvidence[];
  preprocessing: {
    status: InventoryShellPreprocessingStatus;
    summary: string;
    failedSteps: string[];
    updatedAt: string;
  };
  textBundle: {
    summary: string;
    captureText: string;
    mediaTexts: string[];
    failedSteps: string[];
  };
  enrichment: {
    status: InventoryShellEnrichmentStatus;
    summary: string;
    rationale: string;
    derivedFields: string[];
    updatedAt: string;
  };
  proposal: {
    status: InventoryShellProposalStatus;
    summary: string;
    diff: InventoryShellProposalDiff[];
    updatedAt: string;
  };
  searchCorpus?: string;
  trail: InventoryShellTimelineEntry[];
};

export type InventoryShellProcessingColumnId =
  | "captured"
  | "preprocessing"
  | "enrichment"
  | "needs-review";

export type InventoryShellProcessingColumn = {
  id: InventoryShellProcessingColumnId;
  title: string;
  summary: string;
  items: InventoryShellItem[];
};

export function formatInventoryShellWhere(item: {
  container: InventoryShellContainer | null;
  placements?: InventoryShellItem["placements"];
}): string {
  if (item.placements && item.placements.length > 0) {
    return item.placements
      .map((placement) => {
        const label =
          formatInventoryShellContainer(placement.container) ??
          placement.note ??
          "Unplaced";

        return `${label} × ${placement.quantity}`;
      })
      .join(" · ");
  }

  const containerLabel = formatInventoryShellContainer(item.container);

  if (item.container?.location?.name && containerLabel) {
    return `${item.container.location.name} / ${containerLabel}`;
  }

  return containerLabel ?? "Unplaced";
}

export function formatInventoryShellContainer(
  container: Pick<InventoryShellContainer, "name" | "referenceId"> | null,
): string | null {
  if (!container) {
    return null;
  }

  return `${container.name} (${container.referenceId})`;
}

export function formatInventoryShellCategory(category: string | null): string {
  return formatInventoryShellEnum(category) ?? "None";
}

export function formatInventoryShellAcquisitionSource(
  acquisitionSource: string | null,
): string {
  return formatInventoryShellEnum(acquisitionSource) ?? "None";
}

export function formatInventoryShellEstimatedValue(item: {
  costCents: number | null;
  costCurrency: string;
}): string {
  if (item.costCents === null) {
    return "None";
  }

  return `${item.costCurrency.toUpperCase()} ${(item.costCents / 100).toFixed(2)}`;
}

const apartmentResetSession = {
  containerLabel: "Travel drawer",
  destinationLocation: {
    id: "location-office-cabinet",
    name: "Office cabinet",
  },
  id: "session-apartment-reset",
  label: "Apartment reset",
  note: "Read-only route shell for the new inventory experience.",
  originLocation: {
    id: "location-entryway-floor",
    name: "Entryway floor",
  },
} satisfies InventoryShellItem["captureSession"];

export const inventoryShellItems: InventoryShellItem[] = [
  {
    ageLabel: "18m",
    acquisitionSource: "gift",
    captureSession: apartmentResetSession,
    category: null,
    capturedAt: "2026-07-12T15:40:00.000Z",
    containerLabel: "Travel drawer",
    container: {
      id: "container-travel-drawer",
      location: {
        id: "location-office-cabinet",
        name: "Office cabinet",
      },
      name: "Travel drawer",
      referenceId: "BIN-0003",
    },
    costCents: 0,
    costCurrency: "CAD",
    currentStep: "Proposal pending approval",
    evidence: [
      {
        id: "evidence-passport-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Passport and boarding pass visible in a dark pouch.",
      },
      {
        id: "evidence-passport-voice",
        kind: "voice",
        label: "Voice note",
        summary: "Travel documents pouch. Keep with passports.",
      },
      {
        id: "evidence-passport-text",
        kind: "text",
        label: "Manual text",
        summary: "Travel docs for August flights.",
      },
    ],
    enrichment: {
      derivedFields: [
        "title: Passport pouch",
        "category: documents",
        "tags: passport, travel, identity",
      ],
      rationale:
        "Inventory Enrichment matched passport, boarding pass, and travel wording.",
      status: "PROPOSAL_READY",
      summary: "Derived values are ready but still read-only until approval.",
      updatedAt: "2026-07-12T15:53:00.000Z",
    },
    id: "item-passport-pouch",
    images: [
      {
        alt: "Passport pouch with passport and boarding pass",
        caption: "Dark pouch with passport, boarding pass, and pen loop.",
        id: "image-passport-pouch",
        ocrText: "Passport Boarding Pass",
      },
    ],
    importance: "HIGH",
    kind: "GROUP",
    nextAction: "Review Inventory Proposal diff",
    preprocessing: {
      failedSteps: [],
      status: "READY_FOR_ENRICHMENT",
      summary: "Inventory Preprocessing compiled OCR, voice, and typed source facts.",
      updatedAt: "2026-07-12T15:47:00.000Z",
    },
    proposal: {
      diff: [
        {
          current: "Untitled pouch",
          field: "title",
          proposed: "Passport pouch",
        },
        {
          current: "None",
          field: "category",
          proposed: "documents",
        },
        {
          current: "paper",
          field: "tags",
          proposed: "passport, travel, identity",
        },
      ],
      status: "PENDING_APPROVAL",
      summary: "Approval required before search-visible derived values change.",
      updatedAt: "2026-07-12T15:53:00.000Z",
    },
    sourceLabel: "Voice + photo capture",
    status: "KEEP",
    textBundle: {
      captureText: "Travel documents pouch",
      failedSteps: [],
      mediaTexts: [
        "OCR: Passport Boarding Pass",
        "Transcript: travel documents pouch, keep with passports",
      ],
      summary: "Passport, boarding pass, and travel-document evidence bundled.",
    },
    title: "Passport pouch",
    trail: [
      { at: "2026-07-12T15:40:00.000Z", label: "Captured from entryway floor" },
      {
        at: "2026-07-12T15:47:00.000Z",
        label: "Inventory Preprocessing finished text bundle",
      },
      {
        at: "2026-07-12T15:53:00.000Z",
        label: "Inventory Proposal queued for approval",
      },
    ],
  },
  {
    ageLabel: "41m",
    acquisitionSource: "retail",
    captureSession: apartmentResetSession,
    category: "technology",
    capturedAt: "2026-07-12T15:17:00.000Z",
    containerLabel: "Blue bin 4",
    container: {
      id: "container-blue-bin-4",
      location: {
        id: "location-garage-shelf-a",
        name: "Garage shelf A",
      },
      name: "Blue bin 4",
      referenceId: "BIN-0004",
    },
    costCents: 4999,
    costCurrency: "CAD",
    currentStep: "OCR and transcript still running",
    evidence: [
      {
        id: "evidence-switch-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Dock cables and HDMI adapters spread on the floor.",
      },
      {
        id: "evidence-switch-voice",
        kind: "voice",
        label: "Voice note",
        summary: "Keep with Nintendo Switch dock kit.",
      },
    ],
    enrichment: {
      derivedFields: [],
      rationale: "Inventory Enrichment waits for Inventory Preprocessing text only.",
      status: "NOT_STARTED",
      summary: "No derived values yet; waiting on Inventory Preprocessing.",
      updatedAt: "2026-07-12T15:20:00.000Z",
    },
    id: "item-switch-dock-cables",
    images: [
      {
        alt: "Switch dock cables and adapters",
        caption: "HDMI cable, USB-C adapter, and Switch dock charger.",
        id: "image-switch-dock",
        ocrText: "HDMI USB-C Nintendo",
      },
    ],
    importance: "HIGH",
    kind: "GROUP",
    nextAction: "Wait for Inventory Text Bundle",
    preprocessing: {
      failedSteps: [],
      status: "PREPROCESSING",
      summary: "Worker is extracting OCR and transcript from the latest evidence.",
      updatedAt: "2026-07-12T15:20:00.000Z",
    },
    proposal: {
      diff: [],
      status: "NONE",
      summary: "No Inventory Proposal until derived values exist.",
      updatedAt: "2026-07-12T15:20:00.000Z",
    },
    sourceLabel: "Photo + voice capture",
    status: "KEEP",
    textBundle: {
      captureText: "Switch dock cables",
      failedSteps: [],
      mediaTexts: [],
      summary: "Inventory Text Bundle not ready yet.",
    },
    title: "Switch dock cables",
    trail: [
      { at: "2026-07-12T15:17:00.000Z", label: "Captured from living room console" },
      {
        at: "2026-07-12T15:20:00.000Z",
        label: "Inventory Preprocessing claimed the item",
      },
    ],
  },
  {
    ageLabel: "1h 06m",
    acquisitionSource: "secondhand",
    captureSession: apartmentResetSession,
    category: "tools",
    capturedAt: "2026-07-12T14:52:00.000Z",
    containerLabel: "Red tool roll",
    container: {
      id: "container-red-tool-roll",
      location: {
        id: "location-basement-bench",
        name: "Basement bench",
      },
      name: "Red tool roll",
      referenceId: "KIT-0002",
    },
    costCents: 1500,
    costCurrency: "CAD",
    currentStep: "Partial text needs manual review",
    evidence: [
      {
        id: "evidence-tool-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Small screwdrivers and pry picks in a fabric roll.",
      },
      {
        id: "evidence-tool-voice",
        kind: "voice",
        label: "Voice note",
        summary: "Tiny repair tools, maybe phone opening kit.",
      },
    ],
    enrichment: {
      derivedFields: [],
      rationale: "Inventory Enrichment is blocked until review decides the next step.",
      status: "NOT_STARTED",
      summary: "Partial Inventory Text Bundle exists, but review is still needed.",
      updatedAt: "2026-07-12T15:01:00.000Z",
    },
    id: "item-tool-roll",
    images: [
      {
        alt: "Red tool roll with precision repair tools",
        caption: "Precision repair tools laid out in a cloth roll.",
        id: "image-tool-roll",
        ocrText: "iFix opening picks",
      },
    ],
    importance: "MEDIUM",
    kind: "GROUP",
    nextAction: "Open item detail and review failed steps",
    preprocessing: {
      failedSteps: ["Transcript failed: background shop noise drowned out the note."],
      status: "PARTIAL",
      summary: "OCR succeeded, but audio transcript failed and needs review.",
      updatedAt: "2026-07-12T15:01:00.000Z",
    },
    proposal: {
      diff: [],
      status: "NONE",
      summary: "No Inventory Proposal while review is pending.",
      updatedAt: "2026-07-12T15:01:00.000Z",
    },
    sourceLabel: "Photo + voice capture",
    status: "UNSURE",
    textBundle: {
      captureText: "Tiny repair tools",
      failedSteps: ["transcript: background shop noise"],
      mediaTexts: ["OCR: iFix opening picks"],
      summary: "Only OCR text is usable; voice text failed.",
    },
    title: "Tool roll",
    trail: [
      { at: "2026-07-12T14:52:00.000Z", label: "Captured from basement bench" },
      {
        at: "2026-07-12T15:01:00.000Z",
        label: "Inventory Preprocessing marked the item partial",
      },
    ],
  },
  {
    ageLabel: "1h 34m",
    acquisitionSource: "retail",
    captureSession: apartmentResetSession,
    category: "technology",
    capturedAt: "2026-07-12T14:24:00.000Z",
    containerLabel: "Camera cube",
    container: {
      id: "container-camera-cube",
      location: {
        id: "location-hall-closet-top",
        name: "Hall closet top shelf",
      },
      name: "Camera cube",
      referenceId: "CAM-0011",
    },
    costCents: 6500,
    costCurrency: "CAD",
    currentStep: "Source facts saved",
    evidence: [
      {
        id: "evidence-camera-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Soft camera cube with straps and batteries inside.",
      },
      {
        id: "evidence-camera-text",
        kind: "text",
        label: "Manual text",
        summary: "Camera cube from hall closet. Keep with travel gear.",
      },
    ],
    enrichment: {
      derivedFields: [],
      rationale: "Inventory Enrichment has not started because preprocessing is not claimed yet.",
      status: "NOT_STARTED",
      summary: "Read-only captured status before worker pickup.",
      updatedAt: "2026-07-12T14:24:00.000Z",
    },
    id: "item-camera-cube",
    images: [
      {
        alt: "Camera cube with batteries and straps",
        caption: "Small padded camera cube with straps and spare batteries.",
        id: "image-camera-cube",
        ocrText: "Sony NP-FW50",
      },
    ],
    importance: "MEDIUM",
    kind: "GROUP",
    nextAction: "Queue Inventory Preprocessing",
    preprocessing: {
      failedSteps: [],
      status: "CAPTURED",
      summary: "Source evidence is saved and waiting for worker pickup.",
      updatedAt: "2026-07-12T14:24:00.000Z",
    },
    proposal: {
      diff: [],
      status: "NONE",
      summary: "No Inventory Proposal until enrichment runs.",
      updatedAt: "2026-07-12T14:24:00.000Z",
    },
    sourceLabel: "Photo + typed capture",
    status: "KEEP",
    textBundle: {
      captureText: "Camera cube from hall closet",
      failedSteps: [],
      mediaTexts: [],
      summary: "Inventory Text Bundle not started.",
    },
    title: "Camera cube",
    trail: [
      {
        at: "2026-07-12T14:24:00.000Z",
        label: "Captured from hall closet top shelf",
      },
    ],
  },
  {
    ageLabel: "2h 11m",
    acquisitionSource: "online",
    captureSession: apartmentResetSession,
    category: "office",
    capturedAt: "2026-07-12T13:47:00.000Z",
    containerLabel: "Desk lamp crate",
    container: {
      id: "container-desk-lamp-crate",
      location: {
        id: "location-office-floor",
        name: "Office floor",
      },
      name: "Desk lamp crate",
      referenceId: "CRT-0006",
    },
    costCents: 3500,
    costCurrency: "CAD",
    currentStep: "Inventory Enrichment running",
    evidence: [
      {
        id: "evidence-lamp-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Clamp lamp, bulbs, and power brick beside a crate.",
      },
      {
        id: "evidence-lamp-text",
        kind: "text",
        label: "Manual text",
        summary: "Desk lamp kit with spare bulbs.",
      },
    ],
    enrichment: {
      derivedFields: ["category: office", "tags: lamp, bulb, desk"],
      rationale:
        "Inventory Text Bundle is ready and the worker is preparing derived values.",
      status: "PROCESSING",
      summary: "Inventory Enrichment is processing the text bundle now.",
      updatedAt: "2026-07-12T13:58:00.000Z",
    },
    id: "item-desk-lamp-kit",
    images: [
      {
        alt: "Desk lamp kit with spare bulbs",
        caption: "Black clamp lamp, spare bulbs, and power brick.",
        id: "image-desk-lamp",
        ocrText: "LED Desk Lamp",
      },
    ],
    importance: "LOW",
    kind: "GROUP",
    nextAction: "Wait for Inventory Proposal or auto-apply",
    preprocessing: {
      failedSteps: [],
      status: "READY_FOR_ENRICHMENT",
      summary: "Inventory Text Bundle is complete and ready downstream.",
      updatedAt: "2026-07-12T13:54:00.000Z",
    },
    proposal: {
      diff: [],
      status: "NONE",
      summary: "No Inventory Proposal yet; worker still running.",
      updatedAt: "2026-07-12T13:58:00.000Z",
    },
    sourceLabel: "Photo + typed capture",
    status: "KEEP",
    textBundle: {
      captureText: "Desk lamp kit with spare bulbs",
      failedSteps: [],
      mediaTexts: ["OCR: LED Desk Lamp"],
      summary: "Desk lamp, bulbs, and OCR text bundled for enrichment.",
    },
    title: "Desk lamp kit",
    trail: [
      { at: "2026-07-12T13:47:00.000Z", label: "Captured from office floor" },
      {
        at: "2026-07-12T13:54:00.000Z",
        label: "Inventory Preprocessing produced a full text bundle",
      },
      {
        at: "2026-07-12T13:58:00.000Z",
        label: "Inventory Enrichment worker claimed the item",
      },
    ],
  },
  {
    ageLabel: "2h 44m",
    acquisitionSource: "retail",
    captureSession: apartmentResetSession,
    category: "kitchen",
    capturedAt: "2026-07-12T13:14:00.000Z",
    containerLabel: "Green camp bin",
    container: {
      id: "container-green-camp-bin",
      location: {
        id: "location-hall-closet-camp-bin",
        name: "Hall closet camp bin",
      },
      name: "Green camp bin",
      referenceId: "BIN-0012",
    },
    costCents: 2800,
    costCurrency: "CAD",
    currentStep: "Approved Inventory Proposal applied",
    evidence: [
      {
        id: "evidence-camp-mug-photo",
        kind: "photo",
        label: "Item Image",
        summary: "Nested camping mug, mini stove, and fuel sleeve in a mesh sack.",
      },
      {
        id: "evidence-camp-mug-text",
        kind: "text",
        label: "Manual text",
        summary: "Camping mug kit with stove insert. Keep with camp kitchen.",
      },
    ],
    enrichment: {
      derivedFields: [
        "title: Camping mug kit",
        "category: kitchen",
        "tags: camping, mug, stove",
      ],
      rationale:
        "Inventory Enrichment matched the mug, stove insert, and camp-kitchen wording.",
      status: "APPLIED",
      summary: "Derived values were approved and applied to the Inventory Item.",
      updatedAt: "2026-07-12T13:31:00.000Z",
    },
    id: "item-camping-mug-kit",
    images: [
      {
        alt: "Camping mug kit with nested stove insert",
        caption: "Metal mug with folded stove insert and lighter tucked into a mesh sack.",
        id: "image-camping-mug-kit",
        ocrText: "750ml Camp Mug",
      },
    ],
    importance: "MEDIUM",
    kind: "GROUP",
    nextAction: "No action required",
    preprocessing: {
      failedSteps: [],
      status: "READY_FOR_ENRICHMENT",
      summary: "Inventory Preprocessing finished a full text bundle for review.",
      updatedAt: "2026-07-12T13:19:00.000Z",
    },
    proposal: {
      diff: [
        {
          current: "Metal mug bag",
          field: "title",
          proposed: "Camping mug kit",
        },
        {
          current: "household",
          field: "category",
          proposed: "kitchen",
        },
        {
          current: "mug",
          field: "tags",
          proposed: "camping, mug, stove",
        },
      ],
      status: "APPROVED",
      summary: "Approved proposal already applied to search-visible derived fields.",
      updatedAt: "2026-07-12T13:28:00.000Z",
    },
    sourceLabel: "Photo + typed capture",
    status: "KEEP",
    textBundle: {
      captureText: "Camping mug kit with stove insert",
      failedSteps: [],
      mediaTexts: ["OCR: 750ml Camp Mug"],
      summary: "Inventory Text Bundle bundled the mug label and typed camp-kitchen note.",
    },
    title: "Camping mug kit",
    trail: [
      { at: "2026-07-12T13:14:00.000Z", label: "Captured from hall closet floor" },
      {
        at: "2026-07-12T13:19:00.000Z",
        label: "Inventory Preprocessing produced a full text bundle",
      },
      {
        at: "2026-07-12T13:28:00.000Z",
        label: "Inventory Proposal approved for application",
      },
      {
        at: "2026-07-12T13:31:00.000Z",
        label: "Derived values applied to the Inventory Item",
      },
    ],
  },
];

const processingColumnMetadata: Record<
  InventoryShellProcessingColumnId,
  Omit<InventoryShellProcessingColumn, "items">
> = {
  captured: {
    id: "captured",
    summary: "Source evidence saved. Waiting for worker pickup.",
    title: "Captured",
  },
  enrichment: {
    id: "enrichment",
    summary: "Inventory Text Bundle is ready or Inventory Enrichment is active.",
    title: "Enrichment",
  },
  "needs-review": {
    id: "needs-review",
    summary: "Partial text, failed steps, or pending proposal review.",
    title: "Needs review",
  },
  preprocessing: {
    id: "preprocessing",
    summary: "Inventory Preprocessing is extracting usable text.",
    title: "Preprocessing",
  },
};

const processingColumnOrder: InventoryShellProcessingColumnId[] = [
  "captured",
  "preprocessing",
  "enrichment",
  "needs-review",
];

export function listInventoryShellItemsNewestFirst(
  items: InventoryShellItem[] = inventoryShellItems,
): InventoryShellItem[] {
  return [...items].sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt),
  );
}

export function getInventoryShellItem(itemId: string): InventoryShellItem | null {
  return inventoryShellItems.find((item) => item.id === itemId) ?? null;
}

export function getInventoryShellDetailMode(
  item: InventoryShellItem,
): InventoryShellDetailMode {
  if (
    item.proposal.status === "PENDING_APPROVAL" ||
    item.enrichment.status === "PROPOSAL_READY"
  ) {
    return "proposal";
  }

  if (
    item.preprocessing.status === "PARTIAL" ||
    item.preprocessing.status === "NEEDS_REVIEW" ||
    item.preprocessing.status === "FAILED" ||
    item.enrichment.status === "FAILED"
  ) {
    return "error";
  }

  if (
    item.enrichment.status === "APPLIED" ||
    item.enrichment.status === "REJECTED" ||
    item.enrichment.status === "CANCELLED" ||
    item.proposal.status === "APPROVED" ||
    item.proposal.status === "REJECTED"
  ) {
    return "complete";
  }

  return "processing";
}

export function getInventoryShellSummaryCounts(): Record<
  InventoryShellProcessingColumnId,
  number
> {
  const counts = {
    captured: 0,
    enrichment: 0,
    "needs-review": 0,
    preprocessing: 0,
  } satisfies Record<InventoryShellProcessingColumnId, number>;

  for (const item of inventoryShellItems.filter(isInventoryShellProcessingActive)) {
    counts[getInventoryShellProcessingColumnId(item)] += 1;
  }

  return counts;
}

export function getInventoryShellProcessingColumns(
  items: InventoryShellItem[] = inventoryShellItems,
): InventoryShellProcessingColumn[] {
  return processingColumnOrder.map((columnId) => ({
    ...processingColumnMetadata[columnId],
    items: items.filter(isInventoryShellProcessingActive).filter(
      (item) => getInventoryShellProcessingColumnId(item) === columnId,
    ),
  }));
}

function isInventoryShellProcessingActive(item: InventoryShellItem): boolean {
  return getInventoryShellDetailMode(item) !== "complete";
}

function formatInventoryShellEnum(value: string | null): string | null {
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

function getInventoryShellProcessingColumnId(
  item: InventoryShellItem,
): InventoryShellProcessingColumnId {
  if (
    item.proposal.status === "PENDING_APPROVAL" ||
    item.preprocessing.status === "FAILED" ||
    item.preprocessing.status === "PARTIAL" ||
    item.preprocessing.status === "NEEDS_REVIEW" ||
    item.enrichment.status === "FAILED"
  ) {
    return "needs-review";
  }

  if (
    item.enrichment.status === "QUEUED" ||
    item.enrichment.status === "PROCESSING" ||
    item.enrichment.status === "PROPOSAL_READY"
  ) {
    return "enrichment";
  }

  if (
    item.preprocessing.status === "PREPROCESSING" ||
    item.preprocessing.status === "READY_FOR_ENRICHMENT"
  ) {
    return "preprocessing";
  }

  return "captured";
}
