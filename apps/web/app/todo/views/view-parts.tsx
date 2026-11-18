"use client";

// Small pieces shared by the To-Do views. Layouts are not shared: each view follows its reference product.
import { createContext, useContext } from "react";
import { Box, Button, HStack, Icon, Link, Text, chakra } from "@chakra-ui/react";
import { ArrowUpRight, User } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";
import { statusLabel, type ViewActions, type ViewStatus, type ViewTask } from "./view-model";
import { TodoDelegatePicker } from "../todo-delegate-picker";
import { HandBackButtons, HandBackSummary } from "../todo-handback";
import { TodoDelegateProgress } from "../todo-delegate-progress";

export const ref = (t: ViewTask) => `#${t.number}`;

const ActionsContext = createContext<ViewActions | null>(null);
export const ViewActionsProvider = ActionsContext.Provider;
export function useViewActions() {
  const actions = useContext(ActionsContext);
  if (!actions) throw Error("ViewActionsProvider missing");
  return actions;
}

// Linear-style status icon. Shape carries state; colour only reinforces it.
export function StatusIcon({ status, size = 14 }: { status: ViewStatus; size?: number }) {
  const c = 7, r = 5.5;
  const v = (n: string) => `var(--chakra-colors-${n})`;
  const ring = (color: string, dash?: string) => <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray={dash} />;
  const pie = (color: string, frac: number) => {
    const a = frac * Math.PI * 2, R = 3;
    return <path d={`M${c} ${c} L${c} ${c - R} A${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${c + R * Math.sin(a)} ${c - R * Math.cos(a)} Z`} fill={color} />;
  };
  let body: React.ReactNode;
  switch (status) {
    case "inbox": case "someday": body = ring(v("fg-subtle"), "1.6 1.8"); break;
    case "todo": body = ring(v("fg-muted")); break;
    case "approve": body = <>{ring(v("orange-500"), "1.6 1.8")}<circle cx={c} cy={c} r="2" fill={v("orange-500")} /></>; break;
    case "queued": body = ring(v("yellow-500"), "1.6 1.8"); break;
    case "running": body = <>{ring(v("yellow-500"))}{pie(v("yellow-500"), 0.5)}</>; break;
    case "needs-you": body = <>{ring(v("orange-500"))}<circle cx={c} cy={c} r="2.4" fill={v("orange-500")} /></>; break;
    case "done": body = <><circle cx={c} cy={c} r="6.5" fill={v("brand-solid")} /><path d="M4.4 7.2 6.2 9 9.7 5.4" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>; break;
    case "closed": body = <><circle cx={c} cy={c} r="6.5" fill={v("fg-subtle")} /><path d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></>; break;
  }
  return (
    <Tooltip content={statusLabel[status]}>
      <chakra.svg viewBox="0 0 14 14" w={`${size}px`} h={`${size}px`} flexShrink={0} role="img" aria-label={statusLabel[status]}>{body}</chakra.svg>
    </Tooltip>
  );
}

// Linear-style priority. Quantself has one priority flag (Top priority), shown as "High".
export function PriorityButton({ task: t }: { task: ViewTask }) {
  const act = useViewActions();
  const v = (n: string) => `var(--chakra-colors-${n})`;
  return (
    <Tooltip content={t.top ? "Top priority. Click to remove" : "Mark as top priority"}>
      <chakra.button type="button" aria-pressed={t.top} aria-label={t.top ? `Remove top priority from ${t.title}` : `Mark ${t.title} as top priority`} disabled={act.readOnly}
        onClick={(e) => { e.stopPropagation(); act.togglePriority(t); }} display="grid" placeItems="center" boxSize="5" rounded="sm" cursor="pointer" _hover={{ bg: "bg.emphasized" }} _disabled={{ cursor: "default" }} flexShrink={0}>
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          {[0, 1, 2].map((i) => <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.6" fill={t.top ? v("orange-500") : i === 0 ? v("fg-subtle") : v("border-emphasized")} />)}
        </svg>
      </chakra.button>
    </Tooltip>
  );
}

export function OwnerIcon({ task: t, size = 14 }: { task: ViewTask; size?: number }) {
  const act = useViewActions();
  if (act.delegates?.available || t.source.delegation?.delegate) return <TaskDelegate task={t} />;
  const owner = t.status !== "inbox";
  return (
    <Tooltip content={owner ? "You" : "Not triaged"}>
      <Box as="span" display="inline-grid" placeItems="center" boxSize={`${size + 4}px`} rounded="full" flexShrink={0}
        bg={owner ? "bg.emphasized" : undefined} borderWidth={owner ? 0 : "1px"} borderStyle="dashed" borderColor="border.emphasized">
        {owner && <Icon as={User} boxSize={`${size - 3}px`} color="fg.muted" />}
      </Box>
    </Tooltip>
  );
}

export function TaskDelegate({ task }: { task: ViewTask }) {
  const { delegates, decisions } = useViewActions();
  return <TodoDelegatePicker todo={task.source} controls={decisions?.busy(task.source) ? undefined : delegates} />;
}

export function TaskDelegateProgress({ task }: { task: ViewTask }) {
  return <TodoDelegateProgress todo={task.source} timestamp={useViewActions().activityTimestamp} />;
}

export function DueText({ task: t }: { task: ViewTask }) {
  if (!t.dueLabel) return null;
  return <Text as="span" textStyle="xs" color={t.overdue ? "red.fg" : t.dueToday ? "orange.fg" : "fg.muted"} whiteSpace="nowrap">{t.dueLabel}</Text>;
}

export function CategoryChip({ task: t }: { task: ViewTask }) {
  if (!t.category) return null;
  return <HStack gap="1.5" px="2" h="5" rounded="full" borderWidth="1px" flexShrink={0}><Box boxSize="1.5" rounded="full" bg="fg.subtle" /><Text textStyle="xs" color="fg.muted">{t.category}</Text></HStack>;
}

export function GitHubLink({ task: t, label = "Open on GitHub" }: { task: ViewTask; label?: string }) {
  return (
    <Link href={t.url} target="_blank" rel="noreferrer" textStyle="sm" color="fg.muted" display="inline-flex" alignItems="center" gap="1" _hover={{ color: "fg" }} onClick={(e) => e.stopPropagation()}>
      {label}<Icon as={ArrowUpRight} boxSize="3.5" />
    </Link>
  );
}

export function DecisionText({ task: t }: { task: ViewTask }) {
  return <HandBackSummary todo={t.source} />;
}

export function DecisionButtons({ task: t, size = "xs" }: { task: ViewTask; size?: "xs" | "sm" }) {
  return <HandBackButtons todo={t.source} controls={useViewActions().decisions} size={size} />;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <Text px="6" py="10" textStyle="sm" color="fg.muted" textAlign="center">{children}</Text>;
}
