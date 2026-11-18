import { ArchiveIcon } from "lucide-react";
import { Suspense } from "react";
import {
  listInventoryItemsPage,
} from "@/lib/quantself-api-client";
import {
  controlledFilterValue,
  inventoryCategoryValues,
  itemStatusValues,
} from "../browse/inventory-browse-filter-options";
import {
  archiveInventoryItemAction,
  restoreInventoryItemAction,
} from "../actions";
import {
  InventoryArchiveContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "../inventory-loading";
import { InventoryShellCard, InventoryShellLayout } from "../inventory-shell";
import { InventoryArchiveList } from "./inventory-archive-list";

export const dynamic = "force-dynamic";

type InventoryArchivePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function InventoryArchivePage({
  searchParams,
}: InventoryArchivePageProps) {
  const data = loadInventoryArchivePageData(searchParams);

  return (
    <InventoryShellLayout
      active="browse"
      title="Inventory archive"
      titleMeta={
        <Suspense fallback={<InventoryTitleMetaSkeleton />}>
          <InventoryArchiveTitleMeta data={data} />
        </Suspense>
      }
    >
      <Suspense fallback={<InventoryArchiveContentSkeleton />}>
        <InventoryArchiveContent data={data} />
      </Suspense>
    </InventoryShellLayout>
  );
}

async function loadInventoryArchivePageData(
  searchParams: InventoryArchivePageProps["searchParams"],
) {
  const params = (await searchParams) ?? {};
  const query = parseSearchQuery(params.q);
  const category = controlledFilterValue(
    parseSearchQuery(params.category),
    inventoryCategoryValues,
  );
  const status = controlledFilterValue(
    parseSearchQuery(params.status),
    itemStatusValues,
  );
  const cursor = parseSearchQuery(params.cursor) || null;
  const url = new URLSearchParams();
  if (query) url.set("q", query);
  if (category) url.set("category", category);
  if (status) url.set("status", status);
  if (cursor) {
    url.set("page", parseSearchQuery(params.page) || "2");
    url.set("cursor", cursor);
  }
  const returnTo = `/inventory/archive${url.size ? `?${url}` : ""}`;
  const page = await listInventoryItemsPage({
    archived: true,
    query,
    category,
    status,
    cursor,
  });
  return { ...page, query, returnTo };
}

async function InventoryArchiveTitleMeta({
  data,
}: {
  data: ReturnType<typeof loadInventoryArchivePageData>;
}) {
  const { total } = await data;

  return <span>{total} archived</span>;
}

async function InventoryArchiveContent({
  data,
}: {
  data: ReturnType<typeof loadInventoryArchivePageData>;
}) {
  const { items, query, returnTo, total, pageInfo } = await data;

  return (
    <InventoryShellCard
      description="Items kept for reference but hidden from active inventory."
      icon={<ArchiveIcon aria-hidden="true" />}
      title="Archived items"
    >
      <InventoryArchiveList
        total={total}
        nextCursor={pageInfo.nextCursor}
        query={query}
        returnTo={returnTo}
        items={items.map((item) => ({
          archivedAt: item.archivedAt ?? "",
          containerLabel: item.placements[0]?.label ?? "Unplaced",
          containerReferenceId: null,
          id: item.id,
          title: item.title,
        }))}
        restoreAction={restoreInventoryItemAction}
        archiveAction={archiveInventoryItemAction}
      />
    </InventoryShellCard>
  );
}

function parseSearchQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw?.trim() ?? "";
}
