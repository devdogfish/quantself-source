import { expect, mock, test } from "bun:test";
import { fixtureAppointment as appointment, fixtureDay } from "./native-appointments.fixture";
import { patchNativeAppointment, type AppointmentRequest, type NativeAppointment } from "./native-appointment-client";
import { appointmentEdit } from "./native-appointment-editor";
import { appointmentEditToReview, createNativeAppointmentQueue, projectNativeAppointment } from "./native-appointment-queue";
import { projectNativeAppointmentRange } from "./native-appointments";
import { TodoBrowserError } from "./todo-live";

function fixture(read = mock(async () => appointment)) {
  const replies: ReturnType<typeof Promise.withResolvers<NativeAppointment>>[] = [];
  const patch = mock((_id: string, _key: string, _request: AppointmentRequest) => {
    const reply = Promise.withResolvers<NativeAppointment>();
    replies.push(reply);
    return reply.promise;
  });
  let nextKey = 0;
  const queue = createNativeAppointmentQueue({ patch, read, newKey: () => `key-${++nextKey}` });
  const change = () => queue.getSnapshot().entries.get(appointment.id)!;
  const projected = () => projectNativeAppointment(appointment, change());
  const rows = (stamp = 0) => projectNativeAppointmentRange([appointment], queue.getSnapshot().entries, stamp, { from: fixtureDay, to: fixtureDay });
  return { queue, patch, replies, change, projected, rows, read };
}

test("serializes native revisions and keeps later intent visible through an older acknowledgement", async () => {
  const { queue, patch, replies, rows, projected } = fixture();
  const times = { start: "2026-11-16T14:00:00Z", end: "2026-11-16T15:00:00Z" };
  expect(queue.enqueue(appointment, { action: "update", fields: times })).toBe(true);
  expect(queue.enqueue(projected()!, { action: "update", fields: { beforeMinutes: 25, alertMinutes: null } })).toBe(true);
  expect(patch.mock.calls).toEqual([[appointment.id, "key-1", { action: "update", ...times, expectedRevision: 1 }]]);
  expect(rows()[0]).toMatchObject({ ...times, beforeMinutes: 25, alertMinutes: null, revision: 1 });
  replies[0].resolve({ ...appointment, ...times, revision: 2 });
  await replies[0].promise;
  expect(rows()[0]).toMatchObject({ ...times, beforeMinutes: 25, alertMinutes: null, revision: 2 });
  expect(patch.mock.calls[1]).toEqual([appointment.id, "key-2", { action: "update", beforeMinutes: 25, alertMinutes: null, expectedRevision: 2 }]);
  replies[1].resolve({ ...appointment, ...times, beforeMinutes: 25, alertMinutes: null, revision: 3 });
  await replies[1].promise;
  expect(rows()[0]).toMatchObject({ ...times, beforeMinutes: 25, alertMinutes: null, revision: 3 });
});

test("preserves the frozen command on uncertain delivery and waits before sending later intent", async () => {
  const { queue, patch, replies, change, projected } = fixture();
  queue.enqueue(appointment, { action: "update", fields: { afterMinutes: 40 } });
  replies[0].reject(new TypeError("response lost after commit"));
  await replies[0].promise.catch(() => {});
  expect(change().status).toBe("retry");
  queue.enqueue(projected()!, { action: "update", fields: { alertMinutes: 25 } });
  expect(projected()).toMatchObject({ afterMinutes: 40, alertMinutes: 25 });
  expect(patch).toHaveBeenCalledTimes(1);
  queue.retry(appointment.id);
  expect(patch.mock.calls[1]).toEqual(patch.mock.calls[0]);
  expect(patch.mock.calls[1][2]).toBe(patch.mock.calls[0][2]);
  replies[1].resolve({ ...appointment, revision: 2, afterMinutes: 40 });
  await replies[1].promise;
  expect(patch.mock.calls[2]).toEqual([appointment.id, "key-2", { action: "update", alertMinutes: 25, expectedRevision: 2 }]);
  replies[2].resolve({ ...appointment, revision: 3, afterMinutes: 40, alertMinutes: 25 });
  await replies[2].promise;
  expect(change().status).toBe("settled");
});

