"use server";

import { revalidatePath } from "next/cache";
import {
  saveInventoryContainerVisualBounds,
  type EditableInventoryContainerVisual,
} from "@/lib/quantself-api-client";
import { INVENTORY_CONTAINER_VISUAL_KEYS } from "@/lib/inventory-container-visual-catalog";

export type SaveContainerBoundsState = {
  message: string;
  presetKey?: string;
  status: "idle" | "error" | "success";
};

export async function saveContainerBoundsAction(
  _previousState: SaveContainerBoundsState,
  formData: FormData,
): Promise<SaveContainerBoundsState> {
  const presetKey = String(formData.get("presetKey") ?? "");

  try {
    const validPresetKey = INVENTORY_CONTAINER_VISUAL_KEYS.find(
      (candidate) => candidate === presetKey,
    );
    if (!validPresetKey) {
      throw new Error("Container visual preset was not found.");
    }

    const serializedBounds = String(formData.get("bounds") ?? "");
    const serializedHoverBounds = String(formData.get("hoverBounds") ?? "");
    const bounds = JSON.parse(
      serializedBounds,
    ) as EditableInventoryContainerVisual["bounds"];
    const hoverBounds = JSON.parse(
      serializedHoverBounds,
    ) as EditableInventoryContainerVisual["hoverBounds"];

    await saveInventoryContainerVisualBounds({
      bounds,
      hoverBounds,
      presetKey: validPresetKey,
    });
    revalidatePath("/inventory/containers/bounds");
    revalidatePath("/inventory/containers");

    return {
      message: `${presetKey} bounds saved.`,
      presetKey,
      status: "success",
    };
  } catch (error) {
    return {
      message:
        error instanceof Error ? error.message : "Could not save item bounds.",
      presetKey,
      status: "error",
    };
  }
}
