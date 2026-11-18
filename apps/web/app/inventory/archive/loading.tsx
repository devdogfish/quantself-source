import {
  InventoryArchiveContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryShellLayout } from "../inventory-shell";

export default function InventoryArchiveLoading() {
  return (
    <InventoryShellLayout
      active="browse"
      title="Inventory archive"
      titleMeta={<InventoryTitleMetaSkeleton />}
    >
      <InventoryArchiveContentSkeleton />
    </InventoryShellLayout>
  );
}
