"use client";

import { CategoryPicker, useCategories } from "./todo-categories";
import { Alert, Button, Grid, Link, Separator, Skeleton, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { TodoDelegation } from "./todo-delegation";
import { TodoDelegatePicker, type DelegateControls } from "./todo-delegate-picker";
import { projectTodoDelegate } from "./todo-delegate-queue";
import { projectTodoDecision } from "./todo-decision-queue";
import { HandBackButtons, HandBackSummary, type DecisionControls } from "./todo-handback";
import { TodoRelationships } from "./todo-relationships";
import { TodoCaptureReview } from "./todo-capture-review";
import { TodoFactsEditor, editableTodoDescription } from "./todo-facts-editor";
import { useEffect, useRef, useState, useSyncExternalStore, useId } from "react";
import { TaskPopover } from "./task-popover";
import { ChevronRightIcon } from "lucide-react";
import { TodoInlineText } from "./todo-inline-text";
import { TodoLocationInput } from "./todo-location-input";
import { TodoLocationPreview } from "./todo-location-preview";
import { TodoNotesSection } from "./todo-notes-section";
import styles from "./todo-detail.module.css";

import { TodoBrowserError, useTodoStore, type LiveTodo } from "./todo-live";
import { readTodoDetail } from "./todo-detail-reader";
import { taskTime } from "./todo-timing";

const fieldNames = ["Due", "Alert", "Location", "Commitment", "Client", "Estimate", "Cost of waiting", "Waiting since", "Rank", "Top priority"];


export function TodoDetail({
  number,
  draft,
  preview,
  delegates,
  decisions,
  decisionProjection,
  onQueue,
  stale,
  revision,
  onClose,
  canWrite = false,
  canApprove = false,
  onSaved = () => {},
}: {
  number: number;
  draft?: { created?: boolean; pending?: boolean; submit(close: () => void): void; footer: (close: () => void) => import("react").ReactNode };
  preview?: LiveTodo;
  delegates?: DelegateControls;
  decisions?: DecisionControls;
  decisionProjection?: Parameters<typeof projectTodoDecision>[1];
  onQueue?: (command: import("./todo-history").HistoryCommand, before: LiveTodo) => void;
  stale: boolean;
  revision: string | null;
  onClose: () => void;
  canWrite?: boolean;
  canApprove?: boolean;
  onSaved?: () => void;
}) {
  const categories = useCategories();
  const [expanded, setExpanded] = useState(false);
  const [hasExpanded, setHasExpanded] = useState(false);
  const bodyId = useId();
  const titleId = useId();
  const store = useTodoStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const undoInFlight = useRef(false);
  const [captureUndo, setCaptureUndo] = useState<{ pending: boolean; done?: boolean; error?: string }>();
  const canEdit = canWrite && !captureUndo?.pending && !captureUndo?.done;
  const [result, setResult] = useState<{
    todo?: LiveTodo;
    error?: string;
    denied?: boolean;
  } | null>(null);
  const current = draft && (!draft.created || draft.pending) ? preview : snapshot.todos.find(todo => todo.number === number) ?? preview;
  useEffect(() => {
    if (draft && !draft.created) return;
    const controller = new AbortController();
    void readTodoDetail(number, current?.updatedAt)
      .then(({ todo }) => {
        if (!controller.signal.aborted) setResult({ todo });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const denied =
          error instanceof TodoBrowserError &&
          [401, 403, 404].includes(error.status);
        setResult((previous) => ({
          denied,
          todo: denied ? undefined : previous?.todo,
          error: error instanceof Error ? error.message : "Task unavailable.",
        }));
      });
    return () => controller.abort();
  }, [number, revision, current?.updatedAt, !!draft, draft?.created]);
  const denied = result?.denied;
  const unavailable = stale || !!result?.error;
  const record = denied ? undefined : result?.todo && current ? { ...result.todo, ...current,
    delegation: (current.delegation?.revision ?? 0) >= (result.todo.delegation?.revision ?? 0) ? current.delegation ?? result.todo.delegation : result.todo.delegation,
  } : current ?? result?.todo;
  const decided = record && decisionProjection ? projectTodoDecision(record, decisionProjection) : record;
  const todo = decided && delegates ? projectTodoDelegate(decided, delegates.directory) : decided;
  const category = categories.categories.find(c => todo?.categoryId ? c.id === todo.categoryId : c.name === todo?.fields.Category);
  const prose = todo?.scheduleError
    ? todo.body
    : todo?.description ?? editableTodoDescription(todo?.body ?? null);
  const shownFields = todo ? fieldNames.filter(name => (!canWrite || ["URL", "Alert", "Rank", "Top priority"].includes(name)) && name !== "Location" && todo.fields[name] != null && todo.fields[name] !== "" && todo.fields[name] !== "No") : [];
  async function undoCapture(task: LiveTodo, auditId: string) {
    if (undoInFlight.current) return;
    undoInFlight.current = true;
    setCaptureUndo({ pending: true });
    store.edits.start(auditId, task.number, { commandId: auditId, revision: task.updatedAt, trash: { before: false, after: true } });
    try {
      const response = await fetch(`/api/v1/agent-audit/${auditId}/undo`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new TodoBrowserError(result?.message ?? "Undo is unconfirmed. Retry.", response.status, 0);
      if (result?.audit?.id !== auditId || !result.audit.undoneAt ||
          result.todo?.id !== task.id || result.todo?.number !== task.number)
        throw new Error("Undo is unconfirmed. Retry.");
      store.edits.finish(auditId, {
        commandId: auditId, todo: result.todo, outcomes: { trash: "saved" }, message: "", retryable: false,
        cacheGeneration: result.cacheGeneration,
      });
      setCaptureUndo({ pending: false, done: true });
    } catch (error) {
      const message = error instanceof TodoBrowserError ? error.message : "Undo is unconfirmed. Retry.";
      store.edits.fail(auditId, message, true);
      setCaptureUndo({ pending: false, error: message });
      if (error instanceof TodoBrowserError && error.status === 409) onSaved();
    } finally {
      undoInFlight.current = false;
    }
  }
  return (
    <TaskPopover number={draft && !draft.created ? null : number} titleId={titleId} onClose={onClose} selectTitle>
      {close => <fieldset disabled={unavailable} aria-label="Task details" className={styles.fields}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <VisuallyHidden as="h2" id={titleId}>{todo?.title || "Task details"}</VisuallyHidden>
            {todo ? <TodoInlineText key={`title-${draft ? 0 : number}`} title label="Title" placeholder="Task title" onSubmit={draft ? () => draft.submit(close) : close} value={todo.title} readOnly={!canEdit || !onQueue || stale || !!result?.error} onCommit={(before, after) => { if (!after.trim()) throw new Error("A title is required."); onQueue?.({ commandId: crypto.randomUUID(), title: { before, after } }, todo); }} /> : <span className={styles.title}>Task details</span>}
            {todo && <CategoryPicker compact value={category?.name ?? String(todo.fields.Category ?? "")} disabled={!canEdit || !onQueue || stale || !!result?.error} onChange={value => onQueue?.({ commandId: crypto.randomUUID(), fields: { Category: { before: category?.name ?? todo.fields.Category ?? null, after: value || null } } }, todo)} />}
          </div>
          {todo && <TodoLocationInput onSubmit={draft ? () => draft.submit(close) : close} key={`location-${draft ? 0 : number}`} value={String(todo.fields.Location ?? "")} readOnly={!canEdit || !onQueue || stale || !!result?.error} onCommit={(before, after) => onQueue?.({ commandId: crypto.randomUUID(), fields: { Location: { before: before || null, after: after || null } } }, todo)} />}
          {todo && !draft && <>
            <TodoDelegatePicker todo={todo} controls={!canEdit || unavailable || todo.trashed || decisions?.busy(todo) || todo.delegation?.pendingDecision ? undefined : delegates} />
            <HandBackSummary todo={todo} />
            <HandBackButtons todo={todo} controls={captureUndo?.pending || unavailable || todo.trashed ? undefined : decisions} />
            {canWrite && todo.personalCaptureUndoId && !captureUndo?.done && (!todo.trashed || captureUndo?.pending) && (
              <Button type="button" size="xs" variant="ghost" disabled={unavailable || captureUndo?.pending}
                onClick={() => void undoCapture(todo, todo.personalCaptureUndoId!)}>
                {captureUndo?.pending ? "Undoing Tyler’s capture…" : captureUndo?.error ? "Retry undo" : "Undo Tyler’s capture"}
              </Button>
            )}
            {captureUndo?.done && <Text role="status" fontSize="xs" color="fg.muted">Capture undone.</Text>}
            {captureUndo?.error && <Text role="alert" fontSize="xs" color="fg.error">{captureUndo.error}</Text>}
          </>}
        </header>
        {todo && <>
          <Separator borderColor="border" />
          <button type="button" disabled={unavailable} className={styles.dateTrigger} aria-label="Edit date and task details" aria-expanded={expanded} aria-controls={bodyId} onClick={() => { setHasExpanded(true); setExpanded(value => !value); }}>
            <span className={styles.dateCopy}>
              <span>{taskTime(todo)}</span>
              {todo.fields.Due && <span className={styles.due}>Due {todo.fields.Due}{todo.deadlineAt ? ` · ${new Intl.DateTimeFormat("en", { timeZone: "America/Halifax", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(todo.deadlineAt))}` : ""}</span>}
            </span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
          {todo.deadlineError && <Text px="4" fontSize="sm" color="fg.error" role="alert">{todo.deadlineError}</Text>}
        </>}
        {!draft && !result && todo && <VisuallyHidden role="status">Loading details…</VisuallyHidden>}
        {!result && !todo && (
          <Stack gap="6" role="status" aria-label="Loading task" aria-busy="true">
            <VisuallyHidden>Loading task details</VisuallyHidden>
            <Skeleton h="24" w="full" />
            {[0, 1, 2, 3].map((field) => (
              <Stack key={field} gap="2">
                <Skeleton h="4" w="24" />
                <Skeleton h="9" w="full" />
              </Stack>
            ))}
          </Stack>
        )}
        {result?.error && !todo && <Alert.Root status="error" role="alert" bg="bg.panel" color="fg.error" borderWidth="1px" borderColor="border" px="2.5" py="2"><Alert.Description>{result.error}</Alert.Description></Alert.Root>}
        {todo && hasExpanded && (
          <section id={bodyId} hidden={!expanded} aria-label="Task fields" className={styles.body}>
            {canWrite && (
              <TodoFactsEditor
                key={draft ? 0 : number}
                popover
                todo={todo}
                onQueue={onQueue}
                disabled={!canEdit || !onQueue || stale || !!result?.error}
                onSaved={onSaved}
                draft={!!draft && !draft.created}
              />
            )}
            {!!shownFields.length && <Stack as="dl" my="3" gap="2" borderBlockWidth="1px" borderColor="color-mix(in srgb, var(--chakra-colors-fg) 15%, transparent)" py="3">
              {shownFields.map(name => <Grid key={name} minW="0" templateColumns="100px minmax(0, 1fr)" gap="3">
                <Text as="dt" textAlign="right" fontSize="sm" color="fg.muted">{name}</Text>
                <Text as="dd" overflowWrap="break-word" fontSize="sm">{todo.fields[name] ?? (name === "Alert" ? "None" : "Not set")}</Text>
              </Grid>)}
            </Stack>}
            {todo.scheduleError && <Alert.Root status="error" role="alert" bg="bg.panel" color="fg.error" borderWidth="1px" borderColor="border" px="2.5" py="2"><Alert.Description>{todo.scheduleError}</Alert.Description></Alert.Root>}
            {(!draft || draft.created) && <details className={styles.information}>
              <summary>Task information</summary>
              <div className={styles.informationContent}>
                <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" href={todo.url} target="_blank" rel="noreferrer" fontSize="sm" textDecoration="underline" textUnderlineOffset="4px">Open #{todo.number} in GitHub</Link>
                <Text overflowWrap="break-word" fontSize="xs" color="fg.muted">{todo.repository} · {todo.state}{todo.closureReason ? ` · ${todo.closureReason.replaceAll("_", " ")}` : ""}</Text>
                {todo.duplicateOf && <Text fontSize="xs">Duplicate of <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" textDecoration="underline" href={todo.duplicateOf.url}>#{todo.duplicateOf.number}</Link></Text>}
                {!!todo.labels.length && <Text fontSize="xs" color="fg.muted">{todo.labels.join(" · ")}</Text>}
                <details className={styles.information}><summary>Relationships and delegation</summary><div className={styles.informationContent}>
                  <TodoRelationships todo={todo} disabled={!canEdit || stale || !!result?.error} onSaved={onSaved} />
                  <TodoDelegation todo={todo} canWrite={canEdit} canApprove={canApprove} disabled={captureUndo?.pending || stale || !!result?.error} onSaved={onSaved} />
                </div></details>
                {[
                  ...new Set(Array.from([todo.body ?? "", ...(todo.comments ?? []).map(c => c.body)].join("\n").matchAll(/Capture ID: ([a-f0-9-]{36})/g), match => match[1])),
                ].map((id, index) => <details key={id} className={styles.information}><summary>Original capture {index + 1}</summary><div className={styles.informationContent}><TodoCaptureReview id={id} /></div></details>)}
              </div>
            </details>}
            {todo.timingWarnings?.map((warning, index) => <Text fontSize="sm" key={index}>{warning}</Text>)}
          </section>
        )}
        {todo && <>
          <Separator borderColor="border" />
          <footer className={styles.notes}>
            <TodoNotesSection key={`notes-${draft ? 0 : number}`} notes={prose ?? ""} urls={String(todo.fields.URL ?? "")} readOnly={!canEdit || !onQueue || stale || !!result?.error || !!todo.scheduleError} onNotesCommit={(before, after) => onQueue?.({ commandId: crypto.randomUUID(), description: { before, after } }, todo)} onUrlsCommit={(before, after) => onQueue?.({ commandId: crypto.randomUUID(), fields: { URL: { before: before || null, after: after || null } } }, todo)} />
            <TodoLocationPreview location={String(todo.fields.Location ?? "")} />
          </footer>
        </>}
        {draft?.footer(close)}
      </fieldset>}
    </TaskPopover>
  );
}
