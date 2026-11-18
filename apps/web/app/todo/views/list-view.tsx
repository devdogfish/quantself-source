"use client";

// "List" view: Linear My issues (linear.app/docs/my-issues). Pill tabs, tinted status groups, quiet rows.
// Row: priority, number, status, title … category, owner, due. Click opens the task detail.
import { useState } from "react";
import { Box, Button, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { AgentInboxRows } from "./agent-inbox-rows";
import { bucketOf, sortForFocus, type ViewStatus, type ViewTask } from "./view-model";
import { CategoryChip, DecisionButtons, DecisionText, DueText, EmptyState, OwnerIcon, PriorityButton, StatusIcon, TaskDelegateProgress, ref, useViewActions } from "./view-parts";

type Tab = "me" | "delegated" | "inbox" | "someday" | "done";
const tabs: { key: Tab; label: string; match: (t: ViewTask) => boolean }[] = [
  { key: "me", label: "For me", match: (t) => bucketOf(t) === "needs-you" || bucketOf(t) === "yours" },
  { key: "delegated", label: "Delegated", match: (t) => bucketOf(t) === "agents" || t.status === "approve" || t.status === "needs-you" },
  { key: "inbox", label: "Inbox", match: (t) => t.status === "inbox" },
  { key: "someday", label: "Someday", match: (t) => t.status === "someday" },
  { key: "done", label: "Done", match: (t) => t.status === "done" },
];
const groups: { label: string; statuses: ViewStatus[] }[] = [
  { label: "Ready for you", statuses: ["needs-you"] },
  { label: "Approve delegation", statuses: ["approve"] },
  { label: "Agent working", statuses: ["running"] },
  { label: "Queued for agent", statuses: ["queued"] },
  { label: "Todo", statuses: ["todo"] },
  { label: "Inbox", statuses: ["inbox"] },
  { label: "Someday", statuses: ["someday"] },
  { label: "Done", statuses: ["done"] },
];

export function ListView({ tasks, agentInbox }: { tasks: ViewTask[]; agentInbox?: { canWrite: boolean } }) {
  const [tab, setTab] = useState<Tab>("me");
  const nativeState = agentInbox && (tab === "inbox" || tab === "done") ? tab : null;
  const rows = tasks.filter(tabs.find((x) => x.key === tab)!.match).sort(sortForFocus);
  return (
    <Stack gap="0" borderWidth="1px" rounded="l3" overflow="hidden" bg="bg">
      <HStack px="3" h="12" gap="1" borderBottomWidth="1px" overflowX="auto" css={{ scrollbarWidth: "none" }}>
        {tabs.map((x) => (
          <Button key={x.key} size="xs" variant={tab === x.key ? "subtle" : "ghost"} color={tab === x.key ? "fg" : "fg.muted"} onClick={() => setTab(x.key)} flexShrink={0} aria-pressed={tab === x.key}>
            {x.label}{!(agentInbox && (x.key === "inbox" || x.key === "done")) && <Text as="span" color="fg.subtle" fontVariantNumeric="tabular-nums">{tasks.filter(x.match).length}</Text>}
          </Button>
        ))}
      </HStack>
      {rows.length === 0 && !nativeState ? <EmptyState>Nothing here.</EmptyState> : groups.map((g) => {
        const items = rows.filter((t) => g.statuses.includes(t.status));
        const native = (nativeState === "inbox" && g.label === "Inbox") || (nativeState === "done" && g.label === "Done");
        if (!items.length && !native) return null;
        return (
          <Box key={g.label} role="group" aria-label={g.label}>
            <HStack h="9" px="4" gap="2" bg="bg.muted">
              <StatusIcon status={g.statuses[0]} />
              <Text textStyle="sm" fontWeight="medium">{g.label}</Text>
              {!native && <Text textStyle="sm" color="fg.subtle">{items.length}</Text>}
            </HStack>
            {items.map((t) => <ListRow key={t.id} task={t} />)}
            {native && agentInbox && nativeState && <AgentInboxRows state={nativeState} canWrite={agentInbox.canWrite} showEmpty={!items.length} />}
          </Box>
        );
      })}
    </Stack>
  );
}

function ListRow({ task: t }: { task: ViewTask }) {
  const act = useViewActions();
  const decision = t.status === "needs-you" || t.status === "approve";
  return (
    <Box borderBottomWidth="1px" borderColor="border.muted" opacity={t.pending ? 0.6 : 1}>
      <HStack minH="10" px="4" py="1" gap="3" cursor="pointer" _hover={{ bg: "bg.subtle" }} role="button" tabIndex={0}
        onClick={() => act.open(t)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) act.open(t); }} aria-label={`Open ${t.title}`}>
        <PriorityButton task={t} />
        <Text textStyle="sm" color="fg.subtle" w="10" flexShrink={0} fontVariantNumeric="tabular-nums" hideBelow="sm">{ref(t)}</Text>
        {decision ? <StatusIcon status={t.status} /> : <chakra.button type="button" display="grid" placeItems="center" boxSize="5" flexShrink={0} rounded="sm"
          aria-label={`${t.status === "done" ? "Reopen" : "Complete"} ${t.title}`} disabled={act.readOnly}
          onClick={event => { event.stopPropagation(); act.toggleDone(t); }} _hover={{ bg: "bg.emphasized" }}>
          <StatusIcon status={t.status} />
        </chakra.button>}
        <Stack gap="0" flex="1" minW="0"><Text textStyle="sm" truncate>{t.title}</Text><TaskDelegateProgress task={t} /></Stack>
        <Box hideBelow="md"><CategoryChip task={t} /></Box>
        <OwnerIcon task={t} />
        <Box w="16" textAlign="right" flexShrink={0} hideBelow="sm"><DueText task={t} /></Box>
      </HStack>
      {decision && (
        <HStack ps={{ base: "10", sm: "calc(16px + 20px + 12px + 40px + 12px + 14px + 12px)" }} pe="4" pb="2.5" gap="3" wrap="wrap">
          <DecisionText task={t} />
          <DecisionButtons task={t} />
        </HStack>
      )}
    </Box>
  );
}
