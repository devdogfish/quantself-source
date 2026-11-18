import { Flex, Box, Button } from "@chakra-ui/react";
import { ArchiveIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import {
  listInventoryContainers,
  listInventoryItemsPage,
} from "@/lib/quantself-api-client";
import {
  InventoryBrowseContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryShellLayout } from "../inventory-shell";
import { mapInventoryShellItem } from "../inventory-shell-api-data";
import { InventoryBrowse } from "./inventory-browse";
import {
  controlledFilterValue,
  evidenceValues,
  importanceValues,
  inventoryCategoryValues,
  itemKindValues,
  itemStatusValues,
  workflowValues,
} from "./inventory-browse-filter-options";

type InventoryBrowsePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export default function InventoryBrowsePage({
  searchParams,
}: InventoryBrowsePageProps) {
  const data = loadInventoryBrowsePageData(searchParams);

  return (
    <InventoryShellLayout
      active="browse"
      title="Browse inventory"
      titleMeta={
        <Suspense fallback={<InventoryTitleMetaSkeleton />}>
          <InventoryBrowseTitleMeta data={data} />
        </Suspense>
      }
    >
      <Suspense fallback={<InventoryBrowseContentSkeleton />}>
        <InventoryBrowseContent data={data} />
      </Suspense>
    </InventoryShellLayout>
  );
}

async function loadInventoryBrowsePageData(
  searchParams: InventoryBrowsePageProps["searchParams"],
) {
  const params = (await searchParams) ?? {};
  const [page, containers] = await Promise.all([
    listInventoryItemsPage({
      cursor: firstValue(params.cursor) || null,
      category: controlledFilterValue(
        firstValue(params.category),
        inventoryCategoryValues,
      ),
      containerId: firstValue(params.containerId) || null,
      evidence: controlledFilterValue(
        firstValue(params.evidence),
        evidenceValues,
      ),
      importance: controlledFilterValue(
        firstValue(params.importance),
        importanceValues,
      ),
      includeUnready: firstValue(params.includeUnready) === "1",
      kind: controlledFilterValue(firstValue(params.kind), itemKindValues),
      query: firstValue(params.q) || null,
      status: controlledFilterValue(
        firstValue(params.status),
        itemStatusValues,
      ),
      workflow: controlledFilterValue(
        firstValue(params.workflow),
        workflowValues,
      ),
    }),
    listInventoryContainers(),
  ]);

  return {
    initialContainerId: firstValue(params.containerId),
    items: page.items.map(mapInventoryShellItem),
    nextCursor: page.pageInfo.nextCursor,
    total: page.total,
    containerOptions: containers.map((container) => ({
      label: container.name,
      value: container.id,
    })),
  };
}

async function InventoryBrowseTitleMeta({
  data,
}: {
  data: ReturnType<typeof loadInventoryBrowsePageData>;
}) {
  const { total } = await data;

  return <Box as="span">{total} items</Box>;
}

async function InventoryBrowseContent({
  data,
}: {
  data: ReturnType<typeof loadInventoryBrowsePageData>;
}) {
  const { containerOptions, initialContainerId, items, nextCursor, total } =
    await data;

  return (
    <>
      <InventoryBrowse
        containerOptions={containerOptions}
        initialContainerId={initialContainerId}
        items={items}
        nextCursor={nextCursor}
        total={total}
      />
      <Flex justifyContent="end">
        <Button asChild size="sm" variant="ghost">
          <Link href="/inventory/archive">
            <ArchiveIcon />
            Archive
          </Link>
        </Button>
      </Flex>
    </>
  );
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
