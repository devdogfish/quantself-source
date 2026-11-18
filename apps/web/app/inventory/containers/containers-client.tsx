"use client";

import { inventorySecondaryButton } from "../inventory-button-styles";
import { Box, Flex, IconButton, SegmentGroup, Text } from "@chakra-ui/react";
import { Grid2X2Icon, PlusIcon, Rows3Icon, ScanLineIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateInventoryContainerReferenceId } from "@/lib/inventory-container-reference";
import { BentoView } from "./bento-view";
import {
  type ContainerView,
  readContainerPreferences,
  writeContainerPreferences,
} from "./container-preferences";
import { ContainerSearch } from "./container-search";
import type { ContainerDebugRevealState } from "./container-visual";
import { countFilteredItems, filterContainerItems } from "./filter-items";
import {
  ContainerFormDialog,
  type ContainerFormDialogState,
  type InventoryContainerCrudAction,
} from "./container-form-dialog";
import { SearchPill } from "./search-pill";
import { containerPage, controlSurface, listHeader } from "./container-layout";
import { ScrollStack } from "./scroll-stack";
import type { ContainerShelf } from "./types";

const headerAction = {
  boxSize: "10",
  minW: "10",
  p: "0",
  borderRadius: "l2",
  css: { "& svg": { boxSize: "4" } },
} as const;

