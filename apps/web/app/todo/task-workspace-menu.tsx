"use client";

import { useRef, useState, type ComponentProps, type ReactElement, type MouseEvent as ReactMouseEvent } from "react";
import { Badge, Box, Menu, Portal, Text, useMenu } from "@chakra-ui/react";
import { CheckIcon, CopyIcon, ScissorsIcon, ClipboardPasteIcon, Trash2Icon, PencilIcon, PlusIcon, FlagIcon } from "lucide-react";
import s from "./todo-workspace.module.css";
import { useCategories, categoryStyle } from "./todo-categories";
import { localDateTime } from "./todo-timing";
import type { Task } from "./todo-projection";
import { dateLabel, isTaskLinkControl, type Actions } from "./task-workspace-context";

type ContextTriggerProps = Omit<ComponentProps<typeof Box>, "children"> & {
  children: ReactElement;
  menu: ReturnType<typeof useMenu>;
  ignoreTarget(target: EventTarget | null): boolean;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
};

function ContextTrigger({ children, menu, ignoreTarget, onContextMenu, ...props }: ContextTriggerProps) {
  // A separate provider for the menu content keeps unrelated menus inside the
  // trigger (event links and task menus) from registering as submenus.
  const trigger = menu.api.getContextTriggerProps();
  return <Box asChild {...trigger} {...props} style={{ ...trigger.style, ...props.style }}
    onContextMenu={event => {
      if (!event.currentTarget.contains(event.target as Node) || ignoreTarget(event.target) || event.defaultPrevented) return;
      onContextMenu?.(event);
      trigger.onContextMenu?.(event);
    }}
    onPointerDown={event => {
      if (!event.currentTarget.contains(event.target as Node) || ignoreTarget(event.target) || event.defaultPrevented) return;
      props.onPointerDown?.(event);
      trigger.onPointerDown?.(event);
    }}
    onKeyDown={event => {
      if (event.defaultPrevented || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
        || !(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target) || ignoreTarget(event.target)) return;
      event.preventDefault();
      const { left, bottom } = event.target.getBoundingClientRect();
      event.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
    }}
  >{children}</Box>;
}

function useContextMenuFocus() {
  const previous = useRef<HTMLElement | null>(null);
  const handOff = useRef(false);
  return {
    onOpenChange({ open }: { open: boolean }) {
      if (open) {
        handOff.current = false;
        previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      } else {
        const before = previous.current;
        previous.current = null;
        if (!handOff.current && before) queueMicrotask(() => {
          const active = before.ownerDocument.activeElement;
          if (before.isConnected && (active === before.ownerDocument.body || active?.closest('[role="menu"]'))) before.focus({ preventScroll: true });
        });
      }
    },
    onInteractOutside() { handOff.current = true; },
    openNext(action: () => void) { handOff.current = true; action(); },
  };
}

function ContextMenuContent({ children, minW }: { children: React.ReactNode; minW: string }) {
  return <Portal><Menu.Positioner><Menu.Content minW={minW} p="1" rounded="lg" bg="bg.panel" color="fg" shadow="md" borderWidth="1px"
    css={{ "& [role^=menuitem] svg": { boxSize: "4", flexShrink: 0 } }}>
    {children}
  </Menu.Content></Menu.Positioner></Portal>;
}

const contextPositioning = { placement: "right-start", strategy: "fixed", gutter: 2 } as const;

type CalendarMenuTarget = { a: Actions; start?: string; allDay?: boolean };
export function CalendarContextMenu({ children, target, resolve }: { children: ReactElement; target: CalendarMenuTarget; resolve?: (event: ReactMouseEvent<HTMLElement>) => CalendarMenuTarget }) {
  const [clicked, setClicked] = useState<CalendarMenuTarget | null>(null);
  const focus = useContextMenuFocus();
  const current = clicked ?? target;
  const menu = useMenu({ "aria-label": "Calendar actions", positioning: contextPositioning, onOpenChange: focus.onOpenChange, onInteractOutside: focus.onInteractOutside });
  return <>
    <ContextTrigger menu={menu} ignoreTarget={node => node instanceof Element && !!node.closest("[data-calendar-event]")} onContextMenu={event => setClicked(resolve?.(event) ?? target)}>
      {children}
    </ContextTrigger>
    <Menu.RootProvider value={menu} size="md" lazyMount unmountOnExit immediate>
    <ContextMenuContent minW="36">
      <Menu.ItemGroup>
        <Menu.ItemGroupLabel fontSize="xs" fontWeight="normal" color="fg.muted">{dateLabel(current.a.date)}{current.start ? ` · ${current.start}` : ""}</Menu.ItemGroupLabel>
        <Menu.Item value="add" disabled={!current.a.canAdd} onSelect={() => focus.openNext(() => current.a.openAdd(current.start, current.allDay))}><PlusIcon />Add task</Menu.Item>
        <Menu.Item value="paste" disabled={!current.a.canPaste} onSelect={() => current.a.pasteEvent()}><ClipboardPasteIcon />Paste task</Menu.Item>
      </Menu.ItemGroup>
    </ContextMenuContent>
    </Menu.RootProvider>
  </>;
}

