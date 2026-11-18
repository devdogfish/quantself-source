"use client";

import {
  Grid,
  Badge,
  Box,
  HStack,
  Heading,
  Stack,
  Text,
} from "@chakra-ui/react";

import type React from "react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { Panel } from "@/components/shared/dashboard";
import { AreaNav } from "@/components/shared/area-nav";
import type {
  InventoryShellEvidence,
  InventoryShellEnrichmentStatus,
  InventoryShellItem,
  InventoryShellPreprocessingStatus,
  InventoryShellProposalStatus,
} from "./inventory-shell-data";
import { InventoryBrowseNav } from "./inventory-browse-nav";

type InventoryShellRoute =
  "browse" | "capture" | "containers" | "processing" | "item";

export function InventoryShellLayout({
  active,
  children,
  title,
  titleMeta,
}: {
  active: InventoryShellRoute;
  children: React.ReactNode;
  focusItemId?: string;
  title: string;
  titleMeta?: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={title}
        actions={titleMeta}
        nav={
          <HStack gap="1" align="stretch" overflowX="auto">
            <Box minW="0">
              <AreaNav
                label="Inventory routes"
                items={[
                  { href: "/inventory", label: "Capture", exact: true },
                  { href: "/inventory/browse", label: "Browse" },
                  { href: "/inventory/processing", label: "Processing" },
                  { href: "/inventory/containers", label: "Containers" },
                  { href: "/inventory/archive", label: "Archive" },
                ]}
              />
            </Box>
            <InventoryBrowseNav active={active === "browse"} menuOnly />
          </HStack>
        }
      />
      <PageBody>
        <Stack gap="4">{children}</Stack>
      </PageBody>
    </>
  );
}

export function InventoryShellCard({
  action,
  children,
  className,
  description,
  icon,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: string;
  icon?: React.ReactNode;
  title: string;
}) {
  return (
    <Panel
      className={className}
      title={
        <HStack
          gap="2"
          css={{ "& svg": { width: "4", height: "4", flexShrink: 0 } }}
        >
          <Heading as="h2" size="sm" display="flex" alignItems="center" gap="2">
            {icon}
            {title}
          </Heading>
        </HStack>
      }
      description={description}
      action={action}
    >
      <Stack gap="4">{children}</Stack>
    </Panel>
  );
}

export function InventoryMetaGrid({
  entries,
}: {
  entries: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <Grid
      as="dl"
      templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }}
      gap="3"
    >
      {entries.map((entry) => (
        <Box key={entry.label}>
          <Text
            as="dt"
            color="fg.muted"
            textStyle="xs"
            textTransform="uppercase"
            letterSpacing="wide"
          >
            {entry.label}
          </Text>
          <Text as="dd" fontWeight="medium" textStyle="sm">
            {entry.value}
          </Text>
        </Box>
      ))}
    </Grid>
  );
}

export function InventoryEvidenceBadges({
  evidence,
}: {
  evidence: InventoryShellEvidence[];
}) {
  return (
    <HStack gap="2" wrap="wrap">
      {evidence.map((entry) => (
        <Badge key={entry.id} variant="outline">
          {entry.kind}
          <span>{entry.label}</span>
        </Badge>
      ))}
    </HStack>
  );
}

export function InventoryStatusBadge({
  status,
}: {
  status:
    | InventoryShellProposalStatus
    | InventoryShellEnrichmentStatus
    | InventoryShellPreprocessingStatus
    | InventoryShellItem["status"]
    | InventoryShellItem["importance"];
}) {
  return (
    <Badge
      variant={statusBadgeVariant(status)}
      colorPalette={
        status === "TRASH" || status === "REJECTED" ? "red" : undefined
      }
    >
      {statusLabel(status)}
    </Badge>
  );
}

function statusBadgeVariant(
  status:
    | InventoryShellProposalStatus
    | InventoryShellEnrichmentStatus
    | InventoryShellPreprocessingStatus
    | InventoryShellItem["status"]
    | InventoryShellItem["importance"],
): React.ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "TRASH":
    case "REJECTED":
      return "solid";
    case "PROCESSING":
    case "READY_FOR_ENRICHMENT":
    case "PROPOSAL_READY":
    case "PREPROCESSING":
    case "KEEP":
    case "HIGH":
    case "APPLIED":
    case "APPROVED":
      return "subtle";
    default:
      return "outline";
  }
}

function statusLabel(
  status:
    | InventoryShellProposalStatus
    | InventoryShellEnrichmentStatus
    | InventoryShellPreprocessingStatus
    | InventoryShellItem["status"]
    | InventoryShellItem["importance"],
): string {
  return status.toLowerCase().replaceAll("_", " ");
}
