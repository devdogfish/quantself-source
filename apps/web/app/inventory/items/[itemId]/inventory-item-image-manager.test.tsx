import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const uploads: File[][] = [];
const removals: string[] = [];
const reorders: string[][] = [];
let uploadFailure: Error | null = null;
let uploadBarrier: Promise<void> | null = null;
let removeBarrier: Promise<void> | null = null;
let reorderBarrier: Promise<void> | null = null;

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

mock.module("@/lib/quantself-api-browser", () => ({
  deleteInventoryItemMediaFromBrowser: async (
    _itemId: string,
    imageId: string,
  ) => {
    removals.push(imageId);
    await removeBarrier;
  },
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  inventoryItemMediaFilesSignature: (files: File[]) =>
    files.map((file) => file.name).join(":"),
  reorderInventoryItemImagesFromBrowser: async (
    _itemId: string,
    imageIds: string[],
  ) => {
    reorders.push(imageIds);
    await reorderBarrier;
  },
  uploadInventoryItemMediaFromBrowser: async (
    _itemId: string,
    files: File[],
  ) => {
    uploads.push(files);
    if (uploadBarrier) {
      await uploadBarrier;
    }
    if (uploadFailure) {
      throw uploadFailure;
    }
    return files.map((file, index) => ({
      contentType: file.type || "image/jpeg",
      id: `uploaded-${index}`,
      kind: "image" as const,
      originalName: file.name,
      position: index,
      sizeBytes: file.size,
    }));
  },
}));

import { InventoryItemImageManager } from "./inventory-item-image-manager";

