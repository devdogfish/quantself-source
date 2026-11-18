"use client";

import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Portal,
  Field,
  Grid,
  Input,
  Spinner,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import {
  itemButton,
  itemDestructiveButton,
  itemSecondaryButton,
} from "./inventory-item-button-styles";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import type React from "react";
import { useRef, useState, useTransition } from "react";
import { InventoryItemSelectField } from "./inventory-item-select-field";

import {
  formatInventoryAcquisitionSourceLabel,
  formatInventoryCategoryLabel,
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_KINDS,
  INVENTORY_ITEM_STATUSES,
} from "@/lib/inventory-client-contract";

const emptySelectValue = "__none";

export type InventoryItemMutationState = {
  status: "idle" | "success" | "error";
  message: string;
};

export type InventoryItemMutationAction = (
  state: InventoryItemMutationState,
  formData: FormData,
) => Promise<InventoryItemMutationState>;

export type InventoryItemEditableAsset = {
  key: `image:${string}` | `audio:${string}` | `asset:${string}`;
  kind: "image" | "audio" | "asset";
  mimeType: string | null;
  name: string;
  sizeBytes: number | null;
  url: string;
};

export type InventoryItemEditableViewModel = {
  acquisitionSource: string | null;
  aliases: string[];
  archivedAt?: string | null;
  assets: InventoryItemEditableAsset[];
  captureText: string | null;
  category: string | null;
  containerId: string | null;
  costCents: number | null;
  costCurrency: string;
  id: string;
  importance: string;
  kind: string;
  note: string | null;
  status: string;
  tags: string[];
  title: string | null;
};

export type InventoryItemContainerOption = {
  id: string;
  label: string;
};

type InventoryItemSelectDraft = {
  acquisitionSource: string;
  category: string;
  importance: string;
  kind: string;
  status: string;
};

type InventoryItemControlsProps = {
  archiveAction?: InventoryItemMutationAction;
  containers: InventoryItemContainerOption[];
  deleteAction: InventoryItemMutationAction;
  initialEditOpen?: boolean;
  item: InventoryItemEditableViewModel;
  restoreAction?: InventoryItemMutationAction;
  returnTo: Route;
  updateAction: InventoryItemMutationAction;
};

const initialMutationState: InventoryItemMutationState = {
  message: "",
  status: "idle",
};

