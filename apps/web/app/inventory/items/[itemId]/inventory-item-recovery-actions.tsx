"use client";

import { Button, Grid, Spinner, Text } from "@chakra-ui/react";
import {
  itemButton,
  itemSecondaryButton,
} from "./inventory-item-button-styles";
import { PencilIcon, RefreshCwIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { InventoryActionState } from "../../action-state";

type RecoveryAction = (
  state: InventoryActionState,
  formData: FormData,
) => Promise<InventoryActionState>;

const initialState: InventoryActionState = { message: "", status: "idle" };

export function InventoryItemRecoveryActions({
  editHref,
  itemId,
  recovery,
  retryEnrichmentAction,
  retryPreprocessingAction,
}: {
  editHref: Route;
  itemId: string;
  recovery: "edit" | "retry-enrichment" | "retry-preprocessing";
  retryEnrichmentAction: RecoveryAction;
  retryPreprocessingAction: RecoveryAction;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();

  if (recovery === "edit") {
    return (
      <Button {...itemSecondaryButton} asChild>
        <Link href={editHref} scroll={false}>
          <PencilIcon />
          Edit source facts
        </Link>
      </Button>
    );
  }

  const action =
    recovery === "retry-preprocessing"
      ? retryPreprocessingAction
      : retryEnrichmentAction;
  const label =
    recovery === "retry-preprocessing"
      ? "Retry preprocessing"
      : "Retry enrichment";

  function retry() {
    const formData = new FormData();
    formData.set("itemId", itemId);
    setState(initialState);

    startTransition(async () => {
      const nextState = await action(state, formData);
      setState(nextState);

      if (nextState.status === "success") {
        router.refresh();
      }
    });
  }

  return (
    <Grid justifyItems="start" gap="2">
      <Button
        {...itemButton}
        aria-busy={pending}
        disabled={pending || pending}
        onClick={retry}
        type="button"
      >
        {pending && <Spinner size="xs" />}
        <RefreshCwIcon />
        {label}
      </Button>
      <Text
        aria-live="polite"
        fontSize="sm"
        color={state.status === "error" ? "fg.error" : "fg.muted"}
      >
        {state.message}
      </Text>
    </Grid>
  );
}
