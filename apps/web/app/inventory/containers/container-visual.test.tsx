import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getInventoryContainerVisualCatalogEntry } from "@/lib/inventory-container-visual-catalog";
import { buildInventoryItemHref } from "../item-navigation";
import { testContainerVisualPreset } from "../container-test-fixtures";
import type { ContainerShelf } from "./types";

// Exercise the rendered links without the Next.js router's prefetch subscriptions.
mock.module("next/link", () => ({
  default: ({ prefetch: _prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => (
    <a {...props} />
  ),
}));

const { ContainerVisual } = await import("./container-visual");

describe("ContainerVisual", () => {
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

  test("renders the registered empty scene when the container has zero total items", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: 0, items: [] })}
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    expect(
      container.querySelectorAll('[data-scene-layer="shadow"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="empty"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="front"]'),
    ).toHaveLength(0);
    const scene = container.querySelector<HTMLElement>(
      "[data-container-scene]",
    );
    expect(scene).not.toBeNull();
    expect(scene?.style.aspectRatio).toBe(
      `${testContainerVisualPreset.width} / ${testContainerVisualPreset.height}`,
    );
    expect(scene?.style.getPropertyValue("--container-scene-width")).toBe(
      "calc(100% - 1rem)",
    );
    expect(scene?.style.width).toBe("var(--container-scene-width)");
    expect(scene?.style.minHeight).toBe("");
    expect(
      [...container.querySelectorAll("img")].every((image) => image.alt === ""),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-scene-layer="shadow"] img')
        ?.getAttribute("sizes"),
    ).toBe("(max-width: 768px) 94vw, (max-width: 1280px) 48vw, 32vw");
    const link = container.querySelector("a");
    expect(link?.getAttribute("aria-label")).toBeNull();
    expect(link?.textContent).toContain("Open");
  });

  test("bottom-aligns width-driven scenes only in bento mode", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="bento" />
        </ChakraTestWrapper>,
      );
    });

    const bentoVisual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    const bentoScene = container.querySelector<HTMLElement>(
      "[data-container-scene]",
    );

    expect(bentoVisual?.getAttribute("data-visual-mode")).toBe("bento");
    expect(bentoScene?.style.getPropertyValue("--container-scene-width")).toBe(
      "calc(100% - 1rem)",
    );
    expect(bentoScene?.style.height).toBe("");

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="scroll" />
        </ChakraTestWrapper>,
      );
    });

    const scrollVisual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    expect(scrollVisual?.getAttribute("data-visual-mode")).toBe("scroll");
  });

  test("renders a navigation link around the scroll container name", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="scroll" />
        </ChakraTestWrapper>,
      );
    });

    const link = container.querySelector<HTMLElement>(
      '[aria-label="Open Travel tote"]',
    );
    const name = link?.querySelector("span");

    expect(name?.textContent).toBe("Travel tote");
    expect(link?.getAttribute("href")).toBe(
      "/inventory/containers/container-travel-tote",
    );
  });

  test("renders an unlinked container title while preserving item links", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer()}
            linkTitle={false}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const name = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "Travel tote",
    );

    expect(name).not.toBeNull();
    expect(name?.closest("a")).toBeNull();
    expect(
      container.querySelector('a[aria-label="Open Camera"]'),
    ).not.toBeNull();
  });

  test("renders decorative visual bounds only in debug mode", async () => {
    const visualContainer = buildContainer();

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={visualContainer} mode="bento" />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelectorAll("[data-debug-bound]")).toHaveLength(0);

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={visualContainer}
            debugBounds
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    const hoverBounds = container.querySelector<SVGElement>(
      '[data-debug-bound="hover"]',
    );
    const sceneBounds = container.querySelector<HTMLElement>(
      '[data-debug-bound="scene"]',
    );
    const itemBounds = container.querySelector<SVGElement>(
      '[data-debug-bound="item-render"]',
    );
    expect(hoverBounds?.getAttribute("stroke-width")).toBe("40");
    expect(sceneBounds?.getAttribute("aria-hidden")).toBe("true");
    expect(itemBounds).not.toBeNull();
    expect(itemBounds?.getAttribute("points")).toBe(
      visualContainer.visualPreset.bounds
        .map(({ x, y }) => `${x * 100},${y * 100}`)
        .join(" "),
    );
  });

  test("shows opaque items through the translucent front before reveal", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="bento" />
        </ChakraTestWrapper>,
      );
    });

    const items = container.querySelector<HTMLElement>(
      '[data-scene-layer="items"]',
    );
    const front = container.querySelector<HTMLElement>(
      '[data-scene-layer="front"]',
    );
    expect(items).not.toBeNull();
    expect(front).not.toBeNull();
    expect(
      container.querySelectorAll(
        '[data-container-item-card][data-media-type="image"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '[data-container-item-card][data-media-type="text"]',
      ),
    ).toHaveLength(1);
  });

  test("elevates the whole bento card and reveals non-empty contents", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="bento" />
        </ChakraTestWrapper>,
      );
    });

    let visual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    const title = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "Travel tote",
    );

    await act(async () => {
      title?.dispatchEvent(
        new window.MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("open");

    await act(async () => {
      visual?.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              id: "container-empty",
              itemCount: 0,
              items: [],
            })}
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    visual = container.querySelector<HTMLElement>("[data-container-visual]");

    await act(async () => {
      visual?.dispatchEvent(
        new window.MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
  });

  test("keeps image cards square regardless of source aspect ratio", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              itemCount: 1,
              items: [
                {
                  audioId: null,
                  hasAudio: false,
                  id: "item-wide-photo",
                  imageHeight: 600,
                  imageId: "image-wide",
                  imageIds: ["image-wide"],
                  imageWidth: 1200,
                  textPreview: null,
                  title: "Wide photo",
                },
              ],
            })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const imageCard = container.querySelector<HTMLElement>(
      'a[aria-label="Open Wide photo"]',
    );
    const width = Number.parseFloat(imageCard?.style.width ?? "");
    const height = Number.parseFloat(imageCard?.style.height ?? "");

    expect(width / height).toBeCloseTo(1);
    expect(imageCard?.querySelector("img")?.getAttribute("alt")).toBe(
      "Wide photo",
    );
  });

  test("uses layered cards instead of quantity labels for duplicate units", async () => {
    for (const mode of ["scroll", "bento"] as const) {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual
              container={buildContainer({
                itemCount: 2,
                items: [
                  {
                    audioId: null,
                    hasAudio: false,
                    id: "item-camera",
                    imageId: "image-camera",
                    imageIds: ["image-camera"],
                    localQuantity: 2,
                    textPreview: null,
                    title: "Camera",
                    totalQuantity: 2,
                  },
                ],
              })}
              mode={mode}
            />
          </ChakraTestWrapper>,
        );
      });

      const stack = container.querySelector<HTMLElement>(
        '[data-container-item-id="item-camera"]',
      );
      expect(stack?.getAttribute("data-stack-size")).toBe("2");
      expect(stack?.querySelectorAll("[data-stack-layer]")).toHaveLength(2);
      expect(stack?.textContent).not.toContain("×");
    }
  });

  test("uses the shared video preview when an item has no image", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              itemCount: 1,
              items: [
                {
                  audioId: null,
                  hasAudio: false,
                  id: "item-video",
                  imageId: null,
                  textPreview: null,
                  title: "Walkaround",
                  videoId: "video-1",
                },
              ],
            })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const video = container.querySelector("video");

    expect(video?.getAttribute("src")).toBe(
      "/api/v1/inventory-items/item-video/media/video-1",
    );
    expect(
      container.querySelector(
        '[data-container-item-card][data-media-type="video"]',
      ),
    ).not.toBeNull();
  });

  test("keeps hovered items promoted across detailed and compact scenes", async () => {
    for (const mode of ["scroll", "bento"] as const) {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual container={buildContainer()} mode={mode} />
          </ChakraTestWrapper>,
        );
      });

      const camera = container.querySelector<HTMLElement>(
        '[data-container-item-id="item-camera"]',
      );
      const passport = container.querySelector<HTMLElement>(
        '[data-container-item-id="item-passport"]',
      );

      expect(camera).not.toBeNull();
      expect(passport).not.toBeNull();
      expect(camera?.style.zIndex).toBe("");
      expect(passport?.style.zIndex).toBe("");

      await act(async () => {
        camera?.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      await act(async () => {
        camera?.dispatchEvent(
          new window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(camera?.style.zIndex).toBe("1");
      expect(passport?.style.zIndex).toBe("");

      await act(async () => {
        passport?.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      await act(async () => {
        passport?.dispatchEvent(
          new window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(camera?.style.zIndex).toBe("1");
      expect(passport?.style.zIndex).toBe("2");

      await act(async () => {
        camera?.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(camera?.style.zIndex).toBe("2");
      expect(passport?.style.zIndex).toBe("1");
    }
  });

  test("passes only the primary optimized image into the card before engagement", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              itemCount: 1,
              items: [
                {
                  audioId: null,
                  hasAudio: false,
                  id: "item-legacy-photo",
                  imageId: "image-legacy",
                  imageIds: ["image-legacy", "image-detail"],
                  textPreview: null,
                  title: "Legacy photo",
                },
              ],
            })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const imageCard = container.querySelector<HTMLElement>(
      'a[aria-label="Open Legacy photo"]',
    );
    const width = Number.parseFloat(imageCard?.style.width ?? "");
    const height = Number.parseFloat(imageCard?.style.height ?? "");
    expect(width / height).toBeCloseTo(1);
    expect(
      [...(imageCard?.querySelectorAll("[data-slideshow-image]") ?? [])].map(
        (image) => image.getAttribute("src"),
      ),
    ).toEqual([
      "/api/v1/inventory-items/item-legacy-photo/media/image-legacy?representation=preview",
    ]);
  });

  test("keeps quantity stack layers without decoding the same preview repeatedly", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              itemCount: 1,
              items: [
                {
                  audioId: null,
                  hasAudio: false,
                  id: "item-stacked-camera",
                  imageId: "image-stacked-camera",
                  localQuantity: 3,
                  textPreview: null,
                  title: "Stacked camera",
                },
              ],
            })}
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    const item = container.querySelector<HTMLElement>(
      '[data-container-item-id="item-stacked-camera"]',
    );

    expect(item?.querySelectorAll("[data-stack-layer]")).toHaveLength(3);
    expect(item?.querySelectorAll("[data-slideshow-image]")).toHaveLength(1);
    expect(
      item?.querySelector("[data-slideshow-image]")?.getAttribute("src"),
    ).toBe(
      "/api/v1/inventory-items/item-stacked-camera/media/image-stacked-camera?representation=preview",
    );
  });

  test("forces hovered and unhovered states in debug mode", async () => {
    const visualContainer = buildContainer();

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={visualContainer}
            debugBounds
            debugRevealState="hovered"
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    const visual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    expect(visual?.getAttribute("data-reveal-state")).toBe("open");
    expect(visual?.getAttribute("data-debug-reveal-state")).toBe("hovered");

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={visualContainer}
            debugBounds
            debugRevealState="unhovered"
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });
    await act(async () => {
      visual?.dispatchEvent(
        new window.FocusEvent("focusin", {
          bubbles: true,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
    expect(visual?.getAttribute("data-debug-reveal-state")).toBe("unhovered");
  });

  test("uses custom hover bounds for the scroll reveal target", async () => {
    const originalGetBoundingClientRect =
      window.HTMLElement.prototype.getBoundingClientRect;
    const customHoverBounds = [
      { x: 0.02, y: 0.02 },
      { x: 0.12, y: 0.02 },
      { x: 0.12, y: 0.12 },
      { x: 0.02, y: 0.12 },
    ] as const;

    try {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.hasAttribute("data-container-scene")
          ? new window.DOMRect(0, 0, 100, 100)
          : originalGetBoundingClientRect.call(this);
      };

      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual
              container={buildContainer({ hoverBounds: customHoverBounds })}
              mode="scroll"
            />
          </ChakraTestWrapper>,
        );
      });

      const visual = container.querySelector<HTMLElement>(
        "[data-container-visual]",
      );

      const scene = container.querySelector<HTMLElement>(
        "[data-container-scene]",
      )!;
      scene.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 100);
      await act(async () => {
        visual?.dispatchEvent(
          new window.MouseEvent("mousemove", {
            bubbles: true,
            clientX: 7,
            clientY: 7,
            relatedTarget: document.body,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("open");

      await act(async () => {
        visual?.dispatchEvent(
          new window.MouseEvent("mousemove", {
            bubbles: true,
            clientX: 50,
            clientY: 50,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    }
  });

  test("keeps the registered closed scene when search hides a non-empty container's visible items", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: 2 })}
            mode="bento"
            visibleItems={[]}
          />
        </ChakraTestWrapper>,
      );
    });

    expect(
      container.querySelectorAll('[data-scene-layer="shadow"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="front"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="empty"]'),
    ).toHaveLength(0);
    expect(container.querySelector("a")?.getAttribute("data-item-count")).toBe(
      "0",
    );
    expect(
      container.querySelector("a")?.getAttribute("data-total-item-count"),
    ).toBe("2");
  });

  test("does not render a decorative paper label on container scenes", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: 0, items: [] })}
            mode="bento"
          />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelector("[data-paper-label]")).toBeNull();

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: 2 })}
            mode="bento"
            visibleItems={[]}
          />
        </ChakraTestWrapper>,
      );
    });

    expect(container.querySelector("[data-paper-label]")).toBeNull();
  });

  test("renders compact non-clickable visible item tiles in bento mode", async () => {
    const originalGetBoundingClientRect =
      window.HTMLElement.prototype.getBoundingClientRect;
    const sceneWidth = 90;
    const sceneHeight =
      (sceneWidth * testContainerVisualPreset.height) /
      testContainerVisualPreset.width;
    const visualContainer = buildContainer();

    try {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.hasAttribute("data-container-scene")
          ? new window.DOMRect(0, 0, sceneWidth, sceneHeight)
          : originalGetBoundingClientRect.call(this);
      };

      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual
              container={visualContainer}
              mode="bento"
              visibleItems={visualContainer.items.slice(0, 1)}
            />
          </ChakraTestWrapper>,
        );
      });

      const visual = container.querySelector<HTMLAnchorElement>(
        "[data-container-visual]",
      );

      await act(async () => {
        visual?.dispatchEvent(
          new window.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
          }),
        );
        visual?.dispatchEvent(
          new window.MouseEvent("click", {
            bubbles: true,
          }),
        );
      });

      const itemLayer = container.querySelector('[data-scene-layer="items"]');
      const itemTiles = [
        ...(itemLayer?.querySelectorAll<HTMLElement>(
          '[data-item-tile="true"]',
        ) ?? []),
      ];

      expect(
        container.querySelectorAll('[data-scene-layer="back"]'),
      ).toHaveLength(1);
      const front = container.querySelector<HTMLElement>(
        '[data-scene-layer="front"]',
      );
      expect(front).not.toBeNull();
      expect(
        container.querySelectorAll('[data-scene-layer="front"]'),
      ).toHaveLength(1);
      expect(itemTiles).toHaveLength(1);
      expect(
        itemTiles.every((tile) => tile.tagName.toLowerCase() === "span"),
      ).toBe(true);
      expect(
        itemTiles.every((tile) => Number.parseFloat(tile.style.width) < 20),
      ).toBe(true);
      expect(
        itemLayer
          ?.querySelector("[data-container-item-card]")
          ?.getAttribute("data-variant"),
      ).toBe("compact");
      expect(
        container.querySelectorAll('a[href^="/inventory/items/"]'),
      ).toHaveLength(0);
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    }
  });

  test("plays an audio tile on hover and resets it on leave", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({
              itemCount: 1,
              items: [
                {
                  audioId: "audio-cables",
                  hasAudio: true,
                  id: "item-cables",
                  imageId: null,
                  textPreview: null,
                  title: "Cable note",
                },
              ],
            })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const audio = container.querySelector("audio");
    const audioLink = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Open Cable note"]',
    );

    if (!audio || !audioLink) {
      throw new Error("Expected an audio preview element and item link.");
    }

    let pauseCount = 0;
    let playCount = 0;
    let paused = true;
    Object.defineProperties(audio, {
      currentTime: { configurable: true, value: 0, writable: true },
      duration: { configurable: true, value: 10 },
      paused: { configurable: true, get: () => paused },
      pause: {
        configurable: true,
        value: () => {
          pauseCount += 1;
          paused = true;
          audio.dispatchEvent(new Event("pause"));
        },
      },
      play: {
        configurable: true,
        value: async () => {
          playCount += 1;
          paused = false;
        },
      },
    });

    await act(async () => {
      audioLink.dispatchEvent(
        new window.MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(playCount).toBe(1);
    expect(audio.getAttribute("src")).toBe(
      "/api/v1/inventory-items/item-cables/media/audio-cables",
    );
    expect(
      audioLink.querySelector("[data-audio-id]")?.getAttribute("data-audio-id"),
    ).toBe("audio-cables");

    await act(async () => {
      audioLink.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(pauseCount).toBe(1);
    expect(audio.currentTime).toBe(0);
  });

  test("reveals compact bento items on hover, focus, and first touch without item links", async () => {
    const originalGetBoundingClientRect =
      window.HTMLElement.prototype.getBoundingClientRect;
    const sceneWidth = 90;
    const sceneHeight =
      (sceneWidth * testContainerVisualPreset.height) /
      testContainerVisualPreset.width;
    const visualContainer = buildContainer();

    try {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.hasAttribute("data-container-scene")
          ? new window.DOMRect(0, 0, sceneWidth, sceneHeight)
          : originalGetBoundingClientRect.call(this);
      };

      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual
              container={visualContainer}
              mode="bento"
              visibleItems={visualContainer.items.slice(0, 1)}
            />
          </ChakraTestWrapper>,
        );
      });

      const visual = container.querySelector<HTMLAnchorElement>(
        "[data-container-visual]",
      );
      expect(visual).not.toBeNull();
      expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
      expect(
        container.querySelectorAll('[data-scene-layer="front"]'),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll('a[href^="/inventory/items/"]'),
      ).toHaveLength(0);

      await act(async () => {
        visual?.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            clientX: 45,
            clientY: 20,
            relatedTarget: document.body,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("open");
      const front = container.querySelector<HTMLElement>(
        '[data-scene-layer="front"]',
      );
      expect(front).not.toBeNull();
      expect(
        container.querySelector<HTMLElement>('[data-scene-layer="front"]')
          ?.style.transitionDuration,
      ).toBe("300ms");
      expect(
        container.querySelectorAll('[data-scene-layer="shadow"]'),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll(
          '[data-scene-layer="items"] [data-item-tile="true"]',
        ),
      ).toHaveLength(1);

      await act(async () => {
        visual?.dispatchEvent(
          new window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("closed");

      await act(async () => {
        visual?.dispatchEvent(
          new window.FocusEvent("focusin", {
            bubbles: true,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("open");

      await act(async () => {
        visual?.dispatchEvent(
          new window.FocusEvent("focusout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("closed");

      const firstTouchClick = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });

      await act(async () => {
        visual?.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
        visual?.dispatchEvent(
          new window.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
          }),
        );
        visual?.dispatchEvent(firstTouchClick);
      });

      expect(firstTouchClick.defaultPrevented).toBe(true);
      expect(visual?.getAttribute("data-reveal-state")).toBe("open");

      await act(async () => {
        document.body.dispatchEvent(
          new window.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
          }),
        );
      });

      expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    }
  });

  test("fits compact tiles inside the shallow 6L registered bounds", async () => {
    const originalGetBoundingClientRect =
      window.HTMLElement.prototype.getBoundingClientRect;
    const preset = getInventoryContainerVisualCatalogEntry("6L");
    expect(preset).not.toBeNull();
    if (!preset) return;

    const sceneWidth = 300;
    const sceneHeight =
      (sceneWidth * preset.dimensions.height) / preset.dimensions.width;
    const visualContainer = buildContainer({
      visualPreset: {
        ...testContainerVisualPreset,
        bounds: preset.itemBounds,
        height: preset.dimensions.height,
        id: preset.key,
        width: preset.dimensions.width,
      },
      visualPresetKey: preset.key,
    });

    try {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.hasAttribute("data-container-scene")
          ? new window.DOMRect(0, 0, sceneWidth, sceneHeight)
          : originalGetBoundingClientRect.call(this);
      };

      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerVisual container={visualContainer} mode="bento" />
          </ChakraTestWrapper>,
        );
      });

      expect(
        container.querySelectorAll(
          '[data-scene-layer="items"] [data-item-tile="true"]',
        ),
      ).toHaveLength(2);
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    }
  });

  test("height-constrains the scroll scene without changing its registered ratio", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="scroll" />
        </ChakraTestWrapper>,
      );
    });

    const scene = container.querySelector<HTMLElement>(
      "[data-container-scene]",
    );
    const aspectRatio =
      testContainerVisualPreset.width / testContainerVisualPreset.height;

    expect(scene?.style.aspectRatio).toBe(
      `${testContainerVisualPreset.width} / ${testContainerVisualPreset.height}`,
    );
    expect(scene?.style.getPropertyValue("--container-scene-width")).toBe(
      `min(100%, 92vw, 1120px, calc(${formatCssNumber(
        aspectRatio * 100,
      )}svh - ${formatCssNumber(aspectRatio * 9)}rem))`,
    );
    expect(scene?.style.width).toBe("var(--container-scene-width)");
    expect(scene?.style.maxHeight).toBe("");
    expect(
      container
        .querySelector('[data-scene-layer="front"] img')
        ?.getAttribute("sizes"),
    ).toBe("(max-width: 768px) 94vw, 1120px");
    expect(
      container
        .querySelector('[data-scene-layer="front"] img')
        ?.getAttribute("alt"),
    ).toBe("");
  });

  test("reveals detailed items on hover, keyboard, or touch without pinning mouse clicks", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="scroll" />
        </ChakraTestWrapper>,
      );
    });

    const visual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    const scene = container.querySelector<HTMLElement>(
      "[data-container-scene]",
    );
    if (scene) {
      scene.getBoundingClientRect = () => new window.DOMRect(0, 0, 500, 398);
    }
    expect(visual).not.toBeNull();
    expect(visual?.getAttribute("aria-label")).toBe(
      "Travel tote, 2 items in Hall closet",
    );
    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
    expect(
      container.querySelectorAll('[data-scene-layer="shadow"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="back"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="front"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-scene-layer="empty"]'),
    ).toHaveLength(0);

    const cameraLink = container.querySelector<HTMLAnchorElement>(
      '[aria-label="Open Camera"]',
    );
    expect(cameraLink).not.toBeNull();
    expect(cameraLink?.getAttribute("href")).toBe(
      buildInventoryItemHref(
        "item-camera",
        "/inventory/containers/container-travel-tote",
      ),
    );

    const noteLink = container.querySelector<HTMLAnchorElement>(
      '[aria-label="Open Passport pouch"]',
    );
    expect(noteLink).not.toBeNull();

    await act(async () => {
      visual?.dispatchEvent(
        new window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 250,
          clientY: 100,
          relatedTarget: document.body,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("open");

    await act(async () => {
      visual?.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");

    await act(async () => {
      cameraLink?.dispatchEvent(
        new window.FocusEvent("focusin", {
          bubbles: true,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("open");

    await act(async () => {
      visual?.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");

    await act(async () => {
      visual?.dispatchEvent(
        new window.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        }),
      );
      visual?.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");

    await act(async () => {
      visual?.dispatchEvent(
        new window.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
        }),
      );
      visual?.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("open");

    await act(async () => {
      document.body.dispatchEvent(
        new window.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
  });

  test("packs detailed tiles in rendered CSS pixels without violating the minimum", async () => {
    const originalGetBoundingClientRect =
      window.HTMLElement.prototype.getBoundingClientRect;
    const sceneWidth = 320;
    const sceneHeight =
      (sceneWidth * testContainerVisualPreset.height) /
      testContainerVisualPreset.width;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.hasAttribute("data-container-scene")
        ? new window.DOMRect(0, 0, sceneWidth, sceneHeight)
        : originalGetBoundingClientRect.call(this);
    };
    const items = Array.from({ length: 30 }, (_, index) => ({
      audioId: null,
      hasAudio: false,
      id: `item-${index}`,
      imageId: null,
      textPreview: `Item ${index}`,
      title: `Item ${index}`,
    }));

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: items.length, items })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const itemLayer = container.querySelector('[data-scene-layer="items"]');
    const tiles = [...(itemLayer?.querySelectorAll<HTMLElement>("a") ?? [])];

    expect(tiles.length).toBeGreaterThan(0);
    expect(
      tiles.every((tile) => Number.parseFloat(tile.style.width) >= 32),
    ).toBe(true);
    expect(
      itemLayer?.querySelector('[aria-label$=" more items"]'),
    ).not.toBeNull();
    window.HTMLElement.prototype.getBoundingClientRect =
      originalGetBoundingClientRect;
  });

  test("shortens reveal transitions for reduced-motion users", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        addEventListener() {},
        addListener() {},
        dispatchEvent: () => true,
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        removeEventListener() {},
        removeListener() {},
      }),
    });

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual container={buildContainer()} mode="scroll" />
        </ChakraTestWrapper>,
      );
    });

    const visual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    const front = container.querySelector<HTMLElement>(
      '[data-scene-layer="front"]',
    );

    expect(visual?.getAttribute("data-reduced-motion")).toBe("true");
    expect(front?.style.transitionDuration).toBe("80ms");
  });

  test("keeps empty scroll containers inert with no item detail links", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainerVisual
            container={buildContainer({ itemCount: 0, items: [] })}
            mode="scroll"
          />
        </ChakraTestWrapper>,
      );
    });

    const visual = container.querySelector<HTMLElement>(
      "[data-container-visual]",
    );
    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
    expect(
      container.querySelectorAll('[data-scene-layer="back"]'),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('a[href^="/inventory/items/"]'),
    ).toHaveLength(0);
    await act(async () => {
      visual?.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
        }),
      );
    });

    expect(visual?.getAttribute("data-reveal-state")).toBe("closed");
  });
});

function buildContainer(
  overrides: Partial<ContainerShelf> = {},
): ContainerShelf {
  return {
    id: "container-travel-tote",
    itemCount: 2,
    items: [
      {
        audioId: null,
        hasAudio: false,
        id: "item-camera",
        imageId: "image-camera",
        imageIds: ["image-camera"],
        textPreview: null,
        title: "Camera",
      },
      {
        audioId: null,
        hasAudio: false,
        id: "item-passport",
        imageId: null,
        textPreview: "Travel note",
        title: "Passport pouch",
      },
    ],
    location: "Hall closet",
    name: "Travel tote",
    referenceId: "BIN-0001",
    visualPreset: testContainerVisualPreset,
    visualPresetKey: testContainerVisualPreset.id,
    ...overrides,
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

function formatCssNumber(value: number): number {
  return Number(value.toFixed(4));
}
