import type { InventoryContainerVisualPresetRecord } from "@/lib/inventory-client-contract";

export type ContainerShelfItem = {
  audioId: string | null;
  hasAudio: boolean;
  id: string;
  localQuantity?: number;
  imageHeight?: number | null;
  imageId: string | null;
  imageIds?: string[];
  imageWidth?: number | null;
  textPreview: string | null;
  title: string;
  totalQuantity?: number;
  videoId?: string | null;
};

export type ContainerShelf = {
  id: string;
  itemCount: number;
  items: ContainerShelfItem[];
  location: string;
  name: string;
  referenceId: string;
  visualPreset: InventoryContainerVisualPresetRecord;
  visualPresetKey: string;
  hoverBounds?: InventoryContainerVisualPresetRecord["bounds"];
};

export type ContainerVisualMode = "scroll" | "bento";
