import { describe, expect, test } from "bun:test";
import { formatInventoryContainerPickerLabel } from "@/lib/inventory-client-contract";
import { mapContainerOption } from "./container-utils";

describe("container utils", () => {
  test("maps repository container records to picker options", () => {
    const container: Parameters<typeof mapContainerOption>[0] = {
      id: "container-1",
      location: {
        name: "Garage shelf A",
      },
      name: "Blue bin 4",
      referenceId: "BIN-0004",
      sizeLiters: 45,
      visualPresetKey: "39L",
    };

    expect(mapContainerOption(container)).toEqual({
      id: "container-1",
      locationName: "Garage shelf A",
      name: "Blue bin 4",
      referenceId: "BIN-0004",
      sizeLiters: 45,
      visualPresetKey: "39L",
    });
  });

  test("formats picker labels consistently", () => {
    expect(
      formatInventoryContainerPickerLabel({
        name: "Blue bin 4",
        referenceId: "BIN-0004",
      }),
    ).toBe("Blue bin 4 (BIN-0004)");
  });
});
