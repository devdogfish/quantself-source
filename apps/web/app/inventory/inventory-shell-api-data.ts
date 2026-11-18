import { listActiveInventoryItems } from "@/lib/quantself-api-client";
import { mapInventoryShellItem } from "./inventory-shell-item-mapper";
import type { InventoryShellItem } from "./inventory-shell-data";

export async function loadInventoryShellItems(): Promise<InventoryShellItem[]> {
  const items = await listActiveInventoryItems();

  return items.map(mapInventoryShellItem);
}

export { mapInventoryShellItem } from "./inventory-shell-item-mapper";
