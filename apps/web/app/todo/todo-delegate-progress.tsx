"use client";

import { HStack, Link, Text } from "@chakra-ui/react";
import { ArrowUpRight } from "lucide-react";
import type { LiveTodo } from "./todo-live";

const stateLabel = { working: "Working", waiting_on_owner: "Waiting on you", handed_back: "Handed back" };
const activityFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

export function TodoDelegateProgress({ todo, timestamp = 0 }: { todo: LiveTodo; timestamp?: number }) {
  const delegation = todo.delegation;
  if (!delegation?.delegate || !delegation.state) return null;
  const { activity } = delegation;
  const lastActivity = activity?.lastActivityAt;
  const stale = todo.state === "open" && delegation.state === "working" &&
    (activity?.stale || Boolean(activity?.staleAt && timestamp >= Date.parse(activity.staleAt)));
  return <HStack gap="1.5" wrap="wrap" textStyle="xs" color="fg.muted">
    <Text as="span">{stateLabel[delegation.state]}</Text>
    {lastActivity ? <Text as="span">Last active <time dateTime={lastActivity}>{activityFormat.format(new Date(lastActivity))}</time></Text> : <Text as="span">No activity yet</Text>}
    {stale && <Text as="span" color="orange.fg" fontWeight="medium">Stale</Text>}
    {activity?.botHqUrl && <Link href={activity.botHqUrl} target="_blank" rel="noopener noreferrer" variant="underline"
      data-task-link-control onClick={event => event.stopPropagation()}>
      Open in Bot HQ <ArrowUpRight size={12} aria-hidden />
    </Link>}
  </HStack>;
}
