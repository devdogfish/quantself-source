import { inventoryItemMediaContentPath } from "@/lib/quantself-api-browser";

export type InventoryItemMedia =
  | {
      alt: string;
      sources: string[];
      type: "image";
    }
  | {
      audioId: string | null;
      src: string | null;
      type: "audio";
    }
  | {
      poster?: string;
      src: string;
      title: string;
      type: "video";
    }
  | {
      text?: string | null;
      title: string;
      type: "text";
    };

export function selectInventoryItemMedia({
  alt,
  audioId,
  imageIds,
  itemId,
  text,
  title,
  videoId,
}: {
  alt: string;
  audioId?: string | null;
  imageIds: string[];
  itemId: string;
  text?: string | null;
  title: string;
  videoId?: string | null;
}): InventoryItemMedia {
  const uniqueImageIds = [...new Set(imageIds.filter(Boolean))];

  if (uniqueImageIds.length > 0) {
    return {
      alt,
      sources: uniqueImageIds.map((imageId) =>
        inventoryItemMediaContentPath(itemId, imageId, {
          representation: "preview",
        }),
      ),
      type: "image",
    };
  }

  if (videoId) {
    return {
      src: inventoryItemMediaContentPath(itemId, videoId),
      title,
      type: "video",
    };
  }

  if (audioId) {
    return {
      audioId,
      src: inventoryItemMediaContentPath(itemId, audioId),
      type: "audio",
    };
  }

  return {
    text,
    title,
    type: "text",
  };
}
