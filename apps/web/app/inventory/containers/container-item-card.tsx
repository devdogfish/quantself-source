"use client";

import { InventoryItemMediaPreview } from "@/app/inventory/inventory-item-media-preview";
import type { InventoryItemMedia } from "@/app/inventory/inventory-item-media";
import type { InventoryItemAudioPreviewController } from "@/app/inventory/inventory-item-audio-preview";
import { Box } from "@chakra-ui/react";

export type ContainerItemCardMedia =
  | Exclude<InventoryItemMedia, { type: "audio" }>
  | {
      audioId: string | null;
      controller: InventoryItemAudioPreviewController;
      src: string | null;
      type: "audio";
    };

export function containerItemSurface(variant: "compact" | "default") {
  return variant === "compact"
    ? {
        borderColor: "white/75",
        bg: "white/85",
        boxShadow:
          "0 4px 12px rgb(30 32 35 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.92)",
      }
    : {
        borderColor: "white/90",
        bg: "white/55",
        boxShadow:
          "0 18px 35px rgb(30 32 35 / 0.0325), inset 0 1px 1px rgb(255 255 255 / 0.96), inset 0 -1px 0 rgb(75 80 84 / 0.08)",
        backdropFilter: "blur(10px)",
      };
}

export function ContainerItemCard({
  media,
  variant = "default",
}: {
  media: ContainerItemCardMedia;
  variant?: "compact" | "default";
}) {
  const isCompact = variant === "compact";
  const audioPreview = media.type === "audio" ? media.controller : undefined;
  const sharedMedia: InventoryItemMedia =
    media.type === "audio"
      ? { audioId: media.audioId, src: media.src, type: "audio" }
      : media;

  return (
    <Box
      as="span"
      position="relative"
      display="grid"
      boxSize="full"
      placeItems="center"
      overflow="hidden"
      borderRadius="inherit"
      borderWidth="1px"
      color="#303337"
      {...containerItemSurface(variant)}
      data-container-item-card=""
      data-media-type={media.type}
      data-variant={variant}
    >
      <InventoryItemMediaPreview
        audioPreview={audioPreview}
        compact={isCompact}
        media={sharedMedia}
        presentation="tile"
      />
    </Box>
  );
}
