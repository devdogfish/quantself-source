import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Grid,
  Image,
  Text,
} from "@chakra-ui/react";
import {
  itemButton,
  itemSecondaryButton,
} from "./inventory-item-button-styles";
import {
  approveInventoryEnrichmentProposalWithStateAction,
  rejectInventoryEnrichmentProposalWithStateAction,
} from "@/app/settings/inventory-actions";
import { InventoryProposalActions } from "@/app/settings/inventory-proposal-actions";
import * as inventoryActions from "@/app/inventory/actions";
import { CheckIcon, XIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import React, { Suspense } from "react";

import {
  formatInventoryAcquisitionSourceLabel,
  formatInventoryCategoryLabel,
  formatInventoryContainerLabel,
  formatInventoryEstimatedValue,
} from "@/lib/inventory-client-contract";
import {
  InventoryEvidenceBadges,
  InventoryMetaGrid,
  InventoryShellCard,
  InventoryShellLayout,
} from "../../inventory-shell";
import {
  formatInventoryShellAcquisitionSource,
  formatInventoryShellCategory,
  formatInventoryShellContainer,
  formatInventoryShellEstimatedValue,
  formatInventoryShellWhere,
  getInventoryShellDetailMode,
  getInventoryShellItem,
  type InventoryShellDetailMode,
  type InventoryShellItem,
} from "../../inventory-shell-data";
import {
  getInventoryItem,
  listInventoryContainers,
  listInventoryLocations,
  listInventoryProposals,
  inventoryItemMediaContentPath,
  isApiNotFoundError,
  listInventoryItemMedia,
  type InventoryItemMedia,
  type InventoryItem,
  type InventoryProposal,
} from "@/lib/quantself-api-client";
import { sanitizeInventoryItemReturnTo } from "../../item-navigation";
import { InventoryItemBackLink } from "./inventory-item-back-link";
import {
  InventoryItemControls,
  type InventoryItemContainerOption,
  type InventoryItemEditableViewModel,
} from "./inventory-item-controls";
import { InventoryItemImageManager } from "./inventory-item-image-manager";
import { InventoryClothingProfileCard } from "./inventory-clothing-profile-card";
import { InventoryRemedyProfileCard } from "./inventory-remedy-profile-card";
import { InventoryItemMediaManager } from "./inventory-item-media-manager";
import {
  InventoryItemStockCard,
  type InventoryStockLocationOption,
} from "./inventory-item-stock-card";
import { InventoryItemCollapsibleText } from "./inventory-item-collapsible-text";
import { InventoryItemWorkflowCard } from "./inventory-item-workflow-card";
import InventoryItemLoading from "./loading";

type InventoryItemPageProps = {
  params: Promise<{
    itemId: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const detailTitles: Record<InventoryShellDetailMode, string> = {
  complete: "Complete item detail",
  error: "Needs review",
  processing: "Processing queue",
  proposal: "Proposal review",
};

const detailCardDescriptions: Partial<
  Record<InventoryShellDetailMode, string>
> = {
  complete:
    "Read-only final status after Inventory Proposal approval and applied derived values.",
  error:
    "Inventory Preprocessing produced a review status. Keep partial text visible and let the user choose the next step.",
};

const REVIEWABLE_PROPOSAL_FIELDS = new Set([
  "title",
  "category",
  "acquisitionSource",
  "costCents",
  "tags",
  "aliases",
  "status",
  "importance",
  "note",
]);

export default function InventoryItemPage({
  params,
  searchParams,
}: InventoryItemPageProps) {
  return (
    <Suspense fallback={<InventoryItemLoading />}>
      <InventoryItemPageContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function InventoryItemPageContent({
  params,
  searchParams,
}: InventoryItemPageProps) {
  const { itemId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const returnTo = sanitizeInventoryItemReturnTo(resolvedSearchParams.returnTo);
  const initialEditOpen = firstSearchParam(resolvedSearchParams.edit) === "1";
  const editHref = buildInventoryEditHref(itemId, returnTo);
  const pageHref = buildInventoryItemPageHref(
    itemId,
    returnTo,
    initialEditOpen,
  );
  const clothingActionState =
    inventoryClothingActionState(resolvedSearchParams);
  const inventoryItem = await loadInventoryItemSummary(itemId);

  if (inventoryItem.archivedAt) {
    return (
      <ArchivedInventoryItemPage item={inventoryItem} returnTo={returnTo} />
    );
  }

  const [proposal, containers, locations, media] = await Promise.all([
    getPendingInventoryProposal(itemId),
    listInventoryContainers(),
    listInventoryLocations(),
    listInventoryItemMedia(itemId),
  ]);
  const containerOptions = containers.map((container) => ({
    id: container.id,
    label: `${container.name} (${container.referenceId})`,
  }));
  const locationOptions = locations.map((location) => ({
    id: location.id,
    label: location.name,
  }));

  if (proposal) {
    return (
      <RealProposalItemPage
        containers={containerOptions}
        locations={locationOptions}
        media={media}
        item={inventoryItem}
        proposal={proposal}
        initialEditOpen={initialEditOpen}
        returnTo={returnTo}
      />
    );
  }

  return (
    <RealInventoryItemPage
      clothingActionState={clothingActionState}
      containers={containerOptions}
      editHref={editHref}
      initialEditOpen={initialEditOpen}
      locations={locationOptions}
      media={media}
      pageHref={pageHref}
      item={inventoryItem}
      returnTo={returnTo}
    />
  );
}

async function loadInventoryItemSummary(
  itemId: string,
): Promise<InventoryItem> {
  try {
    return await getInventoryItem(itemId);
  } catch (error) {
    if (isApiNotFoundError(error)) {
      notFound();
    }

    throw error;
  }
}

function ArchivedInventoryItemPage({
  item,
  returnTo,
}: {
  item: InventoryItem;
  returnTo: Route;
}) {
  return (
    <InventoryShellLayout
      active="item"
      focusItemId={item.id}
      title={item.title}
    >
      <InventoryItemBackLink href={returnTo} />
      <Box
        as="section"
        display="grid"
        gap="4"
        css={{
          "@media (width >= 80rem)": {
            gridTemplateColumns: "minmax(0, 1.15fr) minmax(19rem, .85fr)",
          },
        }}
      >
        <InventoryShellCard
          description="Archived Inventory Items stay available for direct historical reference."
          title="Archived item detail"
        >
          <Flex flexWrap="wrap" gap="2">
            <Badge
              borderRadius="full"
              size="sm"
              flexShrink={0}
              w="fit-content"
              variant="outline"
            >
              Archived
            </Badge>
          </Flex>
          <InventoryMetaGrid
            entries={[
              {
                label: "Archived",
                value: formatDateTime(item.archivedAt ?? ""),
              },
              {
                label: "Total quantity",
                value: String(item.totalQuantity),
              },
              {
                label: "Primary image",
                value: item.imageId ? "Available" : "None",
              },
            ]}
          />
          {item.imageId ? (
            <Image
              alt={item.title}
              maxH="80"
              borderRadius="0.875rem"
              borderWidth="1px"
              borderColor="border"
              objectFit="cover"
              src={inventoryItemMediaContentPath(item.id, item.imageId)}
            />
          ) : null}
        </InventoryShellCard>

        <Box as="aside" display="grid" alignContent="start" gap="4">
          <InventoryRowsCard title="Placements">
            {item.placements.length > 0 ? (
              <Box as="ul" display="grid" gap="3" px="4" py="4" fontSize="sm">
                {item.placements.map((placement) => (
                  <Box
                    as="li"
                    display="flex"
                    alignItems="center"
                    justifyContent="space-between"
                    gap="3"
                    key={`${item.id}-${placement.label}`}
                  >
                    <Box as="span" fontWeight="medium">
                      {placement.label}
                    </Box>
                    <Box as="span" color="fg.muted">
                      Qty {placement.quantity}
                    </Box>
                  </Box>
                ))}
              </Box>
            ) : (
              <Text px="4" py="4" color="fg.muted" fontSize="sm">
                No placements recorded.
              </Text>
            )}
          </InventoryRowsCard>
        </Box>
      </Box>
    </InventoryShellLayout>
  );
}

async function getPendingInventoryProposal(
  itemId: string,
): Promise<InventoryProposal | null> {
  const [proposal] = await listInventoryProposals({
    limit: 1,
    itemId: itemId,
  });

  return proposal ?? null;
}

function RealProposalItemPage({
  containers,
  initialEditOpen,
  locations,
  media,
  item,
  proposal,
  returnTo,
}: {
  containers: InventoryItemContainerOption[];
  initialEditOpen: boolean;
  locations: InventoryStockLocationOption[];
  media: InventoryItemMedia[];
  item: InventoryItem;
  proposal: InventoryProposal;
  returnTo: ReturnType<typeof sanitizeInventoryItemReturnTo>;
}) {
  const title = item.title ?? item.captureText ?? "Untitled item";
  const reviewableDiff = proposal.diff.filter((entry) =>
    REVIEWABLE_PROPOSAL_FIELDS.has(entry.field),
  );

  return (
    <InventoryShellLayout active="item" focusItemId={item.id} title={title}>
      <Flex
        as="section"
        aria-label="Item commands"
        flexWrap="wrap"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        p="3"
        borderWidth="1px"
        borderColor="border"
        borderRadius="lg"
        bg="bg.panel"
      >
        <InventoryItemBackLink href={returnTo} />
        <InventoryItemControls
          archiveAction={inventoryActions.archiveInventoryItemAction}
          containers={containers}
          deleteAction={inventoryActions.deleteInventoryItemAction}
          initialEditOpen={initialEditOpen}
          item={editableItemViewModel(item, media)}
          restoreAction={inventoryActions.restoreInventoryItemAction}
          returnTo={returnTo}
          updateAction={inventoryActions.updateInventoryItemAction}
        />
      </Flex>
      <Box
        as="section"
        display="grid"
        gap="4"
        css={{
          "@media (width >= 80rem)": {
            gridTemplateColumns: "minmax(0, 1.15fr) minmax(19rem, .85fr)",
          },
        }}
      >
        <Card.Root
          size="sm"
          borderRadius="0.875rem"
          overflow="hidden"
          gap="4"
          py="4"
          borderColor="border"
          bg="bg.muted/50"
          css={{
            "@media (width < 40rem)": {
              mx: "-4",
              borderRadius: "none",
              borderInlineWidth: 0,
            },
          }}
        >
          <Card.Body px="4" py="0" flex="initial" display="grid" gap="4">
            <RealItemImageManager
              media={media}
              itemId={item.id}
              title={title}
            />

            <Box
              as="h2"
              fontFamily="heading"
              fontWeight="semibold"
              fontSize="lg"
            >
              Proposal review
            </Box>
            <Flex flexWrap="wrap" gap="2">
              <Badge
                borderRadius="full"
                size="sm"
                flexShrink={0}
                w="fit-content"
                variant="outline"
              >
                Pending proposal
              </Badge>
              <Badge
                borderRadius="full"
                size="sm"
                flexShrink={0}
                w="fit-content"
                variant="outline"
              >
                {reviewableDiff.length} changes
              </Badge>
            </Flex>

            <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
              <DetailSection title="Source facts">
                <InventoryMetaGrid
                  entries={realInventoryFactEntries(item, media)}
                />
              </DetailSection>

              <RealInventoryMediaGallery media={media} itemId={item.id} />

              <DetailSection
                description="Only reviewable derived fields are shown here."
                title="Proposed Inventory Enrichment"
              >
                {proposal.rationale ? (
                  <Text fontSize="sm">{proposal.rationale}</Text>
                ) : null}
                <RealProposalDiff entries={reviewableDiff} />
              </DetailSection>

              <DetailSection title="Proposal facts">
                <InventoryMetaGrid
                  entries={[
                    {
                      label: "Confidence",
                      value:
                        proposal.confidence === null
                          ? "Unknown"
                          : formatConfidence(proposal.confidence),
                    },
                    {
                      label: "Source refs",
                      value: proposal.sourceRefsSummary,
                    },
                    {
                      label: "Failed steps",
                      value:
                        proposal.failedSteps.length > 0
                          ? proposal.failedSteps.join(", ")
                          : "None",
                    },
                  ]}
                />
              </DetailSection>
            </Grid>
          </Card.Body>
        </Card.Root>

        <Box as="aside" display="grid" alignContent="start" gap="4">
          <RealInventoryStockCard
            containers={containers}
            locations={locations}
            item={item}
          />
          <InventoryRowsCard title="Inventory Text Bundle">
            <RealInventoryTextBundleSummary
              captureText={proposal.captureText}
              failedSteps={proposal.failedSteps}
              ocrEvidence={proposal.ocrEvidence}
              sourceRefsSummary={proposal.sourceRefsSummary}
              transcriptEvidence={proposal.transcriptEvidence}
            />
          </InventoryRowsCard>
        </Box>
      </Box>
      <Box aria-hidden="true" h="20" />
      <Box
        as="section"
        aria-label="Proposal decisions"
        position="fixed"
        insetInline="0"
        bottom="0"
        zIndex={50}
        borderColor="border"
        borderTopWidth="1px"
        bg="bg/95"
        px="4"
        py="3"
        boxShadow="lg"
        backdropFilter="blur(8px)"
        css={{
          "@media (width >= 40rem)": { px: "6" },
          "@media (width >= 64rem)": { px: "8" },
        }}
      >
        <Box
          mx="auto"
          display="flex"
          w="full"
          maxW="80rem"
          justifyContent="end"
        >
          <InventoryProposalActions
            approveAction={approveInventoryEnrichmentProposalWithStateAction}
            itemId={item.id}
            jobId={proposal.id}
            rejectAction={rejectInventoryEnrichmentProposalWithStateAction}
          />
        </Box>
      </Box>
    </InventoryShellLayout>
  );
}

function RealInventoryItemPage({
  clothingActionState,
  containers,
  editHref,
  initialEditOpen,
  locations,
  media,
  pageHref,
  item,
  returnTo,
}: {
  clothingActionState: InventoryClothingActionState;
  containers: InventoryItemContainerOption[];
  editHref: Route;
  initialEditOpen: boolean;
  locations: InventoryStockLocationOption[];
  media: InventoryItemMedia[];
  pageHref: Route;
  item: InventoryItem;
  returnTo: ReturnType<typeof sanitizeInventoryItemReturnTo>;
}) {
  const title = item.title ?? item.captureText ?? "Untitled item";

  return (
    <InventoryShellLayout active="item" focusItemId={item.id} title={title}>
      <Flex
        as="section"
        aria-label="Item commands"
        flexWrap="wrap"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        p="3"
        borderWidth="1px"
        borderColor="border"
        borderRadius="lg"
        bg="bg.panel"
      >
        <InventoryItemBackLink href={returnTo} />
        <InventoryItemControls
          archiveAction={inventoryActions.archiveInventoryItemAction}
          containers={containers}
          deleteAction={inventoryActions.deleteInventoryItemAction}
          initialEditOpen={initialEditOpen}
          item={editableItemViewModel(item, media)}
          restoreAction={inventoryActions.restoreInventoryItemAction}
          returnTo={returnTo}
          updateAction={inventoryActions.updateInventoryItemAction}
        />
      </Flex>
      <Box
        as="section"
        display="grid"
        gap="4"
        css={{
          "@media (width >= 80rem)": {
            gridTemplateColumns: "minmax(0, 1.15fr) minmax(19rem, .85fr)",
          },
        }}
      >
        <Card.Root
          size="sm"
          borderRadius="0.875rem"
          overflow="hidden"
          gap="4"
          py="4"
          css={{
            "@media (width < 40rem)": {
              mx: "-4",
              borderRadius: "none",
              borderInlineWidth: 0,
            },
          }}
        >
          <Card.Body px="4" py="0" flex="initial" display="grid" gap="4">
            <RealItemImageManager
              media={media}
              itemId={item.id}
              title={title}
            />
            <RealInventoryFactSheet media={media} item={item} />
            <RealInventoryMediaGallery media={media} itemId={item.id} />
          </Card.Body>
        </Card.Root>
        <Box as="aside" display="grid" alignContent="start" gap="4">
          <RealInventoryStockCard
            containers={containers}
            locations={locations}
            item={item}
          />
          {item.clothingProfile ? (
            <InventoryClothingWearActionsCard
              actionState={clothingActionState}
              isDirty={item.clothingProfile.isDirty}
              pageHref={pageHref}
              itemId={item.id}
            />
          ) : null}
          {item.clothingProfile ? (
            <InventoryClothingProfileCard
              clothingProfile={item.clothingProfile}
              itemId={item.id}
              updateAction={
                inventoryActions.updateInventoryClothingProfileAction
              }
            />
          ) : null}
          {item.remedyProfile ? (
            <InventoryRemedyProfileCard remedyProfile={item.remedyProfile} />
          ) : null}
          {!item.remedyProfile ? (
            <InventoryItemWorkflowCard
              editHref={editHref}
              item={item}
              retryEnrichmentAction={
                inventoryActions.retryInventoryEnrichmentAction
              }
              retryPreprocessingAction={
                inventoryActions.retryInventoryPreprocessingAction
              }
            />
          ) : null}
        </Box>
      </Box>
    </InventoryShellLayout>
  );
}

type InventoryClothingActionState = {
  confirmationId: string | null;
  message: string;
  itemId: string | null;
  type:
    "error" | "laundry-completed" | "none" | "wear-recorded" | "wear-undone";
};

function InventoryClothingWearActionsCard({
  actionState,
  isDirty,
  pageHref,
  itemId,
}: {
  actionState: InventoryClothingActionState;
  isDirty: boolean;
  pageHref: Route;
  itemId: string;
}) {
  return (
    <Card.Root
      size="sm"
      borderRadius="0.875rem"
      overflow="hidden"
      gap="4"
      py="4"
    >
      <Card.Header px="4" py="0">
        <Card.Title as="h2" fontSize="md" fontWeight="medium" lineHeight="snug">
          Clothing actions
        </Card.Title>
      </Card.Header>
      <Card.Body px="4" py="0" flex="initial" display="grid" gap="3">
        <Text color="fg.muted" fontSize="sm">
          Record actual wear, undo a mistaken confirmation, or mark this item
          clean after laundry.
        </Text>
        {actionState.type !== "none" ? (
          <Box
            borderRadius="xl"
            borderWidth="1px"
            borderColor={
              actionState.type === "error" ? "border.error" : "border"
            }
            bg={actionState.type === "error" ? "bg.error" : "bg.muted/20"}
            color={actionState.type === "error" ? "fg.error" : undefined}
            px="3"
            py="2"
            fontSize="sm"
          >
            {actionState.message}
          </Box>
        ) : null}
        <Flex flexWrap="wrap" gap="2">
          {isDirty ? (
            <form
              action={
                inventoryActions.completeInventoryClothingLaundryRedirectAction
              }
            >
              <input name="mode" type="hidden" value="selected" />
              <input name="itemId" type="hidden" value={itemId} />
              <input name="returnTo" type="hidden" value={pageHref} />
              <Button {...itemSecondaryButton} type="submit">
                Laundry done
              </Button>
            </form>
          ) : (
            <form
              action={
                inventoryActions.markInventoryClothingItemWornRedirectAction
              }
            >
              <input name="itemId" type="hidden" value={itemId} />
              <input name="returnTo" type="hidden" value={pageHref} />
              <Button {...itemButton} type="submit">
                Wore this
              </Button>
            </form>
          )}
          {actionState.type === "wear-recorded" &&
          actionState.confirmationId &&
          actionState.itemId === itemId ? (
            <form
              action={
                inventoryActions.undoInventoryClothingWearConfirmationRedirectAction
              }
            >
              <input
                name="confirmationId"
                type="hidden"
                value={actionState.confirmationId}
              />
              <input name="itemId" type="hidden" value={itemId} />
              <input name="returnTo" type="hidden" value={pageHref} />
              <Button {...itemSecondaryButton} type="submit">
                Undo last wear
              </Button>
            </form>
          ) : null}
        </Flex>
      </Card.Body>
    </Card.Root>
  );
}

function RealInventoryStockCard({
  containers,
  locations,
  item,
}: {
  containers: InventoryItemContainerOption[];
  locations: InventoryStockLocationOption[];
  item: InventoryItem;
}) {
  return (
    <InventoryItemStockCard
      addAction={inventoryActions.addInventoryUnitsAction}
      containers={containers}
      legacyWhere={item.where}
      locations={locations}
      moveAction={inventoryActions.moveInventoryUnitsAction}
      placements={item.placements}
      itemId={item.id}
      removeAction={inventoryActions.removeInventoryUnitsAction}
      totalQuantity={item.totalQuantity}
    />
  );
}

function RealInventoryFactSheet({
  media,
  item,
}: {
  media: InventoryItemMedia[];
  item: InventoryItem;
}) {
  const sections = realInventoryFactSections(item, media);

  return (
    <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
      {sections.map((section) => (
        <DetailSection key={section.title} title={section.title}>
          <InventoryMetaGrid entries={section.entries} />
        </DetailSection>
      ))}
    </Grid>
  );
}

function RealItemImageManager({
  media,
  itemId,
  title,
}: {
  media: InventoryItemMedia[];
  itemId: string;
  title: string;
}) {
  return (
    <InventoryItemImageManager
      images={media.flatMap((entry) =>
        entry.kind === "image"
          ? [
              {
                caption: entry.originalName ?? null,
                id: entry.id,
                url: inventoryItemMediaContentPath(itemId, entry.id),
              },
            ]
          : [],
      )}
      key={media.map(({ id }) => id).join(":")}
      itemId={itemId}
      title={title}
    />
  );
}

function RealInventoryMediaGallery({
  media,
  itemId,
}: {
  media: InventoryItemMedia[];
  itemId: string;
}) {
  return (
    <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
      <InventoryItemMediaManager media={media} itemId={itemId} />
    </Grid>
  );
}

function InventoryRowsCard({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <Card.Root
      size="sm"
      borderRadius="0.875rem"
      overflow="hidden"
      gap="4"
      py="4"
    >
      <Card.Header px="4" py="0">
        <Card.Title as="h2" fontSize="md" fontWeight="medium" lineHeight="snug">
          {title}
        </Card.Title>
      </Card.Header>
      <Card.Body flex="initial" p="0">
        {children}
      </Card.Body>
    </Card.Root>
  );
}

function realInventoryFactEntries(
  item: InventoryItem,
  media: InventoryItemMedia[],
) {
  const imageCount = media.filter((entry) => entry.kind === "image").length;
  const audioCount = media.filter((entry) => entry.kind === "audio").length;
  const fileCount = media.filter((entry) => entry.kind === "asset").length;

  return [
    { label: "Captured", value: monoValue(item.capturedAt) },
    { label: "Item / group", value: sentenceCase(item.kind) },
    { label: "Title", value: item.title ?? "None" },
    { label: "Note", value: item.note ?? "None" },
    { label: "Capture text", value: item.captureText ?? "None" },
    {
      label: "Category",
      value: formatInventoryCategoryLabel(item.category) ?? "None",
    },
    {
      label: "Acquisition source",
      value:
        formatInventoryAcquisitionSourceLabel(item.acquisitionSource) ?? "None",
    },
    {
      label: "Estimated value",
      value:
        formatInventoryEstimatedValue(item.costCents, item.costCurrency) ??
        "None",
    },
    { label: "Tags", value: listValue(item.tags) },
    { label: "Aliases", value: listValue(item.aliases) },
    {
      label: "Source media",
      value: `${imageCount} image${imageCount === 1 ? "" : "s"}, ${audioCount} audio, ${fileCount} file${fileCount === 1 ? "" : "s"}`,
    },
  ];
}

function realInventoryFactSections(
  item: InventoryItem,
  media: InventoryItemMedia[],
) {
  const entries = realInventoryFactEntries(item, media);
  const byLabel = new Map(entries.map((entry) => [entry.label, entry]));

  return [
    {
      entries: requiredFactEntries(byLabel, [
        "Captured",
        "Item / group",
        "Note",
        "Capture text",
      ]),
      title: "Overview",
    },
    {
      entries: requiredFactEntries(byLabel, [
        "Category",
        "Acquisition source",
        "Estimated value",
        "Tags",
        "Aliases",
        "Source media",
      ]),
      title: "Catalog",
    },
  ];
}

function requiredFactEntries<T>(
  entries: Map<string, T>,
  labels: string[],
): T[] {
  return labels.map((label) => {
    const entry = entries.get(label);

    if (!entry) {
      throw new Error(`Missing inventory fact entry: ${label}`);
    }

    return entry;
  });
}

function editableItemViewModel(
  item: InventoryItem,
  media: InventoryItemMedia[],
): InventoryItemEditableViewModel {
  const imageAssets: InventoryItemEditableViewModel["assets"] = media.flatMap(
    (entry, index) =>
      entry.kind === "image"
        ? [
            {
              key: `image:${entry.id}` as const,
              kind: "image" as const,
              mimeType: entry.contentType ?? null,
              name: entry.originalName ?? `Image ${index + 1}`,
              sizeBytes: entry.sizeBytes ?? null,
              url: inventoryItemMediaContentPath(item.id, entry.id),
            },
          ]
        : [],
  );
  const audioAssets: InventoryItemEditableViewModel["assets"] = media.flatMap(
    (entry, index) =>
      entry.kind === "audio"
        ? [
            {
              key: `audio:${entry.id}` as const,
              kind: "audio" as const,
              mimeType: entry.contentType ?? null,
              name: entry.originalName ?? `Audio ${index + 1}`,
              sizeBytes: entry.sizeBytes ?? null,
              url: inventoryItemMediaContentPath(item.id, entry.id),
            },
          ]
        : [],
  );
  const fileAssets: InventoryItemEditableViewModel["assets"] = media.flatMap(
    (entry, index) =>
      entry.kind === "asset"
        ? [
            {
              key: `asset:${entry.id}` as const,
              kind: "asset" as const,
              mimeType: entry.contentType ?? null,
              name: entry.originalName ?? `File ${index + 1}`,
              sizeBytes: entry.sizeBytes ?? null,
              url: inventoryItemMediaContentPath(item.id, entry.id),
            },
          ]
        : [],
  );

  return {
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    archivedAt: item.archivedAt,
    assets: [...imageAssets, ...audioAssets, ...fileAssets],
    captureText: item.captureText ?? null,
    category: item.category,
    containerId: item.containerId ?? null,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    id: item.id,
    importance: item.importance,
    kind: item.kind,
    note: item.note,
    status: item.status,
    tags: item.tags,
    title: item.title,
  };
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ").toLowerCase();

  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function RealProposalDiff({ entries }: { entries: InventoryProposal["diff"] }) {
  if (entries.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        No reviewable field changes.
      </Text>
    );
  }

  return (
    <Grid gap="3">
      {entries.map((entry) => (
        <Grid
          gap="2"
          borderRadius="0.875rem"
          borderWidth="1px"
          borderColor="border"
          p="3"
          css={{
            "@media (width >= 40rem)": { gridTemplateColumns: "8rem 1fr 1fr" },
          }}
          key={entry.field}
        >
          <Text fontWeight="medium" fontSize="sm">
            {entry.label}
          </Text>
          <Box
            borderRadius="0.625rem"
            bg="bg.muted/50"
            px="3"
            py="2"
            fontSize="sm"
          >
            <Box
              as="span"
              display="block"
              color="fg.muted"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
            >
              Current
            </Box>
            <span>{entry.current}</span>
          </Box>
          <Box
            borderRadius="0.625rem"
            bg="bg.muted"
            px="3"
            py="2"
            fontSize="sm"
          >
            <Box
              as="span"
              display="block"
              color="fg.muted"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
            >
              Proposed
            </Box>
            <span>{entry.proposed}</span>
          </Box>
        </Grid>
      ))}
    </Grid>
  );
}

function EvidenceSection({
  entries,
  emptyLabel,
  title,
}: {
  entries: Array<{ id: string; preview: string; secondary: string | null }>;
  emptyLabel: string;
  title: string;
}) {
  return (
    <Box as="section" borderColor="border" borderTopWidth="1px">
      <Text
        px="4"
        py="2"
        fontWeight="medium"
        color="fg.muted"
        fontSize="xs"
        textTransform="uppercase"
        letterSpacing="wide"
      >
        {title}
      </Text>
      {entries.length > 0 ? (
        entries.map((entry) => (
          <Box
            borderColor="border"
            borderTopWidth="1px"
            px="4"
            py="3"
            key={entry.id}
          >
            <Text fontFamily="mono" fontSize="xs" color="fg.muted">
              {entry.id}
            </Text>
            <InventoryItemCollapsibleText
              mt="1"
              whiteSpace="pre-wrap"
              fontSize="sm"
              label={`${title} ${entry.id}`}
              text={entry.preview}
            />
            {entry.secondary ? (
              <Text mt="1" color="fg.muted" fontSize="xs">
                {entry.secondary}
              </Text>
            ) : null}
          </Box>
        ))
      ) : (
        <Text
          borderColor="border"
          borderTopWidth="1px"
          px="4"
          py="3"
          color="fg.muted"
          fontSize="sm"
        >
          {emptyLabel}
        </Text>
      )}
    </Box>
  );
}

function RealInventoryTextBundleSummary({
  captureText,
  failedSteps,
  ocrEvidence,
  sourceRefsSummary,
  transcriptEvidence,
}: {
  captureText: string | null;
  failedSteps: string[];
  ocrEvidence: Array<{ id: string; preview: string; secondary: string | null }>;
  sourceRefsSummary: string;
  transcriptEvidence: Array<{
    id: string;
    preview: string;
    secondary: string | null;
  }>;
}) {
  return (
    <Box fontSize="sm">
      <dl>
        <TextBundleRow label="Source refs">{sourceRefsSummary}</TextBundleRow>
        <TextBundleRow label="Capture">{captureText ?? "None"}</TextBundleRow>
        <TextBundleRow label="Failures">
          <TextBundleList emptyLabel="None" values={failedSteps} />
        </TextBundleRow>
      </dl>

      <EvidenceSection
        entries={ocrEvidence}
        emptyLabel="No OCR evidence in this proposal."
        title="OCR evidence"
      />

      <EvidenceSection
        entries={transcriptEvidence}
        emptyLabel="No transcript evidence in this proposal."
        title="Transcript evidence"
      />
    </Box>
  );
}

function listValue(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function DetailCardAction({
  detailMode,
}: {
  detailMode: InventoryShellDetailMode;
}) {
  if (detailMode === "proposal") {
    return (
      <Flex flexWrap="wrap" alignItems="center" justifyContent="end" gap="2">
        <Button {...itemSecondaryButton} type="button">
          <XIcon />
          Reject proposal
        </Button>
        <Button {...itemButton} type="button">
          <CheckIcon />
          Approve proposal
        </Button>
      </Flex>
    );
  }

  return <DetailModeBadge detailMode={detailMode} />;
}

function DetailModeBadge({
  detailMode,
}: {
  detailMode: InventoryShellDetailMode;
}) {
  if (detailMode === "proposal") {
    return (
      <Badge
        borderRadius="full"
        size="sm"
        flexShrink={0}
        w="fit-content"
        variant="outline"
      >
        Pending approval
      </Badge>
    );
  }

  if (detailMode === "error") {
    return (
      <Badge
        borderRadius="full"
        size="sm"
        flexShrink={0}
        w="fit-content"
        variant="subtle"
        colorPalette="red"
      >
        Needs review
      </Badge>
    );
  }

  if (detailMode === "complete") {
    return (
      <Badge
        borderRadius="full"
        size="sm"
        flexShrink={0}
        w="fit-content"
        variant="subtle"
        colorPalette="gray"
      >
        Complete
      </Badge>
    );
  }

  return (
    <Badge
      borderRadius="full"
      size="sm"
      flexShrink={0}
      w="fit-content"
      variant="subtle"
      colorPalette="gray"
    >
      In flight
    </Badge>
  );
}

function detailModeCardClassName(detailMode: InventoryShellDetailMode): string {
  if (detailMode === "proposal") {
    return "border-border bg-muted/50";
  }

  if (detailMode === "error") {
    return "border-destructive/30 bg-destructive/5";
  }

  if (detailMode === "complete") {
    return "border-border bg-muted/50";
  }

  return "border-border bg-muted/50";
}

function DetailModeSections({
  detailMode,
  item,
}: {
  detailMode: InventoryShellDetailMode;
  item: InventoryShellItem;
}) {
  if (detailMode === "proposal") {
    return (
      <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
        <DetailSection
          description="Capture evidence and derived fields stay in one review surface."
          title="Source facts"
        >
          <InventoryMetaGrid entries={getSourceFactEntries(item)} />
        </DetailSection>

        <DetailSection title="Evidence summary">
          <EvidenceSummary item={item} />
        </DetailSection>

        <DetailSection
          description={item.proposal.summary}
          title="Proposed Inventory Enrichment"
        >
          <Text fontSize="sm">{item.enrichment.rationale}</Text>
          <ProposalDiffList item={item} />
        </DetailSection>
      </Grid>
    );
  }

  if (detailMode === "error") {
    return (
      <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
        <DetailSection
          description="Existing evidence before retry or manual review."
          title="Evidence collected"
        >
          <EvidenceSummary item={item} />
        </DetailSection>
      </Grid>
    );
  }

  if (detailMode === "complete") {
    return (
      <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
        <DetailSection
          description="Source facts beside the applied values now used for search."
          title="Final inventory facts"
        >
          <Grid
            gap="4"
            css={{
              "@media (width >= 64rem)": {
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              },
            }}
          >
            <Grid
              gap="3"
              borderRadius="0.875rem"
              borderWidth="1px"
              borderColor="border"
              bg="bg/80"
              p="4"
            >
              <Text fontWeight="medium" fontSize="sm">
                Source facts
              </Text>
              <InventoryMetaGrid entries={getSourceFactEntries(item)} />
            </Grid>
            <Grid
              gap="3"
              borderRadius="0.875rem"
              borderWidth="1px"
              borderColor="border"
              bg="bg/80"
              p="4"
            >
              <Text fontWeight="medium" fontSize="sm">
                Applied derived values
              </Text>
              <TextBundleList
                emptyLabel="None"
                values={item.enrichment.derivedFields}
              />
            </Grid>
          </Grid>
        </DetailSection>

        <DetailSection title="Evidence summary">
          <EvidenceSummary item={item} />
        </DetailSection>

        <DetailSection title="Processed timestamps">
          <InventoryMetaGrid
            entries={[
              { label: "Captured", value: monoValue(item.capturedAt) },
              {
                label: "Inventory Preprocessing",
                value: monoValue(item.preprocessing.updatedAt),
              },
              {
                label: "Inventory Proposal",
                value: monoValue(item.proposal.updatedAt),
              },
              {
                label: "Inventory Enrichment",
                value: monoValue(item.enrichment.updatedAt),
              },
            ]}
          />
        </DetailSection>

        <DetailSection
          description={item.proposal.summary}
          title="Enrichment history"
        >
          <Text fontSize="sm">{item.enrichment.summary}</Text>
          <Text color="fg.muted" fontSize="sm">
            {item.enrichment.rationale}
          </Text>
          <ProposalDiffList item={item} />
        </DetailSection>
      </Grid>
    );
  }

  return (
    <Grid gap="5" borderColor="border" borderTopWidth="1px" pt="4">
      <DetailSection
        description="Evidence available for the next Inventory Text Bundle."
        title="Evidence collected"
      >
        <EvidenceSummary item={item} />
      </DetailSection>
    </Grid>
  );
}

function DetailSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <Box as="section" display="grid" gap="3">
      <Grid gap="1">
        <Box as="h3" fontFamily="heading" fontSize="md" fontWeight="semibold">
          {title}
        </Box>
        {description ? (
          <Text color="fg.muted" fontSize="sm">
            {description}
          </Text>
        ) : null}
      </Grid>
      {children}
    </Box>
  );
}

function getDetailMetaEntries(
  item: InventoryShellItem,
  detailMode: InventoryShellDetailMode,
) {
  if (detailMode === "proposal") {
    return [
      { label: "Capture Session", value: item.captureSession.label },
      { label: "Captured", value: monoValue(item.capturedAt) },
      { label: "Where", value: formatInventoryShellWhere(item) },
      {
        label: "Container",
        value: formatInventoryShellContainer(item.container) ?? "None",
      },
      { label: "Category", value: formatInventoryShellCategory(item.category) },
      {
        label: "Acquisition source",
        value: formatInventoryShellAcquisitionSource(item.acquisitionSource),
      },
      {
        label: "Estimated value",
        value: formatInventoryShellEstimatedValue(item),
      },
      { label: "Current step", value: item.currentStep },
    ];
  }

  if (detailMode === "error") {
    return [
      { label: "Failed step", value: firstFailure(item) },
      { label: "Error note", value: errorNote(item) },
      {
        label: "Partial Inventory Text Bundle",
        value: hasPartialText(item)
          ? "Yes, partial text exists"
          : "No partial text",
      },
      { label: "Waiting since", value: monoValue(item.capturedAt) },
      { label: "Current step", value: item.currentStep },
      { label: "Next action", value: item.nextAction },
    ];
  }

  if (detailMode === "complete") {
    return [
      { label: "Capture Session", value: item.captureSession.label },
      { label: "Captured", value: monoValue(item.capturedAt) },
      { label: "Applied at", value: monoValue(item.enrichment.updatedAt) },
      { label: "Where", value: formatInventoryShellWhere(item) },
      {
        label: "Container",
        value: formatInventoryShellContainer(item.container) ?? "None",
      },
      { label: "Category", value: formatInventoryShellCategory(item.category) },
      {
        label: "Acquisition source",
        value: formatInventoryShellAcquisitionSource(item.acquisitionSource),
      },
      {
        label: "Estimated value",
        value: formatInventoryShellEstimatedValue(item),
      },
      {
        label: "Proposal status",
        value: statusLabelNode(item.proposal.status),
      },
    ];
  }

  return [
    { label: "Current stage", value: item.currentStep },
    { label: "Waiting since", value: monoValue(item.capturedAt) },
    {
      label: "Inventory Preprocessing",
      value: statusLabelNode(item.preprocessing.status),
    },
    {
      label: "Latest preprocessing update",
      value: monoValue(item.preprocessing.updatedAt),
    },
    {
      label: "Inventory Enrichment",
      value: statusLabelNode(item.enrichment.status),
    },
    {
      label: "Latest enrichment update",
      value: monoValue(item.enrichment.updatedAt),
    },
  ];
}

function getSourceFactEntries(item: InventoryShellItem) {
  return [
    { label: "Source label", value: item.sourceLabel },
    { label: "Capture text", value: item.textBundle.captureText },
    { label: "Where", value: formatInventoryShellWhere(item) },
    {
      label: "Container",
      value: formatInventoryShellContainer(item.container) ?? "None",
    },
    { label: "Category", value: formatInventoryShellCategory(item.category) },
    {
      label: "Acquisition source",
      value: formatInventoryShellAcquisitionSource(item.acquisitionSource),
    },
    {
      label: "Estimated value",
      value: formatInventoryShellEstimatedValue(item),
    },
    { label: "Capture Session", value: item.captureSession.label },
  ];
}

function EvidenceSummary({ item }: { item: InventoryShellItem }) {
  return (
    <>
      <InventoryEvidenceBadges evidence={item.evidence} />
      <Grid gap="3">
        {item.evidence.map((entry) => (
          <Box
            borderRadius="0.875rem"
            borderWidth="1px"
            borderColor="border"
            p="3"
            key={entry.id}
          >
            <Text fontWeight="medium" fontSize="sm">
              {entry.label}
            </Text>
            <Text color="fg.muted" fontSize="sm">
              {entry.summary}
            </Text>
          </Box>
        ))}
      </Grid>
      <Grid gap="3">
        {item.images.map((image) => (
          <Box
            borderRadius="0.875rem"
            borderWidth="1px"
            borderColor="border"
            p="3"
            key={image.id}
          >
            <Text fontWeight="medium" fontSize="sm">
              {image.alt}
            </Text>
            <Text color="fg.muted" fontSize="sm">
              {image.caption}
            </Text>
            <Text mt="1" fontFamily="mono" fontSize="xs">
              {image.ocrText}
            </Text>
          </Box>
        ))}
      </Grid>
    </>
  );
}

function ProposalDiffList({ item }: { item: InventoryShellItem }) {
  if (item.proposal.diff.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        No derived field diff yet.
      </Text>
    );
  }

  return (
    <Grid gap="3">
      {item.proposal.diff.map((entry) => (
        <Grid
          gap="2"
          borderRadius="0.875rem"
          borderWidth="1px"
          borderColor="border"
          p="3"
          css={{
            "@media (width >= 40rem)": { gridTemplateColumns: "8rem 1fr 1fr" },
          }}
          key={entry.field}
        >
          <Text fontWeight="medium" fontSize="sm">
            {entry.field}
          </Text>
          <Box
            borderRadius="0.625rem"
            bg="bg.muted/50"
            px="3"
            py="2"
            fontSize="sm"
          >
            <Box
              as="span"
              display="block"
              color="fg.muted"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
            >
              Current
            </Box>
            <span>{entry.current}</span>
          </Box>
          <Box
            borderRadius="0.625rem"
            bg="bg.muted"
            px="3"
            py="2"
            fontSize="sm"
          >
            <Box
              as="span"
              display="block"
              color="fg.muted"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
            >
              Proposed
            </Box>
            <span>{entry.proposed}</span>
          </Box>
        </Grid>
      ))}
    </Grid>
  );
}

function firstFailure(item: InventoryShellItem): string {
  return (
    item.preprocessing.failedSteps[0] ??
    item.textBundle.failedSteps[0] ??
    "None"
  );
}

function errorNote(item: InventoryShellItem): string {
  return (
    item.preprocessing.failedSteps[0] ??
    "Review required before enrichment can continue."
  );
}

function hasPartialText(item: InventoryShellItem): boolean {
  return (
    item.textBundle.mediaTexts.length > 0 ||
    item.textBundle.captureText.length > 0
  );
}

function InventoryTextBundleSummary({ item }: { item: InventoryShellItem }) {
  return (
    <Box as="dl" fontSize="sm">
      <TextBundleRow label="Summary">{item.textBundle.summary}</TextBundleRow>
      <TextBundleRow label="Capture">
        {item.textBundle.captureText}
      </TextBundleRow>
      <TextBundleRow label="Media">
        <TextBundleList
          emptyLabel="Not ready"
          values={item.textBundle.mediaTexts}
        />
      </TextBundleRow>
      <TextBundleRow label="Failures">
        <TextBundleList
          emptyLabel="None"
          values={item.textBundle.failedSteps}
        />
      </TextBundleRow>
    </Box>
  );
}

function TextBundleRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Grid
      gap="1"
      borderColor="border"
      borderBottomWidth="1px"
      px="4"
      py="3"
      css={{
        _last: { borderBottomWidth: 0 },
        "@media (width >= 40rem)": {
          gridTemplateColumns: "5.5rem 1fr",
          gap: "4",
        },
      }}
    >
      <Box
        as="dt"
        color="fg.muted"
        fontSize="xs"
        textTransform="uppercase"
        letterSpacing="wide"
      >
        {label}
      </Box>
      <Box as="dd" fontWeight="medium" lineHeight="relaxed">
        {children}
      </Box>
    </Grid>
  );
}

function TextBundleList({
  emptyLabel,
  values,
}: {
  emptyLabel: string;
  values: string[];
}) {
  if (values.length === 0) {
    return (
      <Box as="span" color="fg.muted">
        {emptyLabel}
      </Box>
    );
  }

  return (
    <Box as="ul" display="grid" gap="1">
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </Box>
  );
}

function formatDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildInventoryEditHref(itemId: string, returnTo: Route): Route {
  return `/inventory/items/${encodeURIComponent(itemId)}?${new URLSearchParams({
    edit: "1",
    returnTo,
  })}` as Route;
}

function buildInventoryItemPageHref(
  itemId: string,
  returnTo: Route,
  initialEditOpen: boolean,
): Route {
  const params = new URLSearchParams({ returnTo });

  if (initialEditOpen) {
    params.set("edit", "1");
  }

  return `/inventory/items/${encodeURIComponent(itemId)}?${params}` as Route;
}

function inventoryClothingActionState(
  params: Record<string, string | string[] | undefined>,
): InventoryClothingActionState {
  const type = firstSearchParam(params.clothingAction);

  if (!type) {
    return {
      confirmationId: null,
      message: "",
      itemId: null,
      type: "none",
    };
  }

  return {
    confirmationId: firstSearchParam(params.confirmationId) || null,
    message:
      firstSearchParam(params.message) || inventoryClothingActionMessage(type),
    itemId: firstSearchParam(params.itemId) || null,
    type:
      type === "wear-recorded" ||
      type === "wear-undone" ||
      type === "laundry-completed" ||
      type === "error"
        ? type
        : "none",
  };
}

function inventoryClothingActionMessage(type: string): string {
  switch (type) {
    case "wear-recorded":
      return "Wear recorded. Undo is available now.";
    case "wear-undone":
      return "Wear undone. Clothing Item restored to clean.";
    case "laundry-completed":
      return "Laundry completed.";
    case "error":
      return "Clothing action failed.";
    default:
      return "";
  }
}

function monoValue(value: string) {
  return (
    <Box as="span" fontFamily="mono" fontSize="xs">
      {formatDateTime(value)}
    </Box>
  );
}

function statusLabelNode(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}
