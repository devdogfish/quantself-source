import { Flex, Grid, Box, Text, Badge } from "@chakra-ui/react";
import {
  AudioLinesIcon,
  CameraIcon,
  type LucideIcon,
  TypeIcon,
} from "lucide-react";
import type React from "react";
import Link from "next/link";
import type { InventoryItem } from "@/lib/quantself-api-client";
import type { SystemStyleObject } from "@chakra-ui/react";
import { buildInventoryItemHref } from "./item-navigation";
import {
  InventoryItemAudioHoverTarget,
  InventoryItemMediaPreview,
} from "./inventory-item-media-preview";
import {
  type InventoryItemMedia,
  selectInventoryItemMedia,
} from "./inventory-item-media";
import { InventoryStatusBadge } from "./inventory-shell";
import type { InventoryShellItem } from "./inventory-shell-data";
import {
  formatInventoryShellContainer,
  formatInventoryShellWhere,
} from "./inventory-shell-data";

type InventoryItemCardEvidenceKind = "photo" | "voice" | "text";

export type InventoryItemCardModel = {
  container: {
    id: string;
    label: string;
  } | null;
  detailLines?: string[];
  evidenceKinds: InventoryItemCardEvidenceKind[];
  id: string;
  importance: InventoryShellItem["importance"];
  matchExplanation?: string;
  media: InventoryItemMedia;
  placementCount: number;
  specialistBadge?: string;
  status: InventoryShellItem["status"];
  title: string;
  totalQuantity: number;
  whereLabel: string;
};

export function InventoryItemCard({
  footer,
  item,
  returnTo = "/inventory/browse",
  variant = "detailed",
}: {
  footer?: React.ReactNode;
  item: InventoryItemCardModel;
  returnTo?: string;
  variant?: "compact" | "detailed";
}) {
  const itemHref = buildInventoryItemHref(item.id, returnTo);

  if (variant === "compact") {
    return (
      <Flex
        as="article"
        role="group"
        minWidth="0"
        overflow="hidden"
        borderRadius="xl"
        borderWidth="1px"
        borderColor="border"
        background="bg"
        transition="border-color 150ms, background 150ms"
        _hover={{ borderColor: "border.emphasized" }}
      >
        <ItemVisual
          css={{
            aspectRatio: "1",
            width: { base: "24", sm: "28" },
            flexShrink: 0,
            borderColor: "border",
            borderRightWidth: "1px",
          }}
          media={item.media}
          compact
        />
        <Grid minWidth="0" flex="1" alignContent="start" gap="2" p="3">
          <Flex
            minWidth="0"
            alignItems="start"
            justifyContent="space-between"
            gap="2"
          >
            <InventoryItemAudioHoverTarget
              audioId={item.media.type === "audio" ? item.media.audioId : null}
              audioSrc={item.media.type === "audio" ? item.media.src : null}
            >
              <Box
                asChild
                minWidth="0"
                fontWeight="medium"
                textStyle="sm"
                lineHeight="tight"
                textUnderlineOffset="4px"
                _groupHover={{ textDecoration: "underline" }}
              >
                <Link href={itemHref}>{item.title}</Link>
              </Box>
            </InventoryItemAudioHoverTarget>
            <Flex flexShrink={0} gap="1">
              {item.specialistBadge ? (
                <Badge variant="outline">{item.specialistBadge}</Badge>
              ) : null}
              <InventoryStatusBadge status={item.status} />
              <InventoryStatusBadge status={item.importance} />
            </Flex>
          </Flex>
          <InventoryItemWhere item={item} />
          {item.detailLines?.map((line) => (
            <Text lineClamp={2} color="fg.muted" textStyle="xs" key={line}>
              {line}
            </Text>
          ))}
          {item.matchExplanation ? (
            <Text lineClamp={2} color="fg.muted" textStyle="xs">
              {item.matchExplanation}
            </Text>
          ) : null}
          {footer ? (
            <Box borderColor="border" borderTopWidth="1px" pt="2">
              {footer}
            </Box>
          ) : null}
        </Grid>
      </Flex>
    );
  }

  return (
    <Grid
      as="article"
      role="group"
      gridTemplateColumns="minmax(0,1fr)"
      overflow="hidden"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="border"
      background="bg"
      boxShadow="xs"
      transition="border-color 150ms, background 150ms"
      _hover={{ borderColor: "border.emphasized" }}
    >
      <ItemVisual
        css={{
          aspectRatio: "4/3",
          width: "full",
          borderColor: "border",
          borderBottomWidth: "1px",
        }}
        media={item.media}
      />
      <Grid minWidth="0" gap="2.5" p="4">
        <Flex alignItems="start" justifyContent="space-between" gap="3">
          <InventoryItemAudioHoverTarget
            audioId={item.media.type === "audio" ? item.media.audioId : null}
            audioSrc={item.media.type === "audio" ? item.media.src : null}
          >
            <Box
              asChild
              fontWeight="semibold"
              lineHeight="tight"
              textUnderlineOffset="4px"
              _groupHover={{ textDecoration: "underline" }}
            >
              <Link href={itemHref}>{item.title}</Link>
            </Box>
          </InventoryItemAudioHoverTarget>
          <Flex flexShrink={0} gap="1">
            {item.totalQuantity > 1 ? (
              <Badge variant="subtle">× {item.totalQuantity}</Badge>
            ) : null}
            {item.specialistBadge ? (
              <Badge variant="outline">{item.specialistBadge}</Badge>
            ) : null}
            <InventoryStatusBadge status={item.status} />
            <InventoryStatusBadge status={item.importance} />
          </Flex>
        </Flex>
        <InventoryItemWhere item={item} />
        <InventoryItemEvidenceBadges kinds={item.evidenceKinds} />
        {footer ? (
          <Box borderColor="border" borderTopWidth="1px" pt="3">
            {footer}
          </Box>
        ) : null}
      </Grid>
    </Grid>
  );
}

