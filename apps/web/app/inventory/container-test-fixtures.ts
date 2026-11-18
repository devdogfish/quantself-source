import { getInventoryContainerVisualCatalogEntry } from "@/lib/inventory-container-visual-catalog";
import type { InventoryContainerVisualPresetRecord } from "@/lib/inventory-client-contract";

const preset = getInventoryContainerVisualCatalogEntry("39L")!;

export const testContainerVisualPreset: InventoryContainerVisualPresetRecord = {
  backImageUrl: preset.assets.back.webpPath,
  bounds: preset.itemBounds,
  emptyImageUrl: preset.assets.empty.webpPath,
  frontImageUrl: preset.assets.front.webpPath,
  height: preset.dimensions.height,
  id: preset.key,
  isDefault: preset.isDefault,
  name: preset.name,
  shadowImageUrl: preset.assets.shadow.webpPath,
  width: preset.dimensions.width,
};
