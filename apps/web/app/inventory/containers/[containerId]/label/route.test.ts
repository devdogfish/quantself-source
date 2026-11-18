import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { inventoryContainerLabelRouteResponse } from "./response";

describe("inventory container label route", () => {
  test("returns an inline, uncached Letter PDF with a stable QR target", async () => {
    const response = await inventoryContainerLabelRouteResponse(
      new Request("http://internal.local/inventory/containers/container-42/label", {
        headers: {
          "x-forwarded-host": "inventory.example",
          "x-forwarded-proto": "https",
        },
      }),
      "container-42",
      async () => ({
        id: "container-42",
        referenceId: "BIN-0042",
        name: "Basement winter equipment",
        normalizedName: "basement winter equipment",
        locationId: null,
        location: null,
        visualPresetKey: "39L",
        visualPreset: {
          id: "39L",
          name: "39L",
          imagePath: "/tmp/tote.png",
          imageMimeType: "image/png",
          bounds: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.9, y: 0.9 },
            { x: 0.1, y: 0.9 },
          ],
          isDefault: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        sizeLiters: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const pdf = await PDFDocument.load(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="BIN-0042-label.pdf"',
    );
    expect(pdf.getPages()).toHaveLength(1);
    expect(pdf.getSubject()).toBe("https://inventory.example/c/BIN-0042");
  });

  test("returns not found for a deleted or missing container", async () => {
    const response = await inventoryContainerLabelRouteResponse(
      new Request("https://inventory.example/inventory/containers/missing/label"),
      "missing",
      async () => null,
    );

    expect(response.status).toBe(404);
  });

  test("downloads a selected alternate label design", async () => {
    const response = await inventoryContainerLabelRouteResponse(
      new Request(
        "https://inventory.example/inventory/containers/container-42/label?design=equipment-tag-aligned&download=1",
      ),
      "container-42",
      async () => ({
        name: "Basement winter equipment",
        referenceId: "BIN-0042",
      }),
    );
    const pdf = await PDFDocument.load(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="BIN-0042-label-equipment-tag-aligned.pdf"',
    );
    expect(pdf.getPages()).toHaveLength(1);
    expect(pdf.getSubject()).toBe("https://inventory.example/c/BIN-0042");
  });

  test("rejects removed C label designs before loading a container", async () => {
    let lookupCount = 0;

    for (const design of ["equipment-tag-large-qr", "equipment-tag-tight"]) {
      const response = await inventoryContainerLabelRouteResponse(
        new Request(
          `https://inventory.example/inventory/containers/container-42/label?design=${design}`,
        ),
        "container-42",
        async () => {
          lookupCount += 1;
          return null;
        },
      );

      expect(response.status).toBe(400);
    }

    expect(lookupCount).toBe(0);
  });

  test("rejects unknown label designs before loading a container", async () => {
    let lookupCount = 0;
    const response = await inventoryContainerLabelRouteResponse(
      new Request(
        "https://inventory.example/inventory/containers/container-42/label?design=unknown",
      ),
      "container-42",
      async () => {
        lookupCount += 1;
        return null;
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Unknown label design.");
    expect(lookupCount).toBe(0);
  });
});
