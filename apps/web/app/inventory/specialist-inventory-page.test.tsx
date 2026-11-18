import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type React from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";

let inventoryItemsStatus = 200;
let inventoryItemsResponse: { items: Array<Record<string, unknown>> } = {
  items: [],
};
let clothingRecommendationsResponse: {
  recommendations: Array<Record<string, unknown>>;
} = {
  recommendations: [],
};
let remedyIntakesResponse: {
  intakes: Array<Record<string, unknown>>;
} = {
  intakes: [],
};
let lastListInput: Record<string, unknown> | null = null;
let listInputs: Record<string, unknown>[] = [];
let lastRecommendationListInput: Record<string, unknown> | null = null;
let lastRemedyIntakesInput: Record<string, unknown> | null = null;

mock.module("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  } & React.ComponentPropsWithoutRef<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

mock.module("@/app/inventory/actions", () => ({
  completeInventoryClothingLaundryRedirectAction: async () => {},
  declineInventoryClothingRecommendationRedirectAction: async () => {},
  markInventoryClothingItemWornRedirectAction: async () => {},
  markInventoryClothingRecommendationWornRedirectAction: async () => {},
  undoInventoryClothingWearConfirmationRedirectAction: async () => {},
}));

mock.module("@/lib/quantself-api-client", () => ({
  listInventoryClothingRecommendations: async (
    input?: Record<string, unknown>,
  ) => {
    lastRecommendationListInput = input ?? null;

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return clothingRecommendationsResponse.recommendations;
  },
  listRemedyIntakes: async (input?: Record<string, unknown>) => {
    lastRemedyIntakesInput = input ?? null;

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return {
      intakes: remedyIntakesResponse.intakes,
      pageInfo: { nextCursor: null },
      range: input?.range ?? "30d",
    };
  },
  isApiAuthenticationError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status: number }).status === 401,
    ),
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  listInventoryItems: async (input?: Record<string, unknown>) => {
    lastListInput = input ?? null;
    listInputs.push(input ?? {});

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return inventoryItemsResponse.items;
  },
  listInventoryItemsPage: async (input?: Record<string, unknown>) => {
    lastListInput = input ?? null;
    listInputs.push(input ?? {});

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return {
      items: inventoryItemsResponse.items,
      pageInfo: { nextCursor: null },
      total: inventoryItemsResponse.items.length,
    };
  },
}));

