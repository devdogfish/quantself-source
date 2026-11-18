import { describe, expect, test } from "bun:test";
import type { InventoryItem } from "@/lib/quantself-api-client";
import {
  inventoryItemRecovery,
  inventoryItemWorkflowMode,
  type InventoryItemProcessingWithRecovery,
} from "./inventory-item-workflow";

describe("Inventory Item workflow", () => {
  test("maps pending proposals before other states", () => {
    const processing = workflowProcessing();
    processing.proposal.status = "PENDING_APPROVAL";
    processing.enrichment.status = "PROPOSAL_READY";

    expect(inventoryItemWorkflowMode(processing)).toBe("proposal");
  });

  test("maps retryable preprocessing failures to one recovery command", () => {
    const processing = workflowProcessing();
    processing.preprocessing.status = "NEEDS_REVIEW";
    processing.preprocessing.retryable = true;
    processing.preprocessing.failureMessage = "Transcription timed out.";

    expect(inventoryItemWorkflowMode(processing)).toBe("error");
    expect(inventoryItemRecovery(processing)).toEqual({
      kind: "retry-preprocessing",
      reason: "Transcription timed out.",
    });
  });

  test("maps a failed preprocessing job to the same recovery command", () => {
    const processing = workflowProcessing();
    processing.preprocessing.status = "FAILED";
    processing.preprocessing.retryable = true;
    processing.preprocessing.failureMessage = "OCR provider timed out.";

    expect(inventoryItemWorkflowMode(processing)).toBe("error");
    expect(inventoryItemRecovery(processing)).toEqual({
      kind: "retry-preprocessing",
      reason: "OCR provider timed out.",
    });
  });

  test("allows enrichment retry only with a usable text bundle", () => {
    const processing = workflowProcessing();
    processing.enrichment.status = "FAILED";
    processing.enrichment.retryable = true;
    processing.preprocessing.textBundleAvailable = true;

    expect(inventoryItemRecovery(processing)?.kind).toBe(
      "retry-enrichment",
    );

    processing.preprocessing.textBundleAvailable = false;
    expect(inventoryItemRecovery(processing)?.kind).toBe("edit");
  });

  test("maps terminal decisions to complete and queued work to processing", () => {
    const processing = workflowProcessing();

    expect(inventoryItemWorkflowMode(processing)).toBe("processing");

    processing.enrichment.status = "APPLIED";
    processing.proposal.status = "APPROVED";
    expect(inventoryItemWorkflowMode(processing)).toBe("complete");
  });
});

function workflowProcessing(): InventoryItemProcessingWithRecovery {
  const timestamp = "2026-08-01T12:00:00.000Z";
  const recovery = {
    attempts: 0,
    failedAt: null,
    failureMessage: null,
    maxAttempts: 3,
    retryable: false,
  };

  return {
    currentStep: "Inventory Preprocessing queued",
    enrichment: {
      ...recovery,
      rationale: "",
      status: "NOT_STARTED",
      summary: "Inventory Enrichment has not started.",
      updatedAt: timestamp,
    },
    evidence: [],
    history: [],
    nextAction: "Wait for background processing",
    preprocessing: {
      ...recovery,
      failedSteps: [],
      mediaTexts: [],
      status: "CAPTURED",
      summary: "Saved evidence is waiting for preprocessing pickup.",
      textBundleAvailable: false,
      updatedAt: timestamp,
    },
    proposal: {
      status: "NONE",
      summary: "No pending Inventory Proposal.",
      updatedAt: timestamp,
    },
    sourceLabel: "text capture",
  } satisfies InventoryItem["processing"] & {
    enrichment: RecoveryMetadataForTest;
    preprocessing: RecoveryMetadataForTest;
  };
}

type RecoveryMetadataForTest = {
  attempts: number;
  failedAt: string | null;
  failureMessage: string | null;
  maxAttempts: number;
  retryable: boolean;
};
