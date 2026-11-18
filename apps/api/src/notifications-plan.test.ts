import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_ALERT_MINUTES, planAlerts, planNativeAppointmentAlert, wallTime, type NativeReminderAppointment } from "./notifications-plan";
import type { Todo } from "./todos-github";
const task = (patch: Partial<Todo> = {}): Todo => ({ id: "task-1", databaseId: 1, repository: "test/tasks", number: 1, url: "https://example.com/1", title: "Dentist", body: "", state: "open", closureReason: null, updatedAt: "2026-10-30T12:00:00Z", labels: [], fields: {}, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null, ...patch });
test("start alert precedes prep/travel, not the appointment", () => {
  const [alert] = planAlerts(task({ start: "2026-10-30T18:00:00Z", beforeMinutes: 30 }), 10, "09:00", "America/Halifax");
  expect(new Date(alert!.fireAt).toISOString()).toBe("2026-10-30T17:20:00.000Z");
  expect(new Date(alert!.expiresAt).toISOString()).toBe("2026-10-30T17:30:00.000Z");
  expect(alert!.body).toBe("prep/travel begins at 2:30 PM");
});
test("independent start and deadline alerts coalesce only at the same moment", () => {
  const t = task({ start: "2026-10-30T18:00:00Z", fields: { Due: "2026-10-30" }, deadlineAt: "2026-10-30T20:00:00Z" });
  const alerts = planAlerts(t, 10, "09:00", "UTC");
  expect(alerts).toHaveLength(2);
  expect(alerts[1]!.expiresAt - alerts[1]!.fireAt).toBe(3600000);
  expect(planAlerts({ ...t, deadlineAt: t.start }, 10, "09:00", "UTC")).toHaveLength(1);
});
test("date-only alerts use configurable device wall time across DST", () => {
  expect(new Date(wallTime("2026-10-31", "09:00", "America/Halifax")).toISOString()).toBe("2026-10-31T12:00:00.000Z");
  expect(new Date(wallTime("2026-11-01", "09:00", "America/Halifax")).toISOString()).toBe("2026-11-01T13:00:00.000Z");
  const t = task({ fields: { Due: "2026-11-01" } });
  const [halifax] = planAlerts(t, 10, "10:15", "America/Halifax");
  const [tokyo] = planAlerts(t, 10, "10:15", "Asia/Tokyo");
  expect(halifax!.fireAt).not.toBe(tokyo!.fireAt);
  expect(halifax!.expiresAt - halifax!.fireAt).toBe(3600000);
});
test("completed, trashed, disabled and invalid timing never generate obsolete alerts", () => {
  const t = task({ start: "2026-10-30T18:00:00Z" });
  for (const altered of [{ ...t, state: "closed" as const }, { ...t, trashed: true }, { ...t, scheduleError: "bad metadata" }]) expect(planAlerts(altered, 10, "09:00", "UTC")).toEqual([]);
  expect(planAlerts(t, null, "09:00", "UTC")).toEqual([]);
  expect(planAlerts({ ...t, allDay: true }, 10, "09:00", "UTC")).toEqual([]);
  expect(planAlerts(t, 20, "09:00", "UTC")[0]!.key).not.toBe(planAlerts(t, 10, "09:00", "UTC")[0]!.key);
});

test("nonexistent spring-forward morning moves forward through the DST gap", () => {
  expect(new Date(wallTime("2027-03-14", "02:30", "America/Halifax")).toISOString()).toBe("2027-03-14T06:30:00.000Z");
});

test("native interview alerts share start timing and have an independent UUID receipt", () => {
  const id = "ac8e143c-ebc9-4873-85af-3db9db044088";
  const appointment: NativeReminderAppointment = {
    source: "native", id, ownerId: "owner", applicationId: "application", title: "Interview", start: "2026-11-01T09:00:00-04:00",
    beforeMinutes: 30, alertMinutes: DEFAULT_ALERT_MINUTES, revision: 1, cancelledAt: null,
  };
  const native = planNativeAppointmentAlert(appointment, "America/Halifax")!;
  const [legacy] = planAlerts(task(appointment), 10, "09:00", "America/Halifax");
  expect(native).toMatchObject({
    url: `/todo?appointment=${id}`,
    revision: 1,
    fireAt: Date.parse("2026-11-01T12:20:00Z"),
    expiresAt: Date.parse("2026-11-01T12:30:00Z"),
    body: "prep/travel begins at 8:30 AM",
  });
  expect(legacy).toMatchObject({
    number: 1,
    key: createHash("sha256").update(`${id}:${native.fireAt}`).digest("hex"),
    fireAt: native.fireAt,
    expiresAt: native.expiresAt,
    body: native.body,
  });
  expect(native.key).not.toBe(legacy!.key);
  expect(planNativeAppointmentAlert({ ...appointment, start: "2026-11-01T13:00:00Z" }, "UTC")?.key).toBe(native.key);
  expect(planNativeAppointmentAlert({ ...appointment, revision: 2 }, "UTC")?.key).toBe(native.key);
  expect(planNativeAppointmentAlert({ ...appointment, alertMinutes: 20 }, "UTC")?.fireAt).toBe(native.fireAt - 600_000);
  expect(planNativeAppointmentAlert({ ...appointment, alertMinutes: null }, "UTC")).toBeUndefined();
  expect(planNativeAppointmentAlert({ ...appointment, cancelledAt: appointment.start }, "UTC")).toBeUndefined();
});
