import { Badge, Flex, Text } from "@chakra-ui/react";
import { DataGrid, DataGridRow } from "@/components/shared/data-panel";
import {
  InventoryItemEvidenceBadges,
  InventoryItemWhere,
  inventoryShellItemCardModel,
} from "../inventory-item-card";
import {
  InventoryItemMediaPreview,
  InventoryItemMediaProvider,
  useInventoryItemAudioHoverHandlers,
} from "../inventory-item-media-preview";
import { InventoryStatusBadge } from "../inventory-shell";
import {
  formatInventoryShellCategory,
  type InventoryShellItem,
} from "../inventory-shell-data";
import { buildInventoryItemHref } from "../item-navigation";

const columns = "minmax(10rem, 1.3fr) minmax(9rem, 1fr) 11rem minmax(10rem, 1fr)";
const headers = [
  { label: "Item" },
  { label: "Location" },
  { label: "Status" },
  { label: "Evidence" },
];

export function InventoryBrowseGrid({
  items,
  returnTo,
}: {
  items: InventoryShellItem[];
  returnTo: string;
}) {
  return (
    <InventoryItemMediaProvider>
      <DataGrid
        label="Inventory items"
        columns={columns}
        minW="740px"
        headers={headers}
        empty="No matching inventory. Clear or change filters."
      >
        {items.map((item) => (
          <InventoryBrowseGridRow key={item.id} item={item} returnTo={returnTo} />
        ))}
      </DataGrid>
    </InventoryItemMediaProvider>
  );
}

function InventoryBrowseGridRow({
  item,
  returnTo,
}: {
  item: InventoryShellItem;
  returnTo: string;
}) {
  const model = inventoryShellItemCardModel(item);
  const interactivePreview =
    model.media.type === "audio" || model.media.type === "video";

  // Only the title sits above the row link's hover area.
  const audio = model.media.type === "audio" ? model.media : undefined;
  const audioHandlers = useInventoryItemAudioHoverHandlers(
    audio?.audioId ?? null,
    audio?.src,
  );

  return (
    <DataGridRow
      columns={columns}
      href={buildInventoryItemHref(item.id, returnTo)}
      prefetch={false}
      linkProps={audioHandlers && {
        onFocus: audioHandlers.onFocus,
        onBlur: audioHandlers.onBlur,
      }}
    >
      <Text
        as="span"
        fontWeight="medium"
        overflowWrap="anywhere"
        position={audioHandlers ? "relative" : undefined}
        zIndex={audioHandlers ? 1 : undefined}
        onMouseEnter={audioHandlers?.onMouseEnter}
        onMouseLeave={audioHandlers?.onMouseLeave}
      >
        {model.title}
      </Text>
      <InventoryItemWhere item={model} rowLink />
      <Flex gap="1" wrap="wrap">
        <InventoryStatusBadge status={model.status} />
        <InventoryStatusBadge status={model.importance} />
        {model.totalQuantity > 1 && (
          <Badge variant="subtle">× {model.totalQuantity}</Badge>
        )}
        {item.category && (
          <Badge variant="outline">
            {formatInventoryShellCategory(item.category)}
          </Badge>
        )}
      </Flex>
      <Flex align="center" gap="2">
        <InventoryItemMediaPreview
          compact
          imagePresentation="contain-transparent-perimeter"
          media={model.media}
          css={{
            boxSize: "12",
            flexShrink: 0,
            borderRadius: "md",
            borderWidth: "1px",
            zIndex: interactivePreview ? 1 : undefined,
            _focusWithin: {
              outline: "2px solid",
              outlineColor: "colorPalette.focusRing",
            },
          }}
        />
        <InventoryItemEvidenceBadges kinds={model.evidenceKinds} />
      </Flex>
    </DataGridRow>
  );
}
