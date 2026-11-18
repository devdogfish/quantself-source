"use client";

import {
  Flex,
  Grid,
  Box,
  Text,
  Heading,
  Icon,
  Badge,
  Button,
  Card,
  Checkbox,
  Fieldset,
  Popover,
  Portal,
  Input,
  InputGroup,
} from "@chakra-ui/react";

import Link from "next/link";
import {
  AlertTriangleIcon,
  CameraIcon,
  FileTextIcon,
  MicIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type {
  InventoryShellEvidence,
  InventoryShellItem,
  InventoryShellProcessingColumn,
  InventoryShellProcessingColumnId,
} from "./inventory-shell-data";
import {
  formatInventoryShellAcquisitionSource,
  formatInventoryShellCategory,
  formatInventoryShellWhere,
} from "./inventory-shell-data";
import { buildInventoryItemHref } from "./item-navigation";

const evidenceIcons = {
  photo: CameraIcon,
  voice: MicIcon,
  text: FileTextIcon,
};
const evidenceKinds = ["photo", "voice", "text"] as const;

export function InventoryProcessingBoard({
  columns,
}: {
  columns: InventoryShellProcessingColumn[];
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleColumnIds, setVisibleColumnIds] = useState<
    InventoryShellProcessingColumnId[]
  >(columns.map((column) => column.id));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredColumns = columns
    .filter((column) => visibleColumnIds.includes(column.id))
    .map((column) => ({
      ...column,
      items: column.items.filter((item) =>
        itemMatchesQuery(item, normalizedQuery),
      ),
    }));
  const visibleCount = filteredColumns.flatMap((column) => column.items).length;
  const showReviewCard = visibleColumnIds.includes("needs-review");
  const filteredReviewColumn = filteredColumns.find(
    (column) => column.id === "needs-review",
  );
  const reviewItems = filteredReviewColumn?.items ?? [];
  const pipelineColumns = filteredColumns.filter(
    (column) => column.id !== "needs-review",
  );
  const showPipelineCard = pipelineColumns.length > 0;
  const filtersActive =
    normalizedQuery.length > 0 || visibleColumnIds.length !== columns.length;
  const headingId = useId();
  const queryInputId = useId();

  function toggleColumn(
    columnId: InventoryShellProcessingColumnId,
    checked: boolean,
  ) {
    setVisibleColumnIds((current) =>
      checked
        ? columns
            .map((column) => column.id)
            .filter((id) => id === columnId || current.includes(id))
        : current.filter((id) => id !== columnId),
    );
  }

  return (
    <Grid as="section" gap="4" aria-label="Inventory processing board">
      <Flex
        flexDirection={{ base: "column", sm: "row" }}
        gap="2"
        alignItems={{ sm: "center" }}
        justifyContent={{ sm: "end" }}
      >
        <Box
          as="form"
          width={{ base: "100%", sm: "80" }}
          onSubmit={(event) => event.preventDefault()}
          role="search"
        >
          <Box asChild srOnly>
            <label htmlFor={queryInputId}>
              Search inventory processing board
            </label>
          </Box>
          <InputGroup startElement={<SearchIcon size={16} />}>
            <Input
              id={queryInputId}
              name="query"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search items, locations, stages"
              type="search"
              value={query}
            />
          </InputGroup>
        </Box>
        <Popover.Root
          onOpenChange={({ open }) => setFiltersOpen(open)}
          open={filtersOpen}
          positioning={{ placement: "bottom-end", gutter: 8 }}
        >
          <Popover.Trigger asChild>
            <Button
              type="button"
              width={{ base: "100%", sm: "auto" }}
              variant="outline"
            >
              <SlidersHorizontalIcon data-icon="inline-start" />
              Filter
              {filtersActive ? (
                <Badge variant="subtle">{visibleCount}</Badge>
              ) : null}
            </Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content
                width="min(calc(100vw-2rem),24rem)"
                p="0"
                id="inventory-processing-filters"
              >
                <Flex
                  alignItems="start"
                  justifyContent="space-between"
                  gap="3"
                  p="4"
                  pb="0"
                >
                  <Popover.Header>
                    <Popover.Title id={headingId}>Filter board</Popover.Title>
                    <Popover.Description>
                      Choose stages shown on the board.
                    </Popover.Description>
                  </Popover.Header>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Close filters"
                    onClick={() => setFiltersOpen(false)}
                  >
                    <XIcon />
                  </Button>
                </Flex>

                <Grid as="form" aria-labelledby={headingId} gap="4" p="4">
                  <Fieldset.Root>
                    <Fieldset.Legend>Stages</Fieldset.Legend>
                    <Fieldset.Content
                      display="grid"
                      gap="2"
                      gridTemplateColumns={{ sm: "repeat(2, minmax(0, 1fr))" }}
                    >
                      {columns.map((column) => (
                        <Flex
                          justifyContent="space-between"
                          borderRadius="lg"
                          borderWidth="1px"
                          borderColor="border"
                          px="3"
                          py="2"
                          key={column.id}
                          alignItems="center"
                        >
                          <Flex minWidth="0" alignItems="center" gap="2">
                            <Checkbox.Root
                              checked={visibleColumnIds.includes(column.id)}
                              onCheckedChange={({ checked }) =>
                                toggleColumn(column.id, checked === true)
                              }
                            >
                              <Checkbox.HiddenInput
                                id={`inventory-processing-stage-${column.id}`}
                                name={column.id}
                              />
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                              <Checkbox.Label>{column.title}</Checkbox.Label>
                            </Checkbox.Root>
                          </Flex>
                          <Badge variant="outline">{column.items.length}</Badge>
                        </Flex>
                      ))}
                    </Fieldset.Content>
                  </Fieldset.Root>

                  <Flex flexWrap="wrap" justifyContent="end" gap="2" pt="1">
                    <Button
                      onClick={() => {
                        setQuery("");
                        setVisibleColumnIds(columns.map((column) => column.id));
                      }}
                      type="button"
                      variant="outline"
                    >
                      Clear
                    </Button>
                    <Button type="button" onClick={() => setFiltersOpen(false)}>
                      Done
                    </Button>
                  </Flex>
                </Grid>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      </Flex>

      <Grid
        alignItems="start"
        gap="4"
        gridTemplateColumns={{
          base: "minmax(0, 1fr)",
          xl:
            showReviewCard && showPipelineCard
              ? "minmax(20rem, 0.9fr) minmax(0, 1.55fr)"
              : "minmax(0, 1fr)",
        }}
      >
        {showReviewCard ? (
          <Card.Root minWidth="0" overflow="hidden">
            <Card.Header>
              <Card.Title as="h2" display="flex" alignItems="center" gap="2">
                <Icon
                  as={AlertTriangleIcon}
                  aria-hidden="true"
                  boxSize="4"
                  flexShrink={0}
                  color="fg"
                />
                Needs review
              </Card.Title>
            </Card.Header>

            <Card.Body>
              <InventoryItemList
                empty="No review blockers shown."
                items={reviewItems}
              />
            </Card.Body>
          </Card.Root>
        ) : null}

        {showPipelineCard ? (
          <Card.Root minWidth="0" overflow="hidden">
            <Card.Header>
              <Card.Title as="h2" display="flex" alignItems="center" gap="2">
                <Icon
                  as={WorkflowIcon}
                  aria-hidden="true"
                  boxSize="4"
                  flexShrink={0}
                  color="fg"
                />
                Pipeline
              </Card.Title>
            </Card.Header>

            <Grid
              alignItems="stretch"
              gridTemplateColumns={{
                base: "minmax(0, 1fr)",
                lg: `repeat(${Math.min(3, pipelineColumns.length)}, minmax(0, 1fr))`,
              }}
            >
              {pipelineColumns.map((column, index) => (
                <Box
                  as="section"
                  minWidth="0"
                  key={column.id}
                  borderTopWidth={{ base: index > 0 ? "1px" : "0", lg: "0" }}
                  borderLeftWidth={{ lg: index > 0 ? "1px" : "0" }}
                >
                  <Box
                    borderColor="border"
                    borderBottomWidth="1px"
                    px="4"
                    py="3"
                  >
                    <Flex
                      alignItems="center"
                      justifyContent="space-between"
                      gap="3"
                    >
                      <Heading as="h3" fontWeight="medium" textStyle="sm">
                        {column.title}
                      </Heading>
                      <Badge variant="outline">{column.items.length}</Badge>
                    </Flex>
                    <Text mt="1" color="fg.muted" textStyle="xs">
                      {stageHint(column.id)}
                    </Text>
                  </Box>

                  <Box p="4">
                    <InventoryItemList
                      empty="No items shown."
                      items={column.items}
                    />
                  </Box>
                </Box>
              ))}
            </Grid>
          </Card.Root>
        ) : null}

        {showReviewCard || showPipelineCard ? null : (
          <Card.Root>
            <Card.Body>
              <Text color="fg.muted" textStyle="sm">
                No stages selected.
              </Text>
            </Card.Body>
          </Card.Root>
        )}
      </Grid>
    </Grid>
  );
}

function InventoryItemList({
  empty,
  items,
}: {
  empty: string;
  items: InventoryShellItem[];
}) {
  if (items.length === 0) {
    return (
      <Text color="fg.muted" textStyle="sm">
        {empty}
      </Text>
    );
  }

  return (
    <Grid as="ul" gap="2">
      {items.map((item) => (
        <Box as="li" key={item.id}>
          <InventoryQueueItem item={item} />
        </Box>
      ))}
    </Grid>
  );
}

function InventoryQueueItem({ item }: { item: InventoryShellItem }) {
  const status = itemStatus(item);

  return (
    <Box
      asChild
      role="group"
      display="block"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="border"
      background="bg"
      p="2.5"
      transition="border-color 150ms, background 150ms"
      _hover={{ borderColor: "border.emphasized", background: "bg.subtle" }}
      _focusVisible={{
        outline: "2px solid var(--chakra-colors-color-palette-solid)",
        outlineColor: "colorPalette.solid",
        outlineOffset: "1px",
      }}
    >
      <Link
        aria-label={`Open ${item.title}`}
        href={buildInventoryItemHref(item.id, "/inventory/processing")}
      >
        <Grid as="article" gap="2">
          <Flex minWidth="0" flexWrap="wrap" alignItems="start" gap="2">
            <Box minWidth="0" flex="1" flexBasis="44">
              <Box
                as="span"
                fontWeight="medium"
                textUnderlineOffset="4px"
                _groupHover={{ textDecoration: "underline" }}
                _groupFocusVisible={{ textDecoration: "underline" }}
              >
                {item.title}
              </Box>
              <Text mt="1" color="fg.muted" textStyle="sm" lineHeight="snug">
                {formatInventoryShellWhere(item)}
              </Text>
            </Box>
            <Badge variant="outline">{item.ageLabel}</Badge>
          </Flex>

          <Flex flexWrap="wrap" alignItems="center" gap="2">
            <Badge variant={status.variant}>{status.label}</Badge>
            <InventoryEvidenceIcons evidence={item.evidence} />
          </Flex>
          <Text color="fg.muted" textStyle="xs">
            Next: {item.nextAction}
          </Text>
        </Grid>
      </Link>
    </Box>
  );
}

function InventoryEvidenceIcons({
  evidence,
}: {
  evidence: InventoryShellEvidence[];
}) {
  const ariaLabel = evidence
    .map((entry) => `${entry.kind}: ${entry.label}`)
    .join(", ");

  return (
    <Box
      as="span"
      aria-label={ariaLabel ? `Evidence: ${ariaLabel}` : "No evidence"}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      color="fg.muted"
    >
      {evidenceKinds.map((kind) => {
        const count = evidence.filter((entry) => entry.kind === kind).length;

        if (count === 0) {
          return null;
        }

        const EvidenceIcon = evidenceIcons[kind];

        return (
          <Box
            as="span"
            position="relative"
            display="inline-flex"
            aspectRatio="1"
            boxSize="6"
            flexShrink={0}
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            borderWidth="1px"
            borderColor="border"
            background="bg.subtle"
            textStyle="xs"
            key={kind}
            title={`${count} ${kind} evidence`}
          >
            <Icon as={EvidenceIcon} aria-hidden="true" boxSize="3.5" />
            {count > 1 ? (
              <Box
                as="span"
                position="absolute"
                right="0.5"
                bottom="0.5"
                fontSize="0.5rem"
                lineHeight="1"
              >
                {count}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function itemMatchesQuery(item: InventoryShellItem, query: string): boolean {
  if (!query) {
    return true;
  }

  return [
    item.title,
    formatInventoryShellWhere(item),
    formatInventoryShellCategory(item.category),
    formatInventoryShellAcquisitionSource(item.acquisitionSource),
    item.currentStep,
    item.nextAction,
    item.sourceLabel,
    ...item.evidence.map((entry) => entry.label),
  ].some((value) => value.toLowerCase().includes(query));
}

function itemStatus(item: InventoryShellItem): {
  label: string;
  variant: React.ComponentProps<typeof Badge>["variant"];
} {
  if (item.proposal.status === "PENDING_APPROVAL") {
    return { label: "Approve proposal", variant: "outline" };
  }

  if (item.preprocessing.status === "PARTIAL") {
    return { label: "Fix partial text", variant: "outline" };
  }

  if (item.preprocessing.status === "FAILED") {
    return { label: "Review preprocessing", variant: "outline" };
  }

  if (item.preprocessing.status === "NEEDS_REVIEW") {
    return { label: "Review text", variant: "outline" };
  }

  if (item.enrichment.status === "FAILED") {
    return { label: "Review enrichment", variant: "outline" };
  }

  if (item.enrichment.status === "PROCESSING") {
    return { label: "Enriching", variant: "subtle" };
  }

  if (item.enrichment.status === "PROPOSAL_READY") {
    return { label: "Proposal ready", variant: "subtle" };
  }

  if (item.preprocessing.status === "PREPROCESSING") {
    return { label: "Reading evidence", variant: "subtle" };
  }

  if (item.preprocessing.status === "READY_FOR_ENRICHMENT") {
    return { label: "Ready for enrichment", variant: "subtle" };
  }

  return { label: "Waiting pickup", variant: "outline" };
}

function stageHint(columnId: InventoryShellProcessingColumnId): string {
  if (columnId === "captured") {
    return "Saved evidence";
  }

  if (columnId === "preprocessing") {
    return "OCR and transcript";
  }

  if (columnId === "enrichment") {
    return "Derived facts";
  }

  return "Manual decision";
}