export function InventoryItemControls({
  archiveAction,
  deleteAction,
  initialEditOpen = false,
  item,
  restoreAction,
  returnTo,
  updateAction,
}: InventoryItemControlsProps) {
  const router = useRouter();
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [editOpen, setEditOpen] = useState(initialEditOpen);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectDraft, setSelectDraft] = useState<InventoryItemSelectDraft>(() =>
    selectDraftFromItem(item),
  );
  const [updateState, setUpdateState] = useState(initialMutationState);
  const [deleteState, setDeleteState] = useState(initialMutationState);
  const [archiveState, setArchiveState] = useState(initialMutationState);
  const [updatePending, startUpdateTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();
  const [archivePending, startArchiveTransition] = useTransition();

  function resetEditDraft() {
    formRef.current?.reset();
    setSelectDraft(selectDraftFromItem(item));
    setUpdateState(initialMutationState);
  }

  function updateSelectDraft(
    name: keyof InventoryItemSelectDraft,
    value: string,
  ) {
    setSelectDraft((current) => ({ ...current, [name]: value }));
  }

  function handleEditOpenChange(open: boolean) {
    setEditOpen(open);

    if (!open) {
      resetEditDraft();
    }
  }

  function openEditor() {
    resetEditDraft();
    setEditOpen(true);
  }

  function handleUpdate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);

    startUpdateTransition(async () => {
      const nextState = await updateAction(updateState, formData);

      setUpdateState(nextState);

      if (nextState.status === "success") {
        setEditOpen(false);
        resetEditDraft();
        router.refresh();
      }
    });
  }

  function handleDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);

    startDeleteTransition(async () => {
      const nextState = await deleteAction(deleteState, formData);

      setDeleteState(nextState);

      if (nextState.status === "success") {
        setDeleteOpen(false);
        router.push(returnTo);
        router.refresh();
      }
    });
  }

  function handleArchiveToggle() {
    const formData = new FormData();
    formData.set("itemId", item.id);
    const action = item.archivedAt ? restoreAction : archiveAction;

    if (!action) {
      return;
    }

    startArchiveTransition(async () => {
      const nextState = await action(archiveState, formData);

      setArchiveState(nextState);

      if (nextState.status === "success") {
        router.push(item.archivedAt ? returnTo : "/inventory/archive");
        router.refresh();
      }
    });
  }

  return (
    <>
      <Grid
        aria-label="Item actions"
        w="full"
        gridTemplateColumns="repeat(auto-fit, minmax(5.25rem, 1fr))"
        gap="2"
        css={{
          "@media (width >= 40rem)": {
            display: "flex",
            width: "auto",
            flexWrap: "wrap",
            justifyContent: "end",
          },
        }}
        role="group"
      >
        {!item.archivedAt ? (
          <Button {...itemSecondaryButton} onClick={openEditor} type="button">
            <PencilIcon />
            Edit
          </Button>
        ) : null}
        {archiveAction && restoreAction ? (
          <Button
            {...itemSecondaryButton}
            aria-busy={archivePending}
            disabled={archivePending}
            onClick={handleArchiveToggle}
            type="button"
          >
            {archivePending && <Spinner size="xs" />}
            {item.archivedAt ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {item.archivedAt ? "Restore" : "Archive"}
          </Button>
        ) : null}
        <Button
          {...itemDestructiveButton}
          onClick={() => {
            setDeleteState(initialMutationState);
            setDeleteOpen(true);
          }}

          type="button"
        >
          <Trash2Icon />
          Delete
        </Button>
      </Grid>
      {archiveState.status === "error" ? (
        <Text aria-live="polite" color="fg.error" fontSize="sm">
          {archiveState.message}
        </Text>
      ) : null}

      <Dialog.Root
        lazyMount
        unmountOnExit
        placement="center"
        scrollBehavior="inside"
        onOpenChange={({ open }) => handleEditOpenChange(open)}
        open={editOpen}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              display="flex"
              gap="4"
              p="4"
              maxH="calc(100svh - 2rem)"
              flexDirection="column"
              css={{ "@media (width >= 40rem)": { maxWidth: "56rem" } }}
            >
              <Dialog.Header p="0" pe="8" display="grid" gap="1">
                <Dialog.Title fontSize="md">Edit item</Dialog.Title>
                <Dialog.Description fontSize="sm" color="fg.muted">
                  Update the item fields. Manage media in the Images and Media
                  sections.
                </Dialog.Description>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="xs" aria-label="Close" />
              </Dialog.CloseTrigger>
              <Box asChild display="contents">
                <form onSubmit={handleUpdate} ref={formRef}>
                  <Dialog.Body minH="0" p="0">
                    <Stack gap="4">
                      <input name="itemId" type="hidden" value={item.id} />

                      <Grid
                        gap="4"
                        css={{
                          "@media (width >= 40rem)": {
                            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          },
                        }}
                      >
                        <Field.Root gap="2">
                          <Field.Label htmlFor="inventory-item-title">
                            Title
                          </Field.Label>
                          <Input
                            size="sm"
                            borderRadius="md"
                            defaultValue={item.title ?? ""}
                            id="inventory-item-title"
                            name="title"
                          />
                        </Field.Root>
                        <InventoryItemSelectField
                          id="inventory-item-kind"
                          label="Type"
                          name="kind"
                          onValueChange={(value) =>
                            updateSelectDraft("kind", value)
                          }
                          options={INVENTORY_ITEM_KINDS.map((value) => ({
                            label:
                              value === "GROUP" ? "Item group" : "Single item",
                            value,
                          }))}
                          value={selectDraft.kind}
                        />
                        <InventoryItemSelectField
                          id="inventory-item-status"
                          label="Status"
                          name="status"
                          onValueChange={(value) =>
                            updateSelectDraft("status", value)
                          }
                          options={INVENTORY_ITEM_STATUSES.map((value) => ({
                            label: sentenceCase(value),
                            value,
                          }))}
                          value={selectDraft.status}
                        />
                        <InventoryItemSelectField
                          id="inventory-item-importance"
                          label="Importance"
                          name="importance"
                          onValueChange={(value) =>
                            updateSelectDraft("importance", value)
                          }
                          options={INVENTORY_IMPORTANCE_VALUES.map((value) => ({
                            label: sentenceCase(value),
                            value,
                          }))}
                          value={selectDraft.importance}
                        />
                        <InventoryItemSelectField
                          id="inventory-item-category"
                          label="Category"
                          name="category"
                          onValueChange={(value) =>
                            updateSelectDraft("category", value)
                          }
                          options={[
                            { label: "None", value: emptySelectValue },
                            ...INVENTORY_CATEGORY_VALUES.map((value) => ({
                              label:
                                formatInventoryCategoryLabel(value) ??
                                sentenceCase(value),
                              value,
                            })),
                          ]}
                          value={selectDraft.category}
                        />
                        <InventoryItemSelectField
                          id="inventory-item-acquisition-source"
                          label="Acquisition source"
                          name="acquisitionSource"
                          onValueChange={(value) =>
                            updateSelectDraft("acquisitionSource", value)
                          }
                          options={[
                            { label: "None", value: emptySelectValue },
                            ...INVENTORY_ACQUISITION_SOURCE_VALUES.map(
                              (value) => ({
                                label:
                                  formatInventoryAcquisitionSourceLabel(
                                    value,
                                  ) ?? sentenceCase(value),
                                value,
                              }),
                            ),
                          ]}
                          value={selectDraft.acquisitionSource}
                        />
                        <Field.Root gap="2">
                          <Field.Label htmlFor="inventory-item-estimated-value">
                            Estimated value ({item.costCurrency})
                          </Field.Label>
                          <Input
                            size="sm"
                            borderRadius="md"
                            defaultValue={
                              item.costCents === null
                                ? ""
                                : (item.costCents / 100).toFixed(2)
                            }
                            id="inventory-item-estimated-value"
                            min="0"
                            name="estimatedValue"
                            step="0.01"
                            type="number"
                          />
                        </Field.Root>
                        <Field.Root gap="2">
                          <Field.Label htmlFor="inventory-item-tags">
                            Tags
                          </Field.Label>
                          <Input
                            size="sm"
                            borderRadius="md"
                            defaultValue={item.tags.join(", ")}
                            id="inventory-item-tags"
                            name="tags"
                            placeholder="travel, documents"
                          />
                        </Field.Root>
                        <Field.Root gap="2">
                          <Field.Label htmlFor="inventory-item-aliases">
                            Aliases
                          </Field.Label>
                          <Input
                            size="sm"
                            borderRadius="md"
                            defaultValue={item.aliases.join(", ")}
                            id="inventory-item-aliases"
                            name="aliases"
                            placeholder="Other names, comma separated"
                          />
                        </Field.Root>
                      </Grid>

                      <Field.Root gap="2">
                        <Field.Label htmlFor="inventory-item-note">
                          Notes
                        </Field.Label>
                        <Textarea
                          size="sm"
                          borderRadius="md"
                          defaultValue={item.note ?? ""}
                          id="inventory-item-note"
                          name="note"
                        />
                      </Field.Root>
                      <Field.Root gap="2">
                        <Field.Label htmlFor="inventory-item-capture-text">
                          Capture text
                        </Field.Label>
                        <Textarea
                          size="sm"
                          borderRadius="md"
                          defaultValue={item.captureText ?? ""}
                          id="inventory-item-capture-text"
                          name="captureText"
                        />
                      </Field.Root>

                      <Text
                        aria-live="polite"
                        fontSize="sm"
                        color={
                          updateState.status === "error"
                            ? "fg.error"
                            : "fg.muted"
                        }
                      >
                        {updateState.message}
                      </Text>
                    </Stack>
                  </Dialog.Body>
                  <Dialog.Footer p="0">
                    <Button
                      {...itemSecondaryButton}
                      onClick={() => handleEditOpenChange(false)}
                      type="button"
                    >
                      Cancel
                    </Button>
                    <Button
                      {...itemButton}
                      aria-busy={updatePending}
                      disabled={updatePending}
                      type="submit"
                    >
                      {updatePending && <Spinner size="xs" />}
                      <PencilIcon />
                      Save changes
                    </Button>
                  </Dialog.Footer>
                </form>
              </Box>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root
        initialFocusEl={() => deleteCancelRef.current}
        lazyMount
        placement="center"
        role="alertdialog"
        size="sm"
        unmountOnExit
        onOpenChange={({ open }) => {
          setDeleteOpen(open);

          if (!open) {
            setDeleteState(initialMutationState);
          }
        }}
        open={deleteOpen}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content gap="4" p="4">
              <Dialog.Header p="0" display="grid" gap="2">
                <Grid
                  boxSize="10"
                  placeItems="center"
                  borderRadius="full"
                  bg="bg.error"
                  color="fg.error"
                >
                  <Trash2Icon />
                </Grid>
                <Dialog.Title>Delete item?</Dialog.Title>
                <Dialog.Description>
                  This permanently deletes the item and all attached files. This
                  cannot be undone.
                </Dialog.Description>
              </Dialog.Header>
              <form onSubmit={handleDelete}>
                <input name="itemId" type="hidden" value={item.id} />
                <Text
                  aria-live="polite"
                  fontSize="sm"
                  color="fg.error"
                  srOnly={deleteState.status !== "error"}
                >
                  {deleteState.message}
                </Text>
                <Dialog.Footer p="0">
                  <Dialog.CloseTrigger asChild>
                    <Button
                      {...itemSecondaryButton}
                      ref={deleteCancelRef}
                      type="button"
                    >
                      Cancel
                    </Button>
                  </Dialog.CloseTrigger>
                  <Button
                    {...itemDestructiveButton}
                    aria-busy={deletePending}
                    disabled={deletePending}
                    type="submit"
                  >
                    {deletePending && <Spinner size="xs" />}
                    <Trash2Icon />
                    Delete item
                  </Button>
                </Dialog.Footer>
              </form>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function selectDraftFromItem(
  item: InventoryItemEditableViewModel,
): InventoryItemSelectDraft {
  return {
    acquisitionSource: item.acquisitionSource ?? emptySelectValue,
    category: item.category ?? emptySelectValue,
    importance: item.importance,
    kind: item.kind,
    status: item.status,
  };
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ").toLowerCase();

  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
