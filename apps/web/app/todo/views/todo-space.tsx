"use client";

// The To-Do space: a focused, full-window layout (no app navigation) with its own bar and five switchable views (#171).
// The view choice is a per-browser preference. Data and writes come from the workspace (existing queue and history).
import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Box, Button, Flex, HStack, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, Check, ChevronDown, Plus, Undo2 } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";
import type { LiveTodo } from "../todo-live";
import { toViewTask, bucketOf, viewStatus, type ViewActions } from "./view-model";
import { ViewActionsProvider } from "./view-parts";
import { ListView } from "./list-view";
import { TodayView } from "./today-view";
import { PlanView } from "./plan-view";
import { BoardView } from "./board-view";
import { TriageView } from "./triage-view";

export const TODO_LAYOUTS = [
  { key: "list", label: "List", hint: "Grouped by status, like Linear" },
  { key: "today", label: "Today", hint: "Calm daily list, like Things 3" },
  { key: "plan", label: "Plan", hint: "Today's cards and schedule, like Sunsama" },
  { key: "board", label: "Board", hint: "Columns by state, like GitHub Projects" },
  { key: "triage", label: "Triage", hint: "One decision at a time, like Superhuman" },
] as const;
export type TodoLayout = (typeof TODO_LAYOUTS)[number]["key"];

const STORAGE_KEY = "quantself.todo.layout";
const listeners = new Set<() => void>();
const readLayout = (): TodoLayout => {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return TODO_LAYOUTS.some((l) => l.key === saved) ? (saved as TodoLayout) : "list";
  } catch { return "list"; }
};
export function useTodoLayout() {
  const layout = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, readLayout, () => "list" as TodoLayout);
  const set = (next: TodoLayout) => {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* preference only */ }
    listeners.forEach((fn) => fn());
  };
  return [layout, set] as const;
}

export function TodoSpaceBar({ layout, onLayout, todos, canUndo, onUndo, onAdd, readOnly }: {
  layout: TodoLayout; onLayout: (l: TodoLayout) => void; todos: LiveTodo[]; canUndo: boolean; onUndo: () => void; onAdd: () => void; readOnly: boolean;
}) {
  const current = TODO_LAYOUTS.find((l) => l.key === layout)!;
  const waiting = useMemo(() => todos.filter((t) => viewStatus(t) === "needs-you").length, [todos]);
  return (
    <Flex as="header" align="center" gap="3" px={{ base: "3", md: "5" }} h="14" borderBottomWidth="1px" bg="bg" position="sticky" top="0" zIndex="docked">
      <Tooltip content="Back to Quantself">
        <Button asChild size="sm" variant="ghost" color="fg.muted" px="2"><Link href="/" aria-label="Back to Quantself"><ArrowLeft /><Text as="span" hideBelow="sm">Quantself</Text></Link></Button>
      </Tooltip>
      <Box w="1px" h="5" bg="border" hideBelow="sm" />
      <Stack gap="0" minW="0">
        <Text as="h1" textStyle="md" fontWeight="semibold" lineHeight="short">To-Do</Text>
        {waiting > 0 && <Text textStyle="xs" color="orange.fg" lineHeight="short" whiteSpace="nowrap">{waiting} waiting on you</Text>}
      </Stack>
      <HStack ms="auto" gap="2">
        <Box hideBelow="lg">
          <HStack gap="0.5" p="0.5" rounded="l2" bg="bg.muted" role="radiogroup" aria-label="View">
            {TODO_LAYOUTS.map((l) => (
              <Tooltip key={l.key} content={l.hint}>
                <Button size="xs" variant={layout === l.key ? "surface" : "ghost"} color={layout === l.key ? "fg" : "fg.muted"} role="radio" aria-checked={layout === l.key} onClick={() => onLayout(l.key)}>{l.label}</Button>
              </Tooltip>
            ))}
          </HStack>
        </Box>
        <Box hideFrom="lg">
          <Menu.Root positioning={{ placement: "bottom-end" }}>
            <Menu.Trigger asChild><Button size="sm" variant="outline" aria-label={`View: ${current.label}`}>{current.label}<ChevronDown /></Button></Menu.Trigger>
            <Portal><Menu.Positioner><Menu.Content>
              {TODO_LAYOUTS.map((l) => (
                <Menu.Item key={l.key} value={l.key} onSelect={() => onLayout(l.key)}>
                  <Stack gap="0" flex="1"><Text>{l.label}</Text><Text textStyle="xs" color="fg.muted">{l.hint}</Text></Stack>
                  {layout === l.key && <Check size={14} />}
                </Menu.Item>
              ))}
            </Menu.Content></Menu.Positioner></Portal>
          </Menu.Root>
        </Box>
        <Tooltip content="Undo (⌘Z)"><IconButton size="sm" variant="ghost" aria-label="Undo" disabled={!canUndo || readOnly} onClick={onUndo}><Undo2 /></IconButton></Tooltip>
        <Button size="sm" aria-label="Add task" onClick={onAdd} disabled={readOnly}><Plus /><Text hideBelow="sm">New task</Text></Button>
      </HStack>
    </Flex>
  );
}

export function TodoViews({ layout, todos, today, now, actions, loading, agentInbox }: {
  layout: TodoLayout; todos: LiveTodo[]; today: string; now?: string; actions: ViewActions; loading: boolean; agentInbox?: { canWrite: boolean };
}) {
  const tasks = useMemo(() => todos.map((t) => toViewTask(t, today)).filter((t) => bucketOf(t) !== null), [todos, today]);
  const [triageFromPlan, setTriageFromPlan] = useState(false);
  if (loading && !tasks.length && !(layout === "list" && agentInbox)) return <Text textStyle="sm" color="fg.muted" role="status" textAlign="center" py="16">Loading tasks…</Text>;
  return (
    <ViewActionsProvider value={actions}>
      <Box px={{ base: "3", md: "6" }} py={{ base: "4", md: "6" }} maxW="8xl" mx="auto" w="full">
        {layout === "list" && <ListView tasks={tasks} agentInbox={agentInbox} />}
        {layout === "today" && <TodayView tasks={tasks} today={today} />}
        {layout === "plan" && (triageFromPlan
          ? <Stack gap="3"><Button size="xs" variant="ghost" alignSelf="start" onClick={() => setTriageFromPlan(false)}><ArrowLeft />Back to plan</Button><TriageView tasks={tasks} /></Stack>
          : <PlanView tasks={tasks} today={today} now={now} onShowDecisions={() => setTriageFromPlan(true)} />)}
        {layout === "board" && <BoardView tasks={tasks} />}
        {layout === "triage" && <TriageView tasks={tasks} />}
      </Box>
    </ViewActionsProvider>
  );
}
