import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { testContainerVisualPreset } from "./container-test-fixtures";
let searchQueries: Array<string | null> = [];
let inventoryCaptureSessionStatus = 200;
let inventoryCaptureSessionResponse: {
  session: null | {
    container: null | {
      id: string;
      locationName: string | null;
      name: string;
      referenceId: string;
      sizeLiters: number | null;
      visualPresetKey: string;
    };
    containerLabel: string | null;
    destinationLocation: string | null;
    id: string;
    label: string | null;
    note: string | null;
    originRoom: string | null;
  };
} = {
  session: null,
};
let inventoryItemsStatus = 200;
let inventoryItemsResponse: {
  items: Array<{
    id: string;
    imageId: string | null;
    placements: Array<{
      label: string;
      quantity: number;
    }>;
    title: string;
    totalQuantity: number;
  }>;
} = {
  items: [],
};
const inventoryContainersResponse = {
  containers: [
    {
      id: "container-1",
      itemCount: 0,
      latestCapturedAt: null,
      locationName: "Hall closet",
      name: "Travel drawer",
      referenceId: "BIN-0003",
      sampleImages: [],
      sampleItems: [],
      sizeLiters: 20,
      unitCount: 0,
      visualPreset: {
        ...testContainerVisualPreset,
        hoverBounds: testContainerVisualPreset.bounds,
      },
      visualPresetKey: testContainerVisualPreset.id,
    },
  ],
};
const inventoryLocationsResponse = {
  locations: [
    {
      containerCount: 0,
      id: "location-pantry",
      kind: "STORAGE" as const,
      name: "Pantry",
      note: null,
      placementCount: 0,
    },
  ],
};
const inventoryContainerVisualsResponse = {
  editableVisuals: [
    {
      bounds: testContainerVisualPreset.bounds,
      defaultBounds: testContainerVisualPreset.bounds,
      defaultHoverBounds: testContainerVisualPreset.bounds,
      frontImageUrl: testContainerVisualPreset.frontImageUrl,
      height: testContainerVisualPreset.height,
      hoverBounds: testContainerVisualPreset.bounds,
      key: testContainerVisualPreset.id,
      name: testContainerVisualPreset.name,
      width: testContainerVisualPreset.width,
    },
  ],
  visualPresets: [
    {
      id: testContainerVisualPreset.id,
      isDefault: testContainerVisualPreset.isDefault,
      name: testContainerVisualPreset.name,
    },
  ],
};
let apiCalls: string[] = [];
let cleanupGlobals: (() => void) | null = null;

