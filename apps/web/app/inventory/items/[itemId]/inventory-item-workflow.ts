import type { InventoryItem } from "@/lib/quantself-api-client";

type RecoveryMetadata = {
  attempts: number;
  failedAt: string | null;
  failureMessage: string | null;
  maxAttempts: number;
  retryable: boolean;
};

export type InventoryItemProcessingWithRecovery = Omit<
  InventoryItem["processing"],
  "enrichment" | "preprocessing"
> & {
  enrichment: InventoryItem["processing"]["enrichment"] & RecoveryMetadata;
  preprocessing: InventoryItem["processing"]["preprocessing"] &
    RecoveryMetadata;
  history?: Array<{
    at: string;
    stage: "enrichment" | "preprocessing" | "proposal";
    status: string;
    summary: string;
  }>;
};

export type InventoryItemWorkflowMode =
  | "complete"
  | "error"
  | "processing"
  | "proposal";

export type InventoryItemRecovery =
  | { kind: "edit"; reason: string }
  | { kind: "retry-enrichment"; reason: string }
  | { kind: "retry-preprocessing"; reason: string }
  | null;

export function inventoryItemWorkflowMode(
  processing: InventoryItemProcessingWithRecovery,
): InventoryItemWorkflowMode {
  if (
    processing.proposal.status === "PENDING_APPROVAL" ||
    processing.enrichment.status === "PROPOSAL_READY"
  ) {
    return "proposal";
  }

  if (
    processing.preprocessing.status === "FAILED" ||
    processing.preprocessing.status === "PARTIAL" ||
    processing.preprocessing.status === "NEEDS_REVIEW" ||
    processing.enrichment.status === "FAILED"
  ) {
    return "error";
  }

  if (
    processing.enrichment.status === "APPLIED" ||
    processing.enrichment.status === "REJECTED" ||
    processing.enrichment.status === "CANCELLED" ||
    processing.proposal.status === "APPROVED" ||
    processing.proposal.status === "REJECTED"
  ) {
    return "complete";
  }

  return "processing";
}

export function inventoryItemRecovery(
  processing: InventoryItemProcessingWithRecovery,
): InventoryItemRecovery {
  if (processing.enrichment.status === "FAILED") {
    if (
      processing.enrichment.retryable &&
      processing.preprocessing.textBundleAvailable
    ) {
      return {
        kind: "retry-enrichment",
        reason:
          processing.enrichment.failureMessage ??
          "Inventory Enrichment can be retried from the current text bundle.",
      };
    }

    return {
      kind: "edit",
      reason:
        processing.enrichment.failureMessage ??
        "Edit source facts before processing can continue.",
    };
  }

  if (
    processing.preprocessing.status === "FAILED" ||
    processing.preprocessing.status === "PARTIAL" ||
    processing.preprocessing.status === "NEEDS_REVIEW"
  ) {
    if (processing.preprocessing.retryable) {
      return {
        kind: "retry-preprocessing",
        reason:
          processing.preprocessing.failureMessage ??
          processing.preprocessing.failedSteps[0] ??
          "Inventory Preprocessing can be retried from current evidence.",
      };
    }

    return {
      kind: "edit",
      reason:
        processing.preprocessing.failureMessage ??
        processing.preprocessing.failedSteps[0] ??
        "Edit source facts before processing can continue.",
    };
  }

  return null;
}
