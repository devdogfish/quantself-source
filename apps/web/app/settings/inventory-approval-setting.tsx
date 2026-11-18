"use client";

import { Box, Button, Checkbox, Spinner, Text, chakra } from "@chakra-ui/react";
import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { InventoryProposalActionState } from "./inventory-actions";

type SettingAction = (
  state: InventoryProposalActionState,
  formData: FormData,
) => Promise<InventoryProposalActionState>;

const initialState: InventoryProposalActionState = {
  message: "",
  status: "idle",
};

export function InventoryApprovalSetting({
  action,
  autoApproveFuture,
}: {
  action: SettingAction;
  autoApproveFuture: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(autoApproveFuture);
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const nextState = await action(state, formData);
      setState(nextState);
      if (nextState.status === "success") {
        router.refresh();
      }
    });
  }

  return (
    <chakra.form display="grid" gap="4" onSubmit={submit}>
      <Checkbox.Root
        alignItems="start"
        checked={enabled}
        fontSize="sm"
        name="autoApproveFuture"
        onCheckedChange={(event) => setEnabled(event.checked === true)}
      >
        <Checkbox.HiddenInput />
        <Checkbox.Control mt="1" />
        <Checkbox.Label>
          <Box as="span" display="grid" gap="1">
            <Box as="span" fontWeight="medium">
              Auto-approve future inventory enrichments
            </Box>
            <Box as="span" color="fg.muted">
              New enrichments completed while enabled apply automatically.
              Existing pending proposals stay pending.
            </Box>
          </Box>
        </Checkbox.Label>
      </Checkbox.Root>
      <Button justifySelf="start" disabled={pending} type="submit">
        {pending ? <Spinner size="sm" /> : null}
        <CheckIcon size={16} />
        Save
      </Button>
      <Text
        aria-live="polite"
        color={state.status === "error" ? "fg.error" : "fg.muted"}
        minH="5"
        fontSize="sm"
      >
        {state.message}
      </Text>
    </chakra.form>
  );
}
