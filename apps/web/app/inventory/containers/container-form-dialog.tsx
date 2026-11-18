"use client";

import { inventorySecondaryButton } from "../inventory-button-styles";
import {
  LockKeyholeIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useState, useTransition } from "react";
import {
  Box,
  Button,
  Dialog,
  Field,
  Input,
  InputGroup,
  NativeSelect,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import {
  ContainerDialog,
  ContainerDialogFooter,
  ContainerDialogHeader,
  containerDialogInput,
} from "./container-dialog";
import type {
  InventoryContainerActionState,
  InventoryContainerFormOption,
} from "../action-state";
import { initialInventoryContainerActionState } from "../action-state";

export type InventoryContainerCrudAction = (
  state: InventoryContainerActionState,
  formData: FormData,
) => Promise<InventoryContainerActionState>;

export type ContainerFormDialogState<
  TContainer extends InventoryContainerFormOption =
    InventoryContainerFormOption,
> =
  | { mode: "create"; container: null; initialName?: string }
  | { mode: "edit"; container: TContainer };

type ContainerFormDialogProps<
  TContainer extends InventoryContainerFormOption =
    InventoryContainerFormOption,
> = {
  action: InventoryContainerCrudAction;
  dialog: ContainerFormDialogState<TContainer> | null;
  generatedReferenceId?: string;
  finalFocusEl?: () => HTMLElement | null;
  onDelete?: () => void;
  onDone: (state: InventoryContainerActionState) => void;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  open: boolean;
  visualPresets: Array<{
    id: string;
    isDefault: boolean;
    name: string;
  }>;
};

export function ContainerFormDialog<
  TContainer extends InventoryContainerFormOption =
    InventoryContainerFormOption,
>({
  action,
  dialog,
  generatedReferenceId,
  finalFocusEl,
  onDelete,
  onDone,
  onOpenChange,
  onClosed,
  open,
  visualPresets,
}: ContainerFormDialogProps<TContainer>) {
  const [state, setState] = useState(initialInventoryContainerActionState);
  const [isPending, startTransition] = useTransition();
  const container = dialog?.container ?? null;
  const isEdit = dialog?.mode === "edit";
  const initialName = dialog?.mode === "create" ? dialog.initialName : "";
  const referenceId = container?.referenceId ?? generatedReferenceId ?? "";
  const defaultVisualPresetId =
    container?.visualPresetKey ??
    visualPresets.find((preset) => preset.isDefault)?.id ??
    visualPresets[0]?.id;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      const nextState = await action(state, formData);

      setState(nextState);

      if (nextState.status === "success") {
        form.reset();
        onDone(nextState);
      }
    });
  }

  return (
    <ContainerDialog
      onOpenChange={onOpenChange}
      open={open}
      onClosed={onClosed}
      finalFocusEl={finalFocusEl}
    >
      <ContainerDialogHeader>
        <Dialog.Title fontSize="md" lineHeight="1" fontWeight="medium">
          {isEdit ? "Edit container" : "Create container"}
        </Dialog.Title>
        <Dialog.Description textStyle="sm" color="fg.muted">
          {isEdit
            ? "Update the saved container record."
            : "Add a bin, tote, drawer, or box."}
        </Dialog.Description>
      </ContainerDialogHeader>
      <chakra.form display="contents" onSubmit={handleSubmit}>
        <Box minH="0" flex="1" overflowY="auto">
          <Stack gap="5">
            {isEdit && (
              <input
                defaultValue={container?.id}
                name="containerId"
                type="hidden"
              />
            )}
            <Field.Root gap="2">
              <Field.Label htmlFor="container-name">Name</Field.Label>
              <Input
                {...containerDialogInput}
                defaultValue={container?.name ?? initialName ?? ""}
                id="container-name"
                name="containerName"
                required
              />
            </Field.Root>
            <Field.Root gap="2">
              <Field.Label htmlFor="container-reference-id">
                Reference ID
              </Field.Label>
              <InputGroup
                endElement={
                  <LockKeyholeIcon
                    size={14}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                }
              >
                <Input
                  {...containerDialogInput}
                  pe="8"
                  fontFamily="mono"
                  disabled
                  id="container-reference-id"
                  readOnly
                  value={referenceId}
                />
              </InputGroup>
            </Field.Root>
            <Field.Root gap="2">
              <Field.Label htmlFor="container-location">Location</Field.Label>
              <Input
                {...containerDialogInput}
                defaultValue={container?.locationName ?? ""}
                id="container-location"
                name="locationName"
                placeholder="Garage shelf A"
              />
            </Field.Root>
            <Field.Root gap="2">
              <Field.Label htmlFor="container-size-liters">
                Size liters
              </Field.Label>
              <Input
                {...containerDialogInput}
                defaultValue={container?.sizeLiters ?? ""}
                id="container-size-liters"
                min="0.1"
                name="sizeLiters"
                step="0.1"
                type="number"
              />
            </Field.Root>
            <Field.Root gap="2" required>
              <Field.Label htmlFor="container-visual-preset">
                Container image
              </Field.Label>
              <NativeSelect.Root size="sm">
                <NativeSelect.Field
                  {...containerDialogInput}
                  id="container-visual-preset"
                  aria-describedby="container-visual-preset-description"
                  defaultValue={defaultVisualPresetId ?? ""}
                  name="visualPresetKey"
                >
                  <option value="" disabled>
                    Choose container image
                  </option>
                  {visualPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                      {preset.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Field.HelperText
                id="container-visual-preset-description"
                fontSize="sm"
              >
                Choose a repository catalog image preset.
              </Field.HelperText>
            </Field.Root>
            <Text
              aria-live="polite"
              textStyle="sm"
              color={state.status === "error" ? "fg.error" : "fg.muted"}
            >
              {state.message}
            </Text>
          </Stack>
        </Box>
        <ContainerDialogFooter>
          {isEdit && onDelete ? (
            <Button
              size="sm"
              css={{ "@media (min-width: 40rem)": { mr: "auto" } }}
              onClick={onDelete}
              type="button"
              variant="subtle"
              colorPalette="red"
            >
              <Trash2Icon />
              Delete container
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            type="button"
            {...inventorySecondaryButton}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            aria-busy={isPending}
            loading={isPending}
            type="submit"
          >
            {isEdit ? <PencilIcon /> : <PlusIcon />}
            {isEdit ? "Save changes" : "Create container"}
          </Button>
        </ContainerDialogFooter>
      </chakra.form>
    </ContainerDialog>
  );
}
