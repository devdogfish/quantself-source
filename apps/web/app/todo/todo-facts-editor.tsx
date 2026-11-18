"use client";
import { TaskAlert } from "@/components/notifications/task-alert";
import { Alert, Button, Checkbox, Field, Fieldset, Input, Separator, Stack, Text, Textarea, chakra } from "@chakra-ui/react";
import { TodoDetailSelect } from "./todo-detail-select";
import detailStyles from "./todo-detail.module.css";
import { TodoDateField } from "./todo-date-field";
import { CategoryPicker } from "./todo-categories";
import { todoHistory } from "./todo-history";
import { timingRange, localDateTime, taskTiming, timingInstant } from "./todo-timing";
import { useRef, useState, useId, useEffect } from "react";
import type { components } from "@/lib/generated/quantself-api-schema";
import { useJarvisDraft } from "./jarvis-ui";
import {
  TodoBrowserError,
  previewTodoEdit,
  type LiveTodo,
  type TodoCreationHandlers,
} from "./todo-live";

type Create = components["schemas"]["TodoCreate"];
type Edit = components["schemas"]["TodoEdit"];
type Result = components["schemas"]["TodoWriteResult"];
const names = [
  "Commitment",
  "Client",
  "Location",
  "Category",
  "Due",
  "Estimate",
  "Cost of waiting",
  "Waiting since",
] as const;
type FactName = (typeof names)[number];
const factOptions: Partial<Record<FactName, readonly string[]>> = {
  Commitment: ["Inbox", "Active", "Someday"],
  "Cost of waiting": ["Low", "Medium", "High"],
};

function factValue(name: FactName, value: string) {
  if (value === "") return null;
  if (name === "Estimate") return Number(value);
  return value;
}

function factInputType(name: FactName) {
  if (name === "Waiting since" || name === "Due") return "date";
  if (name === "Estimate") return "number";
  return "text";
}

