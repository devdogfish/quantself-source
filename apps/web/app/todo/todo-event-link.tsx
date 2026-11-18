"use client";

import { Link2Icon, MapPinIcon } from "lucide-react";
import { Menu, Portal } from "@chakra-ui/react";
import type { Task } from "./todo-projection";
import s from "./todo-workspace.module.css";

export function EventLink({ task, compact = false }: { task: Task; compact?: boolean }) {
  const urls = task.eventUrls ?? [];
  const location = task.eventLocation?.trim();
  if (!urls.length && !location) return null;
  const label = `Open ${urls.length > 1 ? "links" : "link"} for ${task.title}`;
  const mapLabel = `Open map for ${task.title}`;
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const events = { onPointerDown: stop, onClick: stop, onDoubleClick: stop, onKeyDown: stop, onKeyUp: stop };
  return <span data-task-link-control className={compact ? s.compactEventActions : s.eventActions} {...events}>
    {urls.length === 1 ? <a data-task-link-control className={s.eventAction} href={urls[0]} target="_blank" rel="noreferrer" aria-label={label} title={label}><Link2Icon aria-hidden="true" /></a> : urls.length > 1 ? <Menu.Root lazyMount unmountOnExit positioning={{ placement: "bottom-start", gutter: 4 }}>
      <Menu.Trigger asChild><button data-task-link-control type="button" className={s.eventAction} aria-label={label} title={label}><Link2Icon aria-hidden="true" /></button></Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content data-task-link-control width="auto" maxW="min(28rem, 90vw)" {...events}>
            {urls.map((href, index) => <Menu.Item key={`${index}:${href}`} value={`${index}:${href}`} asChild>
              <a style={{ overflowWrap: "anywhere" }} href={href} target="_blank" rel="noreferrer">{href}</a>
            </Menu.Item>)}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root> : null}
    {location && <a data-task-link-control className={s.eventAction} href={`https://maps.apple.com/search?query=${encodeURIComponent(location)}`} target="_blank" rel="noreferrer" aria-label={mapLabel} title={`${mapLabel}: ${location}`}><MapPinIcon aria-hidden="true" /></a>}
  </span>;
}