test("undo and redo stay optimistic while previous revisions are pending", async () => {
  const { queue, patch, replies, projected } = fixture();
  queue.enqueue(appointment, { action: "update", fields: { alertMinutes: null } });
  queue.enqueue(projected()!, { action: "update", fields: { beforeMinutes: 30 } });
  expect(queue.replay(projected()!, "undo")).toBe(true);
  expect(projected()).toMatchObject({ alertMinutes: null, beforeMinutes: 15 });
  expect(queue.replay(projected()!, "undo")).toBe(true);
  expect(projected()).toMatchObject({ alertMinutes: 10, beforeMinutes: 15 });
  expect(queue.replay(projected()!, "redo")).toBe(true);
  expect(projected()).toMatchObject({ alertMinutes: null, beforeMinutes: 15 });
  expect(patch).toHaveBeenCalledTimes(1);
  let confirmed = appointment;
  for (const [index, fields] of [
    { alertMinutes: null }, { beforeMinutes: 30 }, { beforeMinutes: 15 }, { alertMinutes: 10 }, { alertMinutes: null },
  ].entries()) {
    const expectedRevision = index + 1;
    expect(patch.mock.calls[index][2]).toEqual({ ...fields, action: "update", expectedRevision });
    confirmed = { ...confirmed, ...fields, revision: expectedRevision + 1 };
    replies[index].resolve(confirmed);
    await replies[index].promise;
    expect(projected()).toMatchObject({ alertMinutes: null, beforeMinutes: 15 });
  }
  expect(queue.replay(projected()!, "redo")).toBe(true);
  expect(projected()?.beforeMinutes).toBe(30);
});

test("rolls back on conflict and retains both drafts for explicit review against the current revision", async () => {
  const latest = Promise.withResolvers<NativeAppointment>();
  const { queue, patch, replies, change, projected, read } = fixture(mock(() => latest.promise));
  queue.enqueue(appointment, { action: "update", fields: { beforeMinutes: 45 } });
  queue.enqueue(projected()!, { action: "update", fields: { afterMinutes: 20 } });
  replies[0].reject(new TodoBrowserError("Appointment changed.", 409, 0));
  await replies[0].promise.catch(() => {});
  expect(change().status).toBe("checking");
  expect(projected()).toEqual(appointment);
  expect(appointmentEditToReview(change())).toEqual({ beforeMinutes: 45, afterMinutes: 20 });
  expect(queue.enqueue(appointment, { action: "update", fields: { beforeMinutes: 45 } })).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  latest.resolve({ ...appointment, revision: 7, alertMinutes: 55 });
  await latest.promise;
  expect(change().status).toBe("review");
  expect(queue.replay(projected()!, "undo")).toBe(false);
  expect(projected()).toMatchObject({ beforeMinutes: appointment.beforeMinutes, afterMinutes: appointment.afterMinutes, alertMinutes: 55 });
  expect(patch).toHaveBeenCalledTimes(1);
  queue.enqueue(projected()!, { action: "update", fields: appointmentEditToReview(change())! });
  expect(patch.mock.calls[1]).toEqual([appointment.id, "key-3", { action: "update", beforeMinutes: 45, afterMinutes: 20, expectedRevision: 7 }]);
  replies[1].resolve({ ...appointment, revision: 8, beforeMinutes: 45, afterMinutes: 20, alertMinutes: 55 });
  await replies[1].promise;
  expect(projected()).toMatchObject({ revision: 8, alertMinutes: 55, beforeMinutes: 45, afterMinutes: 20 });
});

