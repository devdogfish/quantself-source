import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InventoryItem } from "@/lib/quantself-api-client";
import {
  InventoryItemCard,
  inventoryItemSearchCardModel,
  inventoryShellItemCardModel,
} from "./inventory-item-card";
import { inventoryShellItems } from "./inventory-shell-data";

describe("InventoryItemCard", () => {
  test("renders shell items with the detailed visual treatment", () => {
    const model = inventoryShellItemCardModel(inventoryShellItems[0]);
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard item={model} variant="detailed" />
      </ChakraTestWrapper>,
    );

    expect(html).toContain(
      'href="/inventory/items/item-passport-pouch?returnTo=%2Finventory%2Fbrowse"',
    );
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-passport-pouch/media/image-passport-pouch?representation=preview"',
    );
    expect(html).toContain(
      'href="/inventory/containers/container-travel-drawer"',
    );
    expect(html).toContain("Photo");
    expect(html).toContain("Audio");
    expect(html).toContain("Text");
    expect(html).not.toContain("Category");
    expect(html).not.toContain("Value");
    expect(html).not.toContain("× 1");
  });

  test("shows quantity only on detailed cards when more than one is owned", () => {
    const model = inventoryItemSearchCardModel(buildSearchResult());
    model.totalQuantity = 2;

    const detailed = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard item={model} variant="detailed" />
      </ChakraTestWrapper>,
    );
    const compact = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard item={model} variant="compact" />
      </ChakraTestWrapper>,
    );

    expect(detailed).toContain("× 2");
    expect(compact).not.toContain("× 2");
  });

  test("adapts search results to the compact variant", () => {
    const model = inventoryItemSearchCardModel(buildSearchResult());
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard item={model} variant="compact" />
      </ChakraTestWrapper>,
    );

    expect(html).toContain(
      'href="/inventory/items/item-1?returnTo=%2Finventory%2Fbrowse"',
    );
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-1/media/image-1?representation=preview"',
    );
    expect(html).toContain("Passport pouch");
    expect(html).toContain("Hall closet");
    expect(html).toContain("Travel drawer (BIN-0003)");
    expect(html).toContain("Matched title and aliases");
    expect(html).not.toContain("Category");
    expect(html).not.toContain("Value");
  });

  test("adds a minimal Clean or Dirty badge for Clothing cards", () => {
    const result = buildSearchResult();
    result.category = "clothing";
    result.clothingProfile = {
      itemId: result.id,
      dirtyQuantity: 1,
      isDirty: true,
      attributes: { version: 1, kind: "shirt" },
      createdAt: "2026-08-03T09:00:00.000Z",
      updatedAt: "2026-08-03T09:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard
          item={inventoryItemSearchCardModel(result)}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(html).toContain("Dirty");
  });

  test.each(["compact", "detailed"] as const)(
    "keeps placement quantities visible for multi-placement %s cards",
    (variant) => {
      const result = buildSearchResult();
      result.placements = [
        {
          containerId: "container-1",
          label: "Travel drawer (BIN-0003)",
          locationId: null,
          locationName: null,
          note: null,
          placementId: "placement-1",
          quantity: 1,
        },
        {
          containerId: "container-2",
          label: "Blue bin (BIN-0004)",
          locationId: null,
          locationName: null,
          note: null,
          placementId: "placement-2",
          quantity: 1,
        },
      ];
      result.totalQuantity = 2;
      result.where = "Travel drawer (BIN-0003) × 1 · Blue bin (BIN-0004) × 1";

      const html = renderToStaticMarkup(
        <ChakraTestWrapper>
          <InventoryItemCard
            item={inventoryItemSearchCardModel(result)}
            variant={variant}
          />
        </ChakraTestWrapper>,
      );

      expect(html).toContain("Travel drawer (BIN-0003)");
      expect(html).toContain("Blue bin (BIN-0004)");
      expect(html.match(/× 1/gu)).toHaveLength(2);
      expect(html).not.toContain("Hall closet / Travel drawer (BIN-0003)");
      expect(html).not.toContain('href="/inventory/containers/container-1"');
    },
  );

  test("links the Container inside a single-placement quantity summary", () => {
    const result = buildSearchResult();
    result.placements = [
      {
        containerId: "container-1",
        label: "Travel drawer (BIN-0003)",
        locationId: null,
        locationName: "Hall closet",
        note: null,
        placementId: "placement-1",
        quantity: 2,
      },
    ];
    result.totalQuantity = 2;
    result.where = "Hall closet / Travel drawer (BIN-0003)";

    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard
          item={inventoryItemSearchCardModel(result)}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(html).toContain('href="/inventory/containers/container-1"');
    expect(html).toContain("Travel drawer (BIN-0003)");
    expect(html).not.toContain("× 2");
  });

  test("shows an audio placeholder when a compact item has no image", () => {
    const result = buildSearchResult();
    result.imageId = null;
    result.processing.evidence = [
      {
        id: "audio-1",
        kind: "voice",
        label: "Audio note",
        summary: "note.webm",
      },
    ];
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard
          item={inventoryItemSearchCardModel(result)}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("lucide-audio-lines");
    expect(html).toContain('data-audio-id="audio-1"');
    expect(html).toContain('data-inventory-audio-hover-target=""');
    expect(html).toContain('data-audio-glyph=""');
  });

  test("connects audio title hover in compact and detailed cards", () => {
    const result = buildSearchResult();
    result.imageId = null;
    result.processing.evidence = [
      {
        id: "audio-1",
        kind: "voice",
        label: "Audio note",
        summary: "note.webm",
      },
    ];
    const model = inventoryItemSearchCardModel(result);

    for (const variant of ["compact", "detailed"] as const) {
      const html = renderToStaticMarkup(
        <ChakraTestWrapper>
          <InventoryItemCard item={model} variant={variant} />
        </ChakraTestWrapper>,
      );

      expect(html).toContain('data-inventory-audio-hover-target=""');
      expect(html).toContain('data-audio-glyph=""');
      expect(html).toContain('data-audio-idle-glyph=""');
      expect(html).toContain('data-audio-playing-glyph=""');
    }
  });

  test("loads only the primary optimized image before slideshow engagement", () => {
    const result = buildSearchResult();
    result.processing.evidence.push({
      id: "image-2",
      kind: "photo",
      label: "Item Image",
      summary: "Passport pouch interior",
    });
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard
          item={inventoryItemSearchCardModel(result)}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(html.match(/data-slideshow-image=/gu)).toHaveLength(1);
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-1/media/image-1?representation=preview"',
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  test("uses a stored video when no image is available", () => {
    const result = buildSearchResult();
    result.imageId = null;
    result.processing.evidence = [
      {
        id: "video-1",
        kind: "video",
        label: "Item Video",
        summary: "walkaround.mp4",
      },
    ];
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCard
          item={inventoryItemSearchCardModel(result)}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(html).toContain("<video");
    expect(html).toContain(
      'src="/api/v1/inventory-items/item-1/media/video-1"',
    );
    expect(html).toContain("lucide-video");
  });
});

function buildSearchResult(): InventoryItem {
  return {
    acquisitionSource: "gift",
    aliases: ["travel document pouch"],
    archivedAt: null,
    captureText: "Passport and charger pouch",
    capturedAt: "2026-07-25T14:00:00.000Z",
    category: "documents",
    clothingProfile: null,
    remedyProfile: null,
    containerId: "container-1",
    containerLabel: "Travel drawer (BIN-0003)",
    costCents: 2500,
    costCurrency: "CAD",
    id: "item-1",
    importance: "HIGH",
    imageId: "image-1",
    kind: "GROUP",
    matchExplanation: "Matched title and aliases",
    note: null,
    placementSummary: "Total 1 · BIN-0003 1",
    placements: [
      {
        containerId: "container-1",
        label: "Travel drawer (BIN-0003)",
        locationId: null,
        locationName: "Hall closet",
        note: null,
        placementId: "placement-1",
        quantity: 1,
      },
    ],
    processing: {
      currentStep: "Inventory Proposal approved",
      enrichment: {
        attempts: 1,
        failedAt: null,
        failureMessage: null,
        maxAttempts: 3,
        rationale: "Inventory Enrichment applied.",
        retryable: false,
        status: "APPLIED",
        summary: "Inventory Enrichment applied.",
        updatedAt: "2026-07-25T14:02:00.000Z",
      },
      evidence: [
        {
          id: "image-1",
          kind: "photo",
          label: "Item Image",
          summary: "Black passport pouch",
        },
      ],
      history: [],
      nextAction: "No action required",
      preprocessing: {
        attempts: 1,
        failedAt: null,
        failedSteps: [],
        failureMessage: null,
        maxAttempts: 3,
        mediaTexts: [],
        status: "READY_FOR_ENRICHMENT",
        summary: "Inventory Text Bundle ready.",
        textBundleAvailable: true,
        retryable: false,
        updatedAt: "2026-07-25T14:01:00.000Z",
      },
      proposal: {
        status: "APPROVED",
        summary: "Inventory Proposal approved.",
        updatedAt: "2026-07-25T14:03:00.000Z",
      },
      sourceLabel: "photo + text capture",
    },
    status: "KEEP",
    tags: ["passport", "travel"],
    title: "Passport pouch",
    totalQuantity: 1,
    where: "Hall closet / Travel drawer (BIN-0003)",
  };
}
