import { expect, mock, test } from "bun:test";
import { appointmentsByDate, appointmentId, readNativeAppointment, readNativeAppointments } from "./native-appointments";
import { fixtureAppointment, fixtureDay, fixtureLegacyAppointment } from "./native-appointments.fixture";
import { calendarEventLanes } from "../calendar/calendar-event-layout";
import { jobInterviewHref } from "../jobs/jobs-client";
import { todosForDate } from "./todo-projection";

test("opens native UUID and legacy issue links through separate routes", () => {
  expect(jobInterviewHref(fixtureAppointment)).toBe(`/todo?appointment=${fixtureAppointment.id}`);
  for (const source of ["github", undefined] as const) {
    expect(jobInterviewHref({ id: fixtureAppointment.id, source, todoNumber: 42, start: fixtureAppointment.start, end: fixtureAppointment.end }))
      .toBe("/todo?task=42");
  }
  expect(appointmentId("42")).toBeNull();
  expect(appointmentId(fixtureAppointment.id.toUpperCase())).toBe(fixtureAppointment.id);
});

test("places overlapping native and GitHub appointments in shared lanes, including prep", () => {
  const native = appointmentsByDate([fixtureAppointment], fixtureDay, fixtureDay).get(fixtureDay)![0];
  const [legacy] = todosForDate([fixtureLegacyAppointment], fixtureDay);
  expect(native).toMatchObject({ start: "09:30", minutes: 60, beforeMinutes: 15, afterMinutes: 10 });
  expect(legacy).toMatchObject({ start: "09:45", minutes: 30 });
  expect(calendarEventLanes([
    { id: native.appointment.id, timing: native }, { id: legacy.id, timing: legacy },
  ], 1).map(({ id, lane, lanes, start, end }) => ({ id, lane, lanes, start, end }))).toEqual([
    { id: native.appointment.id, lane: 0, lanes: 2, start: 555, end: 640 },
    { id: legacy.id, lane: 1, lanes: 2, start: 585, end: 615 },
  ]);
});

test("uses the same midnight, prep and Halifax clock-change projection", () => {
  const crossing = { ...fixtureAppointment, start: "2026-11-17T04:10:00Z", end: "2026-11-17T04:30:00Z" };
  const days = appointmentsByDate([crossing], fixtureDay, "2026-11-17");
  expect(days.get(fixtureDay)?.[0]).toMatchObject({ prepOnly: "before", start: "23:55", minutes: 5 });
  expect(days.get("2026-11-17")?.[0]).toMatchObject({ start: "00:10", beforeMinutes: 10, minutes: 20 });
  const fold = { ...fixtureAppointment, start: "2026-11-01T04:45:00Z", end: "2026-11-01T06:15:00Z" };
  expect(appointmentsByDate([fold], "2026-11-01", "2026-11-01").get("2026-11-01")?.[0]).toMatchObject({
    start: "01:45", minutes: 90, unplaced: true,
  });
  expect(appointmentsByDate([{ ...fixtureAppointment, cancelledAt: fixtureAppointment.start }], fixtureDay, fixtureDay).size).toBe(0);
});

test("uses one range read plus each cursor and a separate native UUID lookup", async () => {
  const second = { ...fixtureAppointment, id: "9316423a-44aa-4e98-a170-0bdfb9db9100" };
  const cursor = { afterStart: fixtureAppointment.start, afterId: fixtureAppointment.id };
  const paths: URL[] = [];
  const request = mock(async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    paths.push(url);
    expect(options).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    if (url.pathname.endsWith(fixtureAppointment.id)) return Response.json(fixtureAppointment);
    return Response.json(url.searchParams.has("afterId")
      ? { appointments: [second], nextCursor: null } : { appointments: [fixtureAppointment], nextCursor: cursor });
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(request, realFetch);
  try {
    const signal = new AbortController().signal;
    expect(await readNativeAppointments({ from: "2026-10-31", to: "2026-11-01" }, signal)).toEqual([fixtureAppointment, second]);
    expect(Object.fromEntries(paths[0].searchParams)).toEqual({ from: "2026-10-31T03:00:00.000Z", to: "2026-11-02T04:00:00.000Z" });
    expect(Object.fromEntries(paths[1].searchParams)).toMatchObject(cursor);
    expect(await readNativeAppointment(fixtureAppointment.id, signal)).toEqual(fixtureAppointment);
    expect(paths.map(url => url.pathname)).toEqual([
      "/api/v1/jobs/interview-appointments", "/api/v1/jobs/interview-appointments", `/api/v1/jobs/interview-appointments/${fixtureAppointment.id}`,
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
