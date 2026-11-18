import type React from "react";
import { Suspense } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { Box, Button, Flex, Grid, Skeleton } from "@chakra-ui/react";
import { LoadingRegion } from "@/components/loading-region";
import {
  listInventoryItemsPage,
} from "@/lib/quantself-api-client";
import { InventorySearchForm } from "./inventory-search-form";
import { InventoryShellCard, InventoryShellLayout } from "./inventory-shell";
import { SpecialistInventoryResults as SpecialistInventoryResultsClient } from "./specialist-inventory-results";

type SpecialistInventoryCategory =
  "clothing" | "food" | "homeopathy" | "supplement";

export type SpecialistInventoryRequest = {
  clothingState?: "clean" | "dirty" | null;
  query: string;
  returnFilters?: Record<string, string | null | undefined>;
};

type SpecialistInventoryPageInput<
  TRequest extends SpecialistInventoryRequest = SpecialistInventoryRequest,
> = {
  actionBanner?: (request: TRequest) => React.ReactNode;
  category: SpecialistInventoryCategory;
  emptyLabel: string;
  filters?: (request: TRequest) => React.ReactNode;
  headerAction?: (request: TRequest) => React.ReactNode;
  lead?: React.ReactNode;
  path: `/inventory/${"clothing" | "food" | "remedies" | "supplements"}`;
  request: TRequest | Promise<TRequest>;
  title: string;
};

/**
 * Synchronous specialist shell. Runtime params and API work suspend only the
 * regions that consume them, keeping the page title, inventory nav, and Search
 * card header available immediately.
 */
export function SpecialistInventoryPage<
  TRequest extends SpecialistInventoryRequest,
>(input: SpecialistInventoryPageInput<TRequest>) {
  const requestPromise = Promise.resolve(input.request);
  const dataPromise = requestPromise.then(async (request) => ({
    page: await listInventoryItemsPage({
      category: input.category,
      clothingState: request.clothingState ?? null,
      query: request.query,
    }),
    request,
  }));
  const captureLabel =
    input.category === "supplement"
      ? "supplements"
      : input.category === "homeopathy"
        ? "remedies"
        : input.category;

  return (
    <InventoryShellLayout
      active="browse"
      title={input.title}
      titleMeta={
        <Suspense fallback={<SpecialistInventoryCountSkeleton />}>
          <SpecialistInventoryCount dataPromise={dataPromise} />
        </Suspense>
      }
    >
      {input.lead}
      <InventoryShellCard
        action={
          <Suspense fallback={<Skeleton h="7" w="56" maxW="full" rounded="lg" />}>
            <SpecialistInventoryHeaderActions
              captureLabel={captureLabel}
              input={input}
              request={requestPromise}
            />
          </Suspense>
        }
        icon={<SearchIcon aria-hidden="true" />}
        title="Search"
      >
        <Suspense fallback={<SpecialistInventoryControlsSkeleton />}>
          <SpecialistInventoryControls input={input} request={requestPromise} />
        </Suspense>
        <Suspense fallback={<SpecialistInventoryResultsSkeleton />}>
          <SpecialistInventoryResults
            dataPromise={dataPromise}
            category={input.category}
            emptyLabel={input.emptyLabel}
            path={input.path}
          />
        </Suspense>
      </InventoryShellCard>
    </InventoryShellLayout>
  );
}

async function SpecialistInventoryHeaderActions<
  TRequest extends SpecialistInventoryRequest,
>({
  captureLabel,
  input,
  request,
}: {
  captureLabel: string;
  input: SpecialistInventoryPageInput<TRequest>;
  request: Promise<TRequest>;
}) {
  const resolvedRequest = await request;

  return (
    <Flex wrap="wrap" align="center" justify="end" gap="2">
      <Button asChild size="xs" variant="outline">
        <Link
          href={`/inventory?${new URLSearchParams({ category: input.category })}`}
        >
          <PlusIcon aria-hidden="true" />
          Capture {captureLabel}
        </Link>
      </Button>
      {input.headerAction?.(resolvedRequest)}
    </Flex>
  );
}

