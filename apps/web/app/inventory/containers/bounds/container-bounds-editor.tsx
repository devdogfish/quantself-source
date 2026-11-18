"use client";

import { inventorySecondaryButton } from "../../inventory-button-styles";
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  NativeSelect,
  SegmentGroup,
  Stack,
  Text,
  VisuallyHidden,
  chakra,
} from "@chakra-ui/react";
import { RotateCcwIcon, SaveIcon, XIcon } from "lucide-react";
import type React from "react";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { EditableInventoryContainerVisual } from "@/lib/quantself-api-client";
import type {
  InventoryContainerVisualBounds,
  InventoryContainerVisualPoint,
} from "@/lib/inventory-container-visual-catalog";
import {
  type SaveContainerBoundsState,
  saveContainerBoundsAction,
} from "./actions";

const CORNER_LABELS = ["TL", "TR", "BR", "BL"] as const;
const KEYBOARD_NUDGE = 0.005;
type BoundsKind = "hover" | "item";
const INITIAL_SAVE_STATE: SaveContainerBoundsState = {
  message: "",
  status: "idle",
};

export function ContainerBoundsEditor({
  initialSelectedKey,
  visuals,
}: {
  initialSelectedKey?: string;
  visuals: EditableInventoryContainerVisual[];
}) {
  const [selectedKey, setSelectedKey] = useState(
    initialSelectedKey ?? visuals[0]?.key ?? "",
  );
  const [boundsKind, setBoundsKind] = useState<BoundsKind>("item");
  const draggingCornerRef = useRef<number | null>(null);
  const submittedDraftRef = useRef<{
    hoverBounds: InventoryContainerVisualBounds;
    itemBounds: InventoryContainerVisualBounds;
    key: string;
  } | null>(null);
  const [itemDrafts, setItemDrafts] = useState<
    Record<string, InventoryContainerVisualBounds>
  >(() =>
    Object.fromEntries(
      visuals.map((visual) => [visual.key, copyBounds(visual.bounds)]),
    ),
  );
  const [hoverDrafts, setHoverDrafts] = useState<
    Record<string, InventoryContainerVisualBounds>
  >(() =>
    Object.fromEntries(
      visuals.map((visual) => [visual.key, copyBounds(visual.hoverBounds)]),
    ),
  );
  const [savedItemBounds, setSavedItemBounds] = useState<
    Record<string, InventoryContainerVisualBounds>
  >(() =>
    Object.fromEntries(
      visuals.map((visual) => [visual.key, copyBounds(visual.bounds)]),
    ),
  );
  const [savedHoverBounds, setSavedHoverBounds] = useState<
    Record<string, InventoryContainerVisualBounds>
  >(() =>
    Object.fromEntries(
      visuals.map((visual) => [visual.key, copyBounds(visual.hoverBounds)]),
    ),
  );
  const [actionState, formAction, pending] = useActionState(
    saveContainerBoundsAction,
    INITIAL_SAVE_STATE,
  );
  const selected = visuals.find((visual) => visual.key === selectedKey);
  const itemBounds = selected ? itemDrafts[selected.key] : undefined;
  const hoverBounds = selected ? hoverDrafts[selected.key] : undefined;
  const bounds = boundsKind === "item" ? itemBounds : hoverBounds;
  const serializedBounds = useMemo(
    () => JSON.stringify(itemBounds ?? []),
    [itemBounds],
  );
  const serializedHoverBounds = useMemo(
    () => JSON.stringify(hoverBounds ?? []),
    [hoverBounds],
  );
  const isDirty = selected
    ? !boundsEqual(itemBounds, savedItemBounds[selected.key]) ||
      !boundsEqual(hoverBounds, savedHoverBounds[selected.key])
    : false;

  useEffect(() => {
    if (!selectedKey) return;

    const nextUrl = containerBoundsPresetUrl(window.location.href, selectedKey);

    if (
      new URL(window.location.href).searchParams.get("preset") === selectedKey
    ) {
      return;
    }

    window.history.replaceState(null, "", nextUrl);
  }, [selectedKey]);

  useEffect(() => {
    const submitted = submittedDraftRef.current;

    if (
      !submitted ||
      actionState.status !== "success" ||
      actionState.presetKey !== submitted.key
    ) {
      return;
    }

    setSavedItemBounds((current) => ({
      ...current,
      [submitted.key]: copyBounds(submitted.itemBounds),
    }));
    setSavedHoverBounds((current) => ({
      ...current,
      [submitted.key]: copyBounds(submitted.hoverBounds),
    }));
    submittedDraftRef.current = null;
  }, [actionState]);

  if (!selected || !bounds || !itemBounds || !hoverBounds) {
    return <Text color="fg.muted">No container visuals found.</Text>;
  }

  const selectedVisualKey = selected.key;
  const selectedDefaultBounds = selected.defaultBounds;
  const selectedDefaultHoverBounds = selected.defaultHoverBounds;

  function updateCorner(index: number, point: InventoryContainerVisualPoint) {
    const setDrafts = boundsKind === "item" ? setItemDrafts : setHoverDrafts;
    const defaultBounds =
      boundsKind === "item"
        ? selectedDefaultBounds
        : selectedDefaultHoverBounds;

    setDrafts((current) => {
      const currentBounds =
        current[selectedVisualKey] ?? copyBounds(defaultBounds);

      return {
        ...current,
        [selectedVisualKey]: updateMirroredBounds(currentBounds, index, point),
      };
    });
  }

  function updateCornerFromClientPoint(
    index: number,
    clientX: number,
    clientY: number,
    stage: HTMLElement,
  ) {
    const rect = stage.getBoundingClientRect();
    updateCorner(index, {
      x: clamp((clientX - rect.left) / rect.width),
      y: clamp((clientY - rect.top) / rect.height),
    });
  }

  return (
    <Grid as="section" gap="4" aria-label="Container bounds editor">
      <Flex
        role="group"
        aria-label="Bounds editor controls"
        wrap="wrap"
        align="end"
        justify="space-between"
        gap="4"
        p="4"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l3"
        bg="bg.subtle"
      >
        <Flex minW="0" wrap="wrap" align="end" gap="4">
          <Field.Root w="auto" gap="1.5">
            <Field.Label>Container size</Field.Label>
            <NativeSelect.Root size="sm" minW="28" bg="bg">
              <NativeSelect.Field
                value={selected.key}
                onChange={(event) => setSelectedKey(event.currentTarget.value)}
              >
                {visuals.map((visual) => (
                  <option key={visual.key} value={visual.key}>
                    {visual.name}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>

          <Stack gap="1.5">
            <Text id="bounds-kind-label" textStyle="sm" fontWeight="medium">
              Editing
            </Text>
            <SegmentGroup.Root
              size="sm"
              aria-labelledby="bounds-kind-label"
              value={boundsKind}
              onValueChange={({ value }) => {
                if (value === "item" || value === "hover") setBoundsKind(value);
              }}
            >
              <SegmentGroup.Indicator />
              <SegmentGroup.Items
                items={[
                  { label: "Item render", value: "item" },
                  { label: "Hover area", value: "hover" },
                ]}
              />
            </SegmentGroup.Root>
          </Stack>
        </Flex>

        <VisuallyHidden id="bounds-editor-help">
          Drag a corner to move both sides symmetrically. Use arrow keys for
          precise adjustments; hold Shift for larger steps.
        </VisuallyHidden>
        <chakra.form
          action={formAction}
          display="flex"
          flexWrap="wrap"
          alignItems="center"
          justifyContent="end"
          gap="2"
          marginInlineStart="auto"
          onSubmit={() => {
            submittedDraftRef.current = {
              hoverBounds: copyBounds(hoverBounds),
              itemBounds: copyBounds(itemBounds),
              key: selected.key,
            };
          }}
        >
          <input name="presetKey" type="hidden" value={selected.key} />
          <input name="bounds" type="hidden" value={serializedBounds} />
          <input
            name="hoverBounds"
            type="hidden"
            value={serializedHoverBounds}
          />
          <Button
            size="sm"
            disabled={boundsEqual(
              bounds,
              boundsKind === "item"
                ? selected.defaultBounds
                : selected.defaultHoverBounds,
            )}
            onClick={() => {
              const setDrafts =
                boundsKind === "item" ? setItemDrafts : setHoverDrafts;
              const defaultBounds =
                boundsKind === "item"
                  ? selected.defaultBounds
                  : selected.defaultHoverBounds;

              setDrafts((current) => ({
                ...current,
                [selected.key]: copyBounds(defaultBounds),
              }));
            }}
            type="button"
            {...inventorySecondaryButton}
          >
            <RotateCcwIcon aria-hidden="true" />
            Default
          </Button>
          {isDirty ? (
            <Button
              size="sm"
                onClick={() => {
                setItemDrafts((current) => ({
                  ...current,
                  [selected.key]: copyBounds(
                    savedItemBounds[selected.key] ?? selected.bounds,
                  ),
                }));
                setHoverDrafts((current) => ({
                  ...current,
                  [selected.key]: copyBounds(
                    savedHoverBounds[selected.key] ?? selected.hoverBounds,
                  ),
                }));
              }}
              type="button"
              {...inventorySecondaryButton}
            >
              <XIcon aria-hidden="true" />
              Cancel
            </Button>
          ) : null}
          <Button size="sm" disabled={!isDirty || pending} type="submit">
            <SaveIcon aria-hidden="true" />
            {pending ? "Saving…" : "Save"}
          </Button>
        </chakra.form>
      </Flex>

      <Grid gap="3">
        <Box
          aria-describedby="bounds-editor-help"
          aria-label={`${selected.name} ${boundsKind} bounds editor`}
          position="relative"
          w="full"
          touchAction="none"
          overflow="hidden"
          borderRadius="l3"
          borderWidth="1px"
          bgImage="linear-gradient(45deg, rgb(0 0 0 / 0.022) 25%, transparent 25%), linear-gradient(-45deg, rgb(0 0 0 / 0.022) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgb(0 0 0 / 0.022) 75%), linear-gradient(-45deg, transparent 75%, rgb(0 0 0 / 0.022) 75%)"
          bgSize="16px 16px"
          backgroundPosition="0 0, 0 8px, 8px -8px, -8px 0"
          data-bounds-editor-stage=""
          onPointerCancel={() => {
            draggingCornerRef.current = null;
          }}
          onPointerMove={(event) => {
            const cornerIndex = draggingCornerRef.current;

            if (cornerIndex === null || event.buttons === 0) return;

            updateCornerFromClientPoint(
              cornerIndex,
              event.clientX,
              event.clientY,
              event.currentTarget,
            );
          }}
          onPointerUp={() => {
            draggingCornerRef.current = null;
          }}
          style={{ aspectRatio: `${selected.width} / ${selected.height}` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- Catalog image is local app data. */}
          <chakra.img
            alt=""
            pointerEvents="none"
            position="absolute"
            inset="0"
            boxSize="full"
            userSelect="none"
            objectFit="contain"
            draggable={false}
            src={selected.frontImageUrl}
          />

          <chakra.svg
            aria-hidden="true"
            pointerEvents="none"
            position="absolute"
            inset="0"
            boxSize="full"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <polygon
              fill={
                boundsKind === "hover"
                  ? "rgba(23, 23, 23, 0.055)"
                  : "transparent"
              }
              points={hoverBounds
                .map(({ x, y }) => `${x * 100},${y * 100}`)
                .join(" ")}
              stroke={
                boundsKind === "hover"
                  ? "rgba(23, 23, 23, 0.78)"
                  : "rgba(82, 82, 82, 0.34)"
              }
              strokeDasharray="7 5"
              strokeWidth={boundsKind === "hover" ? 2 : 1.25}
              vectorEffect="non-scaling-stroke"
            />
            <polygon
              fill={
                boundsKind === "item"
                  ? "rgba(23, 23, 23, 0.085)"
                  : "rgba(23, 23, 23, 0.025)"
              }
              points={itemBounds
                .map(({ x, y }) => `${x * 100},${y * 100}`)
                .join(" ")}
              stroke={
                boundsKind === "item"
                  ? "rgba(23, 23, 23, 0.86)"
                  : "rgba(82, 82, 82, 0.32)"
              }
              strokeWidth={boundsKind === "item" ? 2 : 1.25}
              vectorEffect="non-scaling-stroke"
            />
          </chakra.svg>

          {bounds.map((point, index) => (
            <chakra.button
              aria-label={`Move ${cornerName(index)} corner`}
              position="absolute"
              zIndex={10}
              display="grid"
              boxSize="5"
              transform="translate(-50%, -50%)"
              touchAction="none"
              placeItems="center"
              borderRadius="full"
              borderWidth="2px"
              borderColor="fg"
              bg="bg"
              boxShadow="md"
              cursor="grab"
              _after={{ position: "absolute", boxSize: "11", content: '""' }}
              _active={{ cursor: "grabbing" }}
              _focusVisible={{
                outline: "2px solid",
                outlineColor: "brand.focusRing",
                outlineOffset: "2px",
              }}
              key={CORNER_LABELS[index]}
              onKeyDown={(event) => {
                const delta = keyboardDelta(event.key, event.shiftKey ? 5 : 1);

                if (!delta) return;

                event.preventDefault();
                updateCorner(index, {
                  x: clamp(point.x + delta.x),
                  y: clamp(point.y + delta.y),
                });
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                draggingCornerRef.current = index;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              style={{
                left: `${point.x * 100}%`,
                top: `${point.y * 100}%`,
              }}
              type="button"
            >
              <Box
                as="span"
                aria-hidden="true"
                boxSize="1"
                borderRadius="full"
                bg="fg"
              />
            </chakra.button>
          ))}
        </Box>

        <Flex wrap="wrap" align="center" justify="space-between" gap="3" px="1">
          <Flex
            aria-label="Bounds legend"
            wrap="wrap"
            align="center"
            gap="4"
            textStyle="xs"
            color="fg.muted"
          >
            <Flex as="span" align="center" gap="2">
              <Box
                as="span"
                aria-hidden="true"
                display="block"
                w="6"
                borderTopWidth="2px"
                borderColor="fg"
              />
              Item render
            </Flex>
            <Flex as="span" align="center" gap="2">
              <Box
                as="span"
                aria-hidden="true"
                display="block"
                w="6"
                borderTopWidth="2px"
                borderStyle="dashed"
                borderColor="fg.muted"
              />
              Hover area includes 20px runtime padding
            </Flex>
          </Flex>
          {actionState.presetKey === selected.key &&
          (actionState.status === "error" ||
            (actionState.status === "success" && !isDirty)) ? (
            <Text
              aria-live="polite"
              textStyle="sm"
              color={actionState.status === "error" ? "fg.error" : "fg.muted"}
            >
              {actionState.message}
            </Text>
          ) : null}
        </Flex>
      </Grid>
    </Grid>
  );
}

export function boundsEqual(
  left: InventoryContainerVisualBounds | undefined,
  right: InventoryContainerVisualBounds | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;

  return left.every(
    (point, index) =>
      point.x === right[index]?.x && point.y === right[index]?.y,
  );
}

export function containerBoundsPresetUrl(
  currentHref: string,
  presetKey: string,
): URL {
  const nextUrl = new URL(currentHref);

  nextUrl.searchParams.set("preset", presetKey);

  return nextUrl;
}

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function updateMirroredBounds(
  bounds: InventoryContainerVisualBounds,
  index: number,
  point: InventoryContainerVisualPoint,
): InventoryContainerVisualBounds {
  const isLeft = index === 0 || index === 3;
  const isTop = index === 0 || index === 1;
  const oppositeEdgeY = isTop
    ? Math.min(bounds[2].y, bounds[3].y) - 0.01
    : Math.max(bounds[0].y, bounds[1].y) + 0.01;
  const nextPoint = {
    x: isLeft
      ? clampBetween(point.x, 0, 0.495)
      : clampBetween(point.x, 0.505, 1),
    y: isTop
      ? clampBetween(point.y, 0, oppositeEdgeY)
      : clampBetween(point.y, oppositeEdgeY, 1),
  };
  const mirroredIndex = [1, 0, 3, 2][index]!;
  const next = bounds.map((current) => ({ ...current }));

  next[index] = nextPoint;
  next[mirroredIndex] = {
    x: 1 - nextPoint.x,
    y: nextPoint.y,
  };

  return next as unknown as InventoryContainerVisualBounds;
}

function copyBounds(
  bounds: InventoryContainerVisualBounds,
): InventoryContainerVisualBounds {
  return bounds.map((point) => ({
    ...point,
  })) as unknown as InventoryContainerVisualBounds;
}

function clampBetween(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cornerName(index: number): string {
  return ["top left", "top right", "bottom right", "bottom left"][index] ?? "";
}

function keyboardDelta(
  key: string,
  multiplier: number,
): InventoryContainerVisualPoint | null {
  const amount = KEYBOARD_NUDGE * multiplier;

  switch (key) {
    case "ArrowLeft":
      return { x: -amount, y: 0 };
    case "ArrowRight":
      return { x: amount, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -amount };
    case "ArrowDown":
      return { x: 0, y: amount };
    default:
      return null;
  }
}
