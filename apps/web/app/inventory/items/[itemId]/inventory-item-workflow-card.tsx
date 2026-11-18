import { Box, Grid, Text } from "@chakra-ui/react";
import type { Route } from "next";
import type { InventoryItem } from "@/lib/quantself-api-client";
import { InventoryMetaGrid, InventoryShellCard } from "../../inventory-shell";
import type { InventoryActionState } from "../../action-state";
import { InventoryItemRecoveryActions } from "./inventory-item-recovery-actions";
import {
  inventoryItemRecovery,
  inventoryItemWorkflowMode,
  type InventoryItemProcessingWithRecovery,
} from "./inventory-item-workflow";

type RecoveryAction = (
  state: InventoryActionState,
  formData: FormData,
) => Promise<InventoryActionState>;

export function InventoryItemWorkflowCard({
  editHref,
  item,
  retryEnrichmentAction,
  retryPreprocessingAction,
}: {
  editHref: Route;
  item: InventoryItem;
  retryEnrichmentAction: RecoveryAction;
  retryPreprocessingAction: RecoveryAction;
}) {
  const processing = item.processing as InventoryItemProcessingWithRecovery;
  const mode = inventoryItemWorkflowMode(processing);
  const recovery = inventoryItemRecovery(processing);

  if (mode === "proposal" || mode === "complete") {
    return null;
  }

  return (
    <InventoryShellCard title={workflowTitle(mode)}>
      <InventoryMetaGrid entries={workflowEntries(processing, mode)} />

      {mode === "error" && recovery ? (
        <Grid gap="3" borderColor="border" borderTopWidth="1px" pt="4">
          <Grid gap="1">
            <Box
              as="h3"
              fontFamily="heading"
              fontWeight="semibold"
              fontSize="md"
            >
              Recovery
            </Box>
            <Text color="fg.muted" fontSize="sm">
              {recovery.reason}
            </Text>
          </Grid>
          <InventoryItemRecoveryActions
            editHref={editHref}
            itemId={item.id}
            recovery={recovery.kind}
            retryEnrichmentAction={retryEnrichmentAction}
            retryPreprocessingAction={retryPreprocessingAction}
          />
        </Grid>
      ) : null}
    </InventoryShellCard>
  );
}

function workflowEntries(
  processing: InventoryItemProcessingWithRecovery,
  mode: ReturnType<typeof inventoryItemWorkflowMode>,
) {
  const common = [
    { label: "Current stage", value: processing.currentStep },
    { label: "Next action", value: processing.nextAction },
  ];

  if (mode !== "error") {
    return common;
  }

  const failedState =
    processing.enrichment.status === "FAILED"
      ? processing.enrichment
      : processing.preprocessing;

  return [
    ...common,
    {
      label: "Failure",
      value:
        failedState.failureMessage ??
        processing.preprocessing.failedSteps[0] ??
        "Manual review required.",
    },
  ];
}

function workflowTitle(
  mode: ReturnType<typeof inventoryItemWorkflowMode>,
): string {
  if (mode === "error") return "Processing needs review";
  return "Processing status";
}
