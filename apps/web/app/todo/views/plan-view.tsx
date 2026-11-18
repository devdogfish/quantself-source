"use client";

// "Plan" view: the Today column and calendar rail from Sunsama's daily planning (help.sunsama.com/docs/daily-planning).
// Owner feedback: keep the middle column and the calendar; the agent review column needs more context, so it is a
// single line linking to the decisions instead.
import { Box, Button, Grid, HStack, Icon, Stack, Text, chakra } from "@chakra-ui/react";
import { Bot, Check, Hash, Plus } from "lucide-react";
import { DayTimeline } from "@/components/shared/day-timeline";
import { bucketOf, sortForFocus, type ViewTask } from "./view-model";
import { TaskDelegate, useViewActions } from "./view-parts";

const fmt = (m?: number) => (m == null ? "" : `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`);
const plus = (hhmm: string, m: number) => { const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + m; return `${String(Math.min(23, Math.floor(t / 60))).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

export function PlanView({ tasks, today, now, onShowDecisions }: { tasks: ViewTask[]; today: string; now?: string; onShowDecisions: () => void }) {
  const act = useViewActions();
  const waiting = tasks.filter((t) => bucketOf(t) === "needs-you").length;
  const working = tasks.filter((t) => t.status === "running" || t.status === "queued");
  const todays = tasks.filter((t) => (t.status === "todo" || (t.status === "done" && t.plannedDate === today)) && (t.dueToday || t.overdue || t.plannedDate === today || t.top))
    .sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99") || sortForFocus(a, b));
  const work = todays.filter((t) => t.status !== "done").reduce((s, t) => s + (t.minutes ?? 0), 0);
  const blocks = tasks.filter((t) => t.plannedDate === today && t.start && t.minutes && t.status !== "closed")
    .map((t) => ({ key: t.id, start: t.start!, end: plus(t.start!, t.minutes!), title: t.title, palette: t.delegated ? "gray" : "brand", onClick: () => act.open(t) }));
  return (
    <Grid templateColumns={{ base: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 300px" }} gap="8" maxW="5xl" mx="auto" alignItems="start">
      <Stack gap="3">
        <Stack gap="0.5">
          <Text as="h2" textStyle="xl" fontWeight="semibold">Today</Text>
          <Text textStyle="sm" color="fg.muted" fontStyle="italic">What you plan to do yourself</Text>
        </Stack>
        {(waiting > 0 || working.length > 0) && (
          <HStack gap="3" textStyle="sm" color="fg.muted" wrap="wrap">
            {waiting > 0 && <Button size="xs" variant="outline" colorPalette="orange" onClick={onShowDecisions}>{waiting} waiting on you</Button>}
            {working.length > 0 && <HStack gap="1.5"><Icon as={Bot} boxSize="3.5" /><Text>{working.length} with agents</Text></HStack>}
          </HStack>
        )}
        <chakra.button type="button" display="flex" alignItems="center" borderWidth="1px" rounded="l2" bg="bg" px="3" h="10" gap="2" color="fg.muted" cursor="pointer" _hover={{ borderColor: "border.emphasized" }} onClick={act.add} disabled={act.readOnly}>
          <Icon as={Plus} boxSize="4" /><Text textStyle="sm" flex="1" textAlign="left">Add task</Text>
          <Box px="1.5" rounded="sm" bg="bg.muted" textStyle="xs" fontWeight="medium" fontVariantNumeric="tabular-nums">Work: {fmt(work)}</Box>
        </chakra.button>
        {todays.length === 0 && <Text textStyle="sm" color="fg.muted" py="6" textAlign="center">Nothing planned. Top priorities, tasks due today and today&apos;s scheduled tasks appear here.</Text>}
        {todays.map((t) => <PlanCard key={t.id} task={t} />)}
        {working.map(t => <PlanCard key={t.id} task={t} />)}
      </Stack>
      <Box hideBelow="lg" position="sticky" top="4"><DayTimeline blocks={blocks} now={now} /></Box>
    </Grid>
  );
}

function PlanCard({ task: t }: { task: ViewTask }) {
  const act = useViewActions();
  const done = t.status === "done";
  return (
    <Stack gap="2" borderWidth="1px" rounded="l2" bg="bg" p="3" shadow="xs" opacity={done || t.pending ? 0.6 : 1} cursor="pointer" onClick={() => act.open(t)}
      borderLeftWidth={t.top && !done ? "3px" : "1px"} borderLeftColor={t.top && !done ? "brand.solid" : undefined}>
      <HStack justify="space-between" textStyle="xs" color="fg.muted">
        <Text fontVariantNumeric="tabular-nums" color={t.overdue ? "red.fg" : undefined}>{t.start ?? (t.overdue ? `Overdue, ${t.dueLabel}` : t.dueToday ? "Due today" : "Anytime")}</Text>
        {t.minutes ? <Box px="1.5" rounded="sm" bg="bg.muted" fontWeight="medium" fontVariantNumeric="tabular-nums">{fmt(t.minutes)}</Box> : null}
      </HStack>
      <Text textStyle="sm" fontWeight="medium" textDecoration={done ? "line-through" : undefined}>{t.title}</Text>
      <HStack justify="space-between">
        <chakra.button type="button" aria-label={done ? `Reopen ${t.title}` : `Complete ${t.title}`} boxSize="5" rounded="full" borderWidth="1.5px" borderColor={done ? "green.500" : "border.emphasized"} bg={done ? "green.500" : undefined}
          display="grid" placeItems="center" cursor="pointer" _hover={{ borderColor: "green.500" }} disabled={act.readOnly}
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); act.toggleDone(t); }}>
          {done && <Icon as={Check} boxSize="3" color="white" />}
        </chakra.button>
        <TaskDelegate task={t} />
        {t.category && <HStack gap="0.5" textStyle="xs" color="fg.muted"><Icon as={Hash} boxSize="3" /><Text>{t.category.toLowerCase()}</Text></HStack>}
      </HStack>
    </Stack>
  );
}
