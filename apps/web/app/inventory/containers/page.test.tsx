import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { testContainerVisualPreset } from "../container-test-fixtures";
import type { ContainerShelf } from "./types";

let capturedContainers: ContainerShelf[] = [];
let capturedUrlView: "bento" | "scroll" | undefined;
let capturedLayoutSeed = "";

async function renderServerPage(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(<ChakraTestWrapper>{node}</ChakraTestWrapper>);
  await stream.allReady;

  return (await new Response(stream).text()).replaceAll("<!-- -->", "");
}

mock.module("../actions", () => ({
  createInventoryContainerAction: async () => ({
    container: null,
    message: "",
    status: "idle",
  }),
}));

mock.module("@/lib/quantself-api-client", () => ({
  isApiAuthenticationError: () => false,
  isApiNotFoundError: () => false,
  listActiveInventoryItems: async () => [],
  listInventoryContainers: async () => [
    {
      id: "container-travel-tote",
      itemCount: 2,
      latestCapturedAt: "2026-07-27T12:00:00.000Z",
      locationName: "Hall closet",
      name: "Travel tote",
      referenceId: "BIN-0001",
      sampleImages: [],
      sampleItems: [
        {
          audioId: null,
          hasAudio: false,
          id: "item-camera",
          imageHeight: null,
          imageId: "image-camera",
          imageIds: ["image-camera", "image-camera-detail"],
          imageWidth: null,
          localQuantity: 2,
          textPreview: null,
          title: "Camera",
          totalQuantity: 2,
          videoId: null,
        },
      ],
      sizeLiters: 39,
      unitCount: 2,
      visualPreset: {
        ...testContainerVisualPreset,
        hoverBounds: testContainerVisualPreset.bounds,
      },
      visualPresetKey: testContainerVisualPreset.id,
    },
  ],
  listInventoryContainerVisuals: async () => ({
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
  }),
  listInventoryItems: async () => [],
  resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
}));

mock.module("./containers-client", () => ({
  ContainersClient: ({
    containers,
    layoutSeed,
    urlView,
  }: {
    containers: ContainerShelf[];
    layoutSeed: string;
    urlView?: "bento" | "scroll";
  }) => {
    capturedContainers = containers;
    capturedUrlView = urlView;
    capturedLayoutSeed = layoutSeed;
    return <div>stub</div>;
  },
}));

afterEach(() => {
  capturedContainers = [];
  capturedUrlView = undefined;
  capturedLayoutSeed = "";
});

afterAll(() => {
  mock.restore();
});

describe("containers page", () => {
  test("passes the saved preset key and full resolved visual preset to the client", async () => {
    const { default: InventoryContainersPage } = await import("./page");

    await renderServerPage(
      InventoryContainersPage({
        searchParams: Promise.resolve({ view: "bento" }),
      }),
    );

    expect(capturedUrlView).toBe("bento");
    expect(capturedLayoutSeed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(capturedContainers).toHaveLength(1);
    expect(capturedContainers[0]).toMatchObject({
      hoverBounds: testContainerVisualPreset.bounds,
      id: "container-travel-tote",
      itemCount: 2,
      items: [
        {
          audioId: null,
          hasAudio: false,
          id: "item-camera",
          imageHeight: null,
          imageId: "image-camera",
          imageIds: ["image-camera", "image-camera-detail"],
          imageWidth: null,
          localQuantity: 2,
          textPreview: null,
          title: "Camera",
          totalQuantity: 2,
          videoId: null,
        },
      ],
      location: "Hall closet",
      name: "Travel tote",
      referenceId: "BIN-0001",
      visualPresetKey: testContainerVisualPreset.id,
    });
    expect(capturedContainers[0]?.visualPreset).toMatchObject({
      ...testContainerVisualPreset,
      hoverBounds: testContainerVisualPreset.bounds,
    });
  });

  test("only passes valid URL view overrides", async () => {
    const { default: InventoryContainersPage } = await import("./page");

    await renderServerPage(
      InventoryContainersPage({
        searchParams: Promise.resolve({ view: "cards" }),
      }),
    );

    expect(capturedUrlView).toBeUndefined();
  });
});
