"use client";

import { Flex, Grid, Text, Button } from "@chakra-ui/react";

import { ArchiveRestoreIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DataToolbar } from "@/components/shared/data-toolbar";
import { TablePagination } from "@/components/shared/table-pagination";
import { FilterSelect } from "@/components/shared/filter-select";
import { exportInventoryItemsFromBrowser, listInventoryItemsFromBrowser } from "@/lib/quantself-api-browser";
import {
  categoryOptions,
  itemStatusOptions,
  controlledFilterValue,
  inventoryCategoryValues,
  itemStatusValues,
} from "../browse/inventory-browse-filter-options";
import {
  useInventoryPanelPage,
  INVENTORY_PANEL_PAGE_SIZE,
} from "../use-inventory-panel-page";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { buildInventoryItemHref } from "../item-navigation";
import { useInventoryPanelExport } from "../use-inventory-panel-export";

type InventoryArchiveItem = {
  archivedAt: string;
  containerLabel: string;
  containerReferenceId: string | null;
  id: string;
  title: string;
};

type MutationState = {
  status: "idle" | "success" | "error";
  message: string;
  uncertain?: boolean;
};

type RestoreAction = (
  state: MutationState,
  formData: FormData,
) => Promise<MutationState>;

const initialState: MutationState = { message: "", status: "idle" };
const columns = "minmax(9rem, 1fr) minmax(10rem, 1fr) 8rem 6rem";
const headers = [
  { label: "Item" },
  { label: "Last container" },
  { label: "Archived" },
  { label: "Actions", align: "right" as const },
];