export function ContainersClient({
  containers,
  createAction,
  debugBounds = false,
  layoutSeed,
  urlView,
  visualPresets,
}: {
  containers: ContainerShelf[];
  createAction: InventoryContainerCrudAction;
  debugBounds?: boolean;
  layoutSeed: string;
  urlView?: ContainerView;
  visualPresets: Array<{
    id: string;
    isDefault: boolean;
    name: string;
  }>;
}) {
  const router = useRouter();
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const [sessionLayoutSeed] = useState(layoutSeed);
  const [view, setView] = useState<ContainerView>(urlView ?? "scroll");
  const [activeId, setActiveId] = useState(containers[0]?.id);
  const [selectedId, setSelectedId] = useState<string>();
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const preferencesLoadedRef = useRef(false);
  const [itemQuery, setItemQuery] = useState("");
  const [debugRevealState, setDebugRevealState] =
    useState<ContainerDebugRevealState>("auto");
  const [createDialog, setCreateDialog] =
    useState<ContainerFormDialogState | null>(null);
  const [renderedCreateDialog, setRenderedCreateDialog] =
    useState<ContainerFormDialogState | null>(null);
  const generatedReferenceId = useMemo(
    () => generateInventoryContainerReferenceId(containers),
    [containers],
  );
  const matchingItemCount = useMemo(
    () => countFilteredItems(filterContainerItems(containers, itemQuery)),
    [containers, itemQuery],
  );
  const containerIds = useMemo(
    () => new Set(containers.map(({ id }) => id)),
    [containers],
  );

  useEffect(() => {
    const saved = readContainerPreferences(window.localStorage);
    const savedContainerId =
      saved?.scrollContainerId && containerIds.has(saved.scrollContainerId)
        ? saved.scrollContainerId
        : undefined;
    const nextActiveId = savedContainerId ?? containers[0]?.id;
    const nextView = urlView ?? saved?.view ?? "scroll";
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      setView(nextView);
      setActiveId(nextActiveId);
      setSelectedId(nextView === "scroll" ? nextActiveId : undefined);
      preferencesLoadedRef.current = true;
      setPreferencesLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [containerIds, containers, urlView]);

  useEffect(() => {
    if (!preferencesLoaded) return;

    const next = new URL(window.location.href);
    next.searchParams.set("view", view);
    window.history.replaceState(null, "", next);

    writeContainerPreferences(window.localStorage, {
      ...(activeId ? { scrollContainerId: activeId } : {}),
      version: 1,
      view,
    });
  }, [activeId, preferencesLoaded, view]);

  const reportActiveContainer = useCallback((id: string) => {
    if (!preferencesLoadedRef.current) return;
    setActiveId(id);
  }, []);

  const selectContainer = useCallback(
    (container: ContainerShelf) => {
      reportActiveContainer(container.id);
      setSelectedId(container.id);
    },
    [reportActiveContainer],
  );

  const changeView = useCallback(
    (nextView: ContainerView) => {
      setView(nextView);
      if (nextView === "scroll") setSelectedId(activeId);
    },
    [activeId],
  );

  function openCreateDialog() {
    const dialog: ContainerFormDialogState = {
      mode: "create",
      container: null,
    };
    setRenderedCreateDialog(dialog);
    setCreateDialog(dialog);
  }

  return (
    <Box {...containerPage}>
      <Flex as="header" {...listHeader}>
        <Flex
          pointerEvents="auto"
          flexShrink={0}
          align="center"
          gap="2"
          css={{
            "@media (min-width: 40rem)": {
              transform: "translateX(-1rem)",
            },
          }}
        >
          <IconButton
            {...inventorySecondaryButton}
            {...headerAction}
            bg="bg"
            aria-label="Open bounds editor"
            asChild
            title="Bounds editor"
          >
            <Link href="/inventory/containers/bounds" prefetch={false}>
              <ScanLineIcon aria-hidden="true" />
            </Link>
          </IconButton>
        </Flex>

        <Flex
          pointerEvents="auto"
          order={1}
          minW="0"
          flex="1"
          justify="center"
          css={{ "@media (min-width: 40rem)": { order: 0 } }}
        >
          <Flex w="full" maxW="31rem" minW="0" align="center" gap="2">
            <Box minW="0" flex="1">
              {view === "scroll" ? (
                <ContainerSearch
                  activeId={activeId}
                  containers={containers}
                  onSelect={selectContainer}
                />
              ) : (
                <SearchPill
                  endOffset="-2.5rem"
                  end={
                    <Box
                      as="span"
                      aria-live="polite"
                      whiteSpace="nowrap"
                      fontFamily="mono"
                      fontSize="10px"
                      color="fg.muted"
                      textTransform="uppercase"
                      letterSpacing="0.08em"
                      data-bento-match-count=""
                    >
                      {matchingItemCount}{" "}
                      {matchingItemCount === 1 ? "match" : "matches"}
                    </Box>
                  }
                  aria-label="Filter items inside containers"
                  onChange={(event) => setItemQuery(event.target.value)}
                  placeholder="Find an item…"
                  type="search"
                  value={itemQuery}
                />
              )}
            </Box>

            <IconButton
              {...headerAction}
              aria-label="Add container"
              ref={addTriggerRef}
              colorPalette="brand"
              variant="solid"
              onClick={openCreateDialog}
              title="Add container"
              type="button"
            >
              <PlusIcon aria-hidden="true" />
            </IconButton>
          </Flex>
        </Flex>

        <Flex pointerEvents="auto" h="10" flexShrink={0} align="center">
          <ViewToggle onChange={changeView} value={view} />
        </Flex>
      </Flex>

      {view === "scroll" ? (
        <ScrollStack
          containers={containers}
          debugBounds={debugBounds}
          debugRevealState={debugRevealState}
          layoutSeed={sessionLayoutSeed}
          onActiveChange={reportActiveContainer}
          selectedId={selectedId}
        />
      ) : (
        <BentoView
          containers={containers}
          debugBounds={debugBounds}
          debugRevealState={debugRevealState}
          layoutSeed={sessionLayoutSeed}
          query={itemQuery}
        />
      )}

      {debugBounds ? (
        <DebugRevealControl
          onChange={setDebugRevealState}
          value={debugRevealState}
        />
      ) : null}

      <ContainerFormDialog
        action={createAction}
        dialog={renderedCreateDialog}
        generatedReferenceId={generatedReferenceId}
        finalFocusEl={() => addTriggerRef.current}
        key={renderedCreateDialog ? "create-container" : "create-closed"}
        onDone={() => {
          setCreateDialog(null);
          router.refresh();
        }}
        onOpenChange={(open) => {
          if (!open) setCreateDialog(null);
        }}
        onClosed={() => setRenderedCreateDialog(null)}
        open={createDialog !== null}
        visualPresets={visualPresets}
      />
    </Box>
  );
}

function DebugRevealControl({
  onChange,
  value,
}: {
  onChange: (value: ContainerDebugRevealState) => void;
  value: ContainerDebugRevealState;
}) {
  const states: Array<{
    label: string;
    value: ContainerDebugRevealState;
  }> = [
    { label: "Auto", value: "auto" },
    { label: "Unhovered", value: "unhovered" },
    { label: "Hovered", value: "hovered" },
  ];

  return (
    <Flex
      {...controlSurface}
      aria-label="Container hover state"
      position="fixed"
      bottom="4"
      left="50%"
      zIndex={50}
      transform="translateX(-50%)"
      align="center"
      gap="1"
      borderRadius="l2"
      p="1"
      data-debug-reveal-control=""
    >
      <Text px="2" textStyle="xs" color="fg.muted">Hover preview</Text>
      <SegmentGroup.Root
        aria-label="Container hover state"
        size="xs"
        value={value}
        onValueChange={({ value: nextValue }) => {
          const state = states.find((option) => option.value === nextValue);
          if (state) onChange(state.value);
        }}
      >
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={states} />
      </SegmentGroup.Root>
    </Flex>
  );
}

function ViewToggle({
  onChange,
  value,
}: {
  onChange: (view: ContainerView) => void;
  value: ContainerView;
}) {
  return (
    <SegmentGroup.Root
      aria-label="Container view"
      size="sm"
      onValueChange={({ value: nextValue }) => {
        if (nextValue === "scroll" || nextValue === "bento") {
          onChange(nextValue);
        }
      }}
      value={value}
    >
      <SegmentGroup.Indicator />
      {(
        [
          ["scroll", "Full-screen scroll", Rows3Icon],
          ["bento", "Bento grid", Grid2X2Icon],
        ] as const
      ).map(([option, label, Icon]) => (
        <SegmentGroup.Item
          key={option}
          value={option}
          title={label}
          px="3"
        >
          <Icon size={16} aria-hidden="true" />
          <SegmentGroup.ItemHiddenInput aria-label={label} />
        </SegmentGroup.Item>
      ))}
    </SegmentGroup.Root>
  );
}
