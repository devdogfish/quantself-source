import { Suspense } from "react";
import {
  InventoryProcessingContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryProcessingBoard } from "../inventory-processing-board";
import { InventoryShellLayout } from "../inventory-shell";
import { getInventoryShellProcessingColumns } from "../inventory-shell-data";
import { loadInventoryShellItems } from "../inventory-shell-api-data";

export const dynamic = "force-dynamic";

export default function InventoryProcessingPage() {
  const data = loadInventoryProcessingPageData();

  return (
    <InventoryShellLayout
      active="processing"
      title="Inventory processing"
      titleMeta={
        <Suspense fallback={<InventoryTitleMetaSkeleton />}>
          <InventoryProcessingTitleMeta data={data} />
        </Suspense>
      }
    >
      <Suspense fallback={<InventoryProcessingContentSkeleton />}>
        <InventoryProcessingContent data={data} />
      </Suspense>
    </InventoryShellLayout>
  );
}

async function loadInventoryProcessingPageData() {
  const items = await loadInventoryShellItems();
  const columns = getInventoryShellProcessingColumns(items);
  const totalCount = columns.flatMap((column) => column.items).length;

  return { columns, totalCount };
}

async function InventoryProcessingTitleMeta({
  data,
}: {
  data: ReturnType<typeof loadInventoryProcessingPageData>;
}) {
  const { totalCount } = await data;

  return <span>{totalCount} active items</span>;
}

async function InventoryProcessingContent({
  data,
}: {
  data: ReturnType<typeof loadInventoryProcessingPageData>;
}) {
  const { columns } = await data;

  return <InventoryProcessingBoard columns={columns} />;
}
