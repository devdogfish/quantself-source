"use client";

import { Box, VisuallyHidden, chakra } from "@chakra-ui/react";
import type { Route } from "next";
import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildInventoryItemHref } from "@/app/inventory/item-navigation";
import { inventoryItemMediaContentPath } from "@/lib/quantself-api-browser";
import {
  layoutContainerScene,
  normalizedBoundsToPixels,
  type ContainerScenePlacement,
} from "./container-scene-layout";
import {
  CONTAINER_HOVER_PADDING_PX,
  isPointWithinPaddedPolygon,
} from "./container-hover-bounds";
import {
  type ContainerAudioPreviewController,
  useContainerAudioPreview,
} from "./container-audio-preview";
import {
  ContainerItemCard,
  containerItemSurface,
  type ContainerItemCardMedia,
} from "./container-item-card";
import type {
  ContainerVisualMode,
  ContainerShelf,
  ContainerShelfItem,
} from "./types";

const ContainerLink = chakra(Link, {}, { forwardProps: ["ref"] });

const sceneFocus = {
  outline: "2px solid",
  outlineColor: "black/70",
  outlineOffset: "4px",
};
const tileLayout = {
  position: "absolute",
  aspectRatio: "square",
  borderRadius: "24%",
  borderWidth: "1px",
  borderColor: "transparent",
  bg: "transparent",
  transition: "box-shadow 150ms ease",
} as const;
const tileHover = {
  boxShadow:
    "0 20px 25px -5px rgb(0 0 0 / 0.03125), 0 8px 10px -6px rgb(0 0 0 / 0.03125)",
};
const tileFocus = {
  ...tileHover,
  outline: "2px solid",
  outlineColor: "brand.focusRing",
  outlineOffset: "2px",
};

export type ContainerVisualProps = {
  container: ContainerShelf;
  debugBounds?: boolean;
  debugRevealState?: ContainerDebugRevealState;
  layoutSeed?: string;
  linkTitle?: boolean;
  mode: ContainerVisualMode;
  priority?: boolean;
  visibleItems?: ContainerShelfItem[];
};

export type ContainerDebugRevealState = "auto" | "unhovered" | "hovered";

const DETAIL_PREFERRED_TILE_FRACTION = 0.18;
const DETAIL_PREFERRED_TILE_MAX = 144;
const BENTO_PREFERRED_TILE_FRACTION = 0.1;
const BENTO_PREFERRED_TILE_MAX = 96;
const REDUCED_MOTION_DURATION_MS = 80;
const REVEAL_DURATION_MS = 300;
const BENTO_SCENE_WIDTH = "calc(100% - 1rem)";
const SCROLL_SCENE_VERTICAL_INSET_REM = 9;

/**
 * Shared registered scene boundary for the scroll and bento presentations.
 */