export function SpecialistInventoryLoading({
  lead,
  title,
}: {
  lead?: React.ReactNode;
  title: string;
}) {
  return (
    <InventoryShellLayout
      active="browse"
      title={title}
      titleMeta={<SpecialistInventoryCountSkeleton />}
    >
      {lead}
      <InventoryShellCard
        action={<Skeleton h="7" w="28" rounded="lg" />}
        icon={<SearchIcon aria-hidden="true" />}
        title="Search"
      >
        <SpecialistInventoryControlsSkeleton />
        <SpecialistInventoryResultsSkeleton />
      </InventoryShellCard>
    </InventoryShellLayout>
  );
}

export function SpecialistInventoryLeadSkeleton({
  titles = ["Loading"],
}: {
  titles?: string[];
}) {
  return (
    <LoadingRegion label="Loading recommendations">
      <Grid gap="4">
        {titles.map((title) => (
          <InventoryShellCard key={title} title={title}>
            <Grid gap="3">
              <Skeleton h="4" w="2/5" />
              <Skeleton h="20" w="full" />
            </Grid>
          </InventoryShellCard>
        ))}
      </Grid>
    </LoadingRegion>
  );
}

async function SpecialistInventoryCount({
  dataPromise,
}: {
  dataPromise: Promise<{
    page: Awaited<ReturnType<typeof listInventoryItemsPage>>;
  }>;
}) {
  const { page } = await dataPromise;

  return <Box as="span">{page.total} items</Box>;
}

async function SpecialistInventoryControls<
  TRequest extends SpecialistInventoryRequest,
>({
  input,
  request,
}: {
  input: SpecialistInventoryPageInput<TRequest>;
  request: Promise<TRequest>;
}) {
  const resolvedRequest = await request;

  return (
    <>
      <InventorySearchForm
        action={input.path}
        preservedParams={resolvedRequest.returnFilters}
        query={resolvedRequest.query}
      />
      {input.actionBanner?.(resolvedRequest)}
      {input.filters?.(resolvedRequest)}
    </>
  );
}

async function SpecialistInventoryResults({
  category,
  dataPromise,
  emptyLabel,
  path,
}: {
  category: SpecialistInventoryCategory;
  dataPromise: Promise<{
    page: Awaited<ReturnType<typeof listInventoryItemsPage>>;
    request: SpecialistInventoryRequest;
  }>;
  emptyLabel: string;
  path: SpecialistInventoryPageInput["path"];
}) {
  const { page, request } = await dataPromise;
  const returnTo = buildReturnTo(path, {
    q: request.query,
    ...request.returnFilters,
  });
  return (
    <SpecialistInventoryResultsClient
      category={category}
      clothingState={request.clothingState}
      emptyLabel={emptyLabel}
      filterKey={returnTo}
      initialItems={page.items}
      initialNextCursor={page.pageInfo.nextCursor}
      initialTotal={page.total}
      query={request.query}
      returnTo={returnTo}
    />
  );
}

function SpecialistInventoryCountSkeleton() {
  return (
    <LoadingRegion label="Loading inventory count">
      <Skeleton h="4" w="14" />
    </LoadingRegion>
  );
}

function SpecialistInventoryControlsSkeleton() {
  return (
    <LoadingRegion label="Loading inventory filters">
      <Grid gap="3">
        <Skeleton h="10" w="full" />
        <Flex gap="2">
          <Skeleton h="8" w="16" rounded="full" />
          <Skeleton h="8" w="20" rounded="full" />
        </Flex>
      </Grid>
    </LoadingRegion>
  );
}

function SpecialistInventoryResultsSkeleton() {
  return (
    <LoadingRegion label="Loading inventory items">
      <Grid gap="3">
        <Skeleton h="4" w="20" />
        <Grid gap="3" templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }}>
          {[0, 1, 2, 3].map((index) => (
            <Grid gap="3" rounded="xl" borderWidth="1px" p="4" key={index}>
              <Skeleton h="5" w="3/5" />
              <Skeleton h="4" w="2/5" />
              <Skeleton h="14" w="full" />
            </Grid>
          ))}
        </Grid>
      </Grid>
    </LoadingRegion>
  );
}

function buildReturnTo(
  path: string,
  filters: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  if (params.size === 0) {
    return path;
  }

  return `${path}?${params}`;
}
