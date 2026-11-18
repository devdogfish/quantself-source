import { AppearanceSettings } from "@/app/settings/appearance-settings";
import { NotificationSettings } from "@/components/notifications/settings";
import Link from "next/link";
import {
  Badge,
  Box,
  Grid,
  Heading,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from "@chakra-ui/react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { SettingsRow } from "./settings-row";
import { Suspense, type ReactNode } from "react";
import {
  createApiKeyWithStateAction,
  revokeApiKeyWithStateAction,
  rotateApiKeyWithStateAction,
} from "@/app/settings/actions";
import {
  approveInventoryEnrichmentProposalWithStateAction,
  rejectInventoryEnrichmentProposalWithStateAction,
  updateInventoryEnrichmentApprovalSettingWithStateAction,
} from "@/app/settings/inventory-actions";
import {
  getInventoryEnrichmentSettings,
  listActiveInventoryItems,
  listInventoryProposals,
  type InventoryItem,
  type InventoryProposal,
} from "@/lib/quantself-api-client";
import { loadOwnerApiKeys } from "@/lib/owner-api-keys-server";
import { requireOwnerPageSession } from "@/lib/owner-session-server";
import { InventoryApprovalSetting } from "./inventory-approval-setting";
import { ApiKeysCard } from "./api-keys-card";
import { InventoryProposalActions } from "./inventory-proposal-actions";
import SettingsLoading from "./loading";

export const dynamic = "force-dynamic";

const statusLabels = {
  APPLIED: "Applied",
  CANCELLED: "Cancelled",
  CLAIMED: "Claimed",
  FAILED: "Failed",
  PENDING_APPROVAL: "Pending",
  QUEUED: "Queued",
  REJECTED: "Rejected",
} as const;
const queueStatusOrder = [
  "APPLIED",
  "CANCELLED",
  "CLAIMED",
  "FAILED",
  "PENDING_APPROVAL",
  "QUEUED",
  "REJECTED",
] as const;
type QueueStatus = (typeof queueStatusOrder)[number];

export default function SettingsPage() {
  const dataPromise = loadSettingsPageData();

  return (
    <SettingsPageFrame
      pendingCount={
        <Suspense fallback={<Skeleton height="4" width="16" />}>
          <SettingsPendingCount dataPromise={dataPromise} />
        </Suspense>
      }
    >
      <AppearanceSettings />
      <NotificationSettings />
      <SettingsRow title="Meeting booking" help="Hours, time zone, notice and horizon for calls visitors book from the portfolio.">
        <ChakraLink asChild textStyle="sm" textDecoration="underline"><Link href="/settings/booking">Edit booking hours</Link></ChakraLink>
      </SettingsRow>
      <Suspense fallback={<SettingsLoading contentOnly />}>
        <SettingsPageSectionsAsync dataPromise={dataPromise} />
      </Suspense>
    </SettingsPageFrame>
  );
}

async function loadSettingsPageData() {
  const session = await requireOwnerPageSession();
  const [settings, proposalCandidates, activeItems, apiKeys] =
    await Promise.all([
      getInventoryEnrichmentSettings(),
      listInventoryProposals({ limit: 20 }),
      listActiveInventoryItems(),
      loadOwnerApiKeys(session.user.id),
    ]);
  const activeItemIds = new Set(activeItems.map((item) => item.id));
  const proposals = proposalCandidates.filter((proposal) =>
    activeItemIds.has(proposal.itemId),
  );

  return { activeItems, apiKeys, proposals, settings };
}

type SettingsPageData = Awaited<ReturnType<typeof loadSettingsPageData>>;

async function SettingsPendingCount({
  dataPromise,
}: {
  dataPromise: Promise<SettingsPageData>;
}) {
  const data = await dataPromise;

  return <span>{data.proposals.length} pending</span>;
}

async function SettingsPageSectionsAsync({
  dataPromise,
}: {
  dataPromise: Promise<SettingsPageData>;
}) {
  return <SettingsPageSections data={await dataPromise} />;
}

function SettingsPageFrame({
  children,
  pendingCount,
}: {
  children: ReactNode;
  pendingCount: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Inventory Enrichment"
        facts={[{ label: "Inventory proposals", value: pendingCount }]}
      />
      <PageBody>
        <Stack gap="0">{children}</Stack>
      </PageBody>
    </>
  );
}

function SettingsPageSections({ data }: { data: SettingsPageData }) {
  const { activeItems, apiKeys, proposals, settings } = data;
  const queueCounts = countItemsByStatus(activeItems);
  const approvalModeLabel = settings.approvalsRequired
    ? "Approval required"
    : "Auto-apply enabled";
  const reviewStateLabel =
    proposals.length === 0
      ? "No review needed"
      : `${proposals.length} proposal${proposals.length === 1 ? "" : "s"} ${proposals.length === 1 ? "needs" : "need"} review`;

  return (
    <>
      <SettingsRow
        title="Approval mode"
        help="Choose how inventory enrichments are applied."
      >
        <Stack gap="4">
          <Box>
            <Text fontSize="xs" color="fg.muted">
              Current mode
            </Text>
            <HStack gap="3" wrap="wrap">
              <Text fontWeight="semibold">{approvalModeLabel}</Text>
              <Badge
                variant={settings.approvalsRequired ? "outline" : "subtle"}
              >
                {settings.approvalsRequired ? "Manual review" : "Automatic"}
              </Badge>
            </HStack>
            <Text mt="2" color="fg.muted" textStyle="sm">
              {reviewStateLabel}
            </Text>
          </Box>
          <InventoryApprovalSetting
            action={updateInventoryEnrichmentApprovalSettingWithStateAction}
            autoApproveFuture={!settings.approvalsRequired}
          />
        </Stack>
      </SettingsRow>
      <SettingsRow
        title="Queue state"
        help="Current inventory processing status."
      >
        <Grid
          templateColumns={{
            base: "repeat(2, minmax(0, 1fr))",
            md: "repeat(4, minmax(0, 1fr))",
          }}
          gap="3"
        >
          {queueStatusOrder.map((status) => (
            <Box key={status}>
              <Text textStyle="xs" color="fg.muted">
                {statusLabels[status]}
              </Text>
              <Text mt="1" fontSize="2xl" fontWeight="semibold">
                {queueCounts[status]}
              </Text>
            </Box>
          ))}
        </Grid>
      </SettingsRow>
      <ApiKeysCard
        createAction={createApiKeyWithStateAction}
        initialCredentials={apiKeys}
        revokeAction={revokeApiKeyWithStateAction}
        rotateAction={rotateApiKeyWithStateAction}
      />
      <SettingsRow
        title="Inventory proposals"
        help="Review proposed changes before applying them."
      >
        {proposals.length > 0 ? (
          <Stack gap="6">
            {proposals.map((proposal) => (
              <Stack
                key={proposal.id}
                gap="4"
                borderBottomWidth="1px"
                pb="6"
                minW="0"
              >
                <HStack justify="space-between" align="start" gap="3">
                  <Box minW="0">
                    <Heading as="h3" size="sm">
                      {proposal.itemTitle}
                    </Heading>
                    <Text
                      textStyle="sm"
                      color="fg.muted"
                      overflowWrap="anywhere"
                    >
                      {proposalSubtitle(proposal)}
                    </Text>
                  </Box>
                  <Badge variant="subtle">Pending</Badge>
                </HStack>
                <ProposalDiff entries={proposal.diff} />
                <HStack wrap="wrap" gap="3">
                  <InventoryProposalActions
                    approveAction={
                      approveInventoryEnrichmentProposalWithStateAction
                    }
                    itemId={proposal.itemId}
                    jobId={proposal.id}
                    rejectAction={
                      rejectInventoryEnrichmentProposalWithStateAction
                    }
                  />
                  <ChakraLink asChild textStyle="sm">
                    <Link href={`/inventory/items/${proposal.itemId}`}>
                      Open item
                    </Link>
                  </ChakraLink>
                </HStack>
              </Stack>
            ))}
          </Stack>
        ) : (
          <Text textStyle="sm" color="fg.muted">
            No inventory enrichment proposals waiting.
          </Text>
        )}
      </SettingsRow>
    </>
  );
}

function ProposalDiff({ entries }: { entries: InventoryProposal["diff"] }) {
  if (entries.length === 0) {
    return (
      <Text textStyle="sm" color="fg.muted">
        No displayable changes.
      </Text>
    );
  }
  return (
    <Stack gap="3">
      {entries.map((entry) => (
        <Grid
          key={entry.field}
          templateColumns={{ base: "1fr", md: "8rem minmax(0, 1fr)" }}
          gap="2"
          textStyle="sm"
        >
          <Text fontSize="xs" color="fg.muted">
            {entry.label}
          </Text>
          <Stack minW="0" gap="1" overflowWrap="anywhere">
            <Text color="fg.muted">
              <Text as="span" mr="2" fontSize="xs">
                Current
              </Text>
              {entry.current}
            </Text>
            <Text fontWeight="medium">
              <Text as="span" mr="2" fontSize="xs" color="fg.muted">
                Proposed
              </Text>
              {entry.proposed}
            </Text>
          </Stack>
        </Grid>
      ))}
    </Stack>
  );
}

function countItemsByStatus(
  items: InventoryItem[],
): Record<QueueStatus, number> {
  const counts = Object.fromEntries(
    queueStatusOrder.map((status) => [status, 0]),
  ) as Record<QueueStatus, number>;

  for (const item of items) {
    if (item.processing.proposal.status === "APPROVED") {
      counts.APPLIED += 1;
      continue;
    }

    if (item.processing.proposal.status === "REJECTED") {
      counts.REJECTED += 1;
      continue;
    }

    if (item.processing.enrichment.status === "CANCELLED") {
      counts.CANCELLED += 1;
      continue;
    }

    if (item.processing.proposal.status === "PENDING_APPROVAL") {
      counts.PENDING_APPROVAL += 1;
      continue;
    }

    if (item.processing.enrichment.status === "PROCESSING") {
      counts.CLAIMED += 1;
      continue;
    }

    if (item.processing.enrichment.status === "QUEUED") {
      counts.QUEUED += 1;
      continue;
    }

    if (item.processing.enrichment.status === "FAILED") {
      counts.FAILED += 1;
      continue;
    }

    if (item.processing.preprocessing.status === "NEEDS_REVIEW") {
      counts.FAILED += 1;
      continue;
    }

    if (
      item.processing.preprocessing.status === "CAPTURED" ||
      item.processing.preprocessing.status === "PREPROCESSING" ||
      item.processing.preprocessing.status === "READY_FOR_ENRICHMENT" ||
      item.processing.preprocessing.status === "PARTIAL"
    ) {
      counts.QUEUED += 1;
    }
  }

  return counts;
}

function proposalSubtitle(proposal: InventoryProposal): string {
  return `Inventory Item · ${proposal.itemId}`;
}