export function ContainerVisual({
  container,
  debugBounds = false,
  debugRevealState = "auto",
  layoutSeed = "container-scene",
  linkTitle = true,
  mode,
  priority = false,
  visibleItems = container.items,
}: ContainerVisualProps) {
  const isEmpty = container.itemCount === 0;
  const isScrollMode = mode === "scroll";
  const bentoVisualRef = useRef<HTMLAnchorElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const scrollVisualRef = useRef<HTMLElement>(null);
  const audioPreview = useContainerAudioPreview();
  const sceneSize = useElementSize(
    sceneRef,
    container.visualPreset.height,
    container.visualPreset.width,
  );
  const orderedItems = useMemo(
    () => orderVisibleItems(visibleItems),
    [visibleItems],
  );
  const canReveal = !isEmpty && orderedItems.length > 0;
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isTouchRevealed, setIsTouchRevealed] = useState(false);
  const [promotedItemIds, setPromotedItemIds] = useState<string[]>([]);
  const lastPointerTypeRef = useRef<string | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const revealDurationMs = prefersReducedMotion
    ? REDUCED_MOTION_DURATION_MS
    : REVEAL_DURATION_MS;
  const updateHoveredFromPointer = (clientX: number, clientY: number) => {
    if (!isScrollMode) {
      setIsHovered(true);
      return;
    }

    if (!canReveal) return;

    const scene = sceneRef.current;

    if (!scene) {
      setIsHovered(false);
      return;
    }

    const rect = scene.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
      setIsHovered(false);
      return;
    }

    const hoverBounds = normalizedBoundsToPixels(
      container.hoverBounds ?? container.visualPreset.bounds,
      {
        height: rect.height,
        width: rect.width,
        x: rect.left,
        y: rect.top,
      },
    );

    setIsHovered(
      isPointWithinPaddedPolygon(
        { x: clientX, y: clientY },
        hoverBounds,
        CONTAINER_HOVER_PADDING_PX,
      ),
    );
  };
  const itemLayout = useMemo(() => {
    if (isEmpty || orderedItems.length === 0) {
      return null;
    }

    const bounds = normalizedBoundsToPixels(container.visualPreset.bounds, {
      height: sceneSize.height,
      width: sceneSize.width,
      x: 0,
      y: 0,
    });

    if (canReveal) {
      const preferredTileSize = Math.min(
        isScrollMode ? DETAIL_PREFERRED_TILE_MAX : BENTO_PREFERRED_TILE_MAX,
        sceneSize.width *
          (isScrollMode
            ? DETAIL_PREFERRED_TILE_FRACTION
            : BENTO_PREFERRED_TILE_FRACTION),
      );

      return layoutContainerScene({
        bounds,
        items: orderedItems,
        mode: isScrollMode ? "detail" : "card",
        preferredTileSize,
        seed: `${layoutSeed}:${container.id}`,
      });
    }

    return null;
  }, [
    canReveal,
    container.id,
    container.visualPreset.bounds,
    isEmpty,
    isScrollMode,
    layoutSeed,
    orderedItems,
    sceneSize.height,
    sceneSize.width,
  ]);
  const itemById = useMemo(
    () => new Map(orderedItems.map((item) => [item.id, item])),
    [orderedItems],
  );
  const promotedItemZIndexes = useMemo(
    () => new Map(promotedItemIds.map((itemId, index) => [itemId, index + 1])),
    [promotedItemIds],
  );
  const promoteItem = (itemId: string) => {
    setPromotedItemIds((current) =>
      current.at(-1) === itemId
        ? current
        : [...current.filter((currentId) => currentId !== itemId), itemId],
    );
  };
  const isNaturallyRevealed = isTouchRevealed || isFocusWithin || isHovered;
  const isBentoElevated =
    !isScrollMode && (isHovered || isFocusWithin || isTouchRevealed);
  const effectiveDebugRevealState = debugBounds ? debugRevealState : "auto";
  const isRevealed =
    canReveal &&
    (effectiveDebugRevealState === "hovered" ||
      (effectiveDebugRevealState === "auto" && isNaturallyRevealed));
  const scene = buildScene({
    audioPreview,
    canReveal,
    container,
    debugBounds,
    isRevealed,
    itemLayout,
    mode,
    orderedItems,
    prefersReducedMotion,
    priority,
    promoteItem,
    promotedItemZIndexes,
    revealDurationMs,
    sceneRef,
  });

  useEffect(() => {
    if (!canReveal) {
      setIsTouchRevealed(false);
    }
  }, [canReveal]);

  useEffect(() => {
    if (!isTouchRevealed) return;

    const dismissTouchReveal = (event: PointerEvent) => {
      const visual = isScrollMode
        ? scrollVisualRef.current
        : bentoVisualRef.current;

      if (event.target instanceof Node && !visual?.contains(event.target)) {
        setIsTouchRevealed(false);
      }
    };

    document.addEventListener("pointerdown", dismissTouchReveal);
    return () => {
      document.removeEventListener("pointerdown", dismissTouchReveal);
    };
  }, [isScrollMode, isTouchRevealed]);

  useEffect(() => {
    setIsFocusWithin(false);
    setIsHovered(false);
    setIsTouchRevealed(false);
    setPromotedItemIds([]);
    lastPointerTypeRef.current = null;
  }, [container.id, mode]);

  if (!isScrollMode) {
    return (
      <ContainerLink
        position="relative"
        display="grid"
        minH="0"
        minW="0"
        w="full"
        h="full"
        placeItems="center"
        alignContent="end"
        borderRadius="2rem"
        transition="transform 150ms ease, scale 150ms ease"
        _focusVisible={sceneFocus}
        _motionSafe={isBentoElevated ? { scale: "1.01" } : undefined}
        _active={{ scale: "0.99" }}
        data-container-visual=""
        data-debug-reveal-state={effectiveDebugRevealState}
        data-item-count={visibleItems.length}
        data-reduced-motion={prefersReducedMotion ? "true" : "false"}
        data-reveal-state={isRevealed ? "open" : "closed"}
        data-total-item-count={container.itemCount}
        data-visual-mode={mode}
        href={`/inventory/containers/${container.id}` as Route}
        ref={bentoVisualRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsFocusWithin(false);
          }
        }}
        onClick={(event) => {
          const isTouchActivation = lastPointerTypeRef.current === "touch";
          lastPointerTypeRef.current = null;

          if (!canReveal || !isTouchActivation || isTouchRevealed) return;

          event.preventDefault();
          setIsTouchRevealed(true);
        }}
        onFocus={() => {
          if (lastPointerTypeRef.current === null) {
            setIsFocusWithin(true);
          }
        }}
        onKeyDown={(event) => {
          if (!canReveal || event.key !== "Escape") return;
          setIsTouchRevealed(false);
          setIsHovered(false);
          setIsFocusWithin(false);
        }}
        onMouseEnter={(event) =>
          updateHoveredFromPointer(event.clientX, event.clientY)
        }
        onMouseLeave={() => {
          setIsHovered(false);
        }}
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType;
          if (event.pointerType === "touch") {
            setIsHovered(false);
          }
        }}
        onPointerCancel={() => {
          lastPointerTypeRef.current = null;
        }}
      >
        {audioPreview.media}
        <VisuallyHidden>Open </VisuallyHidden>
        {scene}
        <ContainerMetadata
          container={container}
          interactive={false}
          mode={mode}
        />
      </ContainerLink>
    );
  }

  return (
    <Box
      asChild
      position="relative"
      display="grid"
      minH="0"
      minW="0"
      boxSize="full"
      placeItems="center"
      borderRadius="2rem"
    >
      <section
        aria-label={`${container.name}, ${container.itemCount} ${
          container.itemCount === 1 ? "item" : "items"
        } in ${container.location}`}
        data-container-visual=""
        data-debug-reveal-state={effectiveDebugRevealState}
        data-item-count={visibleItems.length}
        data-reduced-motion={prefersReducedMotion ? "true" : "false"}
        data-reveal-state={isRevealed ? "open" : "closed"}
        data-total-item-count={container.itemCount}
        data-visual-mode={mode}
        ref={scrollVisualRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsFocusWithin(false);
          }
        }}
        onClick={(event) => {
          const isTouchActivation = lastPointerTypeRef.current === "touch";
          lastPointerTypeRef.current = null;

          if (!canReveal || !isTouchActivation) return;
          if (event.target instanceof Element && event.target.closest("a"))
            return;
          setIsTouchRevealed((current) => !current);
        }}
        onFocus={() => {
          if (canReveal && lastPointerTypeRef.current === null) {
            setIsFocusWithin(true);
          }
        }}
        onKeyDown={(event) => {
          if (!canReveal) return;

          if (event.key === "Escape") {
            setIsTouchRevealed(false);
            setIsHovered(false);
            setIsFocusWithin(false);
            return;
          }

          if (
            (event.key === "Enter" || event.key === " ") &&
            event.target === event.currentTarget
          ) {
            event.preventDefault();
            setIsTouchRevealed((current) => !current);
          }
        }}
        onMouseEnter={(event) =>
          updateHoveredFromPointer(event.clientX, event.clientY)
        }
        onMouseLeave={() => {
          setIsHovered(false);
        }}
        onMouseMove={(event) =>
          updateHoveredFromPointer(event.clientX, event.clientY)
        }
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType;
          if (event.pointerType === "touch") {
            setIsHovered(false);
          }
        }}
        onPointerCancel={() => {
          lastPointerTypeRef.current = null;
        }}
        tabIndex={canReveal ? 0 : undefined}
      >
        {audioPreview.media}
        {scene}
        <ContainerMetadata
          container={container}
          interactive={true}
          linkTitle={linkTitle}
          mode={mode}
        />
      </section>
    </Box>
  );

  function buildScene({
    audioPreview,
    canReveal,
    container,
    debugBounds,
    itemLayout,
    isRevealed,
    mode,
    orderedItems,
    prefersReducedMotion,
    priority,
    promoteItem,
    promotedItemZIndexes,
    revealDurationMs,
    sceneRef,
  }: {
    audioPreview: ContainerAudioPreviewController;
    canReveal: boolean;
    container: ContainerShelf;
    debugBounds: boolean;
    itemLayout: ReturnType<typeof layoutContainerScene> | null;
    isRevealed: boolean;
    mode: ContainerVisualMode;
    orderedItems: ContainerShelfItem[];
    prefersReducedMotion: boolean;
    priority: boolean;
    promoteItem: (itemId: string) => void;
    promotedItemZIndexes: ReadonlyMap<string, number>;
    revealDurationMs: number;
    sceneRef: RefObject<HTMLDivElement | null>;
  }) {
    const isEmpty = container.itemCount === 0;
    const stateRole = isEmpty ? "empty" : "front";
    const stateImageUrl = isEmpty
      ? container.visualPreset.emptyImageUrl
      : container.visualPreset.frontImageUrl;
    const sceneAspectRatio =
      container.visualPreset.width / container.visualPreset.height;
    const sceneWidth =
      mode === "scroll"
        ? `min(100%, 92vw, 1120px, calc(${formatCssNumber(
            sceneAspectRatio * 100,
          )}svh - ${formatCssNumber(
            sceneAspectRatio * SCROLL_SCENE_VERTICAL_INSET_REM,
          )}rem))`
        : BENTO_SCENE_WIDTH;
    const sceneStyle: CSSProperties & {
      "--container-scene-width": string;
    } = {
      "--container-scene-width": sceneWidth,
      aspectRatio: `${container.visualPreset.width} / ${container.visualPreset.height}`,
      width: "var(--container-scene-width)",
    };
    const layerTransitionStyle = {
      transitionDuration: `${revealDurationMs}ms`,
    };

    return (
      <Box position="relative" isolation="isolate" overflow="visible" asChild>
        <div data-container-scene="" ref={sceneRef} style={sceneStyle}>
          {debugBounds ? (
            <SceneDebugBounds
              hoverBounds={
                container.hoverBounds ?? container.visualPreset.bounds
              }
              itemBounds={container.visualPreset.bounds}
            />
          ) : null}
          <Box position="absolute" inset="0" overflow="visible">
            <SceneImageLayer
              zIndex={0}
              container={container}
              mode={mode}
              priority={priority}
              role="shadow"
              src={container.visualPreset.shadowImageUrl}
            />
            {canReveal || isRevealed ? (
              <SceneImageLayer
                zIndex={10}
                container={container}
                mode={mode}
                priority={priority}
                role="back"
                src={container.visualPreset.backImageUrl}
              />
            ) : null}
            {itemLayout ? (
              <Box
                position="absolute"
                inset="0"
                zIndex={20}
                pointerEvents={canReveal && isRevealed ? undefined : "none"}
                transition={canReveal ? "opacity 150ms ease-out" : undefined}
                data-scene-layer="items"
                style={canReveal ? layerTransitionStyle : undefined}
              >
                {itemLayout.placements.map((placement) => {
                  if (placement.kind === "overflow") {
                    return mode === "scroll" ? (
                      <ContainerOverflowLink
                        containerId={container.id}
                        count={itemLayout.overflowCount}
                        key="overflow"
                        onPromote={() => promoteItem("overflow")}
                        placement={placement}
                        promotedZIndex={promotedItemZIndexes.get("overflow")}
                      />
                    ) : (
                      <CompactContainerOverflowBadge
                        count={itemLayout.overflowCount}
                        key="overflow"
                        onPromote={() => promoteItem("overflow")}
                        placement={placement}
                        promotedZIndex={promotedItemZIndexes.get("overflow")}
                      />
                    );
                  }

                  const item = placement.itemId
                    ? itemById.get(placement.itemId)
                    : null;

                  if (!item) {
                    return null;
                  }

                  return mode === "scroll" ? (
                    <ContainerItemLink
                      audioPreview={audioPreview}
                      containerId={container.id}
                      item={item}
                      key={item.id}
                      onPromote={() => promoteItem(item.id)}
                      placement={placement}
                      promotedZIndex={promotedItemZIndexes.get(item.id)}
                    />
                  ) : (
                    <CompactContainerItemTile
                      audioPreview={audioPreview}
                      item={item}
                      key={item.id}
                      onPromote={() => promoteItem(item.id)}
                      placement={placement}
                      promotedZIndex={promotedItemZIndexes.get(item.id)}
                    />
                  );
                })}
              </Box>
            ) : null}
            <SceneImageLayer
              zIndex={canReveal ? 30 : 10}
              transition={
                canReveal
                  ? "opacity 150ms ease-out, transform 150ms ease-out, translate 150ms ease-out"
                  : undefined
              }
              opacity={canReveal ? (isRevealed ? 0 : 0.75) : undefined}
              translate={canReveal && isRevealed ? "0 -0.5%" : undefined}
              container={container}
              mode={mode}
              priority={priority}
              role={stateRole}
              src={stateImageUrl}
              style={canReveal ? layerTransitionStyle : undefined}
            />
          </Box>

          <VisuallyHidden>
            {mode === "bento"
              ? "Open "
              : `${prefersReducedMotion ? "Reduced-motion" : "Interactive"} detailed scene with ${orderedItems.length} visible ${
                  orderedItems.length === 1 ? "item" : "items"
                }`}
          </VisuallyHidden>
        </div>
      </Box>
    );
  }
}

