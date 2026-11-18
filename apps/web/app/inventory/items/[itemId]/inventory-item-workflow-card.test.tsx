import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { describe, expect, mock, test } from "bun:test";
import type { Route } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import type { InventoryItem } from "@/lib/quantself-api-client";
import { InventoryItemWorkflowCard } from "./inventory-item-workflow-card";
import type { InventoryItemProcessingWithRecovery } from "./inventory-item-workflow";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const action = async () => ({ message: "", status: "idle" as const });

describe("InventoryItemWorkflowCard", () => {
  test("shows only the useful active-processing summary", () => {
    const html = renderCard(processing());

    expect(html).toContain("Processing status");
    expect(html).toContain("Current stage");
    expect(html).toContain("Reading source media");
    expect(html).toContain("Next action");
    expect(html).not.toContain("attempt");
    expect(html).not.toContain("Source evidence");
    expect(html).not.toContain("updated");
  });

  test("shows a concise failure and its valid recovery", () => {
    const failed = processing();
    failed.preprocessing.status = "FAILED";
    failed.preprocessing.failureMessage = "OCR timed out.";
    failed.preprocessing.retryable = true;

    const html = renderCard(failed);

    expect(html).toContain("Processing needs review");
    expect(html).toContain("OCR timed out.");
    expect(html).toContain("Retry preprocessing");
    expect(html).not.toContain("Preprocessing attempt");
    expect(html).not.toContain("Processing history");
  });

  test("hides completed processing", () => {
    const complete = processing();
    complete.enrichment.status = "APPLIED";
    complete.proposal.status = "APPROVED";

    expect(
      renderCard(complete).replace(
        /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/g,
        "",
      ),
    ).toBe("");
  });
});

function renderCard(processingState: InventoryItemProcessingWithRecovery) {
  return renderToStaticMarkup(
    <ChakraTestWrapper>
      <InventoryItemWorkflowCard
        editHref={"/inventory/items/item-1?edit=1" as Route}
        item={{ id: "item-1", processing: processingState } as InventoryItem}
        retryEnrichmentAction={action}
        retryPreprocessingAction={action}
      />
    </ChakraTestWrapper>,
  );
}

function processing(): InventoryItemProcessingWithRecovery {
  return {
    currentStep: "Reading source media",
    enrichment: {
      attempts: 0,
      failedAt: null,
      failureMessage: null,
      maxAttempts: 3,
      rationale: "",
      retryable: false,
      status: "NOT_STARTED",
      summary: "Waiting for preprocessing.",
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    evidence: [],
    history: [],
    nextAction: "Wait for text extraction",
    preprocessing: {
      attempts: 1,
      failedAt: null,
      failedSteps: [],
      failureMessage: null,
      maxAttempts: 3,
      mediaTexts: [],
      retryable: false,
      status: "PREPROCESSING",
      summary: "Reading source media.",
      textBundleAvailable: false,
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    proposal: {
      status: "NONE",
      summary: "No proposal yet.",
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    sourceLabel: "Inventory capture",
  };
}
