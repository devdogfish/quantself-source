import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InventoryItemAudioHoverTarget,
  InventoryItemMediaPreview,
  InventoryItemMediaProvider,
  imageHasFullyTransparentPerimeter,
} from "./inventory-item-media-preview";

describe("InventoryItemMediaPreview", () => {
  test.each([
    {
      alpha: 0,
      name: "fully transparent perimeter",
      position: [2, 2],
      expected: true,
    },
    {
      alpha: 128,
      name: "partially transparent perimeter pixel",
      position: [0, 1],
      expected: false,
    },
    {
      alpha: 255,
      name: "edge-touching opaque pixel",
      position: [3, 2],
      expected: false,
    },
  ])("recognizes a $name", ({ alpha, expected, position: [x, y] }) => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data[(1 * 4 + 1) * 4 + 3] = 255;
    data[(y * 4 + x) * 4 + 3] = alpha;

    expect(
      imageHasFullyTransparentPerimeter({
        data,
        height: 4,
        width: 4,
      }),
    ).toBe(expected);
  });

  test("fails closed when a perimeter alpha sample is missing", () => {
    expect(
      imageHasFullyTransparentPerimeter({
        data: new Uint8ClampedArray(4 * 4 * 4 - 1),
        height: 4,
        width: 4,
      }),
    ).toBe(false);
  });

  test("contains a qualifying loaded image without adding padding", async () => {
    const { cleanup, host, root, window } = setupDom();
    const canvasPrototype = window.HTMLCanvasElement.prototype;
    const originalGetContext = Object.getOwnPropertyDescriptor(
      canvasPrototype,
      "getContext",
    );

    Object.defineProperty(canvasPrototype, "getContext", {
      configurable: true,
      value: () => ({
        clearRect: () => {},
        drawImage: () => {},
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => ({
          data: new Uint8ClampedArray(width * height * 4),
          height,
          width,
        }),
      }),
    });

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemMediaPreview
              imagePresentation="contain-transparent-perimeter"
              media={{
                alt: "Bottle",
                sources: ["/api/v1/inventory-items/item-1/media/image-1"],
                type: "image",
              }}
            />
          </ChakraTestWrapper>,
        );
      });
      const image = host.querySelector("img");

      if (!image) throw new Error("Expected an image preview.");

      Object.defineProperties(image, {
        naturalHeight: { configurable: true, value: 4 },
        naturalWidth: { configurable: true, value: 4 },
      });
      await act(async () => {
        image.dispatchEvent(new globalThis.Event("load"));
      });

      expect(image.style.objectFit).toBe("contain");
      expect(image.getAttribute("alt")).toBe("Bottle");
    } finally {
      if (originalGetContext) {
        Object.defineProperty(
          canvasPrototype,
          "getContext",
          originalGetContext,
        );
      }
      await cleanup();
    }
  });

  test("keeps idle and playing audio glyphs in one fixed frame", () => {
    const markup = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemMediaPreview
          audioPreview={{
            activeAudioId: "audio-1",
            isPlaying: true,
            media: <></>,
            progress: 0,
            start: async () => {},
            stop: () => {},
          }}
          media={{
            audioId: "audio-1",
            src: "/api/v1/inventory-items/item-1/media/audio-1",
            type: "audio",
          }}
        />
      </ChakraTestWrapper>,
    );

    expect(markup).toContain('aria-label="Preview audio"');
    expect(markup).toContain('data-audio-idle-glyph=""');

    expect(markup).toContain('data-audio-playing-glyph=""');
    expect(markup).toContain("Playing audio");
    expect(markup).toContain("lucide-volume-2");
  });

  test.each([false, true])(
    "reports audio playback progress when compact is %s",
    (compact) => {
      const markup = renderToStaticMarkup(
        <ChakraTestWrapper>
          <InventoryItemMediaPreview
            audioPreview={{
              activeAudioId: "audio-1",
              isPlaying: true,
              media: <></>,
              progress: 0,
              start: async () => {},
              stop: () => {},
            }}
            compact={compact}
            media={{
              audioId: "audio-1",
              src: "/api/v1/inventory-items/item-1/media/audio-1",
              type: "audio",
            }}
            presentation="tile"
          />
        </ChakraTestWrapper>,
      );

      expect(markup).toContain('role="progressbar"');
      expect(markup).toContain('aria-label="Audio playback progress"');
      expect(markup).toContain("Playing audio");
    },
  );

  test("plays one shared audio preview on hover and resets on leave", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemMediaProvider>
              <InventoryItemMediaPreview
                media={{
                  audioId: "audio-1",
                  src: "/api/v1/inventory-items/item-1/media/audio-1",
                  type: "audio",
                }}
              />
            </InventoryItemMediaProvider>
          </ChakraTestWrapper>,
        );
      });
      const audio = host.querySelector("audio");
      const preview = host.querySelector<HTMLElement>(
        "[data-inventory-item-media-preview]",
      );

      if (!audio || !preview) {
        throw new Error("Expected audio media and its shared preview.");
      }

      let pauseCount = 0;
      let playCount = 0;
      let paused = true;
      Object.defineProperties(audio, {
        currentTime: { configurable: true, value: 0, writable: true },
        paused: { configurable: true, get: () => paused },
        pause: {
          configurable: true,
          value: () => {
            pauseCount += 1;
            paused = true;
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
        preview.dispatchEvent(
          new globalThis.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(playCount).toBe(1);
      expect(audio.getAttribute("src")).toBe(
        "/api/v1/inventory-items/item-1/media/audio-1",
      );

      await act(async () => {
        preview.dispatchEvent(
          new globalThis.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      expect(pauseCount).toBe(1);
      expect(audio.currentTime).toBe(0);

      await act(async () => preview.focus());
      expect(playCount).toBe(2);

      await act(async () => preview.blur());
      expect(pauseCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("plays the shared audio preview from a title hover target", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemMediaProvider>
              <InventoryItemAudioHoverTarget
                audioId="audio-1"
                audioSrc="/api/v1/inventory-items/item-1/media/audio-1"
              >
                <span>Audio item title</span>
              </InventoryItemAudioHoverTarget>
            </InventoryItemMediaProvider>
          </ChakraTestWrapper>,
        );
      });
      const audio = host.querySelector("audio");
      const target = host.querySelector<HTMLElement>(
        "[data-inventory-audio-hover-target]",
      );

      if (!audio || !target) {
        throw new Error("Expected audio media and its title hover target.");
      }

      let pauseCount = 0;
      let playCount = 0;
      let paused = true;
      Object.defineProperties(audio, {
        currentTime: { configurable: true, value: 0, writable: true },
        paused: { configurable: true, get: () => paused },
        pause: {
          configurable: true,
          value: () => {
            pauseCount += 1;
            paused = true;
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
        target.dispatchEvent(
          new globalThis.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(playCount).toBe(1);
      expect(audio.getAttribute("src")).toBe(
        "/api/v1/inventory-items/item-1/media/audio-1",
      );

      await act(async () => {
        target.dispatchEvent(
          new globalThis.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(pauseCount).toBe(1);
      expect(audio.currentTime).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("plays a muted video preview on hover and resets on leave", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemMediaPreview
              media={{
                src: "/api/v1/inventory-items/item-1/media/video-1",
                title: "Walkaround",
                type: "video",
              }}
            />
          </ChakraTestWrapper>,
        );
      });
      const preview = host.querySelector<HTMLElement>("[data-video-preview]");
      const video = host.querySelector("video");

      if (!preview || !video) {
        throw new Error("Expected video media and its shared preview.");
      }

      let pauseCount = 0;
      let playCount = 0;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 8, writable: true },
        pause: {
          configurable: true,
          value: () => {
            pauseCount += 1;
          },
        },
        play: {
          configurable: true,
          value: async () => {
            playCount += 1;
          },
        },
      });

      await act(async () => {
        preview.dispatchEvent(
          new globalThis.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(playCount).toBe(1);

      await act(async () => {
        preview.dispatchEvent(
          new globalThis.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(pauseCount).toBe(1);
      expect(video.currentTime).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

function setupDom() {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    HTMLElement: globalThis.HTMLElement,
    HTMLMediaElement: globalThis.HTMLMediaElement,
    MouseEvent: globalThis.MouseEvent,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLMediaElement: window.HTMLMediaElement,
    MouseEvent: window.MouseEvent,
    navigator: window.navigator,
    Node: window.Node,
    cancelAnimationFrame: () => {},
    requestAnimationFrame: () => 1,
    window,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;

  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      Object.assign(globalThis, previous);
      delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
    },
    host,
    root,
    window,
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}
