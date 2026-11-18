"use client";

// "Board" view: GitHub Projects board layout (docs.github.com … customizing-the-board-layout).
// Columns from one status field with count, limit and description; issue cards.
import { useState } from "react";
import { Box, Flex, HStack, Input, InputGroup, Stack, Text } from "@chakra-ui/react";
import { Search } from "lucide-react";
import { sortForFocus, type ViewStatus, type ViewTask } from "./view-model";
import { DecisionButtons, DecisionText, OwnerIcon, StatusIcon, TaskDelegateProgress, useViewActions } from "./view-parts";

const columns: { key: string; name: string; desc: string; dot: string; statuses: ViewStatus[]; limit?: number }[] = [
  { key: "inbox", name: "Inbox", desc: "Captured, not triaged", dot: "gray.400", statuses: ["inbox"] },
  { key: "todo", name: "Todo", desc: "Committed, yours", dot: "blue.500", statuses: ["todo"] },
  { key: "agent", name: "With agents", desc: "Queued or being worked on", dot: "yellow.500", statuses: ["queued", "running"] },
  { key: "you", name: "Needs you", desc: "Approve delegation or review handed-back work", dot: "orange.500", statuses: ["approve", "needs-you"] },
  { key: "done", name: "Done", desc: "Completed", dot: "purple.500", statuses: ["done"] },
];

export function BoardView({ tasks }: { tasks: ViewTask[] }) {
  const [q, setQ] = useState("");
  const shown = tasks.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <Stack gap="0" borderWidth="1px" rounded="l2" bg="bg" overflow="hidden">
      <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
        <InputGroup startElement={<Search size={14} />} flex="1" maxW="lg">
          <Input size="xs" placeholder="Filter by keyword" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tasks" />
        </InputGroup>
        <Text textStyle="xs" color="fg.muted" ms="auto" hideBelow="sm">{tasks.filter((t) => t.status === "someday").length} in Someday hidden</Text>
      </HStack>
      <Flex gap="3" p="3" overflowX="auto" bg="bg.subtle" align="start" minH="70vh">
        {columns.map((c) => {
          const items = shown.filter((t) => c.statuses.includes(t.status)).sort(sortForFocus).slice(0, c.key === "done" ? 20 : undefined);
          return (
            <Stack key={c.key} w="290px" flexShrink={0} gap="2" bg="bg.muted" rounded="l2" p="2" borderWidth="1px" borderColor="border.muted" role="group" aria-label={c.name}>
              <Stack gap="0.5" px="1.5" pt="1">
                <HStack gap="2">
                  <Box boxSize="3" rounded="full" borderWidth="2px" borderColor={c.dot} />
                  <Text textStyle="sm" fontWeight="semibold">{c.name}</Text>
                  <Box px="1.5" rounded="full" bg="bg.emphasized" textStyle="xs" color="fg.muted" fontVariantNumeric="tabular-nums">{shown.filter((t) => c.statuses.includes(t.status)).length}</Box>
                </HStack>
                <Text textStyle="xs" color="fg.muted">{c.desc}</Text>
              </Stack>
              <Stack gap="2">{items.map((t) => <BoardCard key={t.id} task={t} />)}</Stack>
            </Stack>
          );
        })}
      </Flex>
    </Stack>
  );
}

function BoardCard({ task: t }: { task: ViewTask }) {
  const act = useViewActions();
  const decision = t.status === "approve" || t.status === "needs-you";
  return (
    <Stack gap="2" bg="bg" borderWidth="1px" rounded="md" p="3" shadow="xs" _hover={{ borderColor: "border.emphasized" }} cursor="pointer" onClick={() => act.open(t)} opacity={t.pending ? 0.6 : 1}>
      <HStack gap="1.5" textStyle="xs" color="fg.muted">
        <StatusIcon status={t.status} size={12} />
        <Text>#{t.number}</Text>
        <Box ms="auto"><OwnerIcon task={t} size={12} /></Box>
      </HStack>
      <Text textStyle="sm" fontWeight="medium" lineHeight="short">{t.title}</Text>
      {decision && (
        <Stack gap="2" pt="1" borderTopWidth="1px" borderColor="border.muted">
          <DecisionText task={t} />
          <DecisionButtons task={t} />
        </Stack>
      )}
      <TaskDelegateProgress task={t} />
      {(t.category || t.dueLabel) && (
        <HStack gap="1.5" wrap="wrap">
          {t.category && <Box px="2" rounded="full" borderWidth="1px" textStyle="xs" color="fg.muted">{t.category}</Box>}
          {t.dueLabel && <Box px="2" rounded="full" borderWidth="1px" textStyle="xs" color={t.overdue ? "red.fg" : t.dueToday ? "orange.fg" : "fg.muted"}>Due {t.dueLabel.toLowerCase()}</Box>}
        </HStack>
      )}
    </Stack>
  );
}