export function unfinishedTask(task: Task, timestamp: number) {
  return !["completed", "closed"].includes(task.state) && !!task.endsAt && Date.parse(task.endsAt) < timestamp;
}

export function DeadlineChip({ task, a }: { task: Task; a: Actions }) {
  const { categories } = useCategories();
  const category = categories.find(item => item.name === task.kind);
  const label = `Due: ${task.title}${task.deadlineAt ? ` · ${localDateTime(task.deadlineAt).slice(11)}` : ""}`;
  return <button className={s.deadlineFlag} style={categoryStyle(category?.color)} data-deadline={task.number} data-calendar-event data-task-number={task.number} data-selected={a.isEventSelected(task.id)} aria-pressed={a.isEventSelected(task.id)} draggable={false} aria-label={label} title={label}
    onFocus={() => a.selectEvent(task.id)} onPointerDown={() => a.selectEvent(task.id)} onClick={() => a.selectEvent(task.id)}
    onDoubleClick={(event) => { event.stopPropagation(); a.edit(task); }}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); a.edit(task); } }}>
    <span className={s.compactEventIcon} aria-hidden="true"><FlagIcon /></span>
    <span className={s.compactEventTitle}>{label}</span>
  </button>;
}
export function EventContextMenu({ task, a, children }: { task: Task; a: Actions; children: ReactElement }) {
  const focus = useContextMenuFocus();
  const categories = useCategories();
  const category = categories.categories.find(c => c.name === task.kind);
  const highPriority = a.priorities.includes(task.id);
  const atLimit = !highPriority && a.priorities.length >= 3;
  const menu = useMenu({ "aria-label": `Actions for ${task.title}`, positioning: contextPositioning, onInteractOutside: focus.onInteractOutside,
    onOpenChange: event => { focus.onOpenChange(event); if (event.open) a.selectEvent(task.id); } });
  return <>
    <ContextTrigger menu={menu} style={categoryStyle(category?.color)} data-task-number={task.number} data-calendar-event data-selected={a.isEventSelected(task.id)}
      ignoreTarget={isTaskLinkControl}
      onFocusCapture={event => { if (!isTaskLinkControl(event.target)) a.selectEvent(task.id); }}
      onPointerDown={event => { if (event.button === 0 || event.button === 2) a.selectEvent(task.id); }}
      onClickCapture={event => { if (!isTaskLinkControl(event.target)) a.selectEvent(task.id); }}
    >{children}</ContextTrigger>
    <Menu.RootProvider value={menu} size="md" lazyMount unmountOnExit immediate>
    <ContextMenuContent minW="48">
      <Menu.ItemGroup>
        <Menu.Item value="edit" onSelect={() => focus.openNext(() => a.edit(task))}><PencilIcon />{a.readOnly ? "Task details" : "Edit event"}<Menu.ItemCommand>⌘E</Menu.ItemCommand></Menu.Item>
        <Menu.CheckboxItem value="priority" css={{ "&[data-type]": { ps: "2", pe: "8" } }} checked={highPriority} disabled={task.pending || a.priorityReadOnly || atLimit} onCheckedChange={() => a.togglePriority(task.id)}>
          <span className={s.menuPriorityMark} aria-hidden="true">!!</span>Top priority
          <Menu.ItemIndicator insetStart="auto" insetEnd="2"><CheckIcon /></Menu.ItemIndicator>
        </Menu.CheckboxItem>
        {!a.readOnly && atLimit && <Text px="2" py="1" fontSize="xs" color="fg.muted">3 current priorities already chosen</Text>}
      </Menu.ItemGroup>
      <Menu.Separator bg="border" />
      <Menu.ItemGroup>
        <Menu.Item value="copy" disabled={a.readOnly} onSelect={() => a.copyEvent(task, false)}><CopyIcon />Copy task (creates new task)<Menu.ItemCommand>⌘C</Menu.ItemCommand></Menu.Item>
        <Menu.Item value="move" disabled={a.readOnly} onSelect={() => a.copyEvent(task, true)}><ScissorsIcon />Move task<Menu.ItemCommand>⌘X</Menu.ItemCommand></Menu.Item>
        <Menu.Item value="paste" disabled={!a.canPaste} onSelect={a.pasteEvent}><ClipboardPasteIcon />Paste task<Menu.ItemCommand>⌘V</Menu.ItemCommand></Menu.Item>
        <Menu.Item value="unschedule" disabled={task.pending || a.readOnly || !task.start} onSelect={() => a.removeEvent(task)}><Trash2Icon />Unschedule task<Menu.ItemCommand>⌫</Menu.ItemCommand></Menu.Item>
        {a.trash && <Menu.Item value="trash" disabled={task.pending || a.readOnly} onSelect={() => a.trash?.(task)}><Trash2Icon />Move to Trash</Menu.Item>}
      </Menu.ItemGroup>
    </ContextMenuContent>
    </Menu.RootProvider>
  </>;
}

export function PriorityReaction({ task, a }: { task: Task; a: Actions }) {
  return a.priorities.includes(task.id) ? <Badge data-slot="badge" className={s.priorityReaction} justifyContent="center" aria-label={`Top priority: ${task.title}`} title="Top priority"><span className={s.priorityGlyph}>!!</span></Badge> : null;
}
