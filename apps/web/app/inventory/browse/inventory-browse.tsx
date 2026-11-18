"use client";

import {
  Flex,
  Grid,
  Box,
  Text,
  Button,
  Checkbox,
} from "@chakra-ui/react";

import { XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DataPanel } from "@/components/shared/data-panel";
import { FilterSelect } from "@/components/shared/filter-select";
import { exportInventoryItemsFromBrowser, listInventoryItemsFromBrowser } from "@/lib/quantself-api-browser";
import type { InventoryShellItem } from "../inventory-shell-data";
import { mapInventoryShellItem } from "../inventory-shell-item-mapper";
import { DataToolbar } from "@/components/shared/data-toolbar";
import { TablePagination } from "@/components/shared/table-pagination";
import {
  useInventoryPanelPage,
  INVENTORY_PANEL_PAGE_SIZE,
} from "../use-inventory-panel-page";
import {
  categoryOptions,
  controlledFilterValue,
  evidenceOptions,
  evidenceValues,
  importanceOptions,
  importanceValues,
  itemKindOptions,
  itemKindValues,
  itemStatusOptions,
  itemStatusValues,
  inventoryCategoryValues,
  type InventoryBrowseFilterOption,
  workflowOptions,
  workflowValues,
} from "./inventory-browse-filter-options";
import { InventoryBrowseGrid } from "./inventory-browse-grid";
import { useInventoryPanelExport } from "../use-inventory-panel-export";

export const INVENTORY_BROWSE_SEARCH_DEBOUNCE_MS = 300;

type InventoryBrowseProps = {
  containerOptions: InventoryBrowseFilterOption[];
  initialContainerId: string;
  items: InventoryShellItem[];
  nextCursor: string | null;
  total: number;
};

export type BrowseFilters = {
  category: string;
  containerId: string;
  evidence: string;
  importance: string;
  includeUnready: boolean;
  kind: string;
  query: string;
  status: string;
  workflow: string;
};