mock.module("@/lib/quantself-api-client", () => ({
  addInventoryItemUnits: async () => ({
    id: "item-active-1",
    placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
    title: "Passport pouch",
  }),
  archiveInventoryItem: async (id: string) => ({
    archivedAt: "2026-07-28T12:00:00.000Z",
    id,
  }),
  captureInventoryItem: async () => ({
    item: {
      id: "item-1",
    },
  }),
  createInventoryContainer: async () => ({
    createdAt: "2026-07-13T09:00:00.000Z",
    id: "container-1",
    location: null,
    locationId: null,
    metadata: {},
    name: "Travel drawer",
    normalizedName: "travel drawer",
    referenceId: "BIN-0003",
    sizeLiters: 20,
    updatedAt: "2026-07-13T09:00:00.000Z",
    visualPreset: null,
    visualPresetKey: testContainerVisualPreset.id,
  }),
  deleteInventoryContainer: async () => null,
  deleteInventoryItem: async (id: string) => ({
    deletedItemId: id,
  }),
  getInventoryItem: async (id: string) => {
    const item = inventoryItemsResponse.items.find(
      (candidate) => candidate.id === id,
    );

    if (!item) {
      const error = new Error("Inventory Item not found.") as Error & {
        status: number;
      };
      error.status = 404;
      throw error;
    }

    return item;
  },
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  moveInventoryItemUnits: async (id: string) => ({
    archivedAt: null,
    id,
    imageId: null,
    placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
    title: "Passport pouch",
    totalQuantity: 2,
  }),
  moveInventoryItemsToContainer: async () => [],
  markInventoryClothingItemWorn: async (itemId: string) => ({
    item: {
      id: itemId,
    },
    wearConfirmation: {
      createdAt: "2026-08-03T09:00:00.000Z",
      id: "wear-1",
      itemIds: [itemId],
      undoneAt: null,
    },
  }),
  markInventoryClothingRecommendationWorn: async (
    recommendationId: string,
  ) => ({
    recommendation: {
      id: recommendationId,
    },
    wearConfirmation: {
      createdAt: "2026-08-03T09:00:00.000Z",
      id: "wear-1",
      itemIds: ["item-1"],
      undoneAt: null,
    },
  }),
  declineInventoryClothingRecommendation: async (recommendationId: string) => ({
    recommendation: {
      id: recommendationId,
    },
  }),
  removeInventoryItemUnits: async (id: string) => ({
    archivedAt: null,
    id,
    imageId: null,
    placements: [{ label: "Travel drawer (BIN-0003)", quantity: 1 }],
    title: "Passport pouch",
    totalQuantity: 1,
  }),
  retryInventoryEnrichment: async (id: string) => ({ id }),
  retryInventoryPreprocessing: async (id: string) => ({ id }),
  undoInventoryClothingWearConfirmation: async (confirmationId: string) => ({
    items: [],
    wearConfirmation: {
      createdAt: "2026-08-03T09:00:00.000Z",
      id: confirmationId,
      itemIds: [],
      undoneAt: "2026-08-03T09:05:00.000Z",
    },
  }),
  updateInventoryClothingProfile: async (id: string) => ({
    attributes: { version: 1 },
    createdAt: "2026-08-03T09:00:00.000Z",
    isDirty: false,
    itemId: id,
    updatedAt: "2026-08-03T09:00:00.000Z",
  }),
  completeInventoryClothingLaundry: async () => ({
    cleanedCount: 0,
    items: [],
  }),
  getActiveInventoryCaptureSession: async () => {
    apiCalls.push("capture-session");

    if (inventoryCaptureSessionStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryCaptureSessionResponse.session;
  },
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
  listArchivedInventoryItems: async (query?: string | null) => {
    apiCalls.push(`archived:${query ?? ""}`);

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryItemsResponse.items;
  },
  listActiveInventoryItems: async () => {
    apiCalls.push("items");

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryItemsResponse.items;
  },
  listInventoryItems: async (input?: { query?: string | null }) => {
    const query = input?.query?.trim() ?? null;

    searchQueries.push(query);
    apiCalls.push(`search:${query ?? ""}`);

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryItemsResponse.items;
  },
  listInventoryContainers: async () => {
    apiCalls.push("containers");

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryContainersResponse.containers;
  },
  listInventoryContainerVisuals: async () => {
    apiCalls.push("visuals");

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryContainerVisualsResponse;
  },
  listInventoryLocations: async () => {
    apiCalls.push("locations");

    return inventoryLocationsResponse.locations;
  },
  listInventoryItemMedia: async () => [],
  listInventoryProposals: async () => [],
  restoreInventoryItem: async (id: string) => ({
    archivedAt: null,
    id,
  }),
  resolveInventoryContainerByReference: async () => ({
    id: "container-1",
  }),
  saveInventoryCaptureSessionDefaults: async () => ({
    session: { id: "session-1" },
  }),
  updateInventoryContainer: async () => ({
    createdAt: "2026-07-13T09:00:00.000Z",
    id: "container-1",
    location: null,
    locationId: null,
    metadata: {},
    name: "Travel drawer",
    normalizedName: "travel drawer",
    referenceId: "BIN-0003",
    sizeLiters: 20,
    updatedAt: "2026-07-13T09:00:00.000Z",
    visualPreset: null,
    visualPresetKey: testContainerVisualPreset.id,
  }),
  updateInventoryItem: async (id: string) => ({
    id,
    placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
    title: "Passport pouch",
  }),
}));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: (href: string) => {
    throw new Error(`Redirect:${href}`);
  },
  usePathname: () => "/inventory",
  useRouter: () => ({
    push() {},
    replace() {},
    refresh() {},
  }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  cleanupGlobals = registerDomGlobals();
});

afterEach(() => {
  searchQueries = [];
  inventoryCaptureSessionStatus = 200;
  inventoryCaptureSessionResponse = { session: null };
  inventoryItemsStatus = 200;
  inventoryItemsResponse = { items: [] };
  apiCalls = [];
});

afterAll(() => {
  mock.restore();
  cleanupGlobals?.();
});