const debugLabelStyles = {
  position: "absolute",
  borderRadius: "l1",
  px: "1.5",
  py: "0.5",
  fontFamily: "var(--chakra-fonts-mono)",
  fontSize: "9px",
  lineHeight: "1",
  color: "white",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
} as const;

function SceneDebugBounds({
  hoverBounds,
  itemBounds,
}: {
  hoverBounds: ContainerShelf["visualPreset"]["bounds"];
  itemBounds: ContainerShelf["visualPreset"]["bounds"];
}) {
  const itemLabelPoint = itemBounds.reduce(
    (result, point) => ({
      x: Math.min(result.x, point.x),
      y: Math.min(result.y, point.y),
    }),
    { x: 1, y: 1 },
  );
  const hoverLabelPoint = hoverBounds.reduce(
    (result, point) => ({
      x: Math.min(result.x, point.x),
      y: Math.min(result.y, point.y),
    }),
    { x: 1, y: 1 },
  );
  const itemPolygonPoints = itemBounds
    .map(
      ({ x, y }) => `${formatCssNumber(x * 100)},${formatCssNumber(y * 100)}`,
    )
    .join(" ");
  const hoverPolygonPoints = hoverBounds
    .map(
      ({ x, y }) => `${formatCssNumber(x * 100)},${formatCssNumber(y * 100)}`,
    )
    .join(" ");

  return (
    <Box
      aria-hidden="true"
      pointerEvents="none"
      position="absolute"
      inset="0"
      zIndex={60}
      borderWidth="2px"
      borderColor="#2b7fff"
      data-debug-bound="scene"
    >
      <Box as="span" {...debugLabelStyles} top="1" right="1" bg="#2b7fff">
        image canvas
      </Box>
      <chakra.svg
        position="absolute"
        inset="0"
        boxSize="full"
        overflow="visible"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polygon
          data-debug-bound="hover"
          fill="rgba(239, 68, 68, 0.06)"
          points={hoverPolygonPoints}
          stroke="rgba(239, 68, 68, 0.28)"
          strokeWidth={CONTAINER_HOVER_PADDING_PX * 2}
          vectorEffect="non-scaling-stroke"
        />
        <polygon
          data-debug-bound="item-render"
          fill="rgba(34, 197, 94, 0.12)"
          points={itemPolygonPoints}
          stroke="#22c55e"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </chakra.svg>
      <Box
        as="span"
        {...debugLabelStyles}
        bg="#fb2c36"
        style={{
          left: `${formatCssNumber(hoverLabelPoint.x * 100)}%`,
          top: `calc(${formatCssNumber(hoverLabelPoint.y * 100)}% - ${CONTAINER_HOVER_PADDING_PX + 14}px)`,
        }}
      >
        hover +20px
      </Box>
      <Box
        as="span"
        {...debugLabelStyles}
        bg="#00c950"
        style={{
          left: `${formatCssNumber(itemLabelPoint.x * 100)}%`,
          top: `${formatCssNumber(itemLabelPoint.y * 100)}%`,
        }}
      >
        item render
      </Box>
    </Box>
  );
}

