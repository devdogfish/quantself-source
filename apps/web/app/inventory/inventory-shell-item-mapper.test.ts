import { describe, expect, test } from "bun:test";
import type { BrowserInventoryItem } from "@/lib/quantself-api-browser";
import { mapInventoryShellItem } from "./inventory-shell-item-mapper";

describe("inventory shell item mapper", () => {
  test("shows age from the latest processing update instead of stale capture time", () => {
    const realDateNow = Date.now;
    Date.now = () => Date.parse("2026-08-10T12:00:00.000Z");

    try {
      const item = {
        acquisitionSource: null,
        aliases: [],
        archivedAt: null,
        captureText: "Test evidence",
        capturedAt: "2026-08-01T12:00:00.000Z",
        category: null,
        clothingProfile: null,
        containerId: null,
        containerLabel: null,
        costCents: null,
        costCurrency: "CAD",
        id: "item-test",
        imageId: null,
        importance: "MEDIUM",
        kind: "ITEM",
        note: null,
        placementSummary: "Unplaced",
        placements: [],
        processing: {
          currentStep: "Preprocessing needs review",
          enrichment: {
            attempts: 0,
            failedAt: null,
            failureMessage: null,
            maxAttempts: 3,
            rationale: "Inventory Enrichment has not started.",
            retryable: false,
            status: "NOT_STARTED",
            summary: "Waiting for preprocessing.",
            updatedAt: "2026-08-10T11:54:00.000Z",
          },
          evidence: [],
          history: [],
          nextAction: "Review preprocessing evidence",
          preprocessing: {
            attempts: 1,
            failedAt: null,
            failedSteps: ["ocr_timed_out"],
            failureMessage: null,
            maxAttempts: 3,
            mediaTexts: [],
            retryable: true,
            status: "PARTIAL",
            summary: "Some evidence was processed.",
            textBundleAvailable: true,
            updatedAt: "2026-08-10T11:55:00.000Z",
          },
          proposal: {
            status: "NONE",
            summary: "No proposal.",
            updatedAt: "2026-08-10T11:54:00.000Z",
          },
          sourceLabel: "photo + text capture",
        },
        status: "KEEP",
        tags: [],
        title: "Test item",
        totalQuantity: 1,
        remedyProfile: null,
        where: "Unplaced",
      } as BrowserInventoryItem;

      expect(mapInventoryShellItem(item).ageLabel).toBe("5m");
    } finally {
      Date.now = realDateNow;
    }
  });
});
