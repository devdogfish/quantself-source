import { describe, expect, test } from "bun:test";
import {
  buildInventoryItemHref,
  INVENTORY_ITEM_BACK_FALLBACK,
  sanitizeInventoryItemReturnTo,
} from "./item-navigation";

describe("inventory item navigation", () => {
  test("preserves an internal path with filters and hash", () => {
    expect(
      sanitizeInventoryItemReturnTo(
        "/inventory/browse?containerId=bin-1&q=usb#results",
      ),
    ).toBe("/inventory/browse?containerId=bin-1&q=usb#results");
    expect(
      sanitizeInventoryItemReturnTo("/inventory/food?q=kale#results"),
    ).toBe("/inventory/food?q=kale#results");
  });

  test.each([
    undefined,
    "",
    "https://example.com/steal",
    "//example.com/steal",
    "/\\example.com/steal",
    "/settings",
    "/inventory/items",
    "/inventory/items/item-1",
    "/inventory/items/item-1?returnTo=%2Finventory%2Fitems%2Fitem-2",
  ])("falls back for unsafe or looping return target: %s", (value) => {
    expect(sanitizeInventoryItemReturnTo(value)).toBe(
      INVENTORY_ITEM_BACK_FALLBACK,
    );
  });

  test("uses only the first query value", () => {
    expect(
      sanitizeInventoryItemReturnTo([
        "/inventory/processing",
        "https://example.com",
      ]),
    ).toBe("/inventory/processing");
  });

  test("builds an encoded item URL with a sanitized return target", () => {
    expect(
      String(
        buildInventoryItemHref(
          "item/with spaces",
          "/inventory/supplements?q=omega 3",
        ),
      ),
    ).toBe(
      "/inventory/items/item%2Fwith%20spaces?returnTo=%2Finventory%2Fsupplements%3Fq%3Domega%25203",
    );
  });
});