function SceneImageLayer({
  container,
  mode,
  priority,
  role,
  src,
  style,
  ...layerStyles
}: {
  container: ContainerShelf;
  mode: ContainerVisualMode;
  priority: boolean;
  role: string;
  src: string;
  style?: CSSProperties;
} & Pick<
  React.ComponentProps<typeof Box>,
  "zIndex" | "opacity" | "translate" | "transition"
>) {
  return (
    <Box
      position="absolute"
      inset="0"
      pointerEvents="none"
      data-scene-layer={role}
      style={style}
      {...layerStyles}
    >
      <Image
        alt=""
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
        height={container.visualPreset.height}
        priority={priority}
        sizes={
          mode === "scroll"
            ? "(max-width: 768px) 94vw, 1120px"
            : "(max-width: 768px) 94vw, (max-width: 1280px) 48vw, 32vw"
        }
        src={src}
        width={container.visualPreset.width}
      />
    </Box>
  );
}

function ContainerMetadata({
  container,
  interactive,
  linkTitle = true,
  mode,
}: {
  container: ContainerShelf;
  interactive: boolean;
  linkTitle?: boolean;
  mode: ContainerVisualMode;
}) {
  const underlines = (interactive && linkTitle) || mode === "bento";
  const content = (
    <>
      <Box
        as="span"
        data-container-name=""
        display="block"
        fontFamily="body"
        fontWeight="semibold"
        color="#171717"
        textUnderlineOffset={underlines ? "4px" : undefined}
        css={
          underlines
            ? {
                "a:hover &, a:focus-visible &": { textDecoration: "underline" },
              }
            : undefined
        }
      >
        {container.name}
      </Box>
      <Box
        as="span"
        mt="0.5"
        display="block"
        fontFamily="mono"
        fontSize="10px"
        lineHeight="inherit"
        color="black/55"
        textTransform="uppercase"
        letterSpacing="0.16em"
      >
        {container.referenceId}
        <span aria-hidden="true"> · </span>
        {container.location}
      </Box>
    </>
  );
  const layout = {
    textAlign: "center",
    ...(mode === "scroll"
      ? { position: "absolute", insetX: "0", bottom: "3" }
      : { mt: "1.5" }),
    pointerEvents: interactive ? "auto" : "none",
  } as const;

  if (!interactive || !linkTitle) {
    return (
      <Box as="span" aria-hidden={interactive ? undefined : "true"} {...layout}>
        {content}
      </Box>
    );
  }

  return (
    <ContainerLink
      aria-label={`Open ${container.name}`}
      {...layout}
      borderRadius="full"
      px="3"
      py="1"
      _focusVisible={sceneFocus}
      href={`/inventory/containers/${container.id}` as Route}
    >
      {content}
    </ContainerLink>
  );
}

