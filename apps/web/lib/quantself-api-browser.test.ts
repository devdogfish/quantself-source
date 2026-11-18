import { afterEach, describe, expect, test } from "bun:test";
import {
  captureInventoryItemFromBrowser,
  deleteInventoryItemMediaFromBrowser,
  inventoryItemMediaContentPath,
  listRemedyIntakesFromBrowser,
  reorderInventoryItemImagesFromBrowser,
  uploadInventoryItemMediaFromBrowser,
} from "./quantself-api-browser";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Quantself browser API Client", () => {
  test("loads every stable all-time Remedy Intake page in one projection", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      const secondPage = url.includes("cursor=intake-1");
      const intake = {
        bucketDate: secondPage ? "2026-07-01" : "2026-08-03",
        colorKey: "remedy-3",
        id: secondPage ? "intake-2" : "intake-1",
        note: null,
        occurredAt: secondPage
          ? "2026-07-01T12:00:00.000Z"
          : "2026-08-03T12:00:00.000Z",
        potency: "30C",
        itemArchivedAt: null,
        itemId: "item-ars",
        itemTitle: "Arsenicum album",
      };

      return Response.json({
        intakes: [intake],
        pageInfo: { nextCursor: secondPage ? null : "intake-1" },
        range: "all",
      });
    }) as typeof fetch;

    const intakes = await listRemedyIntakesFromBrowser({
      range: "all",
      timeZone: "America/Toronto",
    });

    expect(intakes.map((intake) => intake.id)).toEqual([
      "intake-1",
      "intake-2",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("range=all");
    expect(requests[0]).toContain("timeZone=America%2FToronto");
    expect(requests[1]).toContain("cursor=intake-1");
  });

  test("captures metadata and initial media in one multipart request", async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> =
      [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input });
      return Response.json({
        media: [],
        preprocessingJob: { id: "job-1", status: "QUEUED" },
        item: { id: "item-1" },
      });
    }) as typeof fetch;
    const metadata = { captureText: null, note: null, title: null };
    const files = [
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
      new File(["voice"], "note.webm", { type: "audio/webm" }),
    ];

    await captureInventoryItemFromBrowser(metadata, files, {
      idempotencyKey: "capture-key",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/api/v1/inventory-items/capture");
    expect(requests[0]?.init?.headers).toEqual({
      "Idempotency-Key": "capture-key",
    });
    const body = requests[0]?.init?.body as FormData;
    expect(body.get("metadata")).toBe(JSON.stringify(metadata));
    expect(body.getAll("files").map((entry) => (entry as File).name)).toEqual([
      "front.jpg",
      "note.webm",
    ]);
  });

  test("uploads multipart media directly with a Client-stable retry key", async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> =
      [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input });
      return Response.json({
        media: [
          {
            contentType: "image/jpeg",
            id: "image-1",
            kind: "image",
            originalName: "front.jpg",
            position: 0,
            sizeBytes: 5,
          },
        ],
      });
    }) as typeof fetch;
    const files = [
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
      new File(["voice"], "note.webm", { type: "audio/webm" }),
    ];

    const media = await uploadInventoryItemMediaFromBrowser(
      "item/1",
      files,
      { idempotencyKey: "stable-upload-key" },
    );

    expect(media.map(({ id }) => id)).toEqual(["image-1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(
      "/api/v1/inventory-items/item%2F1/media",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.credentials).toBe("same-origin");
    expect(requests[0]?.init?.headers).toEqual({
      "Idempotency-Key": "stable-upload-key",
    });
    expect(
      (requests[0]?.init?.body as FormData)
        .getAll("files")
        .map((entry) => (entry as File).name),
    ).toEqual(["front.jpg", "note.webm"]);
  });

  test("uses stable retry keys for capture, ordering, and deletion", async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> =
      [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input });
      return Response.json(
        String(input).endsWith("/capture")
          ? { item: { id: "item-1" } }
          : {},
      );
    }) as typeof fetch;

    await captureInventoryItemFromBrowser(
      {
        acquisitionSource: null,
        captureSessionId: null,
        captureText: "Camera",
        category: null,
        containerId: null,
        containerLabelOverride: null,
        costCents: null,
        costCurrency: "CAD",
        importance: "MEDIUM",
        kind: "ITEM",
        note: null,
        quantity: 1,
        status: "KEEP",
        title: "Camera",
      },
      [],
      { idempotencyKey: "capture-key" },
    );
    await reorderInventoryItemImagesFromBrowser(
      "item-1",
      ["image-2", "image-1"],
      { idempotencyKey: "order-key" },
    );
    await deleteInventoryItemMediaFromBrowser("item-1", "image-1", {
      idempotencyKey: "delete-key",
    });

    expect(
      requests.map((request) => ({
        key: (request.init?.headers as Record<string, string>)[
          "Idempotency-Key"
        ],
        method: request.init?.method,
      })),
    ).toEqual([
      { key: "capture-key", method: "POST" },
      { key: "order-key", method: "PUT" },
      { key: "delete-key", method: "DELETE" },
    ]);
  });

  test("encodes parent and media identifiers and surfaces API errors", async () => {
    expect(inventoryItemMediaContentPath("item/1", "image #1")).toBe(
      "/api/v1/inventory-items/item%2F1/media/image%20%231",
    );
    expect(
      inventoryItemMediaContentPath("item/1", "image #1", {
        representation: "preview",
      }),
    ).toBe(
      "/api/v1/inventory-items/item%2F1/media/image%20%231?representation=preview",
    );
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(
          { code: "FORBIDDEN", message: "Missing Inventory Write." },
          { status: 403 },
        ),
      { preconnect: originalFetch.preconnect },
    );

    expect(
      deleteInventoryItemMediaFromBrowser("item-1", "image-1"),
    ).rejects.toThrow("Missing Inventory Write.");
  });
});
