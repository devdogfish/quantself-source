"use client";

// "Triage" view: Superhuman split inbox + Linear Inbox keys (superhuman.com/learn/email/inbox-zero-method, linear.app/docs/inbox).
// One item at a time. Splits: Needs you (agent hand-backs and delegation approvals) and Inbox (captures).
// Keys: J/K move, Tab switch split, E do it / accept, H Someday, Enter open.
import { useEffect, useState } from "react";
import { Box, Button, Flex, HStack, Icon, Kbd, Stack, Text } from "@chakra-ui/react";
import { CheckCheck } from "lucide-react";
import { bucketOf, statusLabel, type ViewTask } from "./view-model";
import { DecisionButtons, DecisionText, GitHubLink, StatusIcon, TaskDelegate, TaskDelegateProgress, useViewActions } from "./view-parts";

type Split = "you" | "inbox" | "agents";
const splits: { key: Split; label: string; match: (t: ViewTask) => boolean }[] = [
  { key: "you", label: "Needs you", match: (t) => bucketOf(t) === "needs-you" },
  { key: "inbox", label: "Inbox", match: (t) => t.status === "inbox" },
  { key: "agents", label: "With agents", match: (t) => t.status === "running" },
];

export function TriageView({ tasks, initialSplit = "you" }: { tasks: ViewTask[]; initialSplit?: Split }) {
  const act = useViewActions();
  const [split, setSplit] = useState<Split>(initialSplit);
  const [sel, setSel] = useState(0);
  const items = tasks.filter(splits.find((s) => s.key === split)!.match).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const i = Math.min(sel, Math.max(0, items.length - 1));
  const cur = items[i];

  const doIt = (t: ViewTask) => {
    if (t.status === "inbox") act.setCommitment(t, "Active");
    else if (t.status === "needs-you" && act.decisions?.available && !act.decisions.busy(t.source)) {
      if (t.source.delegation?.pendingDecision) act.decisions.resume(t.source);
      else act.decisions.decide(t.source, { decision: "accept" });
    }
    else act.open(t);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest("input, textarea, select, [role=menu], [role=dialog], [contenteditable], [data-task-link-control]"))) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(items.length - 1, i + 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(0, i - 1)); }
      else if (e.key === "Tab" && !e.shiftKey && (!(e.target instanceof HTMLElement) || e.target === document.body)) {
        e.preventDefault(); setSplit(splits[(splits.findIndex(item => item.key === split) + 1) % splits.length].key); setSel(0);
      }
      else if (!cur || act.readOnly) return;
      else if (e.key === "e" || (e.key === "a" && split === "you")) doIt(cur);
      else if (e.key === "r" && split === "you" && act.decisions?.available && !act.decisions.busy(cur.source) && !cur.source.delegation?.pendingDecision) act.decisions.returnToAgent(cur.source);
      else if (e.key === "h" && split !== "agents") act.setCommitment(cur, "Someday");
      else if (e.key === "Enter" && e.target === document.body) act.open(cur);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Flex direction={{ base: "column", md: "row" }} borderWidth="1px" rounded="l3" overflow="hidden" bg="bg" h={{ base: "auto", md: "72vh" }}>
      <Stack w={{ base: "full", md: "380px" }} maxH={{ base: "300px", md: "none" }} flexShrink={0} borderRightWidth={{ base: 0, md: "1px" }} borderBottomWidth={{ base: "1px", md: 0 }} gap="0">
        <HStack px="4" h="12" gap="5" borderBottomWidth="1px" role="tablist">
          {splits.map((s) => (
            <Box as="button" key={s.key} role="tab" aria-selected={split === s.key} h="full" borderBottomWidth="2px" borderColor={split === s.key ? "fg" : "transparent"} cursor="pointer" onClick={() => { setSplit(s.key); setSel(0); }}>
              <Text textStyle="sm" fontWeight={split === s.key ? "semibold" : "normal"} color={split === s.key ? "fg" : "fg.muted"}>{s.label} <Text as="span" color="fg.subtle" fontWeight="normal">{tasks.filter(s.match).length}</Text></Text>
            </Box>
          ))}
          <Kbd size="sm" ms="auto" hideBelow="md">Tab</Kbd>
        </HStack>
        <Stack gap="0" overflowY="auto" flex="1">
          {items.map((t, idx) => (
            <Box as="button" key={t.id} textAlign="left" px="4" py="3" borderBottomWidth="1px" borderColor="border.muted" cursor="pointer" onClick={() => setSel(idx)}
              bg={idx === i ? "bg.emphasized" : undefined} boxShadow={idx === i ? "inset 3px 0 0 var(--chakra-colors-brand-solid)" : undefined} _hover={{ bg: idx === i ? "bg.emphasized" : "bg.subtle" }}>
              <HStack gap="2" mb="0.5">
                <Box boxSize="2" rounded="full" bg={t.status === "inbox" ? "transparent" : "orange.500"} flexShrink={0} />
                <Text textStyle="sm" fontWeight="semibold" flex="1" truncate>{t.title}</Text>
              </HStack>
              <Text ps="4" textStyle="sm" color="fg.muted" truncate>{t.status === "inbox" ? t.category ?? "Not triaged" : t.agentNote ?? statusLabel[t.status]}</Text>
            </Box>
          ))}
          {items.length === 0 && <Text px="4" py="8" textStyle="sm" color="fg.muted">Nothing left in this split.</Text>}
        </Stack>
      </Stack>

      <Stack flex="1" minW="0" gap="0" minH={{ base: "360px", md: "0" }}>
        {!cur ? (
          <Stack flex="1" align="center" justify="center" gap="3" color="fg.muted" py="10">
            <Icon as={CheckCheck} boxSize="10" color="green.500" />
            <Text textStyle="lg" fontWeight="semibold" color="fg">You&apos;re all caught up</Text>
            <Text textStyle="sm">{split === "you" ? "Agent hand-backs land here." : split === "inbox" ? "New captures land here." : "No delegated tasks."}</Text>
          </Stack>
        ) : (
          <>
            <Stack px={{ base: "5", md: "8" }} pt="6" pb="4" gap="2" borderBottomWidth="1px">
              <HStack gap="2" textStyle="sm" color="fg.muted"><StatusIcon status={cur.status} /><Text>{statusLabel[cur.status]}</Text><Text color="fg.subtle">{i + 1} of {items.length}</Text></HStack>
              <Text as="h2" textStyle="2xl" fontWeight="semibold" letterSpacing="tight">{cur.title}</Text>
              <TaskDelegateProgress task={cur} />
            </Stack>
            <Stack flex="1" overflowY="auto" px={{ base: "5", md: "8" }} py="6" gap="5" maxW="3xl">
              {split === "you" && <DecisionText task={cur} />}
              {cur.source.description && <Text textStyle="sm" whiteSpace="pre-wrap" lineClamp={8}>{cur.source.description}</Text>}
              <GitHubLink task={cur} />
            </Stack>
            <HStack px={{ base: "5", md: "8" }} py="3" borderTopWidth="1px" gap="2" wrap="wrap" bg="bg.subtle">
              {split === "inbox" && <Button size="sm" disabled={act.readOnly} onClick={() => doIt(cur)}>
                I&apos;ll do it <Kbd size="sm">E</Kbd>
              </Button>}
              {split === "you" && <>
                <DecisionButtons task={cur} size="sm" />
                {act.decisions?.available && !cur.source.delegation?.pendingDecision && <HStack gap="1" fontSize="xs"><Kbd size="sm">A</Kbd> Accept <Kbd size="sm">R</Kbd> Return</HStack>}
              </>}
              <Button size="sm" variant="outline" onClick={() => act.open(cur)}>Open <Kbd size="sm">↵</Kbd></Button>
              <TaskDelegate task={cur} />
              {split !== "agents" && <Button size="sm" variant="ghost" color="fg.muted" disabled={act.readOnly} onClick={() => act.setCommitment(cur, "Someday")}>Someday <Kbd size="sm">H</Kbd></Button>}
              <HStack ms="auto" gap="1" textStyle="xs" color="fg.subtle" hideBelow="md"><Kbd size="sm">J</Kbd><Kbd size="sm">K</Kbd><Text>next / previous</Text></HStack>
            </HStack>
          </>
        )}
      </Stack>
    </Flex>
  );
}