function ContainerItemLink({
  audioPreview,
  containerId,
  item,
  onPromote,
  placement,
  promotedZIndex,
}: {
  audioPreview: ContainerAudioPreviewController;
  containerId: string;
  item: ContainerShelfItem;
  onPromote: () => void;
  placement: ContainerScenePlacement;
  promotedZIndex?: number;
}) {
  const media = getContainerItemCardMedia(item, audioPreview);
  const cardType = media.type;
  const isAudioTile = cardType === "audio";

  return (
    <ContainerLink
      aria-label={`Open ${item.title}`}
      {...tileLayout}
      _focusVisible={tileFocus}
      _hover={tileHover}
      data-container-item-id={item.id}
      href={buildInventoryItemHref(
        item.id,
        `/inventory/containers/${encodeURIComponent(containerId)}`,
      )}
      onBlur={() => {
        if (isAudioTile) audioPreview.stop(item.audioId ?? undefined);
      }}
      onClick={(event) => {
        audioPreview.stop(item.audioId ?? undefined);
        event.stopPropagation();
      }}
      onFocus={() => {
        onPromote();
        if (isAudioTile && media.audioId && media.src) {
          audioPreview.start(media.audioId, media.src);
        }
      }}
      onMouseEnter={() => {
        onPromote();
        if (isAudioTile && media.audioId && media.src) {
          audioPreview.start(media.audioId, media.src);
        }
      }}
      onMouseLeave={() => {
        if (isAudioTile) audioPreview.stop(item.audioId ?? undefined);
      }}
      style={placementStyle(placement, promotedZIndex)}
      data-stack-size={Math.max(1, item.localQuantity ?? 1)}
    >
      <ContainerItemStack item={item} media={media} />
    </ContainerLink>
  );
}