export function inventoryShellItemCardModel(
  item: InventoryShellItem,
): InventoryItemCardModel {
  return {
    container: item.container
      ? {
          id: item.container.id,
          label: `${item.container.name} (${item.container.referenceId})`,
        }
      : null,
    evidenceKinds: [
      ...new Set(
        item.evidence
          .map((entry) => entry.kind)
          .filter(isInventoryItemCardEvidenceKind),
      ),
    ],
    id: item.id,
    importance: item.importance,
    media: selectInventoryItemMedia({
      alt: item.images[0]?.alt ?? item.title,
      audioId:
        item.evidence.find((entry) => entry.kind === "voice")?.id ?? null,
      imageIds: item.images.map((image) => image.id),
      itemId: item.id,
      text: item.textBundle.captureText,
      title: item.title,
      videoId:
        item.evidence.find((entry) => entry.kind === "video")?.id ??
        item.videoId,
    }),
    placementCount:
      item.placements && item.placements.length > 0
        ? item.placements.length
        : item.container
          ? 1
          : 0,
    status: item.status,
    title: item.title,
    totalQuantity: item.totalQuantity ?? 1,
    whereLabel: formatInventoryShellCardWhere(item),
  };
}

export function inventoryItemSearchCardModel(
  item: InventoryItem,
): InventoryItemCardModel {
  const evidenceKinds: InventoryItemCardEvidenceKind[] = [];
  const imageIds = item.processing.evidence
    .filter((entry) => entry.kind === "photo")
    .map((entry) => entry.id);

  if (imageIds.length > 0 || item.imageId) {
    evidenceKinds.push("photo");
  }
  if (item.processing.evidence.some((entry) => entry.kind === "voice")) {
    evidenceKinds.push("voice");
  }
  if (item.captureText?.trim()) {
    evidenceKinds.push("text");
  }

  return {
    container:
      item.containerId && item.containerLabel
        ? {
            id: item.containerId,
            label: item.containerLabel,
          }
        : null,
    evidenceKinds,
    id: item.id,
    importance: item.importance,
    matchExplanation: item.matchExplanation,
    media: selectInventoryItemMedia({
      alt: item.title ?? item.captureText ?? "Inventory item",
      audioId:
        item.processing.evidence.find((entry) => entry.kind === "voice")?.id ??
        null,
      imageIds:
        imageIds.length > 0 ? imageIds : item.imageId ? [item.imageId] : [],
      itemId: item.id,
      text: item.captureText,
      title: item.title ?? item.captureText ?? "Untitled capture",
      videoId:
        item.processing.evidence.find((entry) => entry.kind === "video")?.id ??
        null,
    }),
    placementCount:
      item.placements.length > 0
        ? item.placements.length
        : item.containerId && item.containerLabel
          ? 1
          : 0,
    specialistBadge:
      item.category === "clothing" && item.clothingProfile
        ? (item.clothingProfile.dirtyQuantity ??
            (item.clothingProfile.isDirty ? item.totalQuantity : 0)) === 0
          ? "Clean"
          : (item.clothingProfile.dirtyQuantity ?? item.totalQuantity) <
              item.totalQuantity
            ? "Mixed"
            : "Dirty"
        : undefined,
    detailLines: inventoryItemDetailLines(item),
    status: item.status,
    title: item.title ?? item.captureText ?? "Untitled capture",
    totalQuantity: item.totalQuantity,
    whereLabel: formatInventoryItemSearchCardWhere(item),
  };
}

