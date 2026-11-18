import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, CloseButton, Drawer, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import { readNativeAppointment, useNativeAppointmentRefresh, type NativeAppointment } from "./native-appointments";
import { TodoBrowserError } from "./todo-live";
import { taskTime } from "./todo-timing";
import { NativeAppointmentEditor } from "./native-appointment-editor";
import {
  appointmentCancelIsPending, projectNativeAppointment, useNativeAppointmentChanges, useNativeAppointmentQueue, type AppointmentChange,
} from "./native-appointment-queue";

type Result = { appointment?: NativeAppointment; pending: boolean; error?: string; denied?: boolean };

export function NativeAppointmentDetail({ id, preview, enabled, canWrite, onClose }: {
  id: string;
  preview?: NativeAppointment;
  enabled: boolean | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Result>({ pending: true });
  const [version, retry] = useNativeAppointmentRefresh();
  const queue = useNativeAppointmentQueue();
  const change = useNativeAppointmentChanges().entries.get(id);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setResult(previous => ({ ...previous, pending: true, error: undefined }));
      void readNativeAppointment(id, controller.signal)
        .then(appointment => {
          if (!controller.signal.aborted) setResult({ appointment, pending: false });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const denied = error instanceof TodoBrowserError && [401, 403, 404].includes(error.status);
          setResult(previous => ({
            appointment: denied ? undefined : previous.appointment, pending: false, denied,
            error: denied ? "Appointment unavailable." : "Could not load the appointment.",
          }));
        });
    });
    return () => controller.abort();
  }, [enabled, id, version]);
  const seed = result.appointment ?? preview;
  const appointment = enabled && !result.denied && seed ? projectNativeAppointment(seed, change) : undefined;
  const pending = enabled === null || (enabled && result.pending);
  const saveStatus = enabled && !result.denied && change ? appointmentSaveMessage(change) : undefined;
  const error = enabled === false ? "Appointment unavailable." : result.error;
  return <Drawer.Root open onOpenChange={({ open }) => { if (!open) onClose(); }} size="md">
    <Portal>
      <Drawer.Backdrop />
      <Drawer.Positioner>
        <Drawer.Content>
          <Drawer.Header borderBottomWidth="1px">
            <Stack gap="2">
              <Drawer.Title>{appointment?.title ?? "Interview appointment"}</Drawer.Title>
              {appointment && <HStack><Badge>{appointment.category}</Badge><Badge>{appointment.cancelledAt ? "Cancelled" : "Fixed appointment"}</Badge></HStack>}
            </Stack>
          </Drawer.Header>
          <Drawer.Body>
            <Stack gap="4">
              {appointment && <>
                <Text>{taskTime(appointment)}</Text>
                {(appointment.beforeMinutes > 0 || appointment.afterMinutes > 0) && <Text color="fg.muted">
                  {[
                    appointment.beforeMinutes > 0 && `${appointment.beforeMinutes} min before`,
                    appointment.afterMinutes > 0 && `${appointment.afterMinutes} min after`,
                  ].filter(Boolean).join(" · ")}
                </Text>}
                {!appointment.cancelledAt && <Text color="fg.muted">{appointment.alertMinutes === null ? "Alert off" : `Alert ${appointment.alertMinutes} min before`}</Text>}
                <Button asChild variant="outline" alignSelf="start">
                  <Link href={`/jobs/applications?applicationId=${encodeURIComponent(appointment.applicationId)}`}>Open Jobs application</Link>
                </Button>
              </>}
              {pending && <Text role="status" color="fg.muted">{appointment ? "Checking appointment details…" : "Loading appointment…"}</Text>}
              {saveStatus && <HStack>
                <Text role={change?.status === "saving" || change?.status === "checking" ? "status" : "alert"}>{saveStatus}</Text>
                {(change?.status === "retry" || change?.refreshFailed) && <Button size="sm" variant="outline" onClick={() => queue?.retry(id)}>
                  {change.refreshFailed ? "Reload appointment" : "Retry save"}
                </Button>}
              </HStack>}
              {error && <HStack><Text role="alert">{error}</Text>
                {enabled && !result.denied && <Button size="sm" variant="outline" onClick={retry}>Retry</Button>}
              </HStack>}
              {appointment && canWrite && result.appointment && !appointment.cancelledAt && !change?.writeDenied && queue &&
                <NativeAppointmentEditor appointment={appointment} change={change}
                  onSubmit={action => queue.enqueue(appointment, action)} onDiscard={() => queue.discardDraft(id)}
                  onReplay={direction => queue.replay(appointment, direction)} />}
            </Stack>
          </Drawer.Body>
          <Drawer.CloseTrigger asChild><CloseButton aria-label="Close appointment" position="absolute" top="2" right="2" /></Drawer.CloseTrigger>
        </Drawer.Content>
      </Drawer.Positioner>
    </Portal>
  </Drawer.Root>;
}

export function appointmentSaveMessage(change: AppointmentChange) {
  if (change.status === "saving") return appointmentCancelIsPending(change) ? "Cancelling appointment…" : "Saving appointment…";
  if (change.status === "checking") return "Checking the current appointment…";
  if (change.status === "review" && !change.refreshFailed && !change.writeDenied && !change.base.cancelledAt) {
    return `${change.message ?? "The appointment changed."} Review the current appointment before saving again.`;
  }
  return change.message;
}

export function NativeAppointmentSaveNotice({ onOpen }: { onOpen: (appointment: NativeAppointment) => void }) {
  const { entries } = useNativeAppointmentChanges();
  return [...entries.values()].filter(change => change.status !== "settled" && change.status !== "unavailable").map(change =>
    <HStack key={change.base.id} px="3" py="1">
      <Text textStyle="sm" role="status">{appointmentSaveMessage(change)}</Text>
      <Button size="xs" variant="ghost" onClick={() => onOpen(change.base)}>Open appointment</Button>
    </HStack>);
}
