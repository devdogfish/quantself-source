import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContainerAudioPreviewController } from "./container-audio-preview";
import {
  ContainerItemCard,
  type ContainerItemCardMedia,
} from "./container-item-card";

describe("ContainerItemCard", () => {
  test.each([
    {
      media: {
        alt: "Camera",
        sources: ["/api/v1/inventory-items/item-camera/media/image-camera"],
        type: "image",
      },
      marker: "<img",
      type: "image",
    },
    {
      media: {
        audioId: "audio-note",
        controller: idleAudioController,
        src: "/api/v1/inventory-items/item-audio/media/audio-note",
        type: "audio",
      },
      marker: "lucide-audio-lines",
      type: "audio",
    },
    {
      media: {
        poster: "/api/v1/inventory-items/item-video/media/video-poster",
        src: "/api/v1/inventory-items/item-video/media/video-note",
        title: "Video note",
        type: "video",
      },
      marker: "<video",
      type: "video",
    },
    {
      media: {
        text: "Remember the spare batteries",
        title: "Battery note",
        type: "text",
      },
      marker: "Remember the spare batteries",
      type: "text",
    },
  ] satisfies Array<{
    marker: string;
    media: ContainerItemCardMedia;
    type: ContainerItemCardMedia["type"];
  }>)(
    "uses the shared frosted shell for $type media",
    ({ marker, media, type }) => {
      const markup = renderToStaticMarkup(
        <ChakraTestWrapper>
          <ContainerItemCard media={media} />
        </ChakraTestWrapper>,
      );

      expect(markup).toContain('data-container-item-card=""');
      expect(markup).toContain(`data-media-type="${type}"`);
      expect(markup).toContain(marker);
      expect(markup).not.toMatch(/>(?:AUD|IMG|VID|TXT)</u);
    },
  );

  test("uses a simplified icon-first composition for compact text cards", () => {
    const markup = renderToStaticMarkup(
      <ChakraTestWrapper>
        <ContainerItemCard
          media={{
            text: "Remember the spare batteries",
            title: "Battery note",
            type: "text",
          }}
          variant="compact"
        />
      </ChakraTestWrapper>,
    );

    expect(markup).toContain('data-variant="compact"');
    expect(markup).toContain("lucide-type");
    expect(markup).not.toContain("Remember the spare batteries");
  });

  test("renders only the primary image edge-to-edge before hover slideshow transitions", () => {
    const markup = renderToStaticMarkup(
      <ChakraTestWrapper>
        <ContainerItemCard
          media={{
            alt: "Camera",
            sources: [
              "/api/v1/inventory-items/item-camera/media/image-front",
              "/api/v1/inventory-items/item-camera/media/image-back",
            ],
            type: "image",
          }}
        />
      </ChakraTestWrapper>,
    );

    expect(markup.match(/data-slideshow-image=/gu)).toHaveLength(1);
    expect(markup).not.toContain("object-fit:contain");
  });

  test("starts promptly, then stops and fades back to the thumbnail", async () => {
    const window = new Window({ url: "http://localhost" });
    const previous = {
      document: globalThis.document,
      Event: globalThis.Event,
      HTMLElement: globalThis.HTMLElement,
      MouseEvent: globalThis.MouseEvent,
      navigator: globalThis.navigator,
      Node: globalThis.Node,
      window: globalThis.window,
    };
    let finishTransition = () => {};
    let intervalClears = 0;
    let startSlideshow = () => {};
    let tick = () => {};
    Object.defineProperty(window, "setInterval", {
      configurable: true,
      value: (callback: () => void, delay: number) => {
        expect(delay).toBe(2000);
        tick = callback;
        return 1;
      },
    });
    Object.defineProperty(window, "clearInterval", {
      configurable: true,
      value: () => {
        intervalClears += 1;
      },
    });
    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      value: (callback: () => void, delay: number) => {
        if (delay === 250) {
          startSlideshow = callback;
        } else {
          expect(delay).toBe(500);
          finishTransition = callback;
        }
        return 2;
      },
    });
    Object.defineProperty(window, "clearTimeout", {
      configurable: true,
      value: () => {},
    });
    Object.assign(globalThis, {
      document: window.document,
      Event: window.Event,
      HTMLElement: window.HTMLElement,
      MouseEvent: window.MouseEvent,
      navigator: window.navigator,
      Node: window.Node,
      window,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <ContainerItemCard
              media={{
                alt: "Camera",
                sources: [
                  "/api/v1/inventory-items/item-camera/media/image-front",
                  "/api/v1/inventory-items/item-camera/media/image-back",
                ],
                type: "image",
              }}
            />
          </ChakraTestWrapper>,
        );
      });
      const slideshow = host.querySelector<HTMLElement>(
        "[data-image-slideshow]",
      );
      await act(async () => {
        slideshow?.dispatchEvent(
          new globalThis.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      const images = host.querySelectorAll("[data-slideshow-image]");
      expect(images).toHaveLength(2);
      expect(images[0]?.getAttribute("data-active")).toBe("true");

      await act(async () => startSlideshow());
      expect(images[1]?.getAttribute("data-active")).toBe("true");

      await act(async () => tick());
      expect(images[0]?.getAttribute("data-active")).toBe("true");

      await act(async () => {
        slideshow?.dispatchEvent(
          new globalThis.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(images[0]?.getAttribute("data-active")).toBe("true");
      expect(intervalClears).toBe(1);
      expect(host.querySelectorAll("[data-slideshow-image]")).toHaveLength(2);

      await act(async () => finishTransition());
      expect(host.querySelectorAll("[data-slideshow-image]")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Object.assign(globalThis, previous);
      delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

const idleAudioController: ContainerAudioPreviewController = {
  activeAudioId: null,
  isPlaying: false,
  media: <audio />,
  progress: 0,
  start: async () => {},
  stop: () => {},
};
