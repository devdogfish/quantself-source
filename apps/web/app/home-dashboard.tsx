"use client";

// Home: today across areas. Five independent reads; each tile and section loads and fails on its own.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Button, Flex, HStack, SimpleGrid, Skeleton, Stack, Text } from "@chakra-ui/react";
import { MoreLink, Panel, ProgressDial, Stat } from "@/components/shared/dashboard";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { asRoute } from "@/components/shared/dashboard-types";
import {
  loadBudget, loadHabits, loadInbox, loadJobs, loadTasks, localToday,
  type BudgetWeek, type HabitsToday, type InboxCounts, type JobCounts, type TasksToday,
} from "./home-data";

type Area<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

function useArea<T>(load: () => Promise<T>) {
  const [area, setArea] = useState<Area<T>>({ status: "loading" });
  const generation = useRef(0);
  const run = useCallback(() => {
    const mine = ++generation.current;
    setArea({ status: "loading" });
    load().then(
      (data) => { if (mine === generation.current) setArea({ status: "ready", data }); },
      (cause) => { if (mine === generation.current) setArea({ status: "error", message: cause instanceof Error ? cause.message : "Unavailable." }); },
    );
  }, [load]);
  useEffect(() => { run(); return () => { generation.current++; }; }, [run]);
  return [area, run] as const;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dateLabel = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

function AreaError({ message, onRetry, area }: { message: string; onRetry: () => void; area: string }) {
  return (
    <Stack gap="1.5" role="alert" align="start">
      <Text textStyle="xs" color="red.fg">{area}: {message}</Text>
      <Button size="xs" variant="outline" onClick={onRetry}>Retry {area.toLowerCase()}</Button>
    </Stack>
  );
}

function Tile<T>({ label, href, area, retry, value, note }: {
  label: string; href: string; area: Area<T>; retry: () => void; value: (data: T) => string; note: (data: T) => string;
}) {
  return (
    <Panel minH="28" aria-busy={area.status === "loading"}>
      {area.status === "loading" && <Stack gap="1.5"><Text textStyle="xs" color="fg.muted">{label}</Text><Skeleton h="6" w="20" /><Skeleton h="3.5" w="32" /></Stack>}
      {area.status === "error" && <Stack gap="1.5"><Text textStyle="xs" color="fg.muted">{label}</Text><AreaError area={label} message={area.message} onRetry={retry} /></Stack>}
      {area.status === "ready" && <Stat label={label} value={value(area.data)} href={href}><Text textStyle="xs" color="fg.muted">{note(area.data)}</Text></Stat>}
    </Panel>
  );
}

function Headline({ tasks, habits }: { tasks: Area<TasksToday>; habits: Area<HabitsToday> }) {
  if (tasks.status === "loading" || habits.status === "loading") {
    return <Panel aria-busy="true"><Flex gap="6" align="center"><Skeleton boxSize="120px" rounded="full" /><Stack gap="2" flex="1"><Skeleton h="7" w="64" maxW="full" /><Skeleton h="4" w="48" maxW="full" /></Stack></Flex></Panel>;
  }
  const t = tasks.status === "ready" ? tasks.data : null;
  const h = habits.status === "ready" ? habits.data : null;
  const done = (t?.done ?? 0) + (h?.done ?? 0);
  const total = (t?.total ?? 0) + (h?.total ?? 0);
  const answer = !t && !h ? "Today's progress is unavailable" : total === 0 ? "Nothing scheduled today" : done === total ? `All ${plural(total, "thing")} done today` : `${done} of ${plural(total, "thing")} done today`;
  const left = [
    t && t.open.length ? plural(t.open.length, "task") + " due" : null,
    h && h.left.length ? plural(h.left.reduce((n, g) => n + g.habits.length, 0), "habit") + " left" : null,
    h && h.atRisk ? `${plural(h.atRisk, "habit")} at risk of a second miss` : null,
  ].filter(Boolean);
  const missing = [!t && "tasks", !h && "habits"].filter(Boolean);
  return (
    <Panel>
      <Flex gap="6" align="center" wrap="wrap">
        <ProgressDial value={done} max={Math.max(total, 1)} size={120} label="Today's progress" caption={`of ${total}`} />
        <Stack gap="1.5" minW="0" flex="1">
          <Text as="h2" textStyle="2xl" fontWeight="semibold">{answer}</Text>
          <Text textStyle="sm" color="fg.muted">{left.length ? left.join(" · ") : total > 0 ? "Nothing left to do." : "Enjoy the open day."}</Text>
          {missing.length > 0 && <Text textStyle="xs" color="fg.muted">Not counting {missing.join(" or ")}: unavailable.</Text>}
        </Stack>
      </Flex>
    </Panel>
  );
}

function ListSkeleton() {
  return <Stack gap="2" aria-busy="true"><Skeleton h="4" w="40" /><Skeleton h="4" w="56" /><Skeleton h="4" w="32" /></Stack>;
}

function Group({ title, href, more, children }: { title: string; href: string; more: string; children: React.ReactNode }) {
  return (
    <Stack gap="2" as="section" aria-label={title}>
      <Flex justify="space-between" align="center" gap="3"><Text textStyle="sm" fontWeight="medium">{title}</Text><MoreLink href={href}>{more}</MoreLink></Flex>
      {children}
    </Stack>
  );
}

const shown = 5;

function ActSections({ today, tasks, habits, inbox, jobs, retry }: {
  today: string; tasks: Area<TasksToday>; habits: Area<HabitsToday>; inbox: Area<InboxCounts>; jobs: Area<JobCounts>;
  retry: { tasks: () => void; habits: () => void; inbox: () => void; jobs: () => void };
}) {
  const sections: React.ReactNode[] = [];
  if (tasks.status === "loading") sections.push(<ListSkeleton key="tasks" />);
  else if (tasks.status === "error") sections.push(<AreaError key="tasks" area="Tasks" message={tasks.message} onRetry={retry.tasks} />);
  else if (tasks.data.open.length) {
    const rows = tasks.data.open.slice(0, shown);
    sections.push(
      <Group key="tasks" title="Tasks due today" href="/todo" more={tasks.data.open.length > shown ? `${tasks.data.open.length - shown} more` : "All tasks"}>
        <Stack gap="1" as="ul" listStyleType="none">
          {rows.map((task) => (
            <HStack as="li" key={task.number} gap="3" textStyle="sm" justify="space-between">
              <Box asChild minW="0" _hover={{ textDecoration: "underline" }}><Link href={asRoute(`/todo?task=${task.number}&date=${today}`)}><Text truncate>{task.title}</Text></Link></Box>
              <Text color="fg.muted" textStyle="xs" fontVariantNumeric="tabular-nums" flexShrink={0}>{task.time ?? (task.allDay ? "All day" : "Anytime")}</Text>
            </HStack>
          ))}
        </Stack>
      </Group>,
    );
  }
  if (habits.status === "loading") sections.push(<ListSkeleton key="habits" />);
  else if (habits.status === "error") sections.push(<AreaError key="habits" area="Habits" message={habits.message} onRetry={retry.habits} />);
  else if (habits.data.left.length) {
    sections.push(
      <Group key="habits" title="Habits left today" href="/habits" more="Log habits">
        <Stack gap="2">
          {habits.data.left.map((group) => (
            <Stack key={group.stack} gap="0.5">
              <Text textStyle="xs" color="fg.muted">{group.stack}</Text>
              <Text textStyle="sm">{group.habits.join(" · ")}</Text>
            </Stack>
          ))}
        </Stack>
      </Group>,
    );
  }
  const waiting: { key: string; text: string; href: string }[] = [];
  let inboxLoading = false;
  if (inbox.status === "loading" || jobs.status === "loading") inboxLoading = true;
  if (inbox.status === "ready" && inbox.data.proposals) waiting.push({ key: "proposals", href: "/inventory/processing", text: `${inbox.data.proposals}${inbox.data.proposalsCapped ? "+" : ""} inventory ${inbox.data.proposals === 1 ? "proposal" : "proposals"} to review` });
  if (jobs.status === "ready" && jobs.data.review) waiting.push({ key: "review", href: "/jobs", text: `${plural(jobs.data.review, "job application")} awaiting decision` });
  if (jobs.status === "ready" && jobs.data.needsAttention) waiting.push({ key: "attention", href: "/jobs", text: `${plural(jobs.data.needsAttention, "job application")} needing attention` });
  if (inboxLoading) sections.push(<ListSkeleton key="inbox" />);
  const failures = [
    inbox.status === "error" && <AreaError key="inbox-error" area="Inventory" message={inbox.message} onRetry={retry.inbox} />,
    jobs.status === "error" && <AreaError key="jobs-error" area="Jobs" message={jobs.message} onRetry={retry.jobs} />,
  ].filter(Boolean);
  if (waiting.length) {
    sections.push(
      <Group key="inbox" title="Waiting on you" href="/inventory/processing" more="Inventory">
        <Stack gap="1" as="ul" listStyleType="none">
          {waiting.map((row) => <Box as="li" key={row.key} textStyle="sm"><Box asChild _hover={{ textDecoration: "underline" }}><Link href={asRoute(row.href)}>{row.text}</Link></Box></Box>)}
        </Stack>
      </Group>,
    );
  }
  sections.push(...failures);
  const settled = [tasks, habits, inbox, jobs].every((area) => area.status !== "loading");
  if (!sections.length && settled) return <Text textStyle="sm" color="fg.muted">Nothing to act on. Enjoy the open day.</Text>;
  return <Stack gap="5">{sections}</Stack>;
}

export function HomeDashboard() {
  const today = localToday();
  const [tasks, retryTasks] = useArea(loadTasks);
  const [habits, retryHabits] = useArea(loadHabits);
  const [budget, retryBudget] = useArea(loadBudget);
  const [inbox, retryInbox] = useArea(loadInbox);
  const [jobs, retryJobs] = useArea(loadJobs);
  return (
    <>
      <PageHeader title="Today" description={dateLabel.format(new Date(`${today}T00:00:00Z`))} actions={<Button asChild size="sm" colorPalette="brand"><Link href="/habits">Log habits</Link></Button>} />
      <PageBody>
        <Stack gap="4">
          <Headline tasks={tasks} habits={habits} />
          <SimpleGrid columns={{ base: 2, md: 4 }} gap="4">
            <Tile<TasksToday> label="To-Do" href="/todo" area={tasks} retry={retryTasks} value={(d) => String(d.open.length)} note={(d) => d.open.length ? "open today" : d.total ? "all done today" : "nothing scheduled"} />
            <Tile<HabitsToday> label="Habits" href="/habits" area={habits} retry={retryHabits} value={(d) => `${d.done}/${d.total}`} note={(d) => d.atRisk ? `${d.atRisk} at risk of a second miss` : "done today"} />
            <Tile<TasksToday> label="Next event" href="/calendar" area={tasks} retry={retryTasks} value={(d) => d.next?.time ?? "—"} note={(d) => d.next?.title ?? "No more timed tasks today"} />
            <Tile<BudgetWeek> label="Budget" href="/budgeting" area={budget} retry={retryBudget} value={(d) => d.value} note={(d) => d.note} />
          </SimpleGrid>
          <Panel title="To act on">
            <ActSections today={today} tasks={tasks} habits={habits} inbox={inbox} jobs={jobs} retry={{ tasks: retryTasks, habits: retryHabits, inbox: retryInbox, jobs: retryJobs }} />
          </Panel>
        </Stack>
      </PageBody>
    </>
  );
}