export function InventoryArchiveList({
  items,
  query,
  returnTo,
  restoreAction,
  archiveAction,
  nextCursor = null,
  total = items.length,
}: {
  items: InventoryArchiveItem[];
  nextCursor?: string | null;
  total?: number;
  query: string;
  returnTo: string;
  restoreAction: RestoreAction;
  archiveAction?: RestoreAction;
}) {
  const panel = useInventoryPanelPage({
    pathname: "/inventory/archive",
    initial: { items, total, pageInfo: { nextCursor } },
    loadPage: async (params, signal) => {
      const page = await listInventoryItemsFromBrowser(
        {
          ...archiveFilters(params),
          cursor: params.get("cursor"),
        },
        { signal },
      );
      return {
        ...page,
        items: page.items.map((item) => ({
          id: item.id,
          title: item.title,
          archivedAt: item.archivedAt ?? "",
          containerLabel: item.placements[0]?.label ?? "Unplaced",
          containerReferenceId: null,
        })),
      };
    },
  });
  const [pendingCount, setPendingCount] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const commands = useRef(
    new Map<string, { hide: boolean; form: FormData; uncertain: boolean }>(),
  );
  const [uncertainIds, setUncertainIds] = useState<string[]>([]);
  const desired = useRef(new Map<string, boolean>());
  const confirmed = useRef(new Map<string, boolean>());
  const [undo, setUndo] = useState<Array<{ id: string; hidden: boolean }>>([]);
  const [redo, setRedo] = useState<Array<{ id: string; hidden: boolean }>>([]);
  const [search, setSearch] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlKey = panel.params.toString();
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setSearch(new URLSearchParams(urlKey).get("q") ?? "");
  }, [urlKey]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const [message, setMessage] = useState("");
  const visibleItems = panel.items.filter((item) => !hidden.has(item.id));
  const panelExport = useInventoryPanelExport(
    async (signal) => {
      const rows = await exportInventoryItemsFromBrowser(archiveFilters(panel.params), signal);
      return rows.filter(({ id }) => !hidden.has(id));
    },
    "inventory-archive.csv",
  );
  const searchSettled = search.trim() === (panel.params.get("q")?.trim() ?? "");
  const pendingUndo = [...desired.current].some(([id, hide]) =>
    !hide && (pending.current.has(id) || commands.current.has(id) || confirmed.current.get(id)),
  );
  function filter(name: string, value: string) {
    if (timer.current) clearTimeout(timer.current);
    const params = new URLSearchParams(panel.params);
    if (search) params.set("q", search);
    else params.delete("q");
    if (value) params.set(name, value);
    else params.delete(name);
    panel.changeFilters(params);
  }
  function project(itemId: string, hide: boolean) {
    setHidden((current) => {
      const next = new Set(current);
      if (hide) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }
  function intent(itemId: string, hide: boolean) {
    desired.current.set(itemId, hide);
    project(itemId, hide);
    if (![...commands.current.values()].some((entry) => entry.uncertain))
      setMessage("");
    if (!commands.current.get(itemId)?.uncertain) void save(itemId);
  }
  function restore(itemId: string) {
    setUndo((entries) => [...entries, { id: itemId, hidden: true }]);
    setRedo([]);
    intent(itemId, true);
  }
  async function save(itemId: string) {
    if (pending.current.has(itemId)) return;
    pending.current.add(itemId);
    setPendingCount(pending.current.size);
    try {
      while (
        commands.current.has(itemId) ||
        (desired.current.get(itemId) ?? false) !==
          (confirmed.current.get(itemId) ?? false)
      ) {
        let command = commands.current.get(itemId);
        if (!command) {
          const form = new FormData();
          form.set("itemId", itemId);
          command = {
            hide: desired.current.get(itemId)!,
            form,
            uncertain: false,
          };
          commands.current.set(itemId, command);
        }
        const { hide, form } = command;
        try {
          const action = hide ? restoreAction : archiveAction;
          const state: MutationState = action
            ? await action(initialState, form)
            : { status: "error", message: "Cannot undo this restore." };
          if (state.status !== "success") {
            if (state.uncertain || command.uncertain)
              throw new Error(state.message);
            // Only an authoritative rejection permits rollback. Preserve other items.
            setMessage(state.message || "Could not save item.");
            const previous = confirmed.current.get(itemId) ?? false;
            desired.current.set(itemId, previous);
            project(itemId, previous);
            setUndo((entries) =>
              entries.filter((entry) => entry.id !== itemId),
            );
            setRedo((entries) =>
              entries.filter((entry) => entry.id !== itemId),
            );
            commands.current.delete(itemId);
            break;
          }
          confirmed.current.set(itemId, hide);
          commands.current.delete(itemId);
          setUncertainIds((ids) => ids.filter((id) => id !== itemId));
          if (![...commands.current.values()].some((entry) => entry.uncertain))
            setMessage((message) =>
              message.startsWith("Save unconfirmed.") ? "" : message,
            );
        } catch {
          // Delivery may have committed. Retry this exact absolute-state operation
          // before dispatching any later intent, including Undo/Redo.
          command.uncertain = true;
          setUncertainIds((ids) =>
            ids.includes(itemId) ? ids : [...ids, itemId],
          );
          setMessage(
            "Save unconfirmed. Retry to reconcile; your latest changes are preserved.",
          );
          break;
        }
      }
    } finally {
      pending.current.delete(itemId);
      setPendingCount(pending.current.size);
    }
  }

  return (
    <DataPanel>
      <DataToolbar
        exportsDisabled={!panel.ready || !searchSettled || pendingUndo || panelExport.pending}
        query={search}
        onQuery={(value) => {
          setSearch(value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => filter("q", value), 300);
        }}
        placeholder="Search archived inventory"
        count={panel.ready ? `${panel.total} archived` : ""}
        copyLabel="Copy all matching IDs"
        downloadLabel="Download all matching items"
        onCopy={panelExport.copy}
        onDownload={panelExport.download}
      />
      <Grid p="4" gap="4">
        {panelExport.pending && <Text role="status">Preparing export…</Text>}
        {panelExport.error && <Text role="alert">{panelExport.error}</Text>}
        {pendingUndo && <Text role="status">Exports resume when the archive change is confirmed.</Text>}
        {pendingCount > 0 && (
          <Text role="status" color="fg.muted" textStyle="sm">
            Saving…
          </Text>
        )}
        {archiveAction && (
          <Flex gap="2">
            <Button
              size="sm"
              variant="outline"
              disabled={!undo.length}
              onClick={() => {
                const entry = undo.at(-1)!;
                setUndo(undo.slice(0, -1));
                setRedo([...redo, entry]);
                intent(entry.id, !entry.hidden);
              }}
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!redo.length}
              onClick={() => {
                const entry = redo.at(-1)!;
                setRedo(redo.slice(0, -1));
                setUndo([...undo, entry]);
                intent(entry.id, entry.hidden);
              }}
            >
              Redo
            </Button>
          </Flex>
        )}
        <Flex gap="2" wrap="wrap">
          <FilterSelect
            w="44"
            label="Category filter"
            value={panel.params.get("category") || "__all"}
            items={[
              { label: "All categories", value: "__all" },
              ...categoryOptions,
            ]}
            onChange={(value) =>
              filter("category", value === "__all" ? "" : value)
            }
          />
          <FilterSelect
            w="44"
            label="Item status filter"
            value={panel.params.get("status") || "__all"}
            items={[
              { label: "All statuses", value: "__all" },
              ...itemStatusOptions,
            ]}
            onChange={(value) =>
              filter("status", value === "__all" ? "" : value)
            }
          />
        </Flex>
        {panel.loading && <Text role="status">Loading archived items…</Text>}
        {panel.error && (
          <Flex gap="2">
            <Text role="alert">{panel.error}</Text>
            <Button onClick={panel.retry}>Retry</Button>
          </Flex>
        )}
        {uncertainIds.length > 0 && (
          <Button
            onClick={async () => {
              for (let offset = 0; offset < uncertainIds.length; offset += 4) {
                await Promise.all(uncertainIds.slice(offset, offset + 4).map(save));
              }
            }}
          >
            Retry unconfirmed saves
          </Button>
        )}
        {message ? (
          <Text aria-live="polite" color="fg.muted" textStyle="sm">
            {message}
          </Text>
        ) : null}
      </Grid>
      {panel.ready && (
        <>
          <DataGrid
            label="Archived inventory"
            columns={columns}
            minW="620px"
            headers={headers}
            empty={panel.params.has("q")
              ? "No archived items match this search."
              : "No archived items."}
          >
            {visibleItems.map((item) => (
              <DataGridRow
                key={item.id}
                columns={columns}
                href={buildInventoryItemHref(item.id, panel.returnTo || returnTo)}
                linkProps={{ onClick: panel.savePosition }}
                prefetch={false}
              >
                <Text as="span" fontWeight="medium" overflowWrap="anywhere">
                  {item.title}
                </Text>
                <Text overflowWrap="anywhere">
                  {item.containerLabel}
                  {item.containerReferenceId && ` · ${item.containerReferenceId}`}
                </Text>
                <Text color="fg.muted">{formatArchivedDate(item.archivedAt)}</Text>
                <Button
                  aria-label={`Restore ${item.title}`}
                  justifySelf="end"
                  onClick={() => restore(item.id)}
                  position="relative"
                  size="sm"
                  type="button"
                  variant="outline"
                  zIndex={1}
                >
                  <ArchiveRestoreIcon aria-hidden="true" />
                  Restore
                </Button>
              </DataGridRow>
            ))}
          </DataGrid>
          <TablePagination
            count={panel.total!}
            pageSize={INVENTORY_PANEL_PAGE_SIZE}
            page={panel.page}
            availablePages={panel.availablePages}
            onPageChange={panel.changePage}
          />
        </>
      )}
      <Text px="4" pb="2" textStyle="xs" color="fg.muted">
        Pages become available as you browse.
      </Text>
    </DataPanel>
  );
}

function formatArchivedDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat("en-CA", {
        dateStyle: "medium",
      }).format(date);
}


function archiveFilters(params: URLSearchParams) {
  return {
    archived: true,
    q: params.get("q") || "",
    category: controlledFilterValue(params.get("category"), inventoryCategoryValues) ?? "",
    status: controlledFilterValue(params.get("status"), itemStatusValues) ?? "",
  };
}
