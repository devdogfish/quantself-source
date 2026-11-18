"use client";

import { inventorySecondaryButton } from "../../inventory-button-styles";
import {
  ArrowRightIcon,
  DownloadIcon,
  PrinterIcon,
  SearchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type React from "react";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Input,
  InputGroup,
  Text,
} from "@chakra-ui/react";
import {
  ContainerDialog,
  ContainerDialogFooter,
  ContainerDialogHeader,
  containerDialogInput,
} from "../container-dialog";
import { detailAction } from "../container-layout";

type MutationState = {
  status: "idle" | "success" | "error";
  message: string;
};

type MoveAction = (
  state: MutationState,
  formData: FormData,
) => Promise<MutationState>;

type MoveCandidate = {
  id: string;
  title: string;
  where: string;
};

const initialState: MutationState = { message: "", status: "idle" };
const labelOptions = [
  {
    description: "Selected default. Clean title-first layout.",
    design: "editorial",
    name: "A1 - Clean",
  },
  {
    description: "Full-width QR with half the vertical whitespace.",
    design: "equipment-tag-aligned",
    name: "C - Full QR",
  },
] as const;

export function ContainerRetrievalActions({
  candidates,
  children,
  containerId,
  labelUrl,
  moveAction,
}: {
  candidates: MoveCandidate[];
  children?: React.ReactNode;
  containerId: string;
  labelUrl: string;
  moveAction: MoveAction;
}) {
  const router = useRouter();
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [state, setState] = useState(initialState);
  const [isPending, startTransition] = useTransition();
  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return candidates;
    }

    return candidates.filter((item) =>
      `${item.title} ${item.where}`.toLowerCase().includes(normalized),
    );
  }, [candidates, query]);

  function reset() {
    setQuery("");
    setSelectedIds([]);
    setState(initialState);
  }

  function toggleItem(itemId: string, checked: boolean) {
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, itemId])]
        : current.filter((id) => id !== itemId),
    );
  }

  function moveItems() {
    const formData = new FormData();
    formData.set("containerId", containerId);

    for (const itemId of selectedIds) {
      formData.append("itemIds", itemId);
    }

    startTransition(async () => {
      const nextState = await moveAction(state, formData);
      setState(nextState);

      if (nextState.status === "success") {
        setMoveOpen(false);
        reset();
        router.refresh();
      }
    });
  }

  return (
    <>
      {children}
      <Button
        {...detailAction}
        ref={labelTriggerRef}
        onClick={() => setLabelOpen(true)}
        type="button"
        {...inventorySecondaryButton}
        bg="bg"
      >
        <PrinterIcon />
        Label PDF
      </Button>
      <Button
        {...detailAction}
        ref={moveTriggerRef}
        colorPalette="brand"
        variant="solid"
        disabled={candidates.length === 0}
        onClick={() => setMoveOpen(true)}
        type="button"
      >
        <ArrowRightIcon />
        Move items here
      </Button>

      <ContainerDialog
        onOpenChange={setLabelOpen}
        open={labelOpen}
        finalFocusEl={() => labelTriggerRef.current}
      >
        <ContainerDialogHeader>
          <Dialog.Title fontSize="md" lineHeight="1" fontWeight="medium">
            Download label PDF
          </Dialog.Title>
          <Dialog.Description textStyle="sm" color="fg.muted">
            Choose a printable container label.
          </Dialog.Description>
        </ContainerDialogHeader>
        <Box minH="0" flex="1" overflowY="auto">
          <Box
            as="ul"
            borderWidth="1px"
            borderRadius="l2"
            divideY="1px"
            divideColor="border"
          >
            {labelOptions.map((option) => (
              <Flex
                as="li"
                align="center"
                justify="space-between"
                gap="4"
                p="3"
                key={option.design}
              >
                <Box as="span" minW="0">
                  <Box
                    as="span"
                    display="block"
                    fontWeight="medium"
                    textStyle="sm"
                  >
                    {option.name}
                  </Box>
                  <Box
                    as="span"
                    display="block"
                    color="fg.muted"
                    textStyle="xs"
                  >
                    {option.description}
                  </Box>
                </Box>
                <Button asChild size="sm" {...inventorySecondaryButton}>
                  <a
                    data-label-design={option.design}
                    download
                    href={`${labelUrl}?design=${option.design}&download=1`}
                  >
                    <DownloadIcon />
                    Download
                  </a>
                </Button>
              </Flex>
            ))}
          </Box>
        </Box>
        <ContainerDialogFooter>
          <Button
            size="sm"
            onClick={() => setLabelOpen(false)}
            type="button"
            {...inventorySecondaryButton}
          >
            Done
          </Button>
        </ContainerDialogFooter>
      </ContainerDialog>

      <ContainerDialog
        finalFocusEl={() => moveTriggerRef.current}
        onOpenChange={(nextOpen) => {
          setMoveOpen(nextOpen);

          if (!nextOpen) {
            reset();
          }
        }}
        open={moveOpen}
      >
        <ContainerDialogHeader>
          <Dialog.Title fontSize="md" lineHeight="1" fontWeight="medium">
            Move items here
          </Dialog.Title>
          <Dialog.Description textStyle="sm" color="fg.muted">
            Select active items. The entire move succeeds or nothing changes.
          </Dialog.Description>
        </ContainerDialogHeader>
        <Grid minH="0" flex="1" overflowY="auto" gap="3">
          <InputGroup
            startElement={<SearchIcon size={16} aria-hidden="true" />}
          >
            <Input
              {...containerDialogInput}
              ps="8"
              aria-label="Search movable inventory"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search items"
              value={query}
            />
          </InputGroup>

          {filteredCandidates.length > 0 ? (
            <Box
              as="ul"
              borderWidth="1px"
              borderRadius="l2"
              divideY="1px"
              divideColor="border"
            >
              {filteredCandidates.map((item) => {
                const checked = selectedIds.includes(item.id);

                return (
                  <li key={item.id}>
                    <Checkbox.Root
                      display="flex"
                      cursor="pointer"
                      alignItems="center"
                      gap="3"
                      p="3"
                      checked={checked}
                      onCheckedChange={({ checked: nextChecked }) =>
                        toggleItem(item.id, nextChecked === true)
                      }
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control flexShrink={0}>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Checkbox.Label minW="0">
                        <Box
                          as="span"
                          display="block"
                          truncate
                          fontWeight="medium"
                          textStyle="sm"
                        >
                          {item.title}
                        </Box>
                        <Box
                          as="span"
                          display="block"
                          truncate
                          color="fg.muted"
                          textStyle="xs"
                        >
                          {item.where}
                        </Box>
                      </Checkbox.Label>
                    </Checkbox.Root>
                  </li>
                );
              })}
            </Box>
          ) : (
            <Text
              borderRadius="l2"
              borderWidth="1px"
              borderStyle="dashed"
              p="5"
              textAlign="center"
              color="fg.muted"
              textStyle="sm"
            >
              No movable items match.
            </Text>
          )}

          {state.status === "error" ? (
            <Text aria-live="polite" color="fg.error" textStyle="sm">
              {state.message}
            </Text>
          ) : null}
        </Grid>
        <ContainerDialogFooter>
          <Button
            size="sm"
            onClick={() => setMoveOpen(false)}
            type="button"
            {...inventorySecondaryButton}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            loading={isPending}
            aria-busy={isPending}
            disabled={selectedIds.length === 0 || isPending}
            onClick={moveItems}
            type="button"
          >
            Move {selectedIds.length || ""} item
            {selectedIds.length === 1 ? "" : "s"}
          </Button>
        </ContainerDialogFooter>
      </ContainerDialog>
    </>
  );
}
