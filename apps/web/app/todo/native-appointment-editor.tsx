import { useId, useState } from "react";
import { Button, Dialog, Field, Grid, HStack, Input, Portal, Stack, Text } from "@chakra-ui/react";
import type { AppointmentAction, AppointmentEdit, AppointmentFields, NativeAppointment } from "./native-appointment-client";
import { appointmentCancelIsPending, appointmentEditToReview, type AppointmentChange } from "./native-appointment-queue";
import { localDateTime, timingInstant } from "./todo-timing";

type Draft = Partial<Record<keyof AppointmentFields, string>>;

function minutes(value: string, min: number, max: number, label: string) {
  const amount = Number(value);
  if (!value.trim() || !Number.isInteger(amount) || amount < min || amount > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return amount;
}

function appointmentInstant(value: string, existing: string) {
  if (value === existing) return existing;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  }
  return timingInstant(value, existing);
}

export function appointmentEdit(appointment: NativeAppointment, draft: Draft): AppointmentEdit {
  const fields: AppointmentEdit = {};
  if (draft.start !== undefined || draft.end !== undefined) {
    const start = draft.start === undefined ? appointment.start : appointmentInstant(draft.start, appointment.start);
    const end = draft.end === undefined ? appointment.end : appointmentInstant(draft.end, appointment.end);
    if (!start || !end || Date.parse(end) <= Date.parse(start)) throw new Error("Set a start and an end after it.");
    if (Date.parse(start) !== Date.parse(appointment.start) || Date.parse(end) !== Date.parse(appointment.end)) {
      fields.start = start;
      fields.end = end;
    }
  }
  if (draft.beforeMinutes !== undefined) {
    const before = minutes(draft.beforeMinutes, 0, 1440, "Prep before");
    if (before !== appointment.beforeMinutes) fields.beforeMinutes = before;
  }
  if (draft.afterMinutes !== undefined) {
    const after = minutes(draft.afterMinutes, 0, 1440, "Travel after");
    if (after !== appointment.afterMinutes) fields.afterMinutes = after;
  }
  if (draft.alertMinutes !== undefined) {
    const alert = draft.alertMinutes === "" ? null : minutes(draft.alertMinutes, 1, 10080, "Alert lead");
    if (alert !== appointment.alertMinutes) fields.alertMinutes = alert;
  }
  return fields;
}

export function NativeAppointmentEditor({ appointment, change, onSubmit, onDiscard, onReplay }: {
  appointment: NativeAppointment;
  change?: AppointmentChange;
  onSubmit: (action: AppointmentAction) => boolean;
  onDiscard: () => void;
  onReplay: (direction: "undo" | "redo") => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string>();
  const [explicitOffset, setExplicitOffset] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const review = appointmentEditToReview(change);
  function format(field: keyof AppointmentFields, value: string | number | null) {
    if ((field === "start" || field === "end") && !explicitOffset && typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) {
      return localDateTime(value);
    }
    return String(value ?? "");
  }
  function value(field: keyof AppointmentFields) {
    return format(field, draft[field] ?? (review && field in review ? review[field]! : appointment[field]));
  }
  function edit(field: keyof AppointmentFields, value: string) {
    setDraft(previous => ({ ...previous, [field]: value }));
    setError(undefined);
  }
  function discard() {
    setDraft({});
    setError(undefined);
    onDiscard();
  }
  function save() {
    try {
      const fromReview = Object.fromEntries(Object.entries(review ?? {}).map(([key, value]) => [key, String(value ?? "")])) as Draft;
      const fields = appointmentEdit(appointment, { ...fromReview, ...draft });
      if (!Object.keys(fields).length) { discard(); return; }
      if (onSubmit({ action: "update", fields })) { setDraft({}); setError(undefined); }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Review the appointment fields.");
    }
  }
  const cancelling = appointmentCancelIsPending(change);
  const blocked = cancelling || change?.status === "checking" || change?.refreshFailed;
  const changed = Object.keys(draft).length > 0 || Object.keys(review ?? {}).length > 0;
  const history = change?.base.revision === appointment.revision ? change.history : undefined;
  return <>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <Stack gap="3">
        <Grid templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
          {(["start", "end"] as const).map(field => <Field.Root key={field}>
            <Field.Label htmlFor={formId + field}>{field === "start" ? "Start" : "End"}</Field.Label>
            <Input id={formId + field} type={explicitOffset ? "text" : "datetime-local"} size="sm"
              value={value(field)} disabled={cancelling} required onChange={event => edit(field, event.target.value)} />
          </Field.Root>)}
        </Grid>
        <HStack justify="space-between">
          <Text textStyle="xs" color="fg.muted">{explicitOffset ? "ISO time with offset" : "America/Halifax"}</Text>
          <Button size="xs" type="button" variant="ghost" disabled={cancelling} onClick={() => setExplicitOffset(!explicitOffset)}>
            {explicitOffset ? "Use local time" : "Specify UTC offset"}
          </Button>
        </HStack>
        <Grid templateColumns={{ base: "1fr", sm: "repeat(3, minmax(0, 1fr))" }} gap="3">
          {([
            ["beforeMinutes", "Prep before", 0, 1440],
            ["afterMinutes", "Travel after", 0, 1440],
            ["alertMinutes", "Alert lead", 1, 10080],
          ] as const).map(([field, label, min, max]) => <Field.Root key={field}>
            <Field.Label htmlFor={formId + field}>{label} (min)</Field.Label>
            <Input id={formId + field} type="number" size="sm" min={min} max={max} step={1}
              value={value(field)} disabled={cancelling} required={field !== "alertMinutes"}
              placeholder={field === "alertMinutes" ? "Off" : undefined} onChange={event => edit(field, event.target.value)} />
            {field === "alertMinutes" && <Field.HelperText>Blank turns the alert off.</Field.HelperText>}
          </Field.Root>)}
        </Grid>
        {error && <Text role="alert" color="fg.error">{error}</Text>}
        <HStack wrap="wrap">
          <Button type="submit" size="sm" disabled={!changed || blocked}>Save changes</Button>
          {!!history?.undo.length && <Button size="sm" type="button" variant="ghost" aria-label="Undo appointment edit"
            disabled={blocked} onClick={() => onReplay("undo")}>Undo</Button>}
          {!!history?.redo.length && <Button size="sm" type="button" variant="ghost" aria-label="Redo appointment edit"
            disabled={blocked} onClick={() => onReplay("redo")}>Redo</Button>}
          {change?.status === "review" && !change.refreshFailed && <Button size="sm" type="button" variant="ghost" onClick={discard}>Discard draft</Button>}
          <Button size="sm" type="button" variant="outline" colorPalette="red" disabled={blocked}
            onClick={() => setConfirm(true)}>Cancel appointment</Button>
        </HStack>
      </Stack>
    </form>
    <Dialog.Root role="alertdialog" size="sm" open={confirm} onOpenChange={({ open }) => setConfirm(open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Cancel interview appointment?</Dialog.Title></Dialog.Header>
            <Dialog.Body><Dialog.Description>This removes the appointment from Calendar and stops its future alerts.</Dialog.Description></Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild><Button variant="outline">Keep appointment</Button></Dialog.ActionTrigger>
              <Button colorPalette="red" disabled={blocked} onClick={() => {
                if (onSubmit({ action: "cancel" })) { setConfirm(false); setDraft({}); setError(undefined); }
              }}>Confirm cancellation</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  </>;
}