describe("inventory page search", () => {
  test("loads active capture session and item candidates through the API seam", async () => {
    inventoryCaptureSessionResponse = {
      session: {
        container: null,
        containerLabel: null,
        destinationLocation: "Hall closet",
        id: "session-1",
        label: "Apartment reset",
        note: null,
        originRoom: "Office",
      },
    };
    inventoryItemsResponse = {
      items: [
        {
          id: "item-active-1",
          imageId: "image-1",
          placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
          title: "Passport pouch",
          totalQuantity: 2,
        },
      ],
    };

    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(InventoryPage({}));

    expect(apiCalls).toEqual([
      "capture-session",
      "containers",
      "locations",
      "visuals",
      "items",
    ]);
    expect(html).toContain('aria-label="Inventory capture and search"');
    expect(html).toContain("Apartment reset");
  });

  test("propagates an unauthenticated active item response", async () => {
    inventoryItemsStatus = 401;

    const { default: InventoryPage } = await import("./page");

    await expect(renderStream(InventoryPage({}))).rejects.toThrow(
      "Authentication required.",
    );

  });

  test("reads the persisted query from server search params", async () => {
    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(
      InventoryPage({
        searchParams: Promise.resolve({ q: "charger" }),
      }),
    );

    expect(searchQueries).toEqual(["charger"]);
    expect(html).toContain('name="q"');
    expect(html).toContain('value="charger"');
    expect(html).toContain("No inventory items matched this search.");
  });

  test("submits a GET query and renders API-backed matches", async () => {
    inventoryItemsResponse = {
      items: [buildInventoryItem()],
    };

    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(
      InventoryPage({
        searchParams: Promise.resolve({ q: "passport pouch" }),
      }),
    );

    expect(searchQueries).toEqual(["passport pouch"]);
    expect(html).toContain('action="/inventory"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="passport pouch"');
    expect(html).toContain("Passport pouch");
    expect(html).toContain("Hall closet");
    expect(html).toContain("Travel drawer (BIN-0003)");
    expect(html).toContain(
      'href="/inventory/items/item-1?returnTo=%2Finventory%3Fq%3Dpassport%2Bpouch"',
    );
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-1/media/image-1?representation=preview"',
    );
    expect(html).toContain("keep");
    expect(html).toContain("high");
  });

  test("renders an iPhone when Capture searches for phone", async () => {
    inventoryItemsResponse = {
      items: [
        buildInventoryItem({
          captureText: "my iphone",
          id: "item-iphone",
          title: "My iPhone",
        }),
      ],
    };

    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(
      InventoryPage({
        searchParams: Promise.resolve({ q: "phone" }),
      }),
    );

    expect(html).toContain("My iPhone");
  });

  test("puts the result count before the search query label", async () => {
    inventoryItemsResponse = {
      items: [
        buildInventoryItem({
          captureText: "my iphone",
          id: "item-iphone",
          title: "My iPhone",
        }),
        buildInventoryItem({
          captureText: "spare phone",
          id: "item-spare-phone",
          title: "Spare phone",
        }),
      ],
    };

    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(
      InventoryPage({
        searchParams: Promise.resolve({ q: "phone" }),
      }),
    );
    const document = new Window().document;
    document.body.innerHTML = html;
    const heading = Array.from(document.querySelectorAll("h3")).find((entry) =>
      entry.textContent?.includes("results for"),
    );

    expect(heading?.querySelector("[data-slot=badge]")).toBeNull();
    expect(heading?.textContent).toBe("2 results for “phone”");
  });

  test("does not query the repository before a search is submitted", async () => {
    const { default: InventoryPage } = await import("./page");
    const html = await renderStream(InventoryPage({}));

    expect(searchQueries).toEqual([]);
    expect(html).toContain("Search inventory");
    expect(html).toContain('aria-label="Inventory capture and search"');
    expect(html).not.toContain("Processing now");
    expect(html).not.toContain("Recent captures");
    expect(html).not.toContain("Results for");
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

  return new Response(stream).text();
}

function buildInventoryItem(
  overrides: Partial<{
    captureText: string | null;
    id: string;
    title: string;
  }> = {},
) {
  return {
    acquisitionSource: "gift",
    aliases: ["travel document pouch"],
    archivedAt: null,
    captureText: "Passport and charger pouch",
    capturedAt: "2026-07-25T14:00:00.000Z",
    category: "documents",
    containerId: "container-1",
    containerLabel: "Travel drawer (BIN-0003)",
    costCents: 2500,
    costCurrency: "CAD",
    id: "item-1",
    importance: "HIGH",
    imageId: "image-1",
    kind: "GROUP",
    note: null,
    placementSummary: "Total 2 · Travel drawer (BIN-0003) 2",
    placements: [
      {
        containerId: "container-1",
        label: "Travel drawer (BIN-0003)",
        note: null,
        quantity: 2,
      },
    ],
    processing: {
      currentStep: "Inventory Proposal approved",
      enrichment: {
        rationale: null,
        status: "APPLIED",
        summary: "Inventory Enrichment applied.",
        updatedAt: "2026-07-25T14:02:00.000Z",
      },
      evidence: [
        {
          id: "image-1",
          kind: "photo",
          label: "Photo 1",
          summary: "Black passport pouch",
        },
      ],
      nextAction: "No action required",
      preprocessing: {
        failedSteps: [],
        mediaTexts: [],
        status: "COMPLETED",
        summary: "Inventory Text Bundle ready.",
        textBundleAvailable: true,
        updatedAt: "2026-07-25T14:01:00.000Z",
      },
      proposal: {
        status: "APPROVED",
        summary: "Inventory Proposal approved.",
        updatedAt: "2026-07-25T14:03:00.000Z",
      },
      sourceLabel: "Typed capture text",
    },
    status: "KEEP",
    tags: ["passport", "travel"],
    title: "Passport pouch",
    totalQuantity: 2,
    where: "Hall closet / Travel drawer (BIN-0003)",
    ...overrides,
  };
}

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    navigator: window.navigator,
    Node: window.Node,
    window,
  });

  return () => {
    Object.assign(globalThis, previous);
  };
}
