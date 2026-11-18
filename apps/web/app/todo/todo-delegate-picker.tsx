"use client";

import { Button, Menu, Portal, Text } from "@chakra-ui/react";
import { Bot, ChevronDown } from "lucide-react";
import type { Delegate, TodoDelegateQueue } from "./todo-delegate-queue";
import type { LiveTodo } from "./todo-live";

export type DelegateControls = {
  available: boolean;
  directory: ReturnType<TodoDelegateQueue["getSnapshot"]>;
  load(): void;
  change(todo: LiveTodo, delegate: Delegate | null): void;
};

export function TodoDelegatePicker({ todo, controls }: { todo: LiveTodo; controls?: DelegateControls }) {
  const delegate = todo.delegation?.delegate;
  if (!controls?.available) {
    return delegate ? <Text as="span" textStyle="xs" color="fg.muted">{delegate.name}</Text> : null;
  }
  const { agents, loadingAgents, directoryError } = controls.directory;
  return <Menu.Root lazyMount unmountOnExit positioning={{ placement: "bottom-end" }} onOpenChange={({ open }) => { if (open) controls.load(); }}>
    <Menu.Trigger asChild>
      <Button type="button" size="xs" variant="ghost" aria-label={`Delegate to… ${todo.title}`} data-task-link-control onClick={event => event.stopPropagation()}>
        <Bot aria-hidden />{delegate?.name ?? "Delegate to…"}<ChevronDown aria-hidden />
      </Button>
    </Menu.Trigger>
    <Portal><Menu.Positioner><Menu.Content data-task-link-control onClick={event => event.stopPropagation()}>
      <Menu.RadioItemGroup value={delegate?.id ?? "none"} onValueChange={({ value }) => {
        const chosen = agents?.find(agent => agent.id === value);
        if (value === "none" || chosen) controls.change(todo, chosen ?? null);
      }}>
        <Menu.RadioItem value="none"><Menu.ItemIndicator />No one</Menu.RadioItem>
        {agents?.map(agent => <Menu.RadioItem key={agent.id} value={agent.id}><Menu.ItemIndicator />{agent.name}</Menu.RadioItem>)}
      </Menu.RadioItemGroup>
      {loadingAgents && <Text px="2" py="1" textStyle="xs" role="status">Loading Agents…</Text>}
      {directoryError && <Menu.Item value="retry" closeOnSelect={false} onSelect={() => controls.load()}>Retry loading Agents</Menu.Item>}
      {agents?.length === 0 && <Text px="2" py="1" textStyle="xs">No eligible Agents</Text>}
    </Menu.Content></Menu.Positioner></Portal>
  </Menu.Root>;
}
