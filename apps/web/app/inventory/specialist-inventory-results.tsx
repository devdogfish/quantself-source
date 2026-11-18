"use client";

import { useCallback } from "react";
import { Badge, Button, Flex, Grid, Text } from "@chakra-ui/react";
import { listInventoryItemsFromBrowser } from "@/lib/quantself-api-browser";
import type { InventoryItem } from "@/lib/quantself-api-client";
import * as inventoryActions from "./actions";
import {
  InventoryItemCard,
  inventoryItemSearchCardModel,
} from "./inventory-item-card";
import { InventoryItemMediaProvider } from "./inventory-item-media-preview";
import { usePaginatedInventoryCollection } from "./use-paginated-inventory-collection";

const SPECIALIST_HISTORY_STATE_KEY = "quantself:inventory-specialist";

export function SpecialistInventoryResults({
  filterKey,
  ...props
}: SpecialistInventoryResultsProps) {
  return (
    <SpecialistInventoryResultsForFilter
      {...props}
      filterKey={filterKey}
      key={filterKey}
    />
  );
}

type SpecialistInventoryResultsProps = {
  category: "clothing" | "food" | "homeopathy" | "supplement";
  clothingState?: "clean" | "dirty" | null;
  emptyLabel: string;
  filterKey: string;
  initialItems: InventoryItem[];
  initialNextCursor: string | null;
  initialTotal: number;
  query: string;
  returnTo: string;
};

function SpecialistInventoryResultsForFilter({
  category,
  clothingState = null,
  emptyLabel,
  filterKey,
  initialItems,
  initialNextCursor,
  initialTotal,
  query,
  returnTo,
}: SpecialistInventoryResultsProps) {
  const loadPage = useCallback(
    (cursor: string | null) =>
      listInventoryItemsFromBrowser({
        category,
        clothingState:
          category === "clothing" ? (clothingState ?? undefined) : undefined,
        cursor,
        q: query || undefined,
      }),
    [category, clothingState, query],
  );
  const { error, isLoading, items, retry, sentinelRef, total } =
    usePaginatedInventoryCollection({
      filterKey,
      historyStateKey: SPECIALIST_HISTORY_STATE_KEY,
      initialFilterKey: filterKey,
      initialItems,
      initialNextCursor,
      initialTotal,
      loadPage,
    });

  return (
    <Grid gap="3" minW="0">
      <Text color="fg.muted" textStyle="sm">
        {total} item{total === 1 ? "" : "s"}
      </Text>
      {items.length > 0 ? (
        <InventoryItemMediaProvider>
          <Grid gap="3" templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }}>
            {items.map((item) => (
              <InventoryItemCard
                footer={
                  category === "clothing" ? (
                    <ClothingWardrobeItemFooter
                      item={item}
                      returnTo={returnTo}
                    />
                  ) : null
                }
                item={inventoryItemSearchCardModel(item)}
                key={item.id}
                returnTo={returnTo}
                variant="compact"
              />
            ))}
          </Grid>
        </InventoryItemMediaProvider>
      ) : (
        <Text rounded="xl" borderWidth="1px" borderStyle="dashed" bg="bg.subtle" px="3" py="4" color="fg.muted" textStyle="sm">
          {query
            ? `No matching ${emptyLabel} inventory.`
            : `No ${emptyLabel} inventory yet.`}
        </Text>
      )}
      <div aria-hidden="true" ref={sentinelRef} />
      {isLoading ? (
        <Text role="status" color="fg.muted" textStyle="sm">Loading more items…</Text>
      ) : null}
      {error ? (
        <Flex align="center" gap="2">
          <Text role="alert" color="fg.error" textStyle="sm">{error}</Text>
          <Button
            type="button"
            onClick={() => void retry()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </Flex>
      ) : null}
    </Grid>
  );
}

function ClothingWardrobeItemFooter({
  item,
  returnTo,
}: {
  item: InventoryItem;
  returnTo: string;
}) {
  if (item.category !== "clothing" || !item.clothingProfile) {
    return null;
  }

  const dirtyQuantity =
    item.clothingProfile.dirtyQuantity ??
    (item.clothingProfile.isDirty ? item.totalQuantity : 0);
  const cleanQuantity = Math.max(0, item.totalQuantity - dirtyQuantity);

  return (
    <Flex wrap="wrap" align="center" justify="space-between" gap="2">
      <Badge variant="subtle" colorPalette={dirtyQuantity > 0 ? "red" : "gray"}>
        {cleanQuantity} clean · {dirtyQuantity} dirty
      </Badge>
      <Flex wrap="wrap" justify="end" gap="2">
        {dirtyQuantity > 0 ? (
          <form
            action={
              inventoryActions.completeInventoryClothingLaundryRedirectAction
            }
          >
            <input name="mode" type="hidden" value="selected" />
            <input name="itemId" type="hidden" value={item.id} />
            <input name="returnTo" type="hidden" value={returnTo} />
            <Button size="sm" type="submit" variant="outline">
              Laundry 1
            </Button>
          </form>
        ) : null}
        {cleanQuantity > 0 ? (
          <form
            action={
              inventoryActions.markInventoryClothingItemWornRedirectAction
            }
          >
            <input name="itemId" type="hidden" value={item.id} />
            <input name="returnTo" type="hidden" value={returnTo} />
            <Button size="sm" type="submit">
              Wore 1
            </Button>
          </form>
        ) : null}
      </Flex>
    </Flex>
  );
}
