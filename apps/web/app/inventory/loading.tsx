import {
  InventoryCaptureContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "./inventory-loading";
import { InventoryShellLayout } from "./inventory-shell";

export default function InventoryLoading() {
  return (
    <InventoryShellLayout
      active="capture"
      title="Inventory"
      titleMeta={<InventoryTitleMetaSkeleton />}
    >
      <InventoryCaptureContentSkeleton />
    </InventoryShellLayout>
  );
}
