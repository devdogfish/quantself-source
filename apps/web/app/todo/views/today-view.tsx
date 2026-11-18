"use client";

// "Today" view: Things 3 Today/Upcoming (culturedcode.com/things/support/articles/4001304/).
// Big title, today's schedule in a grey box, quiet checkbox rows with a project subline and deadline flag.
// Changes: agent hand-backs sit at the top with their decision; "Delegated" replaces This Evening.
import { useState } from "react";
import { Box, Checkbox, Flex, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { Archive, Bot, CalendarDays, Flag, Inbox, Layers, Star, type LucideIcon } from "lucide-react";
import { bucketOf, sortForFocus, type ViewTask } from "./view-model";
import { DecisionButtons, DecisionText, EmptyState, TaskDelegate, TaskDelegateProgress, useViewActions } from "./view-parts";

type List = "inbox" | "today" | "upcoming" | "anytime" | "someday" | "logbook" | "agents";

const isToday = (t: ViewTask, today: string) => t.dueToday || t.overdue || t.plannedDate === today || (t.top && t.status === "todo");

export function TodayView({ tasks, today }: { tasks: ViewTask[]; today: string }) {
  const [list, setList] = useState<List>("today");
  const waiting = tasks.filter((t) => bucketOf(t) === "needs-you");
  const nav: { key: List; label: string; icon: LucideIcon; color: string; count?: number; badge?: number }[] = [
    { key: "inbox", label: "Inbox", icon: Inbox, color: "blue.500", count: tasks.filter((t) => t.status === "inbox").length },
    { key: "today", label: "Today", icon: Star, color: "yellow.500", count: tasks.filter((t) => t.status === "todo" && isToday(t, today)).length, badge: waiting.length },
    { key: "upcoming", label: "Upcoming", icon: CalendarDays, color: "red.500" },
    { key: "anytime", label: "Anytime", icon: Layers, color: "teal.500" },
    { key: "someday", label: "Someday", icon: Archive, color: "yellow.700" },
    { key: "logbook", label: "Logbook", icon: Flag, color: "green.600" },
    { key: "agents", label: "Agent work", icon: Bot, color: "fg.muted", count: tasks.filter((t) => t.delegated).length },
  ];
  return (
    <Flex borderWidth="1px" rounded="l3" overflow="hidden" bg="bg" minH="70vh">
      <Stack w="56" flexShrink={0} bg="bg.subtle" borderRightWidth="1px" p="3" gap="0.5" hideBelow="md" as="nav" aria-label="Lists">
        {nav.map((n, i) => (
          <Box key={n.key} mt={i === 1 || i === 5 || i === 6 ? "3" : 0}>
            <HStack as="button" w="full" gap="2" px="2" h="7" rounded="md" bg={list === n.key ? "bg.emphasized" : undefined} _hover={{ bg: list === n.key ? "bg.emphasized" : "bg.muted" }}
              cursor="pointer" onClick={() => setList(n.key)} aria-current={list === n.key ? "page" : undefined}>
              <Icon as={n.icon} boxSize="4" color={n.color} fill={n.key === "today" ? "currentColor" : undefined} />
              <Text textStyle="sm" fontWeight={list === n.key ? "medium" : undefined} flex="1" textAlign="left">{n.label}</Text>
              {!!n.badge && <Box px="1.5" rounded="full" bg="red.500" color="white" textStyle="xs" fontWeight="semibold">{n.badge}</Box>}
              {!!n.count && <Text textStyle="xs" color="fg.subtle">{n.count}</Text>}
            </HStack>
          </Box>
        ))}
      </Stack>
      <Box flex="1" minW="0">
        <HStack gap="1" p="2" borderBottomWidth="1px" overflowX="auto" hideFrom="md" css={{ scrollbarWidth: "none" }}>
          {nav.map((n) => <Box as="button" key={n.key} px="2.5" h="7" rounded="md" flexShrink={0} textStyle="sm" bg={list === n.key ? "bg.emphasized" : undefined} onClick={() => setList(n.key)}>{n.label}</Box>)}
        </HStack>
        <Box maxW="2xl" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "6", md: "10" }}>
          {list === "today" ? <TodayList tasks={tasks} today={today} />
            : list === "upcoming" ? <UpcomingList tasks={tasks} today={today} />
            : <SimpleList list={list} tasks={tasks} />}
        </Box>
      </Box>
    </Flex>
  );
}

function Title({ icon, color, children, filled }: { icon: LucideIcon; color: string; children: React.ReactNode; filled?: boolean }) {
  return <HStack gap="2.5" mb="5"><Icon as={icon} boxSize="6" color={color} fill={filled ? "currentColor" : undefined} /><Text as="h2" textStyle="2xl" fontWeight="bold" letterSpacing="tight">{children}</Text></HStack>;
}

