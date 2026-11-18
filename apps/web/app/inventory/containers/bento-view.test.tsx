import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getInventoryContainerVisualCatalogEntry } from "@/lib/inventory-container-visual-catalog";
import { testContainerVisualPreset } from "../container-test-fixtures";
import { BentoView } from "./bento-view";
import type { ContainerShelf } from "./types";

describe("Bento layout", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("retains the card grid and lazy rendering hints", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView containers={buildContainers()} query="" />
        </ChakraTestWrapper>,
      );
    });

    const grid = container.querySelector('[data-testid="bento-grid"]');
    const articles = container.querySelectorAll<HTMLElement>(
      "[data-container-id]",
    );

    expect(grid?.childElementCount).toBe(articles.length);

    for (const article of articles) {
      expect(article.style.contentVisibility).toBe("auto");
      expect(article.style.containIntrinsicSize).toBe("auto 480px");
    }
  });

  test("keeps the visible container name inside its navigation link", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView containers={buildContainers()} query="" />
        </ChakraTestWrapper>,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>(
      '[data-container-id="container-one"] a',
    );
    const name = [...(link?.querySelectorAll("span") ?? [])].find(
      (element) => element.textContent === "Travel tote",
    );

    expect(name?.closest("a")).toBe(link);
  });

  test("lets container geometry determine overflow", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView containers={buildContainers()} query="" />
        </ChakraTestWrapper>,
      );
    });

    for (const visual of container.querySelectorAll(
      "[data-container-visual]",
    )) {
      expect(visual.hasAttribute("data-overflow-threshold")).toBe(false);
    }
  });

  test("lets geometry render more than six decorative previews", async () => {
    const [baseContainer] = buildContainers();
    const items = Array.from({ length: 30 }, (_, index) => ({
      audioId: null,
      hasAudio: false,
      id: `item-${index}`,
      imageId: `image-${index}`,
      textPreview: null,
      title: `Item ${index}`,
    }));

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView
            containers={[
              {
                ...baseContainer!,
                itemCount: items.length,
                items,
              },
            ]}
            query=""
          />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelectorAll("[data-item-tile]")).toHaveLength(30);
    expect(
      container.querySelector('[data-container-item-id="overflow"]'),
    ).toBeNull();
  });

  test("filters visible items without removing containers", async () => {
    const containers = buildContainers();

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView containers={containers} query="" />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelectorAll("[data-container-id]")).toHaveLength(2);
    expect(container.querySelector("input")).toBeNull();
    expect(
      container
        .querySelector<HTMLAnchorElement>(
          '[data-container-id="container-one"] a',
        )
        ?.getAttribute("href"),
    ).toBe("/inventory/containers/container-one");

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <BentoView containers={containers} query="voice" />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelectorAll("[data-container-id]")).toHaveLength(2);
    expect(
      container
        .querySelector('[data-container-id="container-one"]')
        ?.getAttribute("aria-label"),
    ).toContain("0 visible items");
    expect(
      container
        .querySelector('[data-container-id="container-two"]')
        ?.getAttribute("aria-label"),
    ).toContain("1 visible item");
  });
});

function buildContainers(): ContainerShelf[] {
  return [
    {
      id: "container-one",
      itemCount: 2,
      items: [
        {
          audioId: null,
          hasAudio: false,
          id: "item-passport",
          imageId: null,
          textPreview: "Typed travel note",
          title: "Passport pouch",
        },
        {
          audioId: null,
          hasAudio: false,
          id: "item-camera",
          imageId: "image-camera",
          textPreview: null,
          title: "Camera",
        },
      ],
      location: "Hall closet",
      name: "Travel tote",
      referenceId: "BIN-0001",
      visualPreset: testContainerVisualPreset,
      visualPresetKey: testContainerVisualPreset.id,
    },
    {
      id: "container-two",
      itemCount: 1,
      items: [
        {
          audioId: "audio-keys",
          hasAudio: true,
          id: "item-keys",
          imageId: null,
          textPreview: null,
          title: "Spare keys",
        },
      ],
      location: "Entryway",
      name: "Small drawer",
      referenceId: "BIN-0002",
      visualPreset: buildVisualPreset("6L"),
      visualPresetKey: "6L",
    },
  ];
}

function buildVisualPreset(key: "6L") {
  const preset = getInventoryContainerVisualCatalogEntry(key)!;

  return {
    backImageUrl: preset.assets.back.webpPath,
    bounds: preset.itemBounds,
    emptyImageUrl: preset.assets.empty.webpPath,
    frontImageUrl: preset.assets.front.webpPath,
    height: preset.dimensions.height,
    id: preset.key,
    isDefault: preset.isDefault,
    name: preset.name,
    shadowImageUrl: preset.assets.shadow.webpPath,
    width: preset.dimensions.width,
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}