describe("InventoryItemImageManager", () => {
  afterEach(() => {
    removals.length = 0;
    reorders.length = 0;
    uploads.length = 0;
    uploadBarrier = null;
    removeBarrier = null;
    reorderBarrier = null;
    uploadFailure = null;
  });

  test("uses accessible zero-, single-, and multi-image controls", () => {
    const empty = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemImageManager images={[]} itemId="item-1" title="Lamp" />
      </ChakraTestWrapper>,
    );
    const single = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemImageManager
          images={[{ caption: "lamp.jpg", id: "image-1", url: "/lamp.jpg" }]}
          itemId="item-1"
          title="Lamp"
        />
      </ChakraTestWrapper>,
    );
    const multiple = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemImageManager
          images={[
            { caption: "front.jpg", id: "image-1", url: "/front.jpg" },
            { caption: "back.jpg", id: "image-2", url: "/back.jpg" },
          ]}
          itemId="item-1"
          title="Lamp"
        />
      </ChakraTestWrapper>,
    );

    expect(empty).toContain('data-item-image-drop-target=""');
    expect(empty).toContain('aria-label="Add images"');
    expect(empty).toContain("Drop images here or choose files");
    expect(single).toContain('data-item-image-drop-target=""');
    expect(single).toContain('data-item-single-image=""');
    expect(single).toContain("max-height:70vh");
    expect(single).toContain("object-fit:contain");
    expect(single).toContain('aria-label="Add images"');
    expect(single).toContain('aria-label="Remove image 1"');
    expect(single).toContain('aria-label="View full image of Lamp"');
    expect(multiple).toContain('aria-label="Add images"');
    expect(multiple).toContain('data-item-image-add-tile=""');
    expect(multiple).toContain(
      "grid-template-columns:repeat(auto-fit, minmax(min(100%, max(14rem, calc(33.333% - 0.5rem))), 1fr))",
    );
    expect(multiple).toContain("cursor:grab");
    expect(multiple).toContain('aria-label="Remove image 1"');
    expect(multiple).toContain('aria-label="Remove image 2"');
  });

  test("uploads images dropped anywhere in the multi-image section", async () => {
    const { cleanup, host, root, window } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[
                { caption: "front.jpg", id: "image-1", url: "/front.jpg" },
                { caption: "back.jpg", id: "image-2", url: "/back.jpg" },
              ]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const target = requiredElement<HTMLElement>(
        host,
        "[data-item-image-drop-target]",
      );

      await dispatchFileDragEvent(window, target, "drop", [
        new window.File(["image"], "shade.jpg", { type: "image/jpeg" }),
      ]);

      expect(uploads).toHaveLength(1);
      expect(host.querySelectorAll("img")).toHaveLength(3);
      expect(host.textContent).toContain("1 image added.");
    } finally {
      await cleanup();
    }
  });

  test("opens the picker from the focused multi-image add tile", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[
                { caption: "front.jpg", id: "image-1", url: "/front.jpg" },
                { caption: "back.jpg", id: "image-2", url: "/back.jpg" },
              ]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const input = requiredElement<HTMLInputElement>(
        host,
        'input[type="file"]',
      );
      const addTile = requiredElement<HTMLButtonElement>(
        host,
        '[data-item-image-add-tile][aria-label="Add images"]',
      );
      let pickerClicks = 0;
      input.addEventListener("click", () => {
        pickerClicks += 1;
      });

      addTile.focus();
      expect(document.activeElement).toBe(addTile);
      addTile.click();
      expect(pickerClicks).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("removes an image from the multi-image layout before the save completes", async () => {
    const save = Promise.withResolvers<void>();
    removeBarrier = save.promise;
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[
                { caption: "front.jpg", id: "image-1", url: "/front.jpg" },
                { caption: "back.jpg", id: "image-2", url: "/back.jpg" },
              ]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      await act(async () => {
        requiredElement<HTMLButtonElement>(
          host,
          'button[aria-label="Remove image 2"]',
        ).click();
      });

      expect(removals).toEqual(["image-2"]);
      expect(host.querySelector("[data-item-single-image]")).not.toBeNull();
      expect(host.textContent).toContain("Removing image…");
      await act(async () => save.resolve());
      expect(host.textContent).toContain("Image removed.");
    } finally {
      await cleanup();
    }
  });

  test("updates the primary image before keyboard reorder completes", async () => {
    const save = Promise.withResolvers<void>();
    reorderBarrier = save.promise;
    const { cleanup, host, root, window } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[
                { caption: "front.jpg", id: "image-1", url: "/front.jpg" },
                { caption: "back.jpg", id: "image-2", url: "/back.jpg" },
              ]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const imageCards = host.querySelectorAll("figure");
      setElementRect(imageCards[0], { left: 0, top: 0 });
      setElementRect(imageCards[1], { left: 240, top: 0 });
      const moveButton = requiredElement<HTMLButtonElement>(
        host,
        'button[aria-label="Move image 1"]',
      );
      moveButton.focus();

      await act(async () => {
        dispatchKeyboardEvent(window, moveButton, "Space", " ");
      });
      await act(async () => {
        dispatchKeyboardEvent(window, moveButton, "ArrowRight", "ArrowRight");
      });
      await act(async () => {
        dispatchKeyboardEvent(window, moveButton, "Space", " ");
      });

      expect(reorders).toEqual([["image-2", "image-1"]]);
      expect(host.querySelector("figure")?.textContent).toContain("back.jpg");
      expect(host.querySelector("figure")?.textContent).toContain("Primary");
      expect(host.textContent).toContain("Saving image order…");
      await act(async () => save.resolve());
      expect(host.querySelector("figure")?.textContent).toContain("back.jpg");
    } finally {
      await cleanup();
    }
  });

  for (const state of ["zero", "single"] as const) {
    test(`uploads valid images dropped on the ${state}-image surface`, async () => {
      const { cleanup, host, root, window } = setupDom();

      try {
        await act(async () => {
          root.render(
            <ChakraTestWrapper>
              <InventoryItemImageManager
                images={
                  state === "single"
                    ? [{ caption: null, id: "image-1", url: "/lamp.jpg" }]
                    : []
                }
                itemId="item-1"
                title="Lamp"
              />
            </ChakraTestWrapper>,
          );
        });
        const target = requiredElement<HTMLElement>(
          host,
          "[data-item-image-drop-target]",
        );

        await dispatchFileDragEvent(window, target, "drop", [
          new window.File(["image"], "lamp.jpg"),
        ]);

        expect(uploads).toHaveLength(1);
        expect(uploads[0]?.[0]?.name).toBe("lamp.jpg");
        expect(host.textContent).toContain("1 image added.");
        expect(host.querySelectorAll("img")).toHaveLength(
          state === "single" ? 2 : 1,
        );
        if (state === "zero") {
          expect(host.querySelector("[data-item-single-image]")).not.toBeNull();
        }
      } finally {
        await cleanup();
      }
    });
  }

  test("opens the picker from the keyboard-focusable single-image control", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[{ caption: null, id: "image-1", url: "/lamp.jpg" }]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const input = requiredElement<HTMLInputElement>(
        host,
        'input[type="file"]',
      );
      const addButton = requiredElement<HTMLButtonElement>(
        host,
        'button[aria-label="Add images"]',
      );
      let pickerClicks = 0;
      input.addEventListener("click", () => {
        pickerClicks += 1;
      });

      expect(input.tabIndex).toBe(-1);
      addButton.focus();
      expect(document.activeElement).toBe(addButton);
      addButton.click();
      expect(pickerClicks).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("removes the only image and selects the zero-image layout", async () => {
    const { cleanup, host, root } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[{ caption: null, id: "image-1", url: "/lamp.jpg" }]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });

      await act(async () => {
        requiredElement<HTMLButtonElement>(
          host,
          'button[aria-label="Remove image 1"]',
        ).click();
      });

      expect(removals).toEqual(["image-1"]);
      expect(host.textContent).toContain("Drop images here or choose files");
      expect(host.textContent).toContain("Image removed.");
    } finally {
      await cleanup();
    }
  });

  test("shows drag feedback and rejects unsupported image formats", async () => {
    const { cleanup, host, root, window } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const target = requiredElement<HTMLElement>(
        host,
        "[data-item-image-drop-target]",
      );

      await dispatchFileDragEvent(window, target, "dragenter", []);
      expect(target.hasAttribute("data-drag-active")).toBe(true);

      await dispatchFileDragEvent(window, target, "drop", [
        new window.File(["svg"], "lamp.svg", { type: "image/svg+xml" }),
      ]);
      expect(target.hasAttribute("data-drag-active")).toBe(false);
      expect(uploads).toHaveLength(0);
      expect(host.textContent).toContain("Choose at least one image file.");
    } finally {
      await cleanup();
    }
  });

  test("clears the picker immediately so a failed file can be retried", async () => {
    const { cleanup, host, root, window } = setupDom();

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const input = requiredElement<HTMLInputElement>(
        host,
        'input[type="file"]',
      );
      const file = new window.File(["image"], "lamp.jpg", {
        type: "image/jpeg",
      });
      uploadFailure = new Error("Upload unavailable.");
      setInputFiles(input, [file]);

      await act(async () => {
        input.dispatchEvent(
          new window.Event("change", { bubbles: true }) as unknown as Event,
        );
      });

      expect(input.value).toBe("");
      expect(host.textContent).toContain("Upload unavailable.");

      uploadFailure = null;
      setInputFiles(input, [file]);
      await act(async () => {
        input.dispatchEvent(
          new window.Event("change", { bubbles: true }) as unknown as Event,
        );
      });

      expect(uploads).toHaveLength(2);
      expect(host.textContent).toContain("1 image added.");
    } finally {
      await cleanup();
    }
  });

  test("reports pending upload and ignores a concurrent drop", async () => {
    const { cleanup, host, root, window } = setupDom();
    let releaseUpload = () => {};
    uploadBarrier = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemImageManager
              images={[]}
              itemId="item-1"
              title="Lamp"
            />
          </ChakraTestWrapper>,
        );
      });
      const target = requiredElement<HTMLElement>(
        host,
        "[data-item-image-drop-target]",
      );
      const file = new window.File(["image"], "lamp.jpg", {
        type: "image/jpeg",
      });

      await act(async () => {
        target.dispatchEvent(createFileDragEvent(window, "drop", [file]));
        await waitForText(host, "Uploading images…");
        target.dispatchEvent(createFileDragEvent(window, "drop", [file]));
        expect(uploads).toHaveLength(1);
        releaseUpload();
        await uploadBarrier;
        await Promise.resolve();
      });
      expect(host.textContent).toContain("1 image added.");
    } finally {
      releaseUpload();
      await cleanup();
    }
  });
});

async function dispatchFileDragEvent(
  window: Window,
  target: HTMLElement,
  type: "dragenter" | "drop",
  files: unknown[],
) {
  await act(async () => {
    target.dispatchEvent(createFileDragEvent(window, type, files));
  });
}

function createFileDragEvent(
  window: Window,
  type: "dragenter" | "drop",
  files: unknown[],
): Event {
  const event = new window.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"] },
  });
  return event as unknown as Event;
}

function requiredElement<ElementType extends Element>(
  host: HTMLElement,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected element matching ${selector}.`);
  return element;
}

function setInputFiles(input: HTMLInputElement, files: unknown[]) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
}

function dispatchKeyboardEvent(
  window: Window,
  target: HTMLElement,
  code: string,
  key: string,
) {
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code,
      key,
    }) as unknown as Event,
  );
}

function setElementRect(
  element: Element,
  { left, top }: { left: number; top: number },
) {
  const rect = {
    bottom: top + 180,
    height: 180,
    left,
    right: left + 224,
    top,
    width: 224,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
  element.getBoundingClientRect = () => rect;
}

async function waitForText(host: HTMLElement, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (host.textContent?.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected text: ${expected}`);
}

function setupDom() {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
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
