import { describe, expect, test } from "bun:test";
import {
  getInventoryShellDetailMode,
  getInventoryShellProcessingColumns,
  inventoryShellItems,
} from "./inventory-shell-data";

describe("rejected inventory proposals", () => {
  test("leave the processing flow as a terminal inventory state", () => {
    const rejectedItem = {
      ...inventoryShellItems[0]!,
      currentStep: "Inventory Proposal rejected",
      enrichment: {
        ...inventoryShellItems[0]!.enrichment,
        status: "REJECTED" as const,
      },
      nextAction: "No action required",
      proposal: {
        ...inventoryShellItems[0]!.proposal,
        status: "REJECTED" as const,
      },
    };

    expect(getInventoryShellDetailMode(rejectedItem)).toBe("complete");
    expect(
      getInventoryShellProcessingColumns([rejectedItem]).flatMap(
        (column) => column.items,
      ),
    ).toEqual([]);
  });

  test("leave superseded enrichment outside the processing flow", () => {
    const supersededItem = {
      ...inventoryShellItems[0]!,
      currentStep: "Inventory Enrichment superseded",
      enrichment: {
        ...inventoryShellItems[0]!.enrichment,
        status: "CANCELLED" as const,
      },
      nextAction: "No action required",
      proposal: {
        ...inventoryShellItems[0]!.proposal,
        status: "NONE" as const,
      },
    };

    expect(getInventoryShellDetailMode(supersededItem)).toBe("complete");
    expect(
      getInventoryShellProcessingColumns([supersededItem]).flatMap(
        (column) => column.items,
      ),
    ).toEqual([]);
  });
});
