"use client";

import { Box } from "@chakra-ui/react";
import { AudioLinesIcon, TypeIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { inventoryItemMediaContentPath } from "@/lib/quantself-api-browser";
import {
  layoutContainerScene,
  normalizedBoundsToPixels,
  type ContainerScenePlacement,
} from "../container-scene-layout";
import {
  getContainerPreset,
  type PrototypeContainer,
  type PrototypeItem,
} from "./mock-data";
import styles from "./prototype.module.css";

export interface LayeredContainerProps {
  className?: string;
  container: PrototypeContainer;
  effect?: "blur" | "fade";
  mode?: "card" | "detail";
  priority?: boolean;
  visibleItemIds?: ReadonlySet<string> | null;
}

export function LayeredContainer({
  className,
  container,
  effect = "fade",
  mode = "detail",
  priority = false,
  visibleItemIds,
}: LayeredContainerProps) {
  const [revealed, setRevealed] = useState(false);
  const preset = getContainerPreset(container.presetId);
  const stageRef = useRef<HTMLElement>(null);
  const stageSize = useStageSize(stageRef, {
    height: preset.images.back.height,
    width: preset.images.back.width,
  });
  const visibleItems = useMemo(() => {
    const filtered =
      visibleItemIds == null
        ? container.items
        : container.items.filter((item) => visibleItemIds.has(item.id));

    return filtered.toSorted(
      (left, right) =>
        Number(Boolean(right.imageId)) - Number(Boolean(left.imageId)),
    );
  }, [container.items, visibleItemIds]);
  const layout = useMemo(() => {
    const bounds = normalizedBoundsToPixels(preset.itemBounds, {
      height: stageSize.height,
      width: stageSize.width,
      x: 0,
      y: 0,
    });
    const preferredTileSize = Math.min(
      mode === "detail" ? 144 : 96,
      stageSize.width * (mode === "detail" ? 0.18 : 0.2),
    );

    return layoutContainerScene({
      bounds,
      items: visibleItems,
      mode,
      preferredTileSize,
    });
  }, [
    mode,
    preset.itemBounds,
    stageSize.height,
    stageSize.width,
    visibleItems,
  ]);
  const itemById = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, item])),
    [visibleItems],
  );

  return (
    <Box w="full" className={className}>
      <section
        aria-label={`${container.name}, ${container.itemCount} ${container.itemCount === 1 ? "item" : "items"} in ${container.location}`}
        className={styles.stage}
        data-effect={effect}
        data-revealed={revealed}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setRevealed(false);
          }
        }}
        onClick={(event) => {
          if ((event.target as Element).closest("a")) return;
          setRevealed((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setRevealed((current) => !current);
          }
          if (event.key === "Escape") setRevealed(false);
        }}
        ref={stageRef}
        style={{
          aspectRatio: `${preset.images.back.width} / ${preset.images.back.height}`,
        }}
        tabIndex={0}
      >
        <Image
          alt=""
          className={styles.shadowLayer}
          draggable={false}
          fill
          loading={priority ? "eager" : "lazy"}
          sizes="(max-width: 768px) 100vw, 92vw"
          src={preset.images.shadow}
        />

        <Image
          alt=""
          className={styles.backLayer}
          draggable={false}
          fill
          loading={priority ? "eager" : "lazy"}
          sizes="(max-width: 768px) 100vw, 92vw"
          src={preset.images.back}
        />

        <div className={styles.itemsLayer}>
          {layout.placements.map((placement) => {
            if (placement.kind === "overflow") {
              return (
                <ContainerOverflowLink
                  container={container}
                  count={layout.overflowCount}
                  key="overflow"
                  placement={placement}
                />
              );
            }

            const item = placement.itemId
              ? itemById.get(placement.itemId)
              : null;

            return item ? (
              <ContainerItemLink
                container={container}
                item={item}
                key={item.id}
                mode={mode}
                placement={placement}
              />
            ) : null;
          })}
        </div>

        <Image
          alt=""
          className={styles.frontLayer}
          draggable={false}
          fill
          loading={priority ? "eager" : "lazy"}
          sizes="(max-width: 768px) 100vw, 92vw"
          src={preset.images.front}
        />

        <ContainerSticker container={container} />

        {visibleItems.length === 0 ? (
          <div className={styles.noItems}>
            No matching items
          </div>
        ) : null}
      </section>
    </Box>
  );
}

