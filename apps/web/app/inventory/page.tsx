import { Grid, Box, Text, Heading } from "@chakra-ui/react";
import { PackagePlusIcon, SearchIcon } from "lucide-react";
import { Suspense } from "react";
import {
  getActiveInventoryCaptureSession,
  listActiveInventoryItems,
  listInventoryItems,
  listInventoryContainers,
  listInventoryContainerVisuals,
  listInventoryLocations,
} from "@/lib/quantself-api-client";
import {
  INVENTORY_CATEGORY_VALUES,
  type InventoryCategory,
} from "@/lib/inventory-client-contract";
import {
  createInventoryContainerAction,
  createInventoryItemAction,
} from "./actions";
import { mapContainerOption } from "./container-utils";
import { InventoryCaptureSessionCard } from "./capture-session-card";
import {
  InventoryItemCard,
  inventoryItemSearchCardModel,
} from "./inventory-item-card";
import { InventoryItemMediaProvider } from "./inventory-item-media-preview";
import { InventoryShellCard, InventoryShellLayout } from "./inventory-shell";
import { InventorySearchForm } from "./inventory-search-form";
import {
  InventoryCaptureContentSkeleton,
  InventoryTitleMetaSkeleton,
} from "./inventory-loading";

type InventoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export default function InventoryPage({
  searchParams,
}: InventoryPageProps) {
  const data = loadInventoryPageData(searchParams);

  return (
    <InventoryShellLayout
      active="capture"
      title="Inventory"
      titleMeta={
        <Suspense fallback={<InventoryTitleMetaSkeleton />}>
          <InventoryPageTitleMeta data={data} />
        </Suspense>
      }
    >
      <Suspense fallback={<InventoryCaptureContentSkeleton />}>
        <InventoryPageContent data={data} />
      </Suspense>
    </InventoryShellLayout>
  );
}

async function loadInventoryPageData(
  searchParams: InventoryPageProps["searchParams"],
) {
  const params = (await searchParams) ?? {};
  const query = parseSearchQuery(params.q);
  const initialCategory = parseInventoryCategory(params.category);
  const returnParams = new URLSearchParams();

  if (query) {
    returnParams.set("q", query);
  }
  if (initialCategory) {
    returnParams.set("category", initialCategory);
  }

  const returnTo = returnParams.size
    ? `/inventory?${returnParams}`
    : "/inventory";

  const [activeSession, containers, locations, visuals, searchResults, items] =
    await Promise.all([
      getActiveInventoryCaptureSession(),
      listInventoryContainers(),
      listInventoryLocations(),
      listInventoryContainerVisuals(),
      query ? listInventoryItems({ query }) : Promise.resolve([]),
      listActiveInventoryItems(),
    ]);

  return {
    activeSession,
    containers,
    initialCategory,
    locations,
    items,
    query,
    returnTo,
    searchResults,
    visuals,
  };
}

async function InventoryPageTitleMeta({
  data,
}: {
  data: ReturnType<typeof loadInventoryPageData>;
}) {
  const { activeSession } = await data;

  return <Box as="span">{activeSession?.label ?? "No active session"}</Box>;
}

async function InventoryPageContent({
  data,
}: {
  data: ReturnType<typeof loadInventoryPageData>;
}) {
  const {
    activeSession,
    containers,
    initialCategory,
    locations,
    items,
    query,
    returnTo,
    searchResults,
    visuals,
  } = await data;

  return (
    <Grid
      as="section"
      aria-label="Inventory capture and search"
      alignItems="start"
      gap="4"
      gridTemplateColumns={{ lg: "minmax(0,2fr) minmax(18rem,1fr)" }}
    >
      <InventoryShellCard
        icon={<PackagePlusIcon aria-hidden="true" />}
        title="Capture Session"
      >
        <InventoryCaptureSessionCard
          containers={containers.map(mapContainerOption)}
          captureAction={createInventoryItemAction}
          createContainerAction={createInventoryContainerAction}
          initialCategory={initialCategory}
          locations={locations}
          itemCandidates={items}
          session={mapCaptureSession(activeSession)}
          suggestedItemId={searchResults[0]?.id ?? null}
          visualPresets={visuals.visualPresets}
        />
      </InventoryShellCard>

      <InventorySearch
        query={query}
        results={searchResults}
        returnTo={returnTo}
      />
    </Grid>
  );
}

function InventorySearch({
  query,
  results,
  returnTo,
}: {
  query: string;
  results: Awaited<ReturnType<typeof listInventoryItems>>;
  returnTo: string;
}) {
  const resultNoun = results.length === 1 ? "result" : "results";

  return (
    <InventoryShellCard icon={<SearchIcon aria-hidden="true" />} title="Search">
      <InventorySearchForm query={query} />

      {query ? (
        <Grid gap="3">
          <Heading as="h3" fontWeight="medium" textStyle="sm">
            {results.length} {resultNoun} for &ldquo;{query}&rdquo;
          </Heading>

          {results.length > 0 ? (
            <InventoryItemMediaProvider>
              <Grid
                gap="3"
                gridTemplateColumns={{
                  md: "repeat(2, minmax(0, 1fr))",
                  lg: "minmax(0, 1fr)",
                }}
              >
                {results.map((item) => (
                  <InventoryItemCard
                    item={inventoryItemSearchCardModel(item)}
                    key={item.id}
                    returnTo={returnTo}
                    variant="compact"
                  />
                ))}
              </Grid>
            </InventoryItemMediaProvider>
          ) : (
            <Text
              borderRadius="xl"
              borderWidth="1px"
              borderStyle="dashed"
              borderColor="border"
              background="bg.subtle"
              px="3"
              py="4"
              color="fg.muted"
              textStyle="sm"
            >
              No inventory items matched this search.
            </Text>
          )}
        </Grid>
      ) : null}
    </InventoryShellCard>
  );
}

function parseSearchQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw?.trim() ?? "";
}

function parseInventoryCategory(
  value: string | string[] | undefined,
): InventoryCategory | null {
  const raw = Array.isArray(value) ? value[0] : value;

  return INVENTORY_CATEGORY_VALUES.find((category) => category === raw) ?? null;
}

function mapCaptureSession(
  session: Awaited<ReturnType<typeof getActiveInventoryCaptureSession>>,
): Parameters<typeof InventoryCaptureSessionCard>[0]["session"] {
  return session
    ? {
        ...session,
        container: session.container
          ? {
              id: session.container.id,
              locationName: session.container.locationName,
              name: session.container.name,
              referenceId: session.container.referenceId,
              sizeLiters: session.container.sizeLiters,
              visualPresetKey: session.container.visualPresetKey,
            }
          : null,
      }
    : null;
}
