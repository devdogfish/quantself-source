import type { StaticImageData } from "next/image";
import container6Back from "./_assets/6l/back.webp";
import container6Empty from "./_assets/6l/empty.webp";
import container6Front from "./_assets/6l/front.webp";
import container6Shadow from "./_assets/6l/shadow.webp";
import container39Back from "./_assets/39l/back.webp";
import container39Empty from "./_assets/39l/empty.webp";
import container39Front from "./_assets/39l/front.webp";
import container39Shadow from "./_assets/39l/shadow.webp";
import container80Back from "./_assets/80l/back.webp";
import container80Empty from "./_assets/80l/empty.webp";
import container80Front from "./_assets/80l/front.webp";
import container80Shadow from "./_assets/80l/shadow.webp";

export type ContainerPresetId = "6L" | "39L" | "80L";

export interface PrototypeItem {
  hasAudio: boolean;
  id: string;
  imageId: string | null;
  textPreview: string | null;
  title: string;
}

export interface PrototypeContainer {
  id: string;
  itemCount: number;
  items: PrototypeItem[];
  location: string;
  name: string;
  presetFitCheck: boolean;
  presetId: ContainerPresetId;
  referenceId: string;
  sourceContainerId: string;
}

type Point = { x: number; y: number };

export interface ContainerPreset {
  capacityLabel: string;
  id: ContainerPresetId;
  images: {
    back: StaticImageData;
    empty: StaticImageData;
    front: StaticImageData;
    shadow: StaticImageData;
  };
  itemBounds: readonly [Point, Point, Point, Point];
  label: string;
  stickerBounds: {
    height: number;
    rotation: number;
    width: number;
    x: number;
    y: number;
  };
}

export const PRESET_IDS: ContainerPresetId[] = ["6L", "39L", "80L"];

export const CONTAINER_PRESETS: Record<ContainerPresetId, ContainerPreset> = {
  "6L": {
    id: "6L",
    label: "Shallow organiser",
    capacityLabel: "6 L",
    images: {
      back: container6Back,
      empty: container6Empty,
      front: container6Front,
      shadow: container6Shadow,
    },
    itemBounds: [
      { x: 0.129, y: 0.1572 },
      { x: 0.8722, y: 0.1572 },
      { x: 0.8536, y: 0.6641 },
      { x: 0.1476, y: 0.6641 },
    ],
    stickerBounds: {
      x: 38.91,
      y: 41.94,
      width: 21.37,
      height: 23.6,
      rotation: -0.5,
    },
  },
  "39L": {
    id: "39L",
    label: "Low-profile tote",
    capacityLabel: "39 L",
    images: {
      back: container39Back,
      empty: container39Empty,
      front: container39Front,
      shadow: container39Shadow,
    },
    itemBounds: [
      { x: 0.1856, y: 0.1943 },
      { x: 0.8137, y: 0.1943 },
      { x: 0.7768, y: 0.6736 },
      { x: 0.2225, y: 0.6736 },
    ],
    stickerBounds: {
      x: 35.19,
      y: 45.65,
      width: 29.56,
      height: 21.71,
      rotation: -1,
    },
  },
  "80L": {
    id: "80L",
    label: "Deep storage tote",
    capacityLabel: "80 L",
    images: {
      back: container80Back,
      empty: container80Empty,
      front: container80Front,
      shadow: container80Shadow,
    },
    itemBounds: [
      { x: 0.167, y: 0.1949 },
      { x: 0.8344, y: 0.1949 },
      { x: 0.7973, y: 0.694 },
      { x: 0.2041, y: 0.694 },
    ],
    stickerBounds: {
      x: 35.24,
      y: 46.71,
      width: 29.66,
      height: 20.87,
      rotation: 0.6,
    },
  },
};

export function getContainerPreset(
  presetId: ContainerPresetId,
): ContainerPreset {
  return CONTAINER_PRESETS[presetId];
}

export function pickPresetId(
  sizeLiters: number | null,
  fallbackIndex: number,
): ContainerPresetId {
  if (sizeLiters !== null) {
    if (sizeLiters <= 10) return "6L";
    if (sizeLiters <= 50) return "39L";
    return "80L";
  }

  return PRESET_IDS[fallbackIndex % PRESET_IDS.length];
}