mock.module("next/navigation", () => ({
  usePathname: () => "/inventory/food",
  useRouter: () => ({
    push() {},
    replace() {},
    refresh() {},
  }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  inventoryItemsStatus = 200;
  inventoryItemsResponse = { items: [] };
  clothingRecommendationsResponse = { recommendations: [] };
  remedyIntakesResponse = { intakes: [] };
  lastListInput = null;
  listInputs = [];
  lastRecommendationListInput = null;
  lastRemedyIntakesInput = null;
});

afterAll(() => {
  mock.restore();
});

describe("specialist inventory pages", () => {
  test("renders representative specialist shells while route data loads", async () => {
    const { default: ClothingInventoryLoading } =
      await import("./clothing/loading");
    const { default: FoodInventoryLoading } = await import("./food/loading");
    const clothingHtml = renderToStaticMarkup(
      <ChakraTestWrapper>
        <ClothingInventoryLoading />
      </ChakraTestWrapper>,
    );
    const foodHtml = renderToStaticMarkup(
      <ChakraTestWrapper>
        <FoodInventoryLoading />
      </ChakraTestWrapper>,
    );

    expect(clothingHtml).toContain("Clothing wardrobe");
    expect(clothingHtml).toContain("Wear today");
    expect(clothingHtml).toContain("Upcoming events");
    expect(clothingHtml).toContain("Loading recommendations");
    expect(foodHtml).toContain("Food inventory");
    expect(foodHtml).toContain("Search");
    expect(foodHtml).toContain("Loading inventory items");
  });

  test("renders food inventory results filtered by category and preserves returnTo", async () => {
    inventoryItemsResponse = {
      items: [
        inventoryItem({
          category: "food",
          id: "item-kale",
          placements: [
            {
              containerId: null,
              label: "Pantry",
              locationId: "location-pantry",
              locationName: "Pantry",
              note: null,
              quantity: 2,
            },
          ],
          title: "Kale chips",
          totalQuantity: 2,
          where: "Pantry × 2",
        }),
      ],
    };

    const { default: FoodInventoryPage } = await import("./food/page");
    const html = await renderAsync(
      FoodInventoryPage({
        searchParams: Promise.resolve({ q: "kale" }),
      }),
    );

    expect(lastListInput).toEqual({
      category: "food",
      clothingState: null,
      query: "kale",
    });
    expect(html).toContain('action="/inventory/food"');
    expect(html).toContain('href="/inventory?category=food"');
    expect(html).toContain("Capture food");
    expect(html).toContain("Food inventory");
    expect(html).toContain("Kale chips");
    expect(html).toContain("Pantry × 2");
    expect(html).toContain(
      'href="/inventory/items/item-kale?returnTo=%2Finventory%2Ffood%3Fq%3Dkale"',
    );
  });

  test("opens Clothing capture with its controlled category and state filters", async () => {
    clothingRecommendationsResponse = {
      recommendations: [
        {
          event: null,
          id: "recommendation-1",
          kind: "DAILY",
          options: [
            {
              id: "option-primary",
              items: [
                {
                  archiveState: "ACTIVE",
                  availability: "AVAILABLE",
                  clothingState: "clean",
                  id: "item-shirt",
                  imageId: "image-shirt",
                  title: "Blue oxford shirt",
                  where: "Hall closet / Rail A × 1",
                },
                {
                  archiveState: "ACTIVE",
                  availability: "AVAILABLE",
                  clothingState: "clean",
                  id: "item-belt",
                  imageId: null,
                  title: "Brown leather belt",
                  where: "Hall closet / Drawer B × 1",
                },
              ],
              reason: "Breathable layers for a warm meeting day.",
              slot: "PRIMARY",
            },
          ],
          publishedAt: "2026-08-03T09:00:00.000Z",
          publishedBy: {
            clientId: "client-writer-1",
            clientKind: "api-key",
            clientName: "Outfit Writer",
          },
          reason: "Client picked a concise outfit for Monday, August 3, 2026.",
          status: "PUBLISHED",
          supersededByRecommendationId: null,
          targetDate: "2026-08-03",
        },
        {
          event: {
            label: "Board dinner",
            startsAt: "2026-08-04T19:00:00.000Z",
          },
          id: "recommendation-2",
          kind: "EVENT",
          options: [
            {
              id: "option-event-primary",
              items: [
                {
                  archiveState: "ACTIVE",
                  availability: "AVAILABLE",
                  clothingState: "clean",
                  id: "item-blazer",
                  imageId: "image-blazer",
                  title: "Navy blazer",
                  where: "Bedroom closet / Rail C × 1",
                },
              ],
              reason: "Formal enough for dinner without overheating.",
              slot: "PRIMARY",
            },
          ],
          publishedAt: "2026-08-03T09:05:00.000Z",
          publishedBy: {
            clientId: "client-writer-1",
            clientKind: "api-key",
            clientName: "Outfit Writer",
          },
          reason: "Client picked a concise outfit for the board dinner.",
          status: "PUBLISHED",
          supersededByRecommendationId: null,
          targetDate: "2026-08-04",
        },
      ],
    };
    const boardDinner = clothingRecommendationsResponse.recommendations[1]!;
    clothingRecommendationsResponse.recommendations.push({
      ...boardDinner,
      event: {
        label: "Breakfast meeting",
        startsAt: "2026-08-04T08:00:00.000Z",
      },
      id: "recommendation-3",
      reason: "Client picked an outfit for the breakfast meeting.",
    });
    const { default: ClothingInventoryPage } = await import("./clothing/page");
    const html = await renderAsync(
      ClothingInventoryPage({
        searchParams: Promise.resolve({ timeZone: "America/Halifax" }),
      }),
    );

    expect(lastListInput).toEqual({
      category: "clothing",
      clothingState: null,
      query: "",
    });
    expect(lastRecommendationListInput).toEqual({
      timeZone: "America/Halifax",
    });
    expect(html).toContain("Clothing wardrobe");
    expect(html).toContain("Wear today");
    expect(html).toContain("Upcoming events");
    expect(html).toContain("Blue oxford shirt");
    expect(html).toContain("Hall closet / Rail A × 1");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-shirt/media/image-shirt"',
    );
    expect(html).toContain("Brown leather belt");
    expect(html).not.toContain('src="/api/v1/inventory-items/item-belt/media/');
    expect(html).toContain("Board dinner");
    expect(html).toContain("4:00 PM");
    expect(html).toContain("Navy blazer");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-blazer/media/image-blazer"',
    );
    expect(html.indexOf("Breakfast meeting")).toBeLessThan(
      html.indexOf("Board dinner"),
    );
    expect(html).toContain('href="/inventory?category=clothing"');
    expect(html).toContain(
      'href="/inventory/clothing?timeZone=America%2FHalifax"',
    );
    expect(html).toContain(
      'href="/inventory/clothing?state=clean&amp;timeZone=America%2FHalifax"',
    );
    expect(html).toContain(
      'href="/inventory/clothing?state=dirty&amp;timeZone=America%2FHalifax"',
    );
    const allFilter = html.match(/<a\b[^>]*href="\/inventory\/clothing\?timeZone=America%2FHalifax"[^>]*>/)?.[0];
    expect(allFilter).toContain('aria-current="page"');
    expect(html).toContain("Capture clothing");
    expect(html).toContain("Laundry all dirty");
    expect(html).toContain('name="mode"');
    expect(html).toContain('value="all-dirty"');
    expect(html).toContain('name="returnTo"');
    expect(html).toContain("Wear this outfit");
    expect(html).toContain("Decline recommendation");
  });

  test("passes the Clothing clean or dirty filter through the shared specialist page", async () => {
    const { default: ClothingInventoryPage } = await import("./clothing/page");

    const html = await renderAsync(
      ClothingInventoryPage({
        searchParams: Promise.resolve({ q: "oxford", state: "dirty" }),
      }),
    );

    expect(lastListInput).toEqual({
      category: "clothing",
      clothingState: "dirty",
      query: "oxford",
    });
    expect(lastRecommendationListInput).toBeNull();
    expect(html).toContain('name="state"');
    expect(html).toContain('value="dirty"');
    expect(html).toContain('aria-current="page"');
  });

  test("renders Clothing wear and laundry actions on wardrobe cards", async () => {
    inventoryItemsResponse = {
      items: [
        inventoryItem({
          category: "clothing",
          clothingProfile: {
            attributes: { kind: "shirt", version: 1 },
            createdAt: "2026-08-03T09:00:00.000Z",
            isDirty: false,
            itemId: "item-shirt",
            updatedAt: "2026-08-03T09:00:00.000Z",
          },
          id: "item-shirt",
          title: "Blue oxford shirt",
        }),
        inventoryItem({
          category: "clothing",
          clothingProfile: {
            attributes: { kind: "pants", version: 1 },
            createdAt: "2026-08-03T09:00:00.000Z",
            dirtyQuantity: 1,
            isDirty: true,
            itemId: "item-pants",
            updatedAt: "2026-08-03T09:00:00.000Z",
          },
          id: "item-pants",
          title: "Gray trousers",
          totalQuantity: 2,
        }),
      ],
    };

    const { default: ClothingInventoryPage } = await import("./clothing/page");
    const html = await renderAsync(ClothingInventoryPage({}));

    expect(html).toContain("Wore 1");
    expect(html).toContain("Laundry 1");
    expect(html).toContain("1 clean · 1 dirty");
    expect(html).toContain('name="returnTo"');
  });

  test("renders supplements empty, loading, and error states", async () => {
    const { default: SupplementsInventoryPage } =
      await import("./supplements/page");
    const { default: SupplementsInventoryLoading } =
      await import("./supplements/loading");
    const { default: SupplementsInventoryError } =
      await import("./supplements/error");
    const html = await renderAsync(SupplementsInventoryPage({}));

    expect(lastListInput).toEqual({
      category: "supplement",
      clothingState: null,
      query: "",
    });
    expect(html).toContain('action="/inventory/supplements"');
    expect(html).toContain('href="/inventory?category=supplement"');
    expect(html).toContain("Capture supplements");
    expect(html).toContain("No supplement inventory yet.");
    const loadingHtml = renderToStaticMarkup(
      <ChakraTestWrapper>
        <SupplementsInventoryLoading />
      </ChakraTestWrapper>,
    );
    expect(loadingHtml).toContain("Supplements inventory");
    expect(loadingHtml).toContain("Loading inventory items");
    expect(
      renderToStaticMarkup(
        <ChakraTestWrapper>
          <SupplementsInventoryError
            error={new Error("boom")}
            reset={() => {}}
          />
        </ChakraTestWrapper>,
      ),
    ).toContain("Couldn&#x27;t load supplements inventory.");
  });

  test("renders owned remedies filtered by category with range-aware totals and return links", async () => {
    inventoryItemsResponse = {
      items: [
        inventoryItem({
          category: "homeopathy",
          id: "item-arnica",
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
            itemId: "item-arnica",
            registeredByClientId: "research-client",
            selectionSummary: "Bruising after overexertion.",
            substanceId: "substance-arnica",
            updatedAt: "2026-08-03T09:00:00.000Z",
          },
          title: "Arnica montana",
          totalQuantity: 2,
          where: "Pantry × 2",
        }),
      ],
    };
    remedyIntakesResponse = {
      intakes: [
        {
          id: "intake-1",
          note: "Before bed.",
          occurredAt: new Date().toISOString(),
          potency: "200C",
          itemArchivedAt: null,
          itemId: "item-arnica",
          itemTitle: "Arnica montana",
        },
      ],
    };

    const { default: RemediesInventoryPage } = await import("./remedies/page");
    const { default: RemediesInventoryLoading } =
      await import("./remedies/loading");
    const { default: RemediesInventoryError } =
      await import("./remedies/error");
    const html = await renderAsync(
      RemediesInventoryPage({
        searchParams: Promise.resolve({
          q: "arnica",
          range: "7d",
          timeZone: "America/Toronto",
        }),
      }),
    );

    expect(lastListInput).toEqual({
      category: "homeopathy",
      clothingState: null,
      query: "arnica",
    });
    expect(lastRemedyIntakesInput).toEqual({
      cursor: null,
      range: "7d",
      timeZone: "America/Toronto",
    });
    expect(html).toContain("Owned remedies");
    expect(html).toContain("Record remedy intake");
    expect(html).toContain("Logging affects health history only.");
    expect(html).toContain("7 days");
    expect(html).toContain("1 intake in range");
    expect(html).toContain("Arnica montana: 1");
    expect(html).toContain("200C 1");
    expect(html).toContain("Recent intakes");
    expect(html).toContain("Before bed.");
    expect(html).toContain("Capture remedies");
    expect(html).toContain("Arnica montana");
    expect(html).toContain("Potencies: 30C, 200C");
    expect(html).toContain("Bruising after overexertion.");
    expect(html).toContain("Sources: oorep (arn)");
    expect(html).toContain('href="/inventory?category=homeopathy"');
    expect(html).toContain(
      'href="/inventory/remedies?q=arnica&amp;range=7d&amp;timeZone=America%2FToronto"',
    );
    expect(html).toContain(
      'href="/inventory/items/item-arnica?returnTo=%2Finventory%2Fremedies%3Fq%3Darnica%26range%3D7d%26timeZone%3DAmerica%252FToronto"',
    );
    const loadingHtml = renderToStaticMarkup(
      <ChakraTestWrapper>
        <RemediesInventoryLoading />
      </ChakraTestWrapper>,
    );
    expect(loadingHtml).toContain("Owned remedies");
    expect(loadingHtml).toContain("Loading inventory items");
    expect(
      renderToStaticMarkup(
        <ChakraTestWrapper>
          <RemediesInventoryError error={new Error("boom")} reset={() => {}} />
        </ChakraTestWrapper>,
      ),
    ).toContain("Couldn&#x27;t load remedies inventory.");
  });

  test("keeps the remedy timeline catalog while loading a bounded results page", async () => {
    const { default: RemediesInventoryPage } = await import("./remedies/page");

    await renderAsync(RemediesInventoryPage({}));

    expect(listInputs).toEqual([
      {
        category: "homeopathy",
        clothingState: null,
        query: "",
      },
      {
        category: "homeopathy",
        clothingState: null,
        query: "",
      },
    ]);
  });

  test("surfaces an unauthenticated specialist API response", async () => {
    inventoryItemsStatus = 401;

    const { default: FoodInventoryPage } = await import("./food/page");

    const errors: unknown[] = [];
    await renderAsync(FoodInventoryPage({}), (error) => { errors.push(error); });
    expect(errors).toContainEqual(expect.objectContaining({
      message: "Authentication required.",
      status: 401,
    }));
  });
});

