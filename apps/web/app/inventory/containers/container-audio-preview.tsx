"use client";

import type { InventoryItemAudioPreviewController } from "../inventory-item-audio-preview";
import { ContainerItemCard } from "./container-item-card";

export {
  type InventoryItemAudioPreviewController as ContainerAudioPreviewController,
  useInventoryItemAudioPreview as useContainerAudioPreview,
} from "../inventory-item-audio-preview";

/** @deprecated Use ContainerItemCard with audio media. */
export function FrostedAudioTile({
  audioId,
  controller,
  src,
}: {
  audioId: string | null;
  controller: InventoryItemAudioPreviewController;
  src: string | null;
}) {
  return (
    <ContainerItemCard
      media={{
        audioId,
        controller,
        src,
        type: "audio",
      }}
    />
  );
}