export function InventoryBrowse({
  containerOptions,
  initialContainerId,
  items,
  nextCursor: initialNextCursor,
  total: initialTotal,
}: InventoryBrowseProps) {
  const searchParams = useSearchParams();
  const panel = useInventoryPanelPage({
    pathname: "/inventory/browse",
    initial: {
      items,
      pageInfo: { nextCursor: initialNextCursor },
      total: initialTotal,
    },
    loadPage: async (params, signal) => {
      const page = await listInventoryItemsFromBrowser(
        {
          ...browserQuery(browseFiltersFromSearchParams(params, "")),
          cursor: params.get("cursor"),
        },
        { signal },
      );
      return { ...page, items: page.items.map(mapInventoryShellItem) };
    },
  });
  const urlKey = panel.params.toString();
  const [filters, setFilters] = useState(() =>
    browseFiltersFromSearchParams(searchParams, initialContainerId),
  );
  const filtersRef = useRef(filters);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const next = browseFiltersFromSearchParams(new URLSearchParams(urlKey), "");
    filtersRef.current = next;
    setFilters(next);
  }, [urlKey]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function updateFilters(next: BrowseFilters) {
    if (timer.current) clearTimeout(timer.current);
    filtersRef.current = next;
    setFilters(next);
    panel.changeFilters(browseFiltersSearchParams(next));
  }
  function updateQuery(query: string) {
    const next = { ...filtersRef.current, query };
    if (timer.current) clearTimeout(timer.current);
    filtersRef.current = next;
    setFilters(next);
    timer.current = setTimeout(
      () => panel.changeFilters(browseFiltersSearchParams(next)),
      INVENTORY_BROWSE_SEARCH_DEBOUNCE_MS,
    );
  }
  const {
    items: loadedItems,
    total,
    loading: isLoading,
    error: loadError,
    retry,
  } = panel;

  const panelExport = useInventoryPanelExport(
    (signal) => exportInventoryItemsFromBrowser(
      browserQuery(browseFiltersFromSearchParams(panel.params, "")),
      signal,
    ),
    "inventory.csv",
  );
  const searchSettled = filters.query.trim() === (panel.params.get("q")?.trim() ?? "");

  return (
    <Box
      as="section"
      aria-label="Browse inventory"
      onClickCapture={panel.savePosition}
    >
      <DataPanel>
        <DataToolbar
          exportsDisabled={!panel.ready || !searchSettled || panelExport.pending}
          query={filters.query}
          onQuery={updateQuery}
          placeholder="Search inventory"
          count={panel.ready ? `${total} items` : ""}
          copyLabel="Copy all matching IDs"
          downloadLabel="Download all matching items"
          onCopy={panelExport.copy}
          onDownload={panelExport.download}
        />
        <Grid p="4" gap="4">
          <FilterToolbar
            containerOptions={containerOptions}
            filters={filters}
            onChange={updateFilters}
          />

          {panelExport.pending && <Text role="status">Preparing export…</Text>}
          {panelExport.error && <Text role="alert">{panelExport.error}</Text>}
          {isLoading ? (
            <Text role="status" color="fg.muted" textStyle="sm">
              Loading items…
            </Text>
          ) : null}
          {loadError ? (
            <Flex alignItems="center" gap="2">
              <Text role="alert" color="fg.error" textStyle="sm">
                {loadError}
              </Text>
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
        {panel.ready && (
          <InventoryBrowseGrid items={loadedItems} returnTo={panel.returnTo} />
        )}
        {panel.ready && (
          <TablePagination
            count={total!}
            pageSize={INVENTORY_PANEL_PAGE_SIZE}
            page={panel.page}
            availablePages={isLoading ? [panel.page] : panel.availablePages}
            onPageChange={panel.changePage}
          />
        )}
        <Text px="4" pb="2" textStyle="xs" color="fg.muted">
          Pages become available as you browse.
        </Text>
      </DataPanel>
    </Box>
  );
}

function FilterToolbar({
  containerOptions,
  filters,
  onChange,
}: {
  containerOptions: InventoryBrowseFilterOption[];
  filters: BrowseFilters;
  onChange: (filters: BrowseFilters) => void;
}) {
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <Flex
      flexWrap="wrap"
      alignItems="center"
      gap="2"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="border"
      background="bg"
      p="3"
    >
      <InventoryFilterSelect
        allLabel="All containers"
        ariaLabel="Container filter"
        onChange={(containerId) => onChange({ ...filters, containerId })}
        options={containerOptions}
        value={filters.containerId}
      />
      <InventoryFilterSelect
        allLabel="All item types"
        ariaLabel="Item type filter"
        onChange={(kind) => onChange({ ...filters, kind })}
        options={itemKindOptions}
        value={filters.kind}
      />
      <InventoryFilterSelect
        allLabel="All statuses"
        ariaLabel="Item status filter"
        onChange={(status) => onChange({ ...filters, status })}
        options={itemStatusOptions}
        value={filters.status}
      />
      <InventoryFilterSelect
        allLabel="All importance"
        ariaLabel="Importance filter"
        onChange={(importance) => onChange({ ...filters, importance })}
        options={importanceOptions}
        value={filters.importance}
      />
      <InventoryFilterSelect
        allLabel="All evidence"
        ariaLabel="Evidence filter"
        onChange={(evidence) => onChange({ ...filters, evidence })}
        options={evidenceOptions}
        value={filters.evidence}
      />
      <InventoryFilterSelect
        allLabel="All workflow"
        ariaLabel="Workflow status filter"
        onChange={(workflow) => onChange({ ...filters, workflow })}
        options={workflowOptions}
        value={filters.workflow}
      />
      <Flex
        minHeight={{ base: "9", sm: "8" }}
        alignItems="center"
        gap="2"
        borderRadius="lg"
        borderWidth="1px"
        borderColor="border"
        background="bg"
        px="3"
        textStyle={{ base: "md", sm: "sm" }}
      >
        <Checkbox.Root
          checked={filters.includeUnready}
          onCheckedChange={({ checked }) =>
            onChange({ ...filters, includeUnready: checked === true })
          }
        >
          <Checkbox.HiddenInput id="inventory-browse-include-unready" />
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Label>Include unready items</Checkbox.Label>
        </Checkbox.Root>
      </Flex>
      <InventoryFilterSelect
        allLabel="All categories"
        ariaLabel="Category filter"
        onChange={(category) => onChange({ ...filters, category })}
        options={categoryOptions}
        value={filters.category}
      />
      {hasFilters ? (
        <Button
          type="button"
          aria-label="Clear browse filters"
          onClick={() => onChange(clearedBrowseFilters())}
          size="sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      ) : null}
    </Flex>
  );
}

export function clearedBrowseFilters(): BrowseFilters {
  return {
    category: "",
    containerId: "",
    evidence: "",
    importance: "",
    includeUnready: false,
    kind: "",
    query: "",
    status: "",
    workflow: "",
  };
}

function InventoryFilterSelect({
  allLabel,
  ariaLabel,
  onChange,
  options,
  value,
}: {
  allLabel: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  options: InventoryBrowseFilterOption[];
  value: string;
}) {
  return (
    <Box width={{ base: "full", sm: "44" }}>
      <FilterSelect
        label={ariaLabel}
        w="full"
        items={[{ label: allLabel, value: "__all" }, ...options]}
        value={value || "__all"}
        onChange={(v) => onChange(v === "__all" ? "" : v)}
      />
    </Box>
  );
}

function browserQuery(filters: BrowseFilters) {
  return {
    category: filters.category,
    containerId: filters.containerId,
    evidence: filters.evidence,
    importance: filters.importance,
    includeUnready: filters.includeUnready,
    kind: filters.kind,
    q: filters.query,
    status: filters.status,
    workflow: filters.workflow,
  };
}

export function browseFiltersFromSearchParams(
  searchParams: { get(name: string): string | null },
  initialContainerId: string,
): BrowseFilters {
  return {
    category:
      controlledFilterValue(
        searchParams.get("category"),
        inventoryCategoryValues,
      ) ?? "",
    containerId: searchParams.get("containerId") ?? initialContainerId,
    evidence:
      controlledFilterValue(searchParams.get("evidence"), evidenceValues) ?? "",
    importance:
      controlledFilterValue(searchParams.get("importance"), importanceValues) ??
      "",
    includeUnready: searchParams.get("includeUnready") === "1",
    kind: controlledFilterValue(searchParams.get("kind"), itemKindValues) ?? "",
    query: searchParams.get("q") ?? "",
    status:
      controlledFilterValue(searchParams.get("status"), itemStatusValues) ?? "",
    workflow:
      controlledFilterValue(searchParams.get("workflow"), workflowValues) ?? "",
  };
}

export function browseFiltersSearchParams(
  filters: BrowseFilters,
): URLSearchParams {
  const searchParams = new URLSearchParams();
  const entries = [
    ["q", filters.query],
    ["containerId", filters.containerId],
    ["kind", filters.kind],
    ["status", filters.status],
    ["importance", filters.importance],
    ["evidence", filters.evidence],
    ["workflow", filters.workflow],
    ["category", filters.category],
  ] as const;

  for (const [key, value] of entries) {
    if (value) {
      searchParams.set(key, value);
    }
  }

  if (filters.includeUnready) {
    searchParams.set("includeUnready", "1");
  }

  return searchParams;
}

function browseFiltersKey(filters: BrowseFilters): string {
  return browseFiltersSearchParams(filters).toString();
}

export function browseReturnTo(filters: BrowseFilters): string {
  const searchParams = browseFiltersSearchParams(filters);

  return `/inventory/browse${searchParams.size > 0 ? `?${searchParams}` : ""}`;
}
