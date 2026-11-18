"use client";

import { inventorySecondaryButton } from "../../inventory-button-styles";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import type React from "react";
import { useRef, useState, useTransition } from "react";
import { Button, Dialog, Grid, Text } from "@chakra-ui/react";
import {
  ContainerDialog,
  ContainerDialogFooter,
  ContainerDialogHeader,
} from "../container-dialog";
import { detailAction } from "../container-layout";
import type { InventoryContainerFormOption } from "../../action-state";
import { initialInventoryContainerActionState } from "../../action-state";
import {
  ContainerFormDialog,
  type InventoryContainerCrudAction,
} from "../container-form-dialog";

type ContainerDetailEditProps = {
  container: InventoryContainerFormOption & { itemCount: number };
  deleteAction: InventoryContainerCrudAction;
  updateAction: InventoryContainerCrudAction;
  visualPresets: Array<{
    id: string;
    isDefault: boolean;
    name: string;
  }>;
};

export function ContainerDetailEdit({
  container,
  deleteAction,
  updateAction,
  visualPresets,
}: ContainerDetailEditProps) {
  const router = useRouter();
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [renderEdit, setRenderEdit] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteState, setDeleteState] = useState(
    initialInventoryContainerActionState,
  );
  const [isDeleting, startDeleteTransition] = useTransition();

  function openEdit() {
    setRenderEdit(true);
    setEditOpen(true);
  }

  function openDelete() {
    setDeleteState(initialInventoryContainerActionState);
    setEditOpen(false);
    setDeleteOpen(true);
  }

  function deleteContainer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startDeleteTransition(async () => {
      const nextState = await deleteAction(deleteState, formData);
      setDeleteState(nextState);

      if (nextState.status === "success") {
        setDeleteOpen(false);
        router.replace("/inventory/containers");
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button
        {...detailAction}
        ref={editTriggerRef}
        onClick={openEdit}
        type="button"
        {...inventorySecondaryButton}
        bg="bg"
      >
        <PencilIcon />
        Edit
      </Button>

      <ContainerFormDialog
        action={updateAction}
        dialog={renderEdit ? { mode: "edit", container } : null}
        key={`edit-${container.id}`}
        onDelete={openDelete}
        finalFocusEl={() => editTriggerRef.current}
        onDone={() => {
          setEditOpen(false);
          router.refresh();
        }}
        onOpenChange={setEditOpen}
        onClosed={() => setRenderEdit(false)}
        open={editOpen}
        visualPresets={visualPresets}
      />

      <ContainerDialog
        alert
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        initialFocusEl={() => cancelDeleteRef.current}
        finalFocusEl={() => editTriggerRef.current}
      >
        <ContainerDialogHeader>
          <Grid
            boxSize="10"
            placeItems="center"
            borderRadius="full"
            bg="red.subtle"
            color="red.fg"
          >
            <Trash2Icon size={18} aria-hidden="true" />
          </Grid>
          <Dialog.Title fontSize="md" fontWeight="medium">
            Delete container?
          </Dialog.Title>
          <Dialog.Description textStyle="sm" color="fg.muted">
            {container.itemCount > 0
              ? `${container.itemCount} assigned item${container.itemCount === 1 ? "" : "s"} will become unplaced. Capture defaults using this container clear. Item text label history stays.`
              : "This removes the empty container. Capture defaults using it clear."}
          </Dialog.Description>
        </ContainerDialogHeader>
        <form onSubmit={deleteContainer}>
          <input name="containerId" type="hidden" value={container.id} />
          <Text
            aria-live="polite"
            textStyle="sm"
            color="fg.error"
            mb={deleteState.status === "error" ? "4" : undefined}
          >
            {deleteState.message}
          </Text>
          <ContainerDialogFooter>
            <Dialog.CloseTrigger asChild position="static">
              <Button
                ref={cancelDeleteRef}
                size="sm"
                {...inventorySecondaryButton}
                type="button"
              >
                Cancel
              </Button>
            </Dialog.CloseTrigger>
            <Button
              aria-busy={isDeleting}
              loading={isDeleting}
              size="sm"
              type="submit"
              variant="subtle"
              colorPalette="red"
            >
              <Trash2Icon aria-hidden="true" />
              Delete
            </Button>
          </ContainerDialogFooter>
        </form>
      </ContainerDialog>
    </>
  );
}