function ContainerItemLink({
  container,
  item,
  mode,
  placement,
}: {
  container: PrototypeContainer;
  item: PrototypeItem;
  mode: "card" | "detail";
  placement: ContainerScenePlacement;
}) {
  const returnTo =
    mode === "detail"
      ? `/inventory/containers/${container.sourceContainerId}`
      : "/inventory/containers";

  return (
    <Link
      aria-label={`Open ${item.title}`}
      className={styles.itemLink}
      href={`/inventory/items/${encodeURIComponent(item.id)}?returnTo=${encodeURIComponent(returnTo)}`}
      onClick={(event) => event.stopPropagation()}
      style={placementStyle(placement)}
    >
      {item.imageId ? (
        // eslint-disable-next-line @next/next/no-img-element -- Private app media route.
        <img
          alt={item.title}
          className={styles.itemImage}
          draggable={false}
          src={inventoryItemMediaContentPath(item.id, item.imageId)}
        />
      ) : (
        <ContainerItemPlaceholder item={item} />
      )}
    </Link>
  );
}

function ContainerOverflowLink({
  container,
  count,
  placement,
}: {
  container: PrototypeContainer;
  count: number;
  placement: ContainerScenePlacement;
}) {
  return (
    <Link
      aria-label={`Open ${count} more items`}
      className={styles.overflowLink}
      href={`/inventory/containers/${encodeURIComponent(container.sourceContainerId)}`}
      onClick={(event) => event.stopPropagation()}
      style={placementStyle(placement)}
    >
      +{count}
    </Link>
  );
}

function ContainerItemPlaceholder({ item }: { item: PrototypeItem }) {
  const Icon = item.hasAudio ? AudioLinesIcon : TypeIcon;

  return (
    <span className={styles.itemPlaceholder}>
      <Icon aria-hidden="true" className={styles.itemMediaType} size={20} />
      <span className={styles.itemTitle}>
        {item.title}
      </span>
      <span className={styles.itemMediaType}>
        {item.hasAudio ? "Audio" : "Text"}
      </span>
    </span>
  );
}

function ContainerSticker({ container }: { container: PrototypeContainer }) {
  const preset = getContainerPreset(container.presetId);

  return (
    <div
      aria-hidden="true"
      className={styles.sticker}
      style={{
        aspectRatio: "3.2 / 1",
        left: `${preset.stickerBounds.x}%`,
        rotate: `${preset.stickerBounds.rotation}deg`,
        top: `${preset.stickerBounds.y}%`,
        width: `min(${preset.stickerBounds.width}%, 22rem)`,
      }}
    >
      <div className={styles.stickerBody}>
        <div className={styles.stickerHeader}>
          <span className={styles.stickerRef}>
            {container.referenceId}
          </span>
          <span className={styles.stickerCapacity}>
            {container.presetFitCheck ? "FIT CHECK" : preset.capacityLabel}
          </span>
        </div>
        <strong className={styles.stickerName}>
          {container.name}
        </strong>
        <div className={styles.stickerFooter}>
          <span className={styles.stickerLocation}>{container.location}</span>
          <span className={styles.stickerCount}>
            {container.itemCount}{" "}
            {container.itemCount === 1 ? "item" : "items"}
          </span>
        </div>
      </div>
    </div>
  );
}

function placementStyle(
  placement: ContainerScenePlacement,
): React.CSSProperties {
  return {
    height: placement.size,
    left: placement.center.x - placement.size / 2,
    top: placement.center.y - placement.size / 2,
    transform: `rotate(${placement.rotation}deg)`,
    width: placement.size,
  };
}

function useStageSize(
  ref: React.RefObject<HTMLElement | null>,
  initialSize: { height: number; width: number },
): { height: number; width: number } {
  const [size, setSize] = useState(initialSize);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ height: rect.height, width: rect.width });
      }
    };
    update();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return size;
}
