import {
  InventoryBrowseContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryShellLayout } from "../inventory-shell";

export default function InventoryBrowseLoading() {
  return (
    <InventoryShellLayout
      active="browse"
      title="Browse inventory"
      titleMeta={<InventoryTitleMetaSkeleton />}
    >
      <InventoryBrowseContentSkeleton />
    </InventoryShellLayout>
  );
}
