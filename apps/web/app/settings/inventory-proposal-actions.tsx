"use client";

import { Button, Flex, Grid, Spinner, Text } from "@chakra-ui/react";
import { CheckIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { InventoryProposalActionState } from "./inventory-actions";

type ProposalAction = (
  state: InventoryProposalActionState,
  formData: FormData,
) => Promise<InventoryProposalActionState>;

const initialState: InventoryProposalActionState = {
  message: "",
  status: "idle",
};

export function InventoryProposalActions({
  approveAction,
  itemId,
  jobId,
  rejectAction,
}: {
  approveAction: ProposalAction;
  itemId: string;
  jobId: string;
  rejectAction: ProposalAction;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [pendingAction, setPendingAction] = useState<
    "approve" | "reject" | null
  >(null);
  const [pending, startTransition] = useTransition();

  function act(action: ProposalAction, intent: "approve" | "reject") {
    const formData = new FormData();
    formData.set("itemId", itemId);
    formData.set("jobId", jobId);
    setPendingAction(intent);
    setState(initialState);

    startTransition(async () => {
      const nextState = await action(state, formData);
      setState(nextState);
      setPendingAction(null);

      if (nextState.status === "success") {
        router.refresh();
      }
    });
  }

  return (
    <Grid gap="2">
      <Flex flexWrap="wrap" gap="2">
        <Button
          disabled={pending}
          onClick={() => act(approveAction, "approve")}
          size="sm"
          type="button"
        >
          {pending && pendingAction === "approve" ? (
            <Spinner size="sm" />
          ) : null}
          <CheckIcon size={16} />
          Approve proposal
        </Button>
        <Button
          disabled={pending}
          onClick={() => act(rejectAction, "reject")}
          size="sm"
          type="button"
          variant="outline"
        >
          {pending && pendingAction === "reject" ? <Spinner size="sm" /> : null}
          <XIcon size={16} />
          Reject proposal
        </Button>
      </Flex>
      <Text
        aria-live="polite"
        color={state.status === "error" ? "fg.error" : "fg.muted"}
        minH="5"
        fontSize="sm"
      >
        {state.message}
      </Text>
    </Grid>
  );
}
