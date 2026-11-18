import {
  InventoryProcessingContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryShellLayout } from "../inventory-shell";

export default function InventoryProcessingLoading() {
  return (
    <InventoryShellLayout
      active="processing"
      title="Inventory processing"
      titleMeta={<InventoryTitleMetaSkeleton />}
    >
      <InventoryProcessingContentSkeleton />
    </InventoryShellLayout>
  );
}
