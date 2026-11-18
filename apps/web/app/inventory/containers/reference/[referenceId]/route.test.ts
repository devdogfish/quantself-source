import { describe, expect, test } from "bun:test";
import { inventoryContainerReferenceRouteResponse } from "./response";

describe("inventory container reference route", () => {
  test("normalizes a printed reference and redirects to the current container", async () => {
    let lookedUpReference = "";
    const response = await inventoryContainerReferenceRouteResponse(
      new Request(
        "https://inventory.example/inventory/containers/reference/bin-0042",
      ),
      "bin-0042",
      async (referenceId) => {
        lookedUpReference = referenceId;

        return {
          id: "container/id",
          referenceId: "BIN-0042",
          name: "Basement bin",
          normalizedName: "basement bin",
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
        };
      },
    );

    expect(lookedUpReference).toBe("BIN-0042");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://inventory.example/inventory/containers/container%2Fid",
    );
  });

  test("redirects to the public proxy origin instead of the internal app origin", async () => {
    const response = await inventoryContainerReferenceRouteResponse(
      new Request("http://localhost:3000/c/BIN-0042", {
        headers: {
          "x-forwarded-host": "dashboard.example.com",
          "x-forwarded-proto": "https",
        },
      }),
      "BIN-0042",
      async () => ({ id: "container-42" }),
    );

    expect(response.headers.get("location")).toBe(
      "https://dashboard.example.com/inventory/containers/container-42",
    );
  });

  test("returns 404 forever when a printed reference no longer resolves", async () => {
    const response = await inventoryContainerReferenceRouteResponse(
      new Request(
        "https://inventory.example/inventory/containers/reference/BIN-0042",
      ),
      "BIN-0042",
      async () => null,
    );

    expect(response.status).toBe(404);
  });
});