// A contiguous prose target. Provenance and all comment-delimited data remain outside edits.
export function editableTodoDescription(body: string | null) {
  const raw = body ?? "";
  const provenance =
    /^Source: client message\nCaptured: [^\n]*\nCommand ID: [^\n]*\n<!-- quantself:command [a-f0-9]+ -->\n\n/.exec(
      raw,
    )?.[0] ?? "";
  return raw.slice(provenance.length).split("<!--")[0].trimEnd();
}
export async function saveTodoFacts(
  number: number | undefined,
  command: Create | Edit,
  history: { before?: ReturnType<typeof taskTiming>; replay?: boolean; group?: string } = {},
): Promise<Result> {
  todoHistory.beginWrite(history.replay);
  try {
  const response = await fetch(
    number ? `/api/v1/todos/${number}` : "/api/v1/todos",
    {
      method: number ? "PATCH" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(120000),
    },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok || !result)
    throw new TodoBrowserError(
      result?.message || "Save unavailable. Retry the same command.",
      response.status,
      Number(response.headers.get("retry-after")) || 0,
    );
  if (!history.replay) {
    if (number) todoHistory.record(number, command as Edit, result, history.before, history.group);
    else if (result.todo) todoHistory.clearRedo();
  }
  return result;
  } finally { todoHistory.endWrite(); }
}
export function TodoFactsEditor({
  todo,
  draft = false,
  disabled,
  onSaved,
  creation,
  initialTiming,
  popover = false,
  onQueue,
}: {
  draft?: boolean;
  popover?: boolean;
  todo?: LiveTodo;
  onQueue?: (command: Edit, before: LiveTodo) => void;
  initialTiming?: { start: string; end: string; allDay: boolean };
  disabled: boolean;
  onSaved: () => void;
  creation?: TodoCreationHandlers;
}) {
  const draftBase = useRef(todo);
  const previousSource = useRef(todo);
  const fieldId = useId();
  const [duplicateNumber, setDuplicateNumber] = useState("");
  const [start, setStart] = useState(todo ? localDateTime(todo.start ?? null) : initialTiming?.start ?? "");
  const [end, setEnd] = useState(todo ? localDateTime(todo.end ?? null) : initialTiming?.end ?? "");
  const [allDay, setAllDay] = useState(todo?.allDay ?? initialTiming?.allDay ?? false);
  const [beforeMinutes, setBeforeMinutes] = useState(todo?.beforeMinutes ?? 0);
  const [afterMinutes, setAfterMinutes] = useState(todo?.afterMinutes ?? 0);
  const [fixed, setFixed] = useState(todo?.fixed ?? false);
  const [deadlineClock, setDeadlineClock] = useState(todo?.deadlineAt ? localDateTime(todo.deadlineAt).slice(11) : "");
  const [explicitOffset, setExplicitOffset] = useState(false);
  const [title, setTitle] = useState(todo?.title ?? "");
  const [description, setDescription] = useState(
    todo?.description ?? editableTodoDescription(todo?.body ?? null),
  );
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      names.map((name) => [name, String(todo?.fields[name] ?? "")]),
    ),
  );
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [denied, setDenied] = useState(false);
  const [undo, setUndo] = useState<Edit | null>(null);
  const pending = useRef<Create | Edit | null>(null);
  const pendingUndo = useRef(false);
  const locked = disabled || denied || busy;
  useEffect(() => {
    if (popover || !onQueue || !todo) return;
    if (draftBase.current) draftBase.current = { ...draftBase.current, ...taskTiming(todo), beforeMinutes: todo.beforeMinutes, afterMinutes: todo.afterMinutes };
    setBeforeMinutes(todo.beforeMinutes ?? 0);
    setAfterMinutes(todo.afterMinutes ?? 0);
  }, [todo?.start, todo?.end, todo?.allDay, todo?.fixed, todo?.beforeMinutes, todo?.afterMinutes]);
  useEffect(() => {
    if (!popover || !todo) return;
    const description = todo.description ?? editableTodoDescription(todo.body);
    setTitle(todo.title);
    setDescription(description);
    setFields(previous => ({ ...previous, Location: String(todo.fields.Location ?? ""), Category: String(todo.fields.Category ?? "") }));
    if (draftBase.current) draftBase.current = { ...draftBase.current, title: todo.title, description, fields: { ...draftBase.current.fields, Location: todo.fields.Location ?? null, Category: todo.fields.Category ?? null } };
  }, [popover, todo?.title, todo?.description, todo?.body, todo?.fields.Location, todo?.fields.Category]);
  useEffect(() => {
    const prior = previousSource.current;
    previousSource.current = todo;
    if (!popover || !todo || !prior || !draftBase.current) return;
    const baseline = { ...draftBase.current };
    // Only clean drafts follow incoming state (including Undo). A delayed response
    // must not replace a newer local edit waiting for its debounce.
    const clean = <T,>(draft: T, before: T, after: T) => draft === before || draft === after;
    const timingClean = clean(start, localDateTime(prior.start), localDateTime(todo.start)) && clean(end, localDateTime(prior.end), localDateTime(todo.end)) && clean(allDay, prior.allDay, todo.allDay) && clean(fixed, prior.fixed, todo.fixed) && clean(beforeMinutes, prior.beforeMinutes ?? 0, todo.beforeMinutes ?? 0) && clean(afterMinutes, prior.afterMinutes ?? 0, todo.afterMinutes ?? 0);
    if (timingClean) {
      setStart(localDateTime(todo.start)); setEnd(localDateTime(todo.end)); setAllDay(todo.allDay); setFixed(todo.fixed); setBeforeMinutes(todo.beforeMinutes ?? 0); setAfterMinutes(todo.afterMinutes ?? 0);
      Object.assign(baseline, taskTiming(todo));
    }
    const nextFields = { ...fields };
    const baseFields = { ...baseline.fields };
    for (const name of names) if (clean(fields[name], String(prior.fields[name] ?? ""), String(todo.fields[name] ?? ""))) {
      nextFields[name] = String(todo.fields[name] ?? ""); Object.assign(baseFields, { [name]: todo.fields[name] ?? null });
    }
    setFields(nextFields); baseline.fields = baseFields;
    const priorClock = prior.deadlineAt ? localDateTime(prior.deadlineAt).slice(11) : "";
    const nextClock = todo.deadlineAt ? localDateTime(todo.deadlineAt).slice(11) : "";
    const deadlineClean = clean(deadlineClock, priorClock, nextClock);
    if (deadlineClean) { setDeadlineClock(nextClock); baseline.deadlineAt = todo.deadlineAt; }
    if (timingClean && deadlineClean) baseline.updatedAt = todo.updatedAt;
    draftBase.current = baseline;
  }, [popover, todo]);
  function changePrep(side: "beforeMinutes" | "afterMinutes", value: number) {
    if (side === "beforeMinutes") setBeforeMinutes(value); else setAfterMinutes(value);
    if (popover || !todo || !onQueue || locked || !Number.isInteger(value) || value < 0 || value > 1440) return;
    const baseline = draftBase.current!;
    if (!baseline.start || baseline.allDay || (baseline[side] ?? 0) === value) return;
    const command: Edit = { commandId: crypto.randomUUID(), ...taskTiming(baseline), [side]: value, revision: todo.updatedAt };
    onQueue(command, baseline);
    draftBase.current = previewTodoEdit(baseline, command);
    setError("");
  }

  function changeBound(side: "start" | "end", value: string) {
    if (side === "start") setStart(value); else setEnd(value);
    if (!value || (side === "start" ? end : start)) return;
    try {
      const instant = timingInstant(value)!;
      const other = localDateTime(Date.parse(instant) + (side === "start" ? 30 : -30) * 60000);
      if (side === "start") setEnd(other); else setStart(other);
    } catch (error) { setError((error as Error).message); }
  }
  function deadlineInput() {
    if (!deadlineClock || !fields.Due) return null;
    return timingInstant(`${fields.Due}T${deadlineClock}`, todo?.deadlineAt);
  }
  async function submit(command?: Edit, isUndo = false, automatic = false) {
    if (locked) return;
    if (Date.now() < retryAt) {
      setError("Wait for GitHub's retry delay before retrying.");
      return;
    }
    if (!pending.current) {
      pendingUndo.current = isUndo;
      if (command) pending.current = command;
      else if (!todo) {
        const facts = Object.fromEntries(
          names
            .filter((name) => fields[name] !== "")
            .map((name) => [name, factValue(name, fields[name])]),
        );
        let timing: Partial<Create> = {};
        try { if (start || end) timing = { ...timingRange(start, end), allDay: !!start && allDay, fixed: !!start && fixed, beforeMinutes: start && !allDay ? beforeMinutes : 0, afterMinutes: start && !allDay ? afterMinutes : 0 }; } catch (error) { setError((error as Error).message); return; }
        let deadlineAt: string | null;
        try { deadlineAt = deadlineInput(); } catch (error) { setError((error as Error).message); return; }
        pending.current = {
          commandId: crypto.randomUUID(),
          ...(deadlineAt ? { deadlineAt } : {}),
          title,
          ...timing,
          ...(description ? { description } : {}),
          ...(Object.keys(facts).length ? { fields: facts } : {}),
        } as Create;
      } else {
        const baseline = draftBase.current!;
        const changes = Object.fromEntries(
          names
            .filter(
              (name) => (!popover || (name !== "Location" && name !== "Category")) && fields[name] !== String(baseline.fields[name] ?? ""),
            )
            .map((name) => [
              name,
              {
                before: baseline.fields[name] ?? null,
                after: factValue(name, fields[name]),
              },
            ]),
        );
        const before = baseline.description ?? editableTodoDescription(baseline.body);
        let timing: Partial<Edit> = {};
        if (start !== localDateTime(baseline.start) || end !== localDateTime(baseline.end) || allDay !== baseline.allDay || fixed !== baseline.fixed || beforeMinutes !== (baseline.beforeMinutes ?? 0) || afterMinutes !== (baseline.afterMinutes ?? 0)) {
          try { timing = { revision: baseline.updatedAt, ...timingRange(start, end, baseline), allDay: !!start && allDay, fixed: !!start && fixed, beforeMinutes: start && !allDay ? beforeMinutes : 0, afterMinutes: start && !allDay ? afterMinutes : 0 }; }
          catch (error) { setError((error as Error).message); return; }
        }
        let deadlineAt: string | null;
        try { deadlineAt = deadlineInput(); } catch (error) { setError((error as Error).message); return; }
        pending.current = {
          commandId: crypto.randomUUID(),
          ...timing,
          ...(deadlineAt !== (baseline.deadlineAt ?? null) ? { deadlineAt: { before: baseline.deadlineAt ?? null, after: deadlineAt }, revision: baseline.updatedAt } : {}),
          ...(!popover && title !== baseline.title
            ? { title: { before: baseline.title, after: title } }
            : {}),
          ...(!popover && description !== before
            ? { description: { before, after: description } }
            : {}),
          ...(Object.keys(changes).length ? { fields: changes } : {}),
        } as Edit;
        if (Object.keys(pending.current).length === 1) {
          pending.current = null;
          setError(automatic ? "" : "No changes to save.");
          return;
        }
      }
    }
    if (todo && onQueue) {
      const patch = pending.current as Edit;
      const baseline = draftBase.current!;
      // Only adopt a newer revision when the timing we edited is still current.
      if (patch.start !== undefined && JSON.stringify(taskTiming(todo)) === JSON.stringify(taskTiming(baseline))) patch.revision = todo.updatedAt;
      try { onQueue(patch, baseline); } catch (error) { pending.current = null; setError(error instanceof Error ? error.message : "Could not save changes. Try editing again."); return; }
      draftBase.current = previewTodoEdit(baseline, patch);
      pending.current = null;
      setResult(null);
      setError("");
      return;
    }
    if (!todo) creation?.start(pending.current as Create);
    setBusy(true);
    setError("");
    try {
      const saved = await saveTodoFacts(todo?.number, pending.current, { before: draftBase.current ? taskTiming(draftBase.current) : undefined });
      if (!todo) creation?.finish(pending.current!.commandId, saved);
      setResult(saved);
      if (Object.values(saved.outcomes).some((value) => value !== "saved")) setError(saved.message);
      if (todo && !pendingUndo.current) {
        const patch = pending.current as Edit;
        const inverse: Edit = { commandId: crypto.randomUUID() };
        if (patch.start !== undefined && saved.outcomes.timing === "saved") Object.assign(inverse, { revision: saved.todo?.updatedAt, ...taskTiming(draftBase.current!) });
        if (patch.closure && saved.outcomes.closure === "saved")
          inverse.closure = {
            before: patch.closure.after,
            after: patch.closure.before,
          };
        if (patch.deadlineAt && saved.outcomes.deadlineAt === "saved") { inverse.deadlineAt = { before: patch.deadlineAt.after, after: patch.deadlineAt.before }; inverse.revision = saved.todo?.updatedAt; }
        if (patch.title && saved.outcomes.title === "saved")
          inverse.title = {
            before: patch.title.after,
            after: patch.title.before,
          };
        if (patch.description && saved.outcomes.description === "saved")
          inverse.description = {
            before: patch.description.after,
            after: patch.description.before,
          };
        const inverseFields = Object.fromEntries(
          Object.entries(patch.fields ?? {})
            .filter(([name]) => saved.outcomes[name] === "saved")
            .map(([name, value]) => [
              name,
              { before: value!.after, after: value!.before },
            ]),
        );
        if (Object.keys(inverseFields).length) inverse.fields = inverseFields;
        setUndo(Object.keys(inverse).length > 1 ? inverse : null);
      } else if (pendingUndo.current) setUndo(null);
      onSaved();
    } catch (error) {
      if (!todo)
        creation?.fail(
          pending.current!.commandId,
          error instanceof Error
            ? error.message
            : "Task creation failed. Retry the same command.",
        );
      if (error instanceof TodoBrowserError) {
        setRetryAt(Date.now() + error.retryAfter * 1000);
        if ([401, 403].includes(error.status)) setDenied(true);
        if (error.status === 400) pending.current = null;
      }
      setError(
        error instanceof Error
          ? error.message
          : "Save uncertain. Retry this command.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function transition(after: NonNullable<Edit["closure"]>["after"]) {
    if (!todo) return;
    let before: NonNullable<Edit["closure"]>["before"];
    if (todo.state === "open") {
      before = { outcome: "open" };
    } else if (todo.closureReason === "duplicate" && todo.duplicateOf) {
      before = { outcome: "duplicate", number: todo.duplicateOf.number };
    } else if (todo.closureReason === "not_planned") {
      before = { outcome: "not_planned" };
    } else {
      before = { outcome: "completed" };
    }
    await submit({
      commandId: crypto.randomUUID(),
      closure: { before, after },
    });
  }
  const autosave = useRef<() => void>(() => {});
  autosave.current = () => { if (popover && onQueue && !locked) void submit(undefined, false, true); };
  useEffect(() => {
    if (!popover || !onQueue || locked) return;
    const timer = setTimeout(() => autosave.current(), 3000);
    return () => clearTimeout(timer);
  }, [popover, onQueue, locked, start, end, allDay, fixed, beforeMinutes, afterMinutes, deadlineClock, fields]);
  const complete =
    result &&
    Object.values(result.outcomes).every((value) => value === "saved");
  useJarvisDraft(busy || (!complete && (
    pending.current !== null || duplicateNumber !== "" ||
    deadlineClock !== (todo?.deadlineAt ? localDateTime(todo.deadlineAt).slice(11) : "") || title !== (todo?.title ?? "") || description !== editableTodoDescription(todo?.body ?? null) || start !== localDateTime(todo?.start ?? null) || end !== localDateTime(todo?.end ?? null) || allDay !== (todo?.allDay ?? false) || fixed !== (todo?.fixed ?? false) || beforeMinutes !== (todo?.beforeMinutes ?? 0) || afterMinutes !== (todo?.afterMinutes ?? 0) ||
    names.some(name => fields[name] !== String(todo?.fields[name] ?? ""))
  )));
  return (
    <chakra.form
      display="flex" flexDirection="column" minW="0" gap="6"
      className={popover ? detailStyles.form : undefined}
      onBlurCapture={() => autosave.current()}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Fieldset.Root data-slot="field-set"
        disabled={locked || pending.current !== null}
      >
        <Fieldset.Content data-slot="field-group" gap="5">
          {!popover && <Field.Root data-slot="field" gap="2">
            <Field.Label data-slot="field-label" htmlFor={`${fieldId}-0`}>Title</Field.Label>
            <Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border"
              id={`${fieldId}-0`}
              value={title}
              required
              maxLength={256}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field.Root>}
          {!popover && <Field.Root data-slot="field" gap="2">
            <Field.Label data-slot="field-label" htmlFor={`${fieldId}-1`}>Description</Field.Label>
            <Textarea
              size="sm" borderColor="border" minH="16"
              id={`${fieldId}-1`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field.Root>}
          <>
            <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-start`}>Start</Field.Label>{popover && !explicitOffset ? <TodoDateField id={`${fieldId}-start`} label="Start" withTime={!allDay} disabled={locked || pending.current !== null || !!todo?.scheduleError} value={start} onChange={value => changeBound("start", allDay && value ? `${value}T00:00` : value)} /> : <Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-start`} type={explicitOffset ? "text" : "datetime-local"} disabled={!!todo?.scheduleError} value={start} onChange={e => changeBound("start", e.target.value)} />}</Field.Root>
            <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-end`}>End</Field.Label>{popover && !explicitOffset ? <TodoDateField id={`${fieldId}-end`} label="End" withTime={!allDay} disabled={locked || pending.current !== null || !!todo?.scheduleError} value={end} onChange={value => changeBound("end", allDay && value ? `${value}T00:00` : value)} /> : <Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-end`} type={explicitOffset ? "text" : "datetime-local"} disabled={!!todo?.scheduleError} value={end} onChange={e => changeBound("end", e.target.value)} />}<Field.HelperText data-slot="field-description" fontSize="sm" color="fg.muted">{popover ? "America/Halifax" : "America/Halifax · Optional. Leave both empty to unschedule."}</Field.HelperText></Field.Root>
            <Checkbox.Root
              data-slot="field"
              className={popover ? detailStyles.checkboxField : undefined}
              size="sm"
              ids={{ hiddenInput: `${fieldId}-all-day` }}
              checked={allDay}
              disabled={locked || pending.current !== null || !!todo?.scheduleError}
              onCheckedChange={({ checked }) => setAllDay(checked === true)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label data-slot="field-label">All day</Checkbox.Label>
            </Checkbox.Root>
            <Checkbox.Root
              data-slot="field"
              className={popover ? detailStyles.checkboxField : undefined}
              size="sm"
              ids={{ hiddenInput: `${fieldId}-fixed` }}
              checked={fixed}
              disabled={locked || pending.current !== null || !!todo?.scheduleError}
              onCheckedChange={({ checked }) => setFixed(checked === true)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label data-slot="field-label">Fixed appointment</Checkbox.Label>
            </Checkbox.Root>
            <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-prep-before`}>{popover ? "Prep before" : "Prep before (minutes)"}</Field.Label><Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-prep-before`} type="number" title="Minutes" min={0} max={1440} step={1} disabled={!start || allDay || !!todo?.scheduleError} value={beforeMinutes} onChange={e => changePrep("beforeMinutes", Number(e.target.value))} /></Field.Root>
            <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-prep-after`}>{popover ? "Prep after" : "Prep after (minutes)"}</Field.Label><Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-prep-after`} type="number" title="Minutes" min={0} max={1440} step={1} disabled={!start || allDay || !!todo?.scheduleError} value={afterMinutes} onChange={e => changePrep("afterMinutes", Number(e.target.value))} />{!popover && <Field.HelperText data-slot="field-description" fontSize="sm" color="fg.muted">Shaded time outside the event. Start and end stay unchanged. Set to 0 to remove.</Field.HelperText>}</Field.Root>
            {error.includes("Clock change") && <Button type="button" variant="outline" colorPalette="gray" onClick={() => setExplicitOffset(true)}>Use explicit offsets</Button>}
          </>
          {popover && <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-Due`}>Due</Field.Label><TodoDateField id={`${fieldId}-Due`} label="Due" value={fields.Due} disabled={locked || pending.current !== null} onChange={value => setFields(previous => ({ ...previous, Due: value }))} /></Field.Root>}
          <Field.Root data-slot="field" gap="2"><Field.Label data-slot="field-label" htmlFor={`${fieldId}-deadline-time`}>{popover ? "Deadline time" : "Deadline time (optional)"}</Field.Label><Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-deadline-time`} type="time" disabled={!fields.Due} value={deadlineClock} onChange={event => setDeadlineClock(event.target.value)} />{!popover && <Field.HelperText data-slot="field-description" fontSize="sm" color="fg.muted">Uses the Due date in America/Halifax; does not schedule work.</Field.HelperText>}{todo?.deadlineError && <Text role="alert" fontSize="sm" color="fg.error">{todo.deadlineError}</Text>}</Field.Root>
          {todo && !draft && <TaskAlert number={todo.number} beforeMinutes={beforeMinutes} dateOnly={!!fields.Due && !deadlineClock && (!start || allDay)} />}
          {names
            .filter((name) => (!popover || (name !== "Location" && name !== "Category" && name !== "Due")) && (todo || name !== "Commitment"))
            .map((name) => (
              <Field.Root data-slot="field" gap="2" key={name}>
                <Field.Label data-slot="field-label" htmlFor={`${fieldId}-${name}`}>{name === "Category" ? "Category" : name}</Field.Label>
                {name === "Category" ? <CategoryPicker id={`${fieldId}-${name}`} value={fields.Category} disabled={locked || pending.current !== null} onChange={value => setFields(previous => ({ ...previous, Category: value }))} /> : factOptions[name] ? (
                  <TodoDetailSelect
                    id={`${fieldId}-${name}`}
                    label={name}
                    value={fields[name] || "unknown"}
                    items={[
                      { value: "unknown", label: "Unknown" },
                      ...factOptions[name].map(value => ({ value, label: value })),
                    ]}
                    compact={popover}
                    disabled={locked || pending.current !== null}
                    onChange={value => setFields(previous => ({ ...previous, [name]: value === "unknown" ? "" : value }))}
                  />
                ) : popover && factInputType(name) === "date" ? <TodoDateField id={`${fieldId}-${name}`} label={name} value={fields[name]} disabled={locked || pending.current !== null} onChange={value => setFields(previous => ({ ...previous, [name]: value }))} /> : (
                  <Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border"
                    id={`${fieldId}-${name}`}
                    type={factInputType(name)}
                    min={name === "Estimate" ? 1 : undefined}
                    step={name === "Estimate" ? 1 : undefined}
                    value={fields[name]}
                    onChange={(event) =>
                      setFields({ ...fields, [name]: event.target.value })
                    }
                  />
                )}
              </Field.Root>
            ))}
        </Fieldset.Content>
      </Fieldset.Root>
      {todo && !draft && !pending.current && (
        <div className={popover ? detailStyles.taskActions : undefined}>
          <Separator borderColor="border" />
          <Fieldset.Root data-slot="field-set" disabled={locked}>
            {!popover && <><Fieldset.Legend data-slot="field-legend" fontSize="md">Task status</Fieldset.Legend><Fieldset.HelperText data-slot="field-description" fontSize="sm" color="fg.muted">Whole task · time remains unchanged</Fieldset.HelperText></>}
            <Fieldset.Content data-slot="field-group" gap="5">
              <Button variant="outline" colorPalette="gray" size="xs" h="10" w="full" fontSize="sm" type="button" onClick={() => void transition({ outcome: todo.state === "closed" ? "open" : "completed" })}>
                {todo.state === "closed" ? "Reopen task" : "Mark as done"}
              </Button>
              {todo.state !== "closed" && <details className={detailStyles.secondaryActions}>
                <summary>Other actions</summary>
                <Fieldset.Content data-slot="field-group" gap="5">
                  <Button variant="ghost" colorPalette="gray" size="xs" h="7" fontSize="0.8rem" alignSelf="start" type="button" onClick={() => void transition({ outcome: "not_planned" })}>Close as not planned</Button>
                  <Field.Root data-slot="field" gap="2">
                    <Field.Label data-slot="field-label" htmlFor={`${fieldId}-2`}>Duplicate of</Field.Label>
                    <Input data-slot="input" size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border" id={`${fieldId}-2`} aria-label="Canonical issue number" placeholder="Task number" type="number" min={1} value={duplicateNumber} onChange={e => setDuplicateNumber(e.target.value)} />
                  </Field.Root>
                  <Button variant="ghost" colorPalette="gray" size="xs" h="7" fontSize="0.8rem" alignSelf="end" type="button" disabled={!Number.isSafeInteger(Number(duplicateNumber)) || Number(duplicateNumber) < 1 || Number(duplicateNumber) === todo.number} onClick={() => void transition({ outcome: "duplicate", number: Number(duplicateNumber) })}>Close as duplicate</Button>
                </Fieldset.Content>
              </details>}
            </Fieldset.Content>
          </Fieldset.Root>
        </div>
      )}
      {error && <Alert.Root status="error" role="alert" bg="bg.panel" color="fg.error" borderWidth="1px" borderColor="border" px="2.5" py="2"><Alert.Description>{error}</Alert.Description></Alert.Root>}
      {result && (
        <Stack gap="1" overflowWrap="break-word" fontSize="sm" color="fg.muted" role="status">
          <p>{result.message}</p>
          {Object.entries(result.outcomes).map(([name, status]) => (
            <p key={name}>
              {name}: {status}
            </p>
          ))}
        </Stack>
      )}
      {!popover && !complete && (
        <Button
          alignSelf="start"
          size="xs" fontSize="sm"
          type="submit"
          disabled={locked || (result !== null && !result.retryable)}
        >
          {busy ? "Saving…" : pending.current ? "Retry save" : "Save task"}
        </Button>
      )}
      {undo && (
        <Button
          variant="outline" colorPalette="gray"
          alignSelf="start" size="xs" fontSize="sm"
          type="button"
          disabled={locked}
          onClick={() => {
            pending.current = null;
            setBusy(true);
            void todoHistory.replay("undo", async item => {
              const command = item.execution!;
              if (item.expectedTiming && !item.prepared) {
                if (!todo || JSON.stringify(taskTiming(todo)) !== JSON.stringify(item.expectedTiming)) throw Error("This event changed. Refresh before undoing.");
                command.revision = todo.updatedAt;
                item.prepared = true;
              }
              return saveTodoFacts(item.number, command, { replay: true });
            }).then(() => { setUndo(null); onSaved(); }).catch(error => setError(String(error))).finally(() => setBusy(false));
          }}
        >
          Undo saved changes
        </Button>
      )}
      {todo && result && (
        <Button
          variant="outline" colorPalette="gray"
          alignSelf="start" size="xs" fontSize="sm"
          type="button"
          disabled={locked}
          onClick={() => {
            pending.current = null;
            setResult(null);
            setUndo(null);
            draftBase.current = todo;
            setTitle(todo.title);
            setStart(localDateTime(todo.start ?? null)); setEnd(localDateTime(todo.end ?? null)); setAllDay(todo.allDay); setFixed(todo.fixed);
            setDescription(todo.description ?? editableTodoDescription(todo.body));
            setFields(
              Object.fromEntries(
                names.map((name) => [name, String(todo.fields[name] ?? "")]),
              ),
            );
          }}
        >
          Review current task
        </Button>
      )}
    </chakra.form>
  );
}
