import type { components } from "@/lib/generated/quantself-api-schema";
import { TodoBrowserError, readTodoJson } from "./todo-live";

export type NativeAppointment = components["schemas"]["NativeJobInterviewAppointment"];
export type AppointmentFields = Pick<NativeAppointment, "start" | "end" | "beforeMinutes" | "afterMinutes" | "alertMinutes">;
export type AppointmentEdit = Partial<AppointmentFields>;
export type AppointmentAction = { action: "update"; fields: AppointmentEdit } | { action: "cancel" };
export type AppointmentRequest = components["schemas"]["NativeJobInterviewCommand"];

export const nativeAppointmentEndpoint = "/api/v1/jobs/interview-appointments";
const detailPath = (id: string) => `${nativeAppointmentEndpoint}/${encodeURIComponent(id)}`;

export function readNativeAppointment(id: string, signal?: AbortSignal) {
  return readTodoJson<NativeAppointment>(detailPath(id), signal);
}

export async function patchNativeAppointment(id: string, key: string, command: AppointmentRequest): Promise<NativeAppointment> {
  const response = await fetch(detailPath(id), {
    method: "PATCH", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new TodoBrowserError(typeof body?.message === "string" ? body.message : "Could not save appointment.", response.status, 0);
  }
  if (body?.source !== "native" || body.id !== id || !Number.isSafeInteger(body.revision) || body.revision <= command.expectedRevision ||
      (command.action === "cancel" && !body.cancelledAt)) {
    throw new Error("Appointment acknowledgement could not be verified.");
  }
  return body;
}
