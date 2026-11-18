import { expect, test } from "bun:test";
import { inventoryPanelCsv } from "./use-inventory-panel-export";

test("Inventory CSV quotes multiline titles and neutralizes spreadsheet formulas", () => {
  const csv = inventoryPanelCsv([
    { id: "item-one", title: "Cable, 2\"\nSpare" },
    { id: "item-two", title: "  =1+1" },
    { id: "item-three", title: "\tSpreadsheet-sensitive" },
  ]);
  expect(csv).toBe(
    "id,title\r\n" +
      "\"item-one\",\"Cable, 2\"\"\nSpare\"\r\n" +
      "\"item-two\",\"'  =1+1\"\r\n" +
      "\"item-three\",\"'\tSpreadsheet-sensitive\"",
  );
});
