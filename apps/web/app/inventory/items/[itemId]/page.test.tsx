import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { testContainerVisualPreset } from "../../container-test-fixtures";
import type { InventoryItemRecord } from "../../../../../api/src/inventory-service";

let currentItem: InventoryItemRecord | null = null;
let currentProposals: Array<Record<string, unknown>> = [];
let currentApiItem: Record<string, unknown> | null = null;
let currentApiStatus = 200;

async function renderServerPage(node: ReactNode): Promise<string> {
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
  if (renderError) throw renderError;

  // Assertions describe the rendered UI, excluding provider styles and theme bootstrap code.
  return (await new Response(stream).text())
    .replaceAll("<!-- -->", "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

registerModuleMocks();

afterEach(() => {
  currentItem = null;
  currentProposals = [];
  currentApiItem = null;
  currentApiStatus = 200;
});

afterAll(() => {
  mock.restore();
});

function registerModuleMocks(): void {
  const inventoryActionsMock = () => ({
    addInventoryUnitsAction: async () => ({ message: "", status: "idle" }),
    archiveInventoryItemAction: async () => ({ message: "", status: "idle" }),
    completeInventoryClothingLaundryRedirectAction: async () => {},
    deleteInventoryItemAction: async () => ({ message: "", status: "idle" }),
    markInventoryClothingItemWornRedirectAction: async () => {},
    moveInventoryUnitsAction: async () => ({ message: "", status: "idle" }),
    removeInventoryUnitsAction: async () => ({ message: "", status: "idle" }),
    retryInventoryEnrichmentAction: async () => ({
      message: "",
      status: "idle",
    }),
    retryInventoryPreprocessingAction: async () => ({
      message: "",
      status: "idle",
    }),
    restoreInventoryItemAction: async () => ({ message: "", status: "idle" }),
    undoInventoryClothingWearConfirmationRedirectAction: async () => {},
    updateInventoryClothingProfileAction: async () => ({
      message: "",
      status: "idle",
    }),
    updateInventoryItemAction: async () => ({ message: "", status: "idle" }),
  });

  mock.module("next/link", () => ({
    default: ({
      children,
      href,
    }: {
      children: ReactNode;
      href: string;
    } & Omit<ComponentPropsWithoutRef<"a">, "children" | "href">) => (
      <a href={href}>{children}</a>
    ),
  }));

  mock.module("./inventory-clothing-profile-card", () => ({
    InventoryClothingProfileCard: ({
      clothingProfile,
    }: {
      clothingProfile: {
        attributes: {
          colors?: string[];
          fitNotes?: string;
          kind?: string;
        };
        isDirty: boolean;
      };
    }) => (
      <section>
        <h3>Clothing profile</h3>
        <p>Wear state</p>
        <p>{clothingProfile.isDirty ? "Dirty" : "Clean"}</p>
        <p>{clothingProfile.attributes.kind ?? ""}</p>
        <p>{clothingProfile.attributes.colors?.join(", ") ?? ""}</p>
        <p>{clothingProfile.attributes.fitNotes ?? ""}</p>
        <button type="button">Save clothing profile</button>
      </section>
    ),
  }));

  mock.module("./inventory-remedy-profile-card", () => ({
    InventoryRemedyProfileCard: ({
      remedyProfile,
    }: {
      remedyProfile: {
        externalReferences: Array<{
          referenceId?: string;
          source: string;
          url: string;
        }>;
        potencies: string[];
        selectionSummary: string | null;
      };
    }) => (
      <section>
        <h3>Remedy profile</h3>
        <p>{remedyProfile.potencies.join(", ")}</p>
        <p>{remedyProfile.selectionSummary ?? ""}</p>
        <p>
          {remedyProfile.externalReferences
            .map((reference) =>
              reference.referenceId
                ? `${reference.source} (${reference.referenceId})`
                : reference.source,
            )
            .join(", ")}
        </p>
      </section>
    ),
  }));

  mock.module("./inventory-item-controls", () => ({
    InventoryItemControls: () => (
      <div>
        <button type="button">Edit</button>
        <button type="button">Delete</button>
      </div>
    ),
  }));

  mock.module("./inventory-item-image-manager", () => ({
    InventoryItemImageManager: ({
      images = [],
      itemId,
      title,
    }: {
      images?: Array<{ id: string }>;
      itemId: string;
      title: string;
    }) => (
      <section>
        <h3>Images</h3>
        {images.map((entry) => (
          <img
            alt={title}
            key={entry.id}
            src={`/api/v1/inventory-items/${itemId}/media/${entry.id}`}
          />
        ))}
      </section>
    ),
  }));

  mock.module("./inventory-item-media-manager", () => ({
    InventoryItemMediaManager: ({
      media = [],
      itemId,
    }: {
      media?: Array<{
        contentType: string | null;
        id: string;
        kind: string;
        originalName: string | null;
      }>;
      itemId: string;
    }) => {
      const images = media.filter((entry) => entry.kind === "image");
      const audio = media.filter((entry) => entry.kind === "audio");
      const assets = media.filter((entry) => entry.kind === "asset");

      return (
        <section>
          <h3>Media</h3>
          {images.length > 0 ? (
            <section>
              <h3>Item Images</h3>
              {images.map((entry) => (
                <figure key={entry.id}>
                  <img
                    alt={entry.originalName ?? entry.id}
                    src={`/api/v1/inventory-items/${itemId}/media/${entry.id}`}
                  />
                  <figcaption>{entry.originalName ?? entry.id}</figcaption>
                </figure>
              ))}
            </section>
          ) : null}
          {audio.length > 0 ? (
            <section>
              <h3>Audio</h3>
              {audio.map((entry) => (
                <div key={entry.id}>
                  <audio
                    aria-label={`Play ${entry.originalName ?? entry.id}`}
                    src={`/api/v1/inventory-items/${itemId}/media/${entry.id}`}
                  />
                  <input
                    aria-label={`Seek ${entry.originalName ?? entry.id}`}
                    type="range"
                  />
                  <span>{entry.originalName ?? entry.id}</span>
                </div>
              ))}
            </section>
          ) : null}
          {assets.length > 0 ? (
            <section>
              <h3>Item files</h3>
              {assets.map((entry) => (
                <div key={entry.id}>
                  <a
                    href={`/api/v1/inventory-items/${itemId}/media/${entry.id}`}
                  >
                    {entry.originalName ?? entry.id}
                  </a>
                  <p>{entry.contentType}</p>
                </div>
              ))}
            </section>
          ) : null}
        </section>
      );
    },
  }));

  mock.module("./inventory-item-stock-card", () => ({
    InventoryItemStockCard: ({
      placements,
    }: {
      placements: Array<{ label: string }>;
    }) => (
      <section>
        <h3>Stock</h3>
        {placements.map((placement) => (
          <p key={placement.label}>{placement.label}</p>
        ))}
        <button type="button">Add units</button>
        <button type="button">Move units</button>
        <button type="button">Remove units</button>
      </section>
    ),
  }));

  mock.module("./inventory-item-workflow-card", () => ({
    InventoryItemWorkflowCard: ({
      editHref,
      item,
    }: {
      editHref: string;
      item: {
        processing: {
          enrichment: {
            rationale: string;
            status: string;
          };
          history?: Array<{ summary: string }>;
          preprocessing: {
            attempts: number;
            failureMessage: string | null;
            maxAttempts: number;
            retryable: boolean;
            status: string;
          };
        };
      };
    }) => (
      <section>
        {item.processing.preprocessing.status === "NEEDS_REVIEW" ? (
          <>
            <h3>Processing needs review</h3>
            <p>Inventory Text Bundle</p>
            <p>Preprocessing attempt</p>
            <p>
              {item.processing.preprocessing.attempts} of{" "}
              {item.processing.preprocessing.maxAttempts}
            </p>
            <p>{item.processing.preprocessing.failureMessage}</p>
            {item.processing.preprocessing.retryable ? (
              <button type="button">Retry preprocessing</button>
            ) : (
              <a href={editHref}>Edit source facts</a>
            )}
            <p>No usable text bundle is available yet.</p>
          </>
        ) : null}
        {item.processing.enrichment.status === "APPLIED" ? (
          <>
            <h3>Processing complete</h3>
            <p>Inventory Enrichment outcome</p>
            <p>{item.processing.enrichment.rationale}</p>
            <p>Enrichment · Applied</p>
          </>
        ) : null}
      </section>
    ),
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

  mock.module("@/app/inventory/actions", inventoryActionsMock);
  mock.module(
    "/home/agent/workspace/apps/web/app/inventory/actions.ts",
    inventoryActionsMock,
  );

  const nextNavigationMock = () => ({
    notFound: () => {
      throw new Error("Not found");
    },
    usePathname: () => "/inventory/items/item-1",
    useRouter: () => ({
      push: () => {},
      replace: () => {},
      refresh: () => {},
    }),
    useSearchParams: () => new URLSearchParams(),
  });

  mock.module("next/navigation", nextNavigationMock);
  mock.module("next/navigation.js", nextNavigationMock);

  mock.module("@/lib/quantself-api-client", () => ({
    getActiveInventoryCaptureSession: async () => null,
    getInventoryItem: async (id: string) => {
      if (currentApiStatus === 401) {
        const error = new Error("Authentication required.") as Error & {
          status: number;
        };
        error.status = 401;
        throw error;
      }

      if (currentApiStatus === 404) {
        const error = new Error("Inventory Item not found.") as Error & {
          status: number;
        };
        error.status = 404;
        throw error;
      }

      if (currentApiItem?.id === id) {
        return currentApiItem;
      }

      if (currentItem?.id === id) {
        return buildApiItemFromItem(currentItem);
      }

      const error = new Error("Inventory Item not found.") as Error & {
        status: number;
      };
      error.status = 404;
      throw error;
    },
    inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
      `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
    isApiAuthenticationError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 401,
      ),
    isApiNotFoundError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 404,
      ),
    listInventoryItemMedia: async (itemId: string) => {
      if (currentItem?.id !== itemId) {
        return [];
      }

      return [
        ...currentItem.images.flatMap((image, index) =>
          image.id
            ? [
                {
                  contentType: image.mimeType ?? null,
                  id: image.id,
                  kind: "image" as const,
                  originalName: image.originalName ?? `Image ${index + 1}`,
                  position: index,
                  sizeBytes: image.sizeBytes ?? null,
                },
              ]
            : [],
        ),
        ...(currentItem.audioNotes ?? []).flatMap((audio, index) =>
          audio.id
            ? [
                {
                  contentType: audio.mimeType ?? null,
                  id: audio.id,
                  kind: "audio" as const,
                  originalName: audio.originalName ?? `Audio ${index + 1}`,
                  position: null,
                  sizeBytes: audio.sizeBytes ?? null,
                },
              ]
            : [],
        ),
        ...(currentItem.assets ?? []).flatMap((asset, index) =>
          asset.id
            ? [
                {
                  contentType: asset.mimeType ?? null,
                  id: asset.id,
                  kind: "asset" as const,
                  originalName: asset.originalName ?? `File ${index + 1}`,
                  position: null,
                  sizeBytes: asset.sizeBytes ?? null,
                },
              ]
            : [],
        ),
      ];
    },
    listInventoryContainers: async () => {
      if (!currentItem?.container) {
        return [];
      }

      return [
        {
          createdAt: currentItem.container.createdAt.toISOString(),
          id: currentItem.container.id,
          location: currentItem.container.location ?? null,
          locationId: currentItem.container.locationId ?? null,
          locationName: currentItem.container.location?.name ?? null,
          metadata: currentItem.container.metadata ?? {},
          name: currentItem.container.name,
          normalizedName: currentItem.container.normalizedName ?? "",
          referenceId: currentItem.container.referenceId,
          sizeLiters: currentItem.container.sizeLiters ?? null,
          updatedAt: currentItem.container.updatedAt.toISOString(),
          visualPreset:
            currentItem.container.visualPreset ?? testContainerVisualPreset,
          visualPresetKey:
            currentItem.container.visualPresetKey ??
            testContainerVisualPreset.id,
        },
      ];
    },
    listInventoryLocations: async () => {
      const placements = currentItem?.placements ?? [];
      const directLocations = placements.flatMap((placement) =>
        placement.locationId && placement.location
          ? [
              {
                containerCount: 0,
                id: placement.locationId,
                kind: placement.location.kind,
                name: placement.location.name,
                note: null,
                placementCount: placement.quantity,
              },
            ]
          : [],
      );

      if (directLocations.length > 0) {
        return directLocations;
      }

      return currentItem?.locationId && currentItem.locationName
        ? [
            {
              containerCount: 0,
              id: currentItem.locationId,
              kind: "STORAGE" as const,
              name: currentItem.locationName,
              note: null,
              placementCount: currentItem.totalQuantity ?? 0,
            },
          ]
        : [];
    },
    listInventoryItems: async () => [],
    listInventoryProposals: async (input?: {
      limit?: number;
      itemId?: string;
    }) =>
      currentProposals
        .filter((proposal) =>
          input?.itemId ? proposal.itemId === input.itemId : true,
        )
        .slice(0, input?.limit ?? currentProposals.length),
    resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
  }));
}

function buildApiItemFromItem(item: InventoryItemRecord) {
  const placements = item.placements?.length
    ? item.placements.map((placement) => ({
        containerId: placement.containerId ?? null,
        label:
          formatContainerLabel(placement.container) ??
          placement.location?.name ??
          placement.note ??
          "Unplaced",
        locationId: placement.locationId ?? null,
        locationName:
          placement.location?.name ??
          placement.container?.location?.name ??
          null,
        note: placement.note,
        placementId: placement.id,
        quantity: placement.quantity,
      }))
    : formatContainerLabel(item.container)
      ? [
          {
            containerId: item.container?.id ?? null,
            label: formatContainerLabel(item.container) ?? "Unplaced",
            locationId: item.container?.location?.id ?? item.locationId,
            locationName: item.container?.location?.name ?? item.locationName,
            note: null,
            placementId: `placement-${item.id}-primary`,
            quantity: item.totalQuantity ?? 1,
          },
        ]
      : [];
  const totalQuantity =
    item.totalQuantity ??
    placements.reduce((total, placement) => total + placement.quantity, 0) ??
    1;
  const where =
    placements.length > 0
      ? placements
          .map((placement) => {
            const locationName = placement.locationName ?? item.locationName;

            return locationName
              ? `${locationName} / ${placement.label}`
              : placement.label;
          })
          .join(" · ")
      : "Unplaced";

  return buildApiItem({
    acquisitionSource: item.acquisitionSource ?? null,
    aliases: item.aliases,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    captureText: item.captureText ?? null,
    capturedAt: item.capturedAt.toISOString(),
    category: item.category ?? null,
    containerId: item.containerId ?? item.container?.id ?? null,
    containerLabel: formatContainerLabel(item.container),
    costCents: item.costCents ?? null,
    costCurrency: item.costCurrency,
    id: item.id,
    imageId: item.images[0]?.id ?? null,
    importance: item.importance,
    kind: item.kind,
    note: item.note ?? null,
    placementSummary:
      placements.length > 0
        ? `Total ${totalQuantity} · ${placements
            .map((placement) => `${placement.label} ${placement.quantity}`)
            .join(" · ")}`
        : "Unplaced",
    placements,
    status: item.status,
    tags: item.tags,
    title: item.title ?? item.captureText ?? "Untitled Inventory Item",
    totalQuantity,
    where,
  });
}

function buildApiItem(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    captureText: null,
    capturedAt: "2026-07-13T11:00:00.000Z",
    category: null,
    clothingProfile: null,
    remedyProfile: null,
    containerId: null,
    containerLabel: null,
    costCents: null,
    costCurrency: "CAD",
    id: "item-1",
    imageId: null,
    importance: "MEDIUM",
    kind: "ITEM",
    note: null,
    placementSummary: "Unplaced",
    placements: [],
    processing: {
      currentStep: "Wait for background processing",
      enrichment: {
        attempts: 0,
        failedAt: null,
        failureMessage: null,
        maxAttempts: 3,
        rationale: "Inventory Enrichment has not started.",
        retryable: false,
        status: "NOT_STARTED",
        summary: "Inventory Enrichment has not started.",
        updatedAt: "2026-07-13T11:00:00.000Z",
      },
      evidence: [],
      nextAction: "Wait for background processing",
      preprocessing: {
        attempts: 0,
        failedAt: null,
        failureMessage: null,
        failedSteps: [],
        maxAttempts: 3,
        mediaTexts: [],
        retryable: false,
        status: "CAPTURED",
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        updatedAt: "2026-07-13T11:00:00.000Z",
      },
      proposal: {
        status: "NONE",
        summary: "No pending Inventory Proposal.",
        updatedAt: "2026-07-13T11:00:00.000Z",
      },
      sourceLabel: "Inventory capture",
    },
    status: "UNSURE",
    tags: [],
    title: "Untitled Inventory Item",
    totalQuantity: 1,
    where: "Unplaced",
    ...overrides,
  };
}

function formatContainerLabel(
  container: InventoryItemRecord["container"] | null | undefined,
): string | null {
  if (!container) {
    return null;
  }

  return `${container.name} (${container.referenceId})`;
}

describe("inventory item page", () => {
  test("renders a real pending proposal with OCR and transcript context", async () => {
    currentItem = {
      aliases: [],
      audioNotes: [
        {
          filePath: "storage/inventory-audio/travel-note.m4a",
          id: "audio-1",
          mimeType: "audio/mp4",
          originalName: "travel-note.m4a",
          sizeBytes: 2048,
        },
      ],
      captureSessionId: "session-1",
      captureText: "Passport, charger, and travel adapters in black pouch.",
      capturedAt: new Date("2026-07-13T11:00:00.000Z"),
      acquisitionSource: null,
      category: null,
      containerLabel: "Travel pouch",
      costCents: null,
      costCurrency: "CAD",
      id: "item-1",
      images: [
        {
          filePath: "storage/inventory-images/travel-pouch.jpg",
          id: "image-1",
          mimeType: "image/jpeg",
          ocrText: null,
          originalName: "travel-pouch.jpg",
          sizeBytes: 1024,
        },
      ],
      importance: "LOW",
      kind: "GROUP",
      locationId: null,
      locationName: "Hall closet",
      metadata: {},
      note: "Needs sort",
      originLocationId: null,
      originLocationName: "Bedroom",
      searchText: "passport charger travel adapters black pouch",
      status: "UNSURE",
      tags: [],
      title: "Black pouch",
    };
    currentProposals = [
      {
        captureText: "Passport, charger, and travel adapters in black pouch.",
        capturedAt: "2026-07-13T11:00:00.000Z",
        confidence: 0.94,
        diff: [
          {
            field: "title",
            label: "Title",
            current: "Black pouch",
            proposed: "Passport and charger pouch",
          },
          {
            field: "category",
            label: "Category",
            current: "None",
            proposed: "Documents",
          },
          {
            field: "acquisitionSource",
            label: "Acquisition source",
            current: "None",
            proposed: "Gift",
          },
          {
            field: "costCents",
            label: "Estimated value",
            current: "None",
            proposed: "CAD 12.50",
          },
          {
            field: "tags",
            label: "Tags",
            current: "None",
            proposed: "documents, travel",
          },
          {
            field: "aliases",
            label: "Aliases",
            current: "None",
            proposed: "travel document pouch",
          },
          {
            field: "status",
            label: "Status",
            current: "Unsure",
            proposed: "Keep",
          },
          {
            field: "importance",
            label: "Importance",
            current: "Low",
            proposed: "High",
          },
          {
            field: "note",
            label: "Note",
            current: "Needs sort",
            proposed: "Passport and charging kit stored together.",
          },
        ],
        failedSteps: [],
        id: "job-1",
        ocrEvidence: [
          {
            id: "image-1",
            preview: "PASSPORT USB-C CHARGER",
            secondary: "girke · tesseract-latin-psm11-gray",
          },
        ],
        itemId: "item-1",
        itemTitle: "Black pouch",
        rationale: "OCR and transcript mention passport and charger.",
        sourceRefsSummary: "1 item, 1 image, 1 audio, 0 file",
        transcriptEvidence: [
          {
            id: "audio-1",
            preview: "Passport, charger, and travel adapters live here.",
            secondary: "0.0s-2.1s",
          },
        ],
        updatedAt: "2026-07-13T12:00:30.000Z",
      },
    ];

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-1" }),
        searchParams: Promise.resolve({
          returnTo: "/inventory/browse?containerId=container-1&q=passport",
        }),
      }),
    );

    expect(html).toContain("Back");
    expect(html).toContain(
      'href="/inventory/browse?containerId=container-1&amp;q=passport"',
    );
    expect(html).toContain("Proposal review");
    expect(html).toContain("Pending proposal");
    expect(html).not.toContain(">Approval required</span>");
    expect(html).toContain("Approve proposal");
    expect(html).toContain("Reject proposal");
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Delete</button>");
    expect(html).toContain("Passport and charger pouch");
    expect(html).toContain("Acquisition source");
    expect(html).toContain("Gift");
    expect(html).toContain("Estimated value");
    expect(html).toContain("CAD 12.50");
    expect(html).toContain("OCR evidence");
    expect(html).toContain("Transcript evidence");
    expect(html).toContain("PASSPORT USB-C CHARGER");
    expect(html).toContain("Passport, charger, and travel adapters live here.");
    expect(html).toContain("OCR and transcript mention passport and charger.");
    expect(html).toContain("94%");
    expect(html).toContain("travel document pouch");
    expect(html.match(/>Media<\/h3>/g)).toHaveLength(1);
    expect(html).toContain("Images");
    expect(html).toContain("Audio");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-1/media/audio-1"',
    );
    expect(html).toContain("travel-note.m4a");
    expect(html).toContain('aria-label="Play travel-note.m4a"');
    expect(html).toContain('aria-label="Seek travel-note.m4a"');
    expect(html).not.toContain("<audio controls");
    expect(html).toContain("Item / group");
    expect(html).toContain("Source media");
    expect(html).not.toContain("storage/inventory-images");
    expect(html).not.toContain("storage/inventory-audio");
    expect(html).toContain("travel-pouch.jpg");
    expect(html).not.toContain("View container");
    expect(html.indexOf('aria-label="Item Images"')).toBeLessThan(
      html.indexOf("Proposal review"),
    );
    expect(html).toContain('aria-label="Proposal decisions"');
    expect(html).not.toContain("sticky bottom-0");
  });

  test("renders structured capture facts without stale item location labels", async () => {
    currentItem = {
      aliases: [],
      acquisitionSource: "gift",
      audioNotes: [],
      captureSessionId: "session-1",
      captureText: "Passport, charger, and travel adapters in black pouch.",
      capturedAt: new Date("2026-07-13T11:00:00.000Z"),
      category: "documents",
      container: {
        createdAt: new Date("2026-07-13T10:00:00.000Z"),
        id: "container-1",
        location: {
          id: "location-1",
          kind: "STORAGE",
          name: "Hall closet",
        },
        locationId: "location-1",
        metadata: {},
        name: "Travel pouch",
        normalizedName: "travel pouch",
        photoFilePath: null,
        referenceId: "BIN-0007",
        sizeLiters: 3,
        updatedAt: new Date("2026-07-13T10:00:00.000Z"),
        visualPreset: testContainerVisualPreset,
        visualPresetKey: testContainerVisualPreset.id,
      },
      containerId: "container-1",
      containerLabel: "Travel pouch",
      costCents: 1250,
      costCurrency: "CAD",
      id: "item-2",
      images: [],
      importance: "LOW",
      kind: "GROUP",
      locationId: "location-1",
      locationName: "Hall closet",
      metadata: {},
      note: "Needs sort",
      originLocationId: null,
      originLocationName: "Bedroom",
      searchText:
        "passport charger travel adapters black pouch hall closet travel pouch documents gift cad 12.50",
      status: "UNSURE",
      tags: [],
      title: "Black pouch",
    };
    currentItem.placements = [
      {
        container: currentItem.container ?? null,
        containerId: "container-1",
        createdAt: new Date("2026-07-13T11:00:00.000Z"),
        id: "placement-1",
        itemId: currentItem.id,
        note: null,
        quantity: 1,
        updatedAt: new Date("2026-07-13T11:00:00.000Z"),
      },
    ];
    currentItem.totalQuantity = 1;

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-2" }),
      }),
    );

    expect(html).not.toContain(">Inventory item<");
    expect(html).toContain("Overview");
    expect(html).not.toContain("Storage");
    expect(html).toContain("Catalog");
    expect(html).not.toContain("Stored in");
    expect(html).toContain("Travel pouch (BIN-0007)");
    expect(html).toContain("Stock");
    expect(html).toContain("Add units");
    expect(html).toContain("Move units");
    expect(html).toContain("Remove units");
    expect(html).not.toContain("Merge items");
    expect(html).toContain("Category");
    expect(html).toContain("Documents");
    expect(html).toContain("Acquisition source");
    expect(html).toContain("Gift");
    expect(html).toContain("Estimated value");
    expect(html).toContain("CAD 12.50");
    expect(html).not.toContain(">Origin<");
    expect(html).not.toContain("Inventory Location");
    expect(html).toContain('href="/inventory/browse"');

    currentItem.totalQuantity = 2;
    currentItem.placements[0]!.quantity = 2;
    const multiUnitHtml = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-2" }),
      }),
    );

    expect(multiUnitHtml).not.toContain("Total quantity");
    expect(multiUnitHtml).toContain("Stock");
  });

  test("renders a Clothing Profile editor on shared item detail", async () => {
    currentApiItem = buildApiItem({
      category: "clothing",
      clothingProfile: {
        itemId: "item-shirt",
        isDirty: false,
        attributes: {
          version: 1,
          kind: "shirt",
          colors: ["blue", "white"],
          fitNotes: "Works untucked.",
        },
        createdAt: "2026-08-03T09:00:00.000Z",
        updatedAt: "2026-08-03T09:00:00.000Z",
      },
      id: "item-shirt",
      title: "Blue oxford shirt",
    });

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-shirt" }),
      }),
    );

    expect(html).toContain("Clothing profile");
    expect(html).toContain("Clothing actions");
    expect(html).toContain("Wear state");
    expect(html).toContain("Clean");
    expect(html).toContain("shirt");
    expect(html).toContain("blue, white");
    expect(html).toContain("Works untucked.");
    expect(html).toContain("Save clothing profile");
    expect(html).toContain("Wore this");
  });

  test("renders a Remedy Profile section on shared item detail", async () => {
    currentApiItem = buildApiItem({
      category: "homeopathy",
      id: "item-remedy",
      remedyProfile: {
        createdAt: "2026-08-03T09:00:00.000Z",
        externalReferences: [
          {
            referenceId: "arn",
            source: "oorep",
            url: "https://www.oorep.com/remedy/arn",
          },
        ],
        potencies: ["30C", "200C"],
        itemId: "item-remedy",
        registeredByClientId: "research-client",
        selectionSummary: "Bruising after overexertion.",
        substanceId: "substance-remedy",
        updatedAt: "2026-08-03T09:00:00.000Z",
      },
      title: "Arnica montana",
    });

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-remedy" }),
      }),
    );

    expect(html).toContain("Remedy profile");
    expect(html).toContain("30C, 200C");
    expect(html).toContain("Bruising after overexertion.");
    expect(html).toContain("oorep (arn)");
  });

  test("shows undo feedback after recording Clothing wear on item detail", async () => {
    currentApiItem = buildApiItem({
      category: "clothing",
      clothingProfile: {
        itemId: "item-shirt",
        isDirty: true,
        attributes: {
          version: 1,
          kind: "shirt",
        },
        createdAt: "2026-08-03T09:00:00.000Z",
        updatedAt: "2026-08-03T10:30:00.000Z",
      },
      id: "item-shirt",
      title: "Blue oxford shirt",
    });

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-shirt" }),
        searchParams: Promise.resolve({
          clothingAction: "wear-recorded",
          confirmationId: "wear-1",
          itemId: "item-shirt",
          returnTo: "/inventory/clothing",
        }),
      }),
    );

    expect(html).toContain("Wear recorded. Undo is available now.");
    expect(html).toContain("Undo last wear");
    expect(html).toContain("Laundry done");
  });

  test("renders every uploaded Item Image through the private media route", async () => {
    currentItem = {
      aliases: [],
      acquisitionSource: null,
      assets: [
        {
          filePath: "storage/inventory-assets/manual.pdf",
          id: "asset-manual",
          mimeType: "application/pdf",
          originalName: "manual.pdf",
          sizeBytes: 4096,
        },
      ],
      audioNotes: [],
      captureSessionId: null,
      captureText: "Magnesium supplement",
      capturedAt: new Date("2026-07-25T12:00:00.000Z"),
      category: "medical",
      containerLabel: "Medicine bin",
      costCents: null,
      costCurrency: "CAD",
      id: "item-with-images",
      images: [
        {
          filePath: "storage/inventory-images/magnesium-front.jpg",
          id: "image-front",
          mimeType: "image/jpeg",
          originalName: "magnesium-front.jpg",
        },
        {
          filePath: "storage/inventory-images/magnesium-back.jpg",
          id: "image-back",
          mimeType: "image/jpeg",
          originalName: "magnesium-back.jpg",
        },
      ],
      importance: "MEDIUM",
      kind: "ITEM",
      locationId: null,
      locationName: null,
      metadata: {},
      note: null,
      originLocationId: null,
      originLocationName: null,
      searchText: "magnesium supplement",
      status: "KEEP",
      tags: [],
      title: "Magnesium supplement",
    };

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-with-images" }),
      }),
    );

    expect(html).toContain("Item Images");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-with-images/media/image-front"',
    );
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-with-images/media/image-back"',
    );
    expect(
      html.indexOf(
        'src="/api/v1/inventory-items/item-with-images/media/image-front"',
      ),
    ).toBeLessThan(html.indexOf("Captured"));
    expect(html).not.toContain(">Inventory item<");
    expect(html).toContain("Item files");
    expect(html).toContain(
      'href="/api/v1/inventory-items/item-with-images/media/asset-manual"',
    );
    expect(html).toContain("manual.pdf");
    expect(html).toContain("application/pdf");
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Delete</button>");
    expect(html).not.toContain("storage/inventory-images");
    expect(html).not.toContain("storage/inventory-assets");
    expect(html).toContain('href="/inventory/browse"');
  });

  test("renders API-backed processing, retryable failure, and recovery detail", async () => {
    currentApiItem = buildApiItem({
      id: "item-failed",
      title: "Failed capture",
    });
    const processing = currentApiItem.processing as Record<string, unknown>;
    const preprocessing = processing.preprocessing as Record<string, unknown>;
    preprocessing.attempts = 2;
    preprocessing.failedAt = "2026-08-01T12:10:00.000Z";
    preprocessing.failureMessage = "Transcription timed out.";
    preprocessing.failedSteps = ["Transcription timed out."];
    preprocessing.maxAttempts = 3;
    preprocessing.retryable = true;
    preprocessing.status = "NEEDS_REVIEW";

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-failed" }),
      }),
    );

    expect(html).toContain("Processing needs review");
    expect(html).toContain("Preprocessing attempt");
    expect(html).toContain("Transcription timed out.");
    expect(html).toContain("2 of 3");
    expect(html).toContain("Retry preprocessing");
    expect(html).toContain("Inventory Text Bundle");
    expect(html).toContain("No usable text bundle is available yet.");
  });

  test("routes non-retryable failures into the source-fact editor", async () => {
    currentApiItem = buildApiItem({
      id: "item-manual-review",
      title: "Manual review",
    });
    const processing = currentApiItem.processing as Record<string, unknown>;
    const preprocessing = processing.preprocessing as Record<string, unknown>;
    preprocessing.failureMessage = "No usable text was produced.";
    preprocessing.retryable = false;
    preprocessing.status = "NEEDS_REVIEW";

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-manual-review" }),
        searchParams: Promise.resolve({ returnTo: "/inventory/processing" }),
      }),
    );

    expect(html).toContain("Edit source facts");
    expect(html).toContain("edit=1");
    expect(html).toContain("returnTo=%2Finventory%2Fprocessing");
  });

  test("renders a compact completed processing history", async () => {
    currentApiItem = buildApiItem({
      id: "item-complete",
      title: "Complete capture",
    });
    const processing = currentApiItem.processing as Record<string, unknown>;
    const enrichment = processing.enrichment as Record<string, unknown>;
    const proposal = processing.proposal as Record<string, unknown>;
    enrichment.rationale = "Applied derived title and category.";
    enrichment.status = "APPLIED";
    enrichment.summary = "Approved derived values were applied.";
    proposal.status = "APPROVED";
    processing.history = [
      {
        at: "2026-08-01T12:04:00.000Z",
        stage: "enrichment",
        status: "APPLIED",
        summary: "Approved derived values were applied.",
      },
    ];

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-complete" }),
      }),
    );

    expect(html).toContain("Processing complete");
    expect(html).toContain("Inventory Enrichment outcome");
    expect(html).toContain("Applied derived title and category.");
    expect(html).toContain("Enrichment · Applied");
  });

  test("renders archived Inventory Item detail from the API seam", async () => {
    currentApiItem = buildApiItem({
      archivedAt: "2026-07-26T12:00:00.000Z",
      id: "item-archived",
      imageId: "image-archived",
      placementSummary: "Basement tote × 1",
      placements: [{ label: "Basement tote", quantity: 1 }],
      title: "Projector",
      totalQuantity: 1,
      where: "Basement tote × 1",
    });

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-archived" }),
        searchParams: Promise.resolve({ returnTo: "/inventory/archive" }),
      }),
    );

    expect(html).toContain("Archived item detail");
    expect(html).toContain("Projector");
    expect(html).toContain("Archived");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-archived/media/image-archived"',
    );
    expect(html).toContain("Basement tote");
    expect(html).toContain("Qty 1");
    expect(html).toContain('href="/inventory/archive"');
  });

  test("propagates an unauthenticated archived detail response", async () => {
    currentApiStatus = 401;

    const { default: InventoryItemPage } = await import("./page");

    await expect(
      renderServerPage(
        InventoryItemPage({
          params: Promise.resolve({ itemId: "item-archived" }),
          searchParams: Promise.resolve({ returnTo: "/inventory/archive" }),
        }),
      ),
    ).rejects.toThrow(
      "Authentication required.",
    );

  });

  test("maps an API 404 directly to not-found navigation", async () => {
    currentApiStatus = 404;

    const { default: InventoryItemPage } = await import("./page");

    await expect(
      renderServerPage(
        InventoryItemPage({
          params: Promise.resolve({ itemId: "item-passport-pouch" }),
        }),
      ),
    ).rejects.toThrow("Not found");
  });

  test("rejects an external return target", async () => {
    currentItem = {
      aliases: [],
      acquisitionSource: null,
      audioNotes: [],
      captureSessionId: null,
      captureText: "USB cables",
      capturedAt: new Date("2026-07-25T12:00:00.000Z"),
      category: "technology",
      containerLabel: "Electronics bin",
      costCents: null,
      costCurrency: "CAD",
      id: "item-safe-back",
      images: [],
      importance: "MEDIUM",
      kind: "GROUP",
      locationId: null,
      locationName: null,
      metadata: {},
      note: null,
      originLocationId: null,
      originLocationName: null,
      searchText: "usb cables",
      status: "KEEP",
      tags: [],
      title: "USB cables",
    };

    const { default: InventoryItemPage } = await import("./page");
    const html = await renderServerPage(
      InventoryItemPage({
        params: Promise.resolve({ itemId: "item-safe-back" }),
        searchParams: Promise.resolve({
          returnTo: "https://example.com/phishing",
        }),
      }),
    );

    expect(html).toContain('href="/inventory/browse"');
    expect(html).not.toContain("example.com");
  });
});