test("a queued cancellation waits for acknowledgement and removes the stale range row", async () => {
  const { queue, patch, replies, rows, projected } = fixture();
  queue.enqueue(appointment, { action: "update", fields: { beforeMinutes: 25 } });
  queue.enqueue(projected()!, { action: "cancel" });
  expect(rows()).toHaveLength(1);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(queue.enqueue(projected()!, { action: "update", fields: { alertMinutes: 60 } })).toBe(false);
  replies[0].resolve({ ...appointment, revision: 2, beforeMinutes: 25 });
  await replies[0].promise;
  expect(patch.mock.calls[1]).toEqual([appointment.id, "key-2", { action: "cancel", expectedRevision: 2 }]);
  expect(rows()).toHaveLength(1);
  replies[1].resolve({ ...appointment, revision: 3, beforeMinutes: 25, cancelledAt: appointment.start });
  await replies[1].promise;
  expect(rows()).toEqual([]);
  expect(projected()?.cancelledAt).toBe(appointment.start);
});

test("moving across days updates both ranges during pending and after a write without reviving an absent row", async () => {
  const { queue, replies, rows } = fixture();
  const day = "2026-11-17";
  const times = { start: `${day}T13:30:00.000Z`, end: `${day}T14:30:00.000Z` };
  const nextDay = (stamp: number) => projectNativeAppointmentRange([], queue.getSnapshot().entries, stamp, { from: day, to: day });
  queue.enqueue(appointment, { action: "update", fields: times });
  expect(rows()).toEqual([]);
  expect(nextDay(0)[0]).toMatchObject(times);
  replies[0].resolve({ ...appointment, ...times, revision: 2 });
  await replies[0].promise;
  expect(nextDay(0)[0].revision).toBe(2);
  expect(nextDay(queue.getSnapshot().stamp)).toEqual([]);
});

test("sends the UUID PATCH with an independent key and verifies the acknowledgement", async () => {
  const request = mock(async (_path: string | URL | Request, _init?: RequestInit) => Response.json({ ...appointment, revision: 2, alertMinutes: null }));
  const saved = globalThis.fetch;
  globalThis.fetch = Object.assign(request, saved);
  try {
    const command = { action: "update" as const, expectedRevision: 1, alertMinutes: null };
    expect(await patchNativeAppointment(appointment.id, "write-once", command)).toMatchObject({ revision: 2, alertMinutes: null });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe(`/api/v1/jobs/interview-appointments/${appointment.id}`);
    expect(options).toMatchObject({ method: "PATCH", credentials: "same-origin", headers: { "Idempotency-Key": "write-once" } });
    expect(JSON.parse(options!.body as string)).toEqual(command);
    await expect(patchNativeAppointment(appointment.id, "cancel-key", { action: "cancel", expectedRevision: 1 })).rejects.toThrow("could not be verified");
  } finally {
    globalThis.fetch = saved;
  }
});

test("validates Halifax timing pairs, buffers and alerts independently", () => {
  expect(appointmentEdit(appointment, { start: "2026-11-16T10:00", beforeMinutes: "0", alertMinutes: "" }))
    .toEqual({ start: "2026-11-16T14:00:00.000Z", end: appointment.end, beforeMinutes: 0, alertMinutes: null });
  expect(appointmentEdit(appointment, { afterMinutes: "1440" })).toEqual({ afterMinutes: 1440 });
  expect(() => appointmentEdit(appointment, { end: "2026-11-16T08:00" })).toThrow("after");
  expect(() => appointmentEdit(appointment, { beforeMinutes: "1441" })).toThrow("1440");
  expect(() => appointmentEdit(appointment, { alertMinutes: "0" })).toThrow("10080");
  expect(() => appointmentEdit(appointment, { start: "2026-11-01T01:30" })).toThrow("Clock change");
  expect(appointmentEdit(appointment, { start: "2026-11-01T01:30:00.000-03:00" }).start).toBe("2026-11-01T04:30:00.000Z");
});
