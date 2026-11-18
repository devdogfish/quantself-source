import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  browseFiltersFromSearchParams,
  browseFiltersSearchParams,
  browseReturnTo,
  type BrowseFilters,
  clearedBrowseFilters,
} from "./inventory-browse";
import { buildInventoryBrowseSearchCorpus } from "./inventory-browse-search";

type InventoryItemRecord = Omit<
  Parameters<typeof buildInventoryBrowseSearchCorpus>[0],
  "images"
> & {
  [key: string]: unknown;
  containerLabel: string | null;
  id: string;
  images: Array<
    Parameters<typeof buildInventoryBrowseSearchCorpus>[0]["images"][number] & {
      filePath: string;
      id?: string;
      mimeType?: string | null;
      sizeBytes?: number | null;
    }
  >;
  locationName: string | null;
};
type InventoryTextBundleContract = NonNullable<
  Parameters<typeof buildInventoryBrowseSearchCorpus>[1]
>;
type InventoryTextBundle = Omit<InventoryTextBundleContract, "mediaTexts"> & {
  [key: string]: unknown;
  mediaTexts: Array<
    InventoryTextBundleContract["mediaTexts"][number] & {
      mediaId: string;
      transcriptSegments?: Array<{
        end: number;
        start: number;
        text: string;
      }> | null;
      type: "image" | "audio" | "video";
    }
  >;
};

const emptyFilters: BrowseFilters = {
  category: "",
  containerId: "",
  evidence: "",
  importance: "",
  includeUnready: false,
  kind: "",
  query: "",
  status: "",
  workflow: "",
};

describe("inventory browse behavior", () => {
  test("keeps Archive available as a low-visibility Browse action", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(source).toContain('href="/inventory/archive"');
    expect(source).toContain('variant="ghost"');
    expect(source).toContain("Archive");
  });

  test("round-trips every URL-backed search and filter", () => {
    const filters = browseFiltersFromSearchParams(
      new URLSearchParams({
        category: "technology",
        containerId: "container-1",
        evidence: "photo",
        importance: "HIGH",
        includeUnready: "1",
        kind: "ITEM",
        q: "home cinema",
        status: "KEEP",
        workflow: "COMPLETE",
      }),
      "fallback-container",
    );

    expect(filters).toEqual({
      category: "technology",
      containerId: "container-1",
      evidence: "photo",
      importance: "HIGH",
      includeUnready: true,
      kind: "ITEM",
      query: "home cinema",
      status: "KEEP",
      workflow: "COMPLETE",
    });
    expect(browseFiltersSearchParams(filters).toString()).toBe(
      "q=home+cinema&containerId=container-1&kind=ITEM&status=KEEP&importance=HIGH&evidence=photo&workflow=COMPLETE&category=technology&includeUnready=1",
    );
    expect(browseReturnTo(filters)).toBe(
      "/inventory/browse?q=home+cinema&containerId=container-1&kind=ITEM&status=KEEP&importance=HIGH&evidence=photo&workflow=COMPLETE&category=technology&includeUnready=1",
    );
  });

  test("clears filters back to the ready-only default", () => {
    expect(clearedBrowseFilters()).toEqual(emptyFilters);
  });

  test("drops invalid controlled filters from manually edited URLs", () => {
    expect(
      browseFiltersFromSearchParams(
        new URLSearchParams({
          category: "invalid",
          evidence: "video",
          importance: "URGENT",
          kind: "COLLECTION",
          status: "SOLD",
          workflow: "FINISHED",
        }),
        "",
      ),
    ).toEqual(emptyFilters);
  });

  test("builds corpus from derived fields, OCR, and transcripts", () => {
    const item = buildItem();
    const bundle: InventoryTextBundle = {
      captureText: "manual bundle note",
      failedSteps: [],
      item: {
        containerLabel: item.containerLabel,
        containerLocation: item.locationName,
        id: item.id,
        importance: item.importance,
        kind: item.kind,
        note: item.note,
        status: item.status,
        title: item.title,
      },
      mediaTexts: [
        {
          mediaId: "image-1",
          ocrLines: ["SERIAL ZX9"],
          ocrText: "DEVICE LABEL",
          type: "image",
        },
        {
          mediaId: "audio-1",
          transcript: "stored under stairs",
          transcriptSegments: [
            { end: 1.2, start: 0, text: "backup projector" },
          ],
          type: "audio",
        },
      ],
      schemaVersion: 1,
      sourceRefs: [{ id: item.id, kind: "item" }],
    };

    const corpus = buildInventoryBrowseSearchCorpus(item, bundle);

    for (const expected of [
      "secondhand",
      "CAD 12.50",
      "fragile",
      "home cinema",
      "legacy lookup phrase",
      "PACKAGE OCR",
      "SERIAL ZX9",
      "stored under stairs",
      "backup projector",
    ]) {
      expect(corpus).toContain(expected);
    }
  });
});

function buildItem(): InventoryItemRecord {
  return {
    acquisitionSource: "secondhand",
    aliases: ["home cinema"],
    audioNotes: [],
    captureSessionId: null,
    captureText: "projector capture",
    capturedAt: new Date("2026-07-25T12:00:00.000Z"),
    category: "technology",
    containerLabel: "Electronics bin",
    costCents: 1250,
    costCurrency: "CAD",
    id: "item-projector",
    images: [
      {
        caption: "Projector package",
        filePath: "/tmp/projector.jpg",
        id: "image-1",
        mimeType: "image/jpeg",
        ocrText: "PACKAGE OCR",
        originalName: "projector.jpg",
      },
    ],
    importance: "HIGH",
    kind: "ITEM",
    locationId: null,
    locationName: "Basement",
    metadata: {},
    note: "Keep as backup",
    originLocationId: null,
    originLocationName: null,
    searchText: "legacy lookup phrase",
    status: "KEEP",
    tags: ["fragile"],
    title: "Projector",
  };
}