function ContainerOverflowLink({
  containerId,
  count,
  onPromote,
  placement,
  promotedZIndex,
}: {
  containerId: string;
  count: number;
  onPromote: () => void;
  placement: ContainerScenePlacement;
  promotedZIndex?: number;
}) {
  return (
    <ContainerLink
      aria-label={`Open ${count} more items`}
      {...tileLayout}
      display="grid"
      placeItems="center"
      borderRadius="l2"
      borderColor="white"
      bg="white/95"
      fontWeight="semibold"
      boxShadow="0 4px 6px -1px rgb(0 0 0 / 0.025), 0 2px 4px -2px rgb(0 0 0 / 0.025)"
      _hover={tileHover}
      _focusVisible={tileFocus}
      data-container-item-id="overflow"
      href={`/inventory/containers/${encodeURIComponent(containerId)}` as Route}
      onClick={(event) => event.stopPropagation()}
      onFocus={onPromote}
      onMouseEnter={onPromote}
      style={placementStyle(placement, promotedZIndex)}
    >
      +{count}
    </ContainerLink>
  );
}

function CompactContainerItemTile({
  audioPreview,
  item,
  onPromote,
  placement,
  promotedZIndex,
}: {
  audioPreview: ContainerAudioPreviewController;
  item: ContainerShelfItem;
  onPromote: () => void;
  placement: ContainerScenePlacement;
  promotedZIndex?: number;
}) {
  const media = getContainerItemCardMedia(item, audioPreview, true);
  const cardType = media.type;
  const isAudioTile = cardType === "audio";

  return (
    <Box
      as="span"
      aria-hidden="true"
      {...tileLayout}
      _hover={tileHover}
      data-container-item-id={item.id}
      data-item-tile="true"
      data-stack-size={Math.max(1, item.localQuantity ?? 1)}
      onMouseEnter={() => {
        onPromote();
        if (isAudioTile && media.audioId && media.src) {
          audioPreview.start(media.audioId, media.src);
        }
      }}
      onMouseLeave={() => {
        if (isAudioTile) audioPreview.stop(item.audioId ?? undefined);
      }}
      style={placementStyle(placement, promotedZIndex)}
    >
      <ContainerItemStack item={item} media={media} variant="compact" />
    </Box>
  );
}

