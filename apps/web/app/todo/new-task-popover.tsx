"use client";
import { useRef, useState, type ComponentProps } from "react";
import { TodoDetail } from "./todo-detail";
import { saveTodoFacts, TodoFactsEditor } from "./todo-facts-editor";
import { previewTodoEdit, TodoBrowserError, type LiveTodo } from "./todo-live";
import { timingRange } from "./todo-timing";
import { Alert, Box, Button } from "@chakra-ui/react";
import type { components } from "@/lib/generated/quantself-api-schema";

type Create = components["schemas"]["TodoCreate"];
type Edit = components["schemas"]["TodoEdit"];
function rebase(command: Edit, before: LiveTodo): Edit {
  return { ...command,
    ...(command.title ? { title: { before: before.title, after: command.title.after } } : {}),
    ...(command.description ? { description: { before: before.description ?? "", after: command.description.after } } : {}),
    ...(command.fields ? { fields: Object.fromEntries(Object.entries(command.fields).map(([name, value]) => [name, { before: before.fields[name] ?? null, after: value!.after }])) } : {}),
    ...(command.deadlineAt ? { deadlineAt: { before: before.deadlineAt ?? null, after: command.deadlineAt.after } } : {}),
    ...(command.start !== undefined || command.deadlineAt ? { revision: before.updatedAt } : {}),
  };
}
export function NewTaskPopover({ onClose, initialTiming, creation, disabled, onSaved, onQueue, onCreated }: ComponentProps<typeof TodoFactsEditor> & { onClose(): void; onCreated?(todo: LiveTodo): void }) {
  const [todo, setTodo] = useState<LiveTodo>(() => ({
    id: "new-task", databaseId: 0, number: 0, repository: "", url: "", title: "New task", body: "", description: "",
    state: "open", closureReason: null, updatedAt: new Date().toISOString(), labels: [], fields: {}, fieldValues: [],
    ...timingRange(initialTiming?.start ?? "", initialTiming?.end ?? ""), allDay: initialTiming?.allDay ?? false, fixed: false, scheduleError: null,
  }));
  const current = useRef(todo);
  const queuedBase = useRef(todo);
  const pending = useRef<Create | null>(null);
  const later = useRef<Edit[]>([]);
  const saving = useRef(false);
  const created = useRef(false);
  const closeAfterSave = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function publish(value: LiveTodo) { current.current = value; setTodo(value); }
  function flushLater(base: LiveTodo) {
    let next = base; queuedBase.current = base;
    while (later.current.length) {
      const command = rebase(later.current[0], next);
      try { onQueue?.(command, next); } catch (error) {
        publish(later.current.reduce((value, change) => previewTodoEdit(value, rebase(change, value)), next));
        throw error;
      }
      later.current.shift(); next = previewTodoEdit(next, command); queuedBase.current = next;
    }
    publish(next);
  }
  async function submit(close?: () => void) {
    if (disabled) return;
    if (close) closeAfterSave.current = close;
    if (created.current) { if (close) close(); return; }
    if (saving.current) return;
    const value = current.current;
    if (!value.title.trim()) { setError("A title is required."); return; }
    pending.current ??= { commandId: crypto.randomUUID(), title: value.title, description: value.description,
      start: value.start, end: value.end, allDay: value.allDay, fixed: value.fixed,
      beforeMinutes: value.beforeMinutes, afterMinutes: value.afterMinutes, fields: value.fields, deadlineAt: value.deadlineAt };
    saving.current = true; setBusy(true); setError("");
    creation?.start(pending.current);
    try {
      const result = await saveTodoFacts(undefined, pending.current);
      creation?.finish(pending.current.commandId, result);
      if (!result.todo) throw Error(result.message || "Creation uncertain. Retry the same command.");
      created.current = true;
      onCreated?.(result.todo);
      publish(result.todo);
      flushLater(result.todo);
      onSaved();
      if (Object.values(result.outcomes).some(value => value !== "saved")) { setError(result.message); return; }
      closeAfterSave.current?.(); closeAfterSave.current = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task creation failed. Retry the same command.";
      if (!created.current) creation?.fail(pending.current.commandId, message);
      setError(message);
      if (error instanceof TodoBrowserError && error.status === 400) { pending.current = null; later.current = []; }
    } finally { saving.current = false; setBusy(false); }
  }
  return <TodoDetail number={todo.number} preview={todo} stale={false} revision={null} canWrite={!disabled} onClose={onClose}
    onQueue={(command, baseline) => {
      if (disabled) throw Error("Task editing unavailable. Your draft has been kept.");
      if (created.current) {
        if (later.current.length) {
          later.current.push(command);
          try { flushLater(queuedBase.current); setError(""); } catch (error) { setError(String(error)); }
        } else {
          onQueue?.(command, baseline);
          publish(previewTodoEdit(baseline, command));
        }
      } else {
        const next = previewTodoEdit(current.current, command);
        if (JSON.stringify(next) === JSON.stringify(current.current)) return;
        publish(next);
        if (pending.current) later.current.push(command);
        else void submit();
      }
    }}
    draft={{
      created: created.current,
      pending: later.current.length > 0,
      submit: close => { void submit(close); },
      footer: () => error ? (
        <Box px="4" pb="4">
          <Alert.Root status="error" role="alert" bg="bg.panel" color="fg.error" borderWidth="1px" borderColor="border" px="2.5" py="2">
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
          {(!created.current || later.current.length > 0) && (
            <Button
              type="button"
              size="xs"
              fontSize="sm"
              disabled={disabled || busy}
              onClick={() => {
                if (created.current) {
                  try { flushLater(queuedBase.current); setError(""); }
                  catch (error) { setError(String(error)); }
                } else void submit();
              }}
            >
              Retry save
            </Button>
          )}
        </Box>
      ) : null,
    }}
  />;
}