function inventoryItemDetailLines(item: InventoryItem): string[] | undefined {
  if (!item.remedyProfile) {
    return undefined;
  }

  const lines = [
    item.remedyProfile.potencies.length > 0
      ? `Potencies: ${item.remedyProfile.potencies.join(", ")}`
      : null,
    item.remedyProfile.selectionSummary
      ? item.remedyProfile.selectionSummary
      : null,
    item.remedyProfile.externalReferences.length > 0
      ? `Sources: ${item.remedyProfile.externalReferences
          .map((reference) =>
            reference.referenceId
              ? `${reference.source} (${reference.referenceId})`
              : reference.source,
          )
          .join(", ")}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines : undefined;
}

function formatInventoryShellCardWhere(item: InventoryShellItem): string {
  if (!item.placements || item.placements.length === 0) {
    return formatInventoryShellWhere(item);
  }

  return item.placements
    .map(
      (placement) =>
        formatInventoryShellContainer(placement.container) ??
        placement.note ??
        "Unplaced",
    )
    .join(" · ");
}

function formatInventoryItemSearchCardWhere(item: InventoryItem): string {
  return item.where;
}

function isInventoryItemCardEvidenceKind(
  value: InventoryShellItem["evidence"][number]["kind"],
): value is InventoryItemCardEvidenceKind {
  return value === "photo" || value === "voice" || value === "text";
}

function ItemVisual({
  css,
  compact = false,
  media,
}: {
  css?: SystemStyleObject;
  compact?: boolean;
  media: InventoryItemMedia;
}) {
  return (
    <InventoryItemMediaPreview
      css={css}
      compact={compact}
      imagePresentation="contain-transparent-perimeter"
      media={media}
    />
  );
}

export function InventoryItemWhere({
  item,
  rowLink = false,
}: {
  item: InventoryItemCardModel;
  rowLink?: boolean;
}) {
  const containerLabel = item.container?.label ?? "";
  const containerLabelIndex = item.whereLabel.indexOf(containerLabel);

  if (
    !item.container ||
    item.placementCount !== 1 ||
    containerLabelIndex < 0
  ) {
    return (
      <Text color="fg.muted" textStyle="xs" truncate={item.placementCount <= 1}>
        {item.whereLabel}
      </Text>
    );
  }

  const beforeContainer = item.whereLabel.slice(0, containerLabelIndex);
  const afterContainer = item.whereLabel.slice(
    containerLabelIndex + containerLabel.length,
  );

  return (
    <Text truncate={true} color="fg.muted" textStyle="xs">
      {beforeContainer}
      <Box
        asChild
        fontWeight="medium"
        color="fg"
        position={rowLink ? "relative" : undefined}
        zIndex={rowLink ? 1 : undefined}
        textUnderlineOffset="4px"
        _hover={{ textDecoration: "underline" }}
      >
        <Link
          href={`/inventory/containers/${encodeURIComponent(item.container.id)}`}
          prefetch={rowLink ? false : undefined}
        >
          {item.container.label}
        </Link>
      </Box>
      {afterContainer}
    </Text>
  );
}

export function InventoryItemEvidenceBadges({
  kinds,
}: {
  kinds: InventoryItemCardEvidenceKind[];
}) {
  return (
    <Flex flexWrap="wrap" gap="1.5">
      {kinds.map((kind) => {
        const Icon: LucideIcon =
          kind === "photo"
            ? CameraIcon
            : kind === "voice"
              ? AudioLinesIcon
              : TypeIcon;

        return (
          <Badge key={kind} variant="outline">
            <Icon />
            {kind === "voice" ? "Audio" : sentenceCase(kind)}
          </Badge>
        );
      })}
    </Flex>
  );
}

function sentenceCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
