"use client";

import {
  Button,
  Card,
  CloseButton,
  Dialog,
  Portal,
  Field,
  Flex,
  Input,
  Spinner,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import {
  itemDestructiveButton,
  itemButton,
  itemSecondaryButton,
} from "./inventory-item-button-styles";
import { ArrowRightLeftIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type React from "react";
import { useState, useTransition } from "react";
import { InventoryItemSelectField } from "./inventory-item-select-field";

const unplacedValue = "unplaced";

type StockActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export type InventoryStockMutationAction = (
  state: StockActionState,
  formData: FormData,
) => Promise<StockActionState>;

export type InventoryItemPlacementViewModel = {
  containerId: string | null;
  label: string;
  locationId: string | null;
  note: string | null;
  placementId: string;
  quantity: number;
};

export type InventoryStockContainerOption = {
  id: string;
  label: string;
};

export type InventoryStockLocationOption = {
  id: string;
  label: string;
};

type StockDialog = "add" | "move" | "remove" | null;

type InventoryItemStockCardProps = {
  addAction: InventoryStockMutationAction;
  containers: InventoryStockContainerOption[];
  locations: InventoryStockLocationOption[];
  legacyWhere: string;
  moveAction: InventoryStockMutationAction;
  placements: InventoryItemPlacementViewModel[];
  itemId: string;
  removeAction: InventoryStockMutationAction;
  totalQuantity: number;
};

const initialActionState: StockActionState = {
  message: "",
  status: "idle",
};

export function InventoryItemStockCard({
  addAction,
  containers,
  locations,
  legacyWhere,
  moveAction,
  placements,
  itemId,
  removeAction,
  totalQuantity,
}: InventoryItemStockCardProps) {
  const router = useRouter();
  const firstSource = placementValue({
    containerId: placements[0]?.containerId ?? null,
    locationId: placements[0]?.locationId ?? null,
  });
  const [dialog, setDialog] = useState<StockDialog>(null);
  const [source, setSource] = useState(firstSource);
  const [destination, setDestination] = useState(() =>
    defaultDestination(firstSource, containers, locations),
  );
  const [actionState, setActionState] = useState(initialActionState);
  const [pending, startTransition] = useTransition();
  const selectedPlacement =
    placements.find(
      (placement) =>
        placementValue({
          containerId: placement.containerId,
          locationId: placement.locationId,
        }) === source,
    ) ?? placements[0];
  const identicalMove = source === destination;

  function openDialog(nextDialog: Exclude<StockDialog, null>) {
    const nextSource = placementValue({
      containerId: placements[0]?.containerId ?? null,
      locationId: placements[0]?.locationId ?? null,
    });

    setSource(nextSource);
    setDestination(
      nextDialog === "add"
        ? nextSource
        : defaultDestination(nextSource, containers, locations),
    );
    setActionState(initialActionState);
    setDialog(nextDialog);
  }

  function closeDialog() {
    if (!pending) {
      setDialog(null);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (dialog === "move" && identicalMove) {
      setActionState({
        message: "Choose a different destination.",
        status: "error",
      });
      return;
    }

    const formData = new FormData(event.currentTarget);
    applyPlacementTargetFields(formData, dialog, {
      destination,
      source,
    });
    const action =
      dialog === "add"
        ? addAction
        : dialog === "move"
          ? moveAction
          : removeAction;

    startTransition(async () => {
      const nextState = await action(actionState, formData);

      setActionState(nextState);

      if (nextState.status === "success") {
        setDialog(null);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Card.Root size="sm" overflow="hidden" borderRadius="lg">
        <Card.Header
          gap="3"
          pb="4"
          borderBottomWidth="1px"
          borderColor="border"
          bg="bg.subtle"
        >
          <Card.Title as="h2">Stock</Card.Title>
          <Flex alignItems="baseline" gap="2">
            <chakra.strong
              fontWeight="semibold"
              fontSize="3xl"
              lineHeight="short"
              fontVariantNumeric="tabular-nums"
            >
              {totalQuantity}
            </chakra.strong>
            <Text color="fg.muted" fontSize="sm">
              Total quantity
            </Text>
          </Flex>
        </Card.Header>
        <Card.Body gap="4">
          {placements.length > 0 ? (
            <chakra.ul
              display="grid"
              divideY="1px"
              divideColor="border"
              borderWidth="1px"
              borderColor="border"
              borderRadius="md"
              fontSize="sm"
            >
              {placements.map((placement) => (
                <chakra.li
                  display="flex"
                  alignItems="start"
                  justifyContent="space-between"
                  gap="3"
                  px="3"
                  py="2"
                  key={placement.placementId}
                >
                  <chakra.span display="grid" minW="0" gap="0.5">
                    <chakra.span truncate fontWeight="medium">
                      {placement.label}
                    </chakra.span>
                    {placement.note ? (
                      <chakra.span truncate color="fg.muted" fontSize="xs">
                        Note: {placement.note}
                      </chakra.span>
                    ) : null}
                  </chakra.span>
                  <chakra.span
                    flexShrink={0}
                    color="fg.muted"
                    fontVariantNumeric="tabular-nums"
                  >
                    Qty {placement.quantity}
                  </chakra.span>
                </chakra.li>
              ))}
            </chakra.ul>
          ) : (
            <Text
              borderWidth="1px"
              borderColor="border"
              borderRadius="md"
              p="3"
              color="fg.muted"
              fontSize="sm"
            >
              No units recorded.
            </Text>
          )}

          <Text color="fg.muted" fontSize="xs">
            Legacy Where: {legacyWhere}
          </Text>

          <Flex gap="2" wrap="wrap">
            <Button
              {...itemButton}
              w="full"
              onClick={() => openDialog("add")}
              type="button"
            >
              <PlusIcon />
              Add units
            </Button>
            <Button
              {...itemSecondaryButton}
              flex="1 1 8rem"
              disabled={placements.length === 0}
              onClick={() => openDialog("move")}
              type="button"
            >
              <ArrowRightLeftIcon />
              Move units
            </Button>
            <Button
              {...itemDestructiveButton}
              flex="1 1 8rem"
              disabled={placements.length === 0}
              onClick={() => openDialog("remove")}
              type="button"
            >
              <MinusIcon />
              Remove units
            </Button>
          </Flex>

          {actionState.status === "success" ? (
            <Text aria-live="polite" color="fg.muted" fontSize="sm">
              {actionState.message}
            </Text>
          ) : null}
        </Card.Body>
      </Card.Root>

      <Dialog.Root
        lazyMount
        unmountOnExit
        placement="center"
        scrollBehavior="inside"
        onOpenChange={({ open }) => !open && closeDialog()}
        open={dialog !== null}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              maxW="min(calc(100vw - 2rem), 24rem)"
              display="flex"
              gap="4"
              p="4"
              maxH="calc(100svh - 2rem)"
              flexDirection="column"
            >
              <Dialog.Header p="0" pe="8" display="grid" gap="1">
                <Dialog.Title fontSize="md">{dialogTitle(dialog)}</Dialog.Title>
                <Dialog.Description fontSize="sm" color="fg.muted">
                  {dialogDescription(dialog)}
                </Dialog.Description>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="xs" aria-label="Close" />
              </Dialog.CloseTrigger>
              <chakra.form display="contents" onSubmit={handleSubmit}>
                <Dialog.Body minH="0" p="0">
                  <Stack gap="4">
                    <input name="itemId" type="hidden" value={itemId} />

                    {dialog === "move" || dialog === "remove" ? (
                      <InventoryItemSelectField
                        id={`inventory-stock-${dialog}-source`}
                        label="Source"
                        name="source"
                        onValueChange={setSource}
                        options={placements.map((placement) => ({
                          label: `${placement.label} (${placement.quantity} available)`,
                          value: placementValue({
                            containerId: placement.containerId,
                            locationId: placement.locationId,
                          }),
                        }))}
                        value={source}
                      />
                    ) : null}

                    {dialog === "add" || dialog === "move" ? (
                      <InventoryItemSelectField
                        id={`inventory-stock-${dialog}-destination`}
                        label="Destination"
                        name="destination"
                        onValueChange={setDestination}
                        options={destinationOptions(containers, locations)}
                        value={destination}
                      />
                    ) : null}

                    <Field.Root gap="2">
                      <Field.Label
                        htmlFor={`inventory-stock-${dialog}-quantity`}
                      >
                        Quantity
                      </Field.Label>
                      <Input
                        size="sm"
                        borderRadius="md"
                        defaultValue="1"
                        id={`inventory-stock-${dialog}-quantity`}
                        max={
                          dialog === "add"
                            ? undefined
                            : selectedPlacement?.quantity
                        }
                        min="1"
                        name="quantity"
                        required
                        step="1"
                        type="number"
                      />
                    </Field.Root>

                    {dialog === "move" && identicalMove ? (
                      <Text color="fg.error" fontSize="sm">
                        Choose a destination different from the source.
                      </Text>
                    ) : null}
                    {dialog === "remove" ? (
                      <Text color="fg.muted" fontSize="sm">
                        Removing the final unit archives this Item.
                      </Text>
                    ) : null}
                    {actionState.status === "error" ? (
                      <Text aria-live="polite" color="fg.error" fontSize="sm">
                        {actionState.message}
                      </Text>
                    ) : null}
                  </Stack>
                </Dialog.Body>
                <Dialog.Footer p="0">
                  <Button
                    {...itemSecondaryButton}
                    onClick={closeDialog}
                    type="button"
                  >
                    Cancel
                  </Button>
                  <Button
                    {...itemButton}
                    aria-busy={pending}
                    disabled={(dialog === "move" && identicalMove) || pending}
                    type="submit"
                    variant={dialog === "remove" ? "subtle" : "solid"}
                    colorPalette={dialog === "remove" ? "red" : "brand"}
                  >
                    {pending && <Spinner size="xs" />}
                    {dialogTitle(dialog)}
                  </Button>
                </Dialog.Footer>
              </chakra.form>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function destinationOptions(
  containers: InventoryStockContainerOption[],
  locations: InventoryStockLocationOption[],
) {
  return [
    { label: "Unplaced", value: unplacedValue },
    ...locations.map((location) => ({
      label: location.label,
      value: `location:${location.id}`,
    })),
    ...containers.map((container) => ({
      label: container.label,
      value: `container:${container.id}`,
    })),
  ];
}

function defaultDestination(
  source: string,
  containers: InventoryStockContainerOption[],
  locations: InventoryStockLocationOption[],
): string {
  return (
    destinationOptions(containers, locations).find(
      (option) => option.value !== source,
    )?.value ?? source
  );
}

function placementValue(target: {
  containerId: string | null;
  locationId: string | null;
}): string {
  if (target.containerId) {
    return `container:${target.containerId}`;
  }

  if (target.locationId) {
    return `location:${target.locationId}`;
  }

  return unplacedValue;
}

function parsePlacementValue(value: string): {
  containerId: string | null;
  locationId: string | null;
} {
  if (value.startsWith("container:")) {
    return {
      containerId: value.slice("container:".length),
      locationId: null,
    };
  }

  if (value.startsWith("location:")) {
    return {
      containerId: null,
      locationId: value.slice("location:".length),
    };
  }

  return {
    containerId: null,
    locationId: null,
  };
}

function applyPlacementTargetFields(
  formData: FormData,
  dialog: StockDialog,
  values: {
    destination: string;
    source: string;
  },
) {
  formData.delete("source");
  formData.delete("destination");

  if (dialog === "add") {
    setPlacementTargetFields(formData, parsePlacementValue(values.destination));
    return;
  }

  if (dialog === "move") {
    setPlacementTargetFields(
      formData,
      parsePlacementValue(values.source),
      "source",
    );
    setPlacementTargetFields(
      formData,
      parsePlacementValue(values.destination),
      "destination",
    );
    return;
  }

  if (dialog === "remove") {
    setPlacementTargetFields(formData, parsePlacementValue(values.source));
  }
}

function setPlacementTargetFields(
  formData: FormData,
  target: {
    containerId: string | null;
    locationId: string | null;
  },
  prefix?: "destination" | "source",
) {
  const containerField = prefix ? `${prefix}ContainerId` : "containerId";
  const locationField = prefix ? `${prefix}LocationId` : "locationId";

  if (target.containerId) {
    formData.set(containerField, target.containerId);
  } else {
    formData.delete(containerField);
  }

  if (target.locationId) {
    formData.set(locationField, target.locationId);
  } else {
    formData.delete(locationField);
  }
}

function dialogTitle(dialog: StockDialog): string {
  switch (dialog) {
    case "add":
      return "Add units";
    case "move":
      return "Move units";
    case "remove":
      return "Remove units";
    default:
      return "Update stock";
  }
}

function dialogDescription(dialog: StockDialog): string {
  switch (dialog) {
    case "add":
      return "Add copies of this Item to a destination.";
    case "move":
      return "Move copies between Placements.";
    case "remove":
      return "Remove copies from a Placement.";
    default:
      return "Update this Item's stock.";
  }
}