function TodayList({ tasks, today }: { tasks: ViewTask[]; today: string }) {
  const waiting = tasks.filter((t) => bucketOf(t) === "needs-you");
  const mine = tasks.filter((t) => t.status === "todo" && isToday(t, today)).sort(sortForFocus);
  const scheduled = tasks.filter((t) => t.plannedDate === today && t.start && t.status !== "done").sort((a, b) => a.start!.localeCompare(b.start!));
  const delegated = tasks.filter((t) => t.status === "queued" || t.status === "running");
  return (
    <>
      <Title icon={Star} color="yellow.500" filled>Today</Title>
      {scheduled.length > 0 && (
        <Stack gap="0.5" bg="bg.muted" rounded="l2" px="3" py="2.5" mb="6" textStyle="sm">
          {scheduled.map((t) => <HStack key={t.id} gap="2"><Box w="0.5" h="3.5" bg="brand.solid" rounded="full" /><Text color="brand.fg" fontVariantNumeric="tabular-nums">{t.start}</Text><Text truncate>{t.title}</Text></HStack>)}
        </Stack>
      )}
      {waiting.map((t) => <ThingsRow key={t.id} task={t} />)}
      {mine.map((t) => <ThingsRow key={t.id} task={t} />)}
      {waiting.length + mine.length === 0 && <EmptyState>Nothing planned for today. Pick something from Anytime.</EmptyState>}
      {delegated.length > 0 && (
        <>
          <HStack gap="2" mt="10" mb="1" pb="1.5" borderBottomWidth="1px"><Icon as={Bot} boxSize="4" color="fg.muted" /><Text textStyle="sm" fontWeight="semibold" color="fg.muted">Delegated</Text></HStack>
          {delegated.map((t) => <ThingsRow key={t.id} task={t} />)}
        </>
      )}
    </>
  );
}

function UpcomingList({ tasks, today }: { tasks: ViewTask[]; today: string }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T12:00:00Z`) + (i + 1) * 86400000).toISOString().slice(0, 10));
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" });
  const dateOf = (t: ViewTask) => t.plannedDate ?? (t.dueLabel ? t.source.fields.Due ?? undefined : undefined);
  return (
    <>
      <Title icon={CalendarDays} color="red.500">Upcoming</Title>
      {days.map((d, i) => {
        const items = tasks.filter((t) => t.status !== "done" && t.status !== "closed" && dateOf(t) === d);
        return (
          <Box key={d} mb="6">
            <HStack gap="2" align="baseline" pb="1.5" borderBottomWidth="1px" mb="1">
              <Text textStyle="2xl" fontWeight="bold">{Number(d.slice(8))}</Text>
              <Text textStyle="sm" fontWeight="semibold" color="fg.muted">{i === 0 ? "Tomorrow" : weekday.format(new Date(`${d}T12:00:00Z`))}</Text>
            </HStack>
            {items.map((t) => <ThingsRow key={t.id} task={t} />)}
          </Box>
        );
      })}
    </>
  );
}

function SimpleList({ list, tasks }: { list: Exclude<List, "today" | "upcoming">; tasks: ViewTask[] }) {
  const meta: Record<typeof list, { label: string; icon: LucideIcon; color: string; match: (t: ViewTask) => boolean; empty: string }> = {
    inbox: { label: "Inbox", icon: Inbox, color: "blue.500", match: (t) => t.status === "inbox", empty: "Inbox is clear." },
    anytime: { label: "Anytime", icon: Layers, color: "teal.500", match: (t) => t.status === "todo", empty: "Nothing committed." },
    someday: { label: "Someday", icon: Archive, color: "yellow.700", match: (t) => t.status === "someday", empty: "Nothing parked." },
    logbook: { label: "Logbook", icon: Flag, color: "green.600", match: (t) => t.status === "done", empty: "Nothing completed yet." },
    agents: { label: "Agent work", icon: Bot, color: "fg.muted", match: (t) => t.delegated, empty: "No agent work. Delegate from a task's detail." },
  };
  const m = meta[list];
  const items = tasks.filter(m.match).sort(sortForFocus);
  return (
    <>
      <Title icon={m.icon} color={m.color}>{m.label}</Title>
      {items.length === 0 ? <EmptyState>{m.empty}</EmptyState> : items.map((t) => <ThingsRow key={t.id} task={t} />)}
    </>
  );
}

function ThingsRow({ task: t }: { task: ViewTask }) {
  const act = useViewActions();
  const decision = t.status === "needs-you" || t.status === "approve";
  const agentRunning = t.status === "queued" || t.status === "running";
  const sub = decision || agentRunning ? null : t.category;
  return (
    <HStack align="start" gap="3" py="1.5" px="1" rounded="md" _hover={{ bg: "bg.subtle" }} opacity={t.pending ? 0.6 : 1}>
      <Checkbox.Root size="sm" mt="0.5" checked={t.status === "done"} disabled={act.readOnly || decision}
        onCheckedChange={() => act.toggleDone(t)} aria-label={`${t.status === "done" ? "Reopen" : "Complete"} ${t.title}`}>
        <Checkbox.HiddenInput /><Checkbox.Control rounded="sm" borderStyle={t.status === "someday" ? "dashed" : undefined} />
      </Checkbox.Root>
      <Stack gap="0" flex="1" minW="0" cursor="pointer" onClick={() => act.open(t)}>
        <Text textStyle="sm" truncate opacity={t.status === "done" ? 0.5 : 1}>{t.title}</Text>
        {sub && <Text textStyle="xs" color="fg.muted" truncate>{sub}</Text>}
        <TaskDelegateProgress task={t} />
        {decision && (
          <Stack gap="2" mt="1.5" mb="1" ps="3" borderLeftWidth="2px" borderColor="orange.300">
            <DecisionText task={t} />
            <DecisionButtons task={t} />
          </Stack>
        )}
      </Stack>
      <TaskDelegate task={t} />
      {t.dueLabel && t.status !== "done" && (
        <HStack gap="1" color={t.overdue || t.dueToday ? "red.500" : "fg.subtle"} textStyle="xs" flexShrink={0} mt="0.5">
          <Icon as={Flag} boxSize="3" fill="currentColor" /><Text>{t.dueLabel.toLowerCase()}</Text>
        </HStack>
      )}
    </HStack>
  );
}