function ContainerItemStack({
  item,
  media,
  variant = "default",
}: {
  item: ContainerShelfItem;
  media: ContainerItemCardMedia;
  variant?: "compact" | "default";
}) {
  const layerCount = Math.min(3, Math.max(1, item.localQuantity ?? 1));
  const layerIndexes = Array.from(
    { length: layerCount },
    (_, index) => layerCount - index - 1,
  );

  return (
    <Box
      as="span"
      position="relative"
      display="block"
      boxSize="full"
      overflow="visible"
      borderRadius="inherit"
    >
      {layerIndexes.map((layerIndex) => {
        const isFront = layerIndex === 0;

        return (
          <Box
            as="span"
            aria-hidden={isFront ? undefined : "true"}
            borderRadius="inherit"
            transition="transform 200ms ease-out"
            _motionReduce={{ transition: "none" }}
            position={isFront ? "relative" : "absolute"}
            display={isFront ? "block" : undefined}
            boxSize={isFront ? "full" : undefined}
            inset={isFront ? undefined : "0"}
            pointerEvents={isFront ? undefined : "none"}
            zIndex={isFront ? 10 : 3 - layerIndex}
            transform={
              isFront
                ? undefined
                : `translate(${layerIndex * 3}px, ${layerIndex * 3}px) rotate(${layerIndex}deg)`
            }
            css={
              isFront
                ? undefined
                : {
                    "[data-container-item-id]:hover &, [data-container-item-id]:focus-visible &":
                      {
                        transform: `translate(${layerIndex * 10}px, ${layerIndex * 6}px) rotate(${layerIndex === 1 ? 3 : 7}deg)`,
                      },
                  }
            }
            data-stack-layer={layerIndex}
            key={layerIndex}
          >
            {isFront ? (
              <ContainerItemCard media={media} variant={variant} />
            ) : (
              <ContainerItemStackLayer variant={variant} />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function ContainerItemStackLayer({
  variant,
}: {
  variant: "compact" | "default";
}) {
  return (
    <Box
      as="span"
      display="block"
      boxSize="full"
      borderRadius="inherit"
      borderWidth="1px"
      {...containerItemSurface(variant)}
      data-container-item-stack-layer=""
    />
  );
}

function CompactContainerOverflowBadge({
  count,
  onPromote,
  placement,
  promotedZIndex,
}: {
  count: number;
  onPromote: () => void;
  placement: ContainerScenePlacement;
  promotedZIndex?: number;
}) {
  return (
    <Box
      as="span"
      aria-hidden="true"
      {...tileLayout}
      {...containerItemSurface("compact")}
      display="grid"
      placeItems="center"
      fontWeight="semibold"
      _hover={tileHover}
      data-container-item-id="overflow"
      data-item-tile="true"
      onMouseEnter={onPromote}
      style={placementStyle(placement, promotedZIndex)}
    >
      +{count}
    </Box>
  );
}

function getContainerItemCardType(
  item: ContainerShelfItem,
): ContainerItemCardMedia["type"] {
  if (item.imageId) return "image";
  if (item.videoId) return "video";
  if (item.hasAudio) return "audio";
  return "text";
}

function getContainerItemCardMedia(
  item: ContainerShelfItem,
  audioPreview: ContainerAudioPreviewController,
  decorative = false,
): ContainerItemCardMedia {
  switch (getContainerItemCardType(item)) {
    case "image":
      return {
        alt: decorative ? "" : item.title,
        sources: getItemImageIds(item).map((imageId) =>
          inventoryItemMediaContentPath(item.id, imageId, {
            representation: "preview",
          }),
        ),
        type: "image",
      };
    case "audio":
      return {
        audioId: item.audioId,
        controller: audioPreview,
        src: item.audioId
          ? inventoryItemMediaContentPath(item.id, item.audioId)
          : null,
        type: "audio",
      };
    case "video":
      if (!item.videoId) {
        return {
          text: item.textPreview,
          title: item.title,
          type: "text",
        };
      }
      return {
        src: inventoryItemMediaContentPath(item.id, item.videoId),
        title: item.title,
        type: "video",
      };
    case "text":
      return {
        text: item.textPreview,
        title: item.title,
        type: "text",
      };
  }
}

function placementStyle(
  placement: ContainerScenePlacement,
  zIndex?: number,
): CSSProperties {
  return {
    height: placement.size,
    left: placement.center.x - placement.size / 2,
    top: placement.center.y - placement.size / 2,
    transform: `rotate(${placement.rotation}deg)`,
    width: placement.size,
    zIndex,
  };
}

function getItemImageIds(item: ContainerShelfItem): string[] {
  return [
    ...new Set(
      (item.imageIds?.length ? item.imageIds : [item.imageId]).filter(
        (imageId): imageId is string => Boolean(imageId),
      ),
    ),
  ];
}

function orderVisibleItems(
  items: readonly ContainerShelfItem[],
): ContainerShelfItem[] {
  return [...items].sort(
    (left, right) =>
      Number(Boolean(right.imageId || right.videoId)) -
      Number(Boolean(left.imageId || left.videoId)),
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(mediaQuery.matches);

    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);

      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);

    return () => mediaQuery.removeListener(update);
  }, []);

  return prefersReducedMotion;
}

function useElementSize(
  ref: RefObject<HTMLElement | null>,
  initialHeight: number,
  initialWidth: number,
): { height: number; width: number } {
  const [size, setSize] = useState({
    height: initialHeight,
    width: initialWidth,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = ({ height, width }: { height: number; width: number }) => {
      const nextSize =
        width > 0 && height > 0
          ? { height, width }
          : { height: initialHeight, width: initialWidth };

      setSize((current) =>
        current.height === nextSize.height && current.width === nextSize.width
          ? current
          : nextSize,
      );
    };

    update(element.getBoundingClientRect());

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [initialHeight, initialWidth, ref]);

  return size;
}

function formatCssNumber(value: number): number {
  return Number(value.toFixed(4));
}