async function renderAsync(
  node: React.ReactNode,
  onError: (error: unknown) => void = () => {},
): Promise<string> {
  const stream = await renderToReadableStream(
    <ChakraTestWrapper>{node}</ChakraTestWrapper>,
    { onError },
  );
  await stream.allReady;

  return (await new Response(stream).text()).replaceAll("<!-- -->", "");
}

function inventoryItem(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    captureText: null,
    capturedAt: "2026-08-02T09:00:00.000Z",
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
    placementSummary: "Total 1 · Pantry 1",
    placements: [
      {
        containerId: null,
        label: "Pantry",
        locationId: "location-pantry",
        locationName: "Pantry",
        note: null,
        quantity: 1,
      },
    ],
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
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      evidence: [],
      history: [],
      nextAction: "Wait for background processing",
      preprocessing: {
        attempts: 0,
        failedAt: null,
        failedSteps: [],
        failureMessage: null,
        maxAttempts: 3,
        mediaTexts: [],
        retryable: false,
        status: "CAPTURED",
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      proposal: {
        status: "NONE",
        summary: "No pending Inventory Proposal.",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      sourceLabel: "Inventory capture",
    },
    status: "KEEP",
    tags: [],
    title: "Inventory item",
    totalQuantity: 1,
    where: "Pantry × 1",
    ...overrides,
  };
}
