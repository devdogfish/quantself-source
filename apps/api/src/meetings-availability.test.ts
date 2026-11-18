import { describe, expect, test } from "bun:test";
import { defaultMeetingSettings, habitBusyIntervals, openSlots, slotIso, taskBusyIntervals, weeklyHoursSchema, type MeetingSettingsValue } from "./meetings-availability";
import { parseHabits } from "./habits-definition";
import type { Todo } from "./todos-github";

// Monday 2026-11-16 08:00 in Halifax (AST, UTC-4).
const now = Date.parse("2026-11-16T12:00:00Z");
const settings: MeetingSettingsValue = { ...defaultMeetingSettings, weeklyHours: { tue: [["09:00", "11:00"]] }, noticeMinutes: 720, horizonDays: 14 };
const iso = (slots: number[]) => slots.map(slotIso);
const at = (value: string) => Date.parse(value);

describe("open slots", () => {
  test("are 30-minute starts on :00/:30 inside weekly hours in the Owner's time zone", () => {
    const slots = openSlots({ settings, now, busy: [], to: at("2026-11-18T00:00:00Z") });
    expect(iso(slots)).toEqual(["2026-11-17T13:00:00Z", "2026-11-17T13:30:00Z", "2026-11-17T14:00:00Z", "2026-11-17T14:30:00Z"]);
  });

  test("the last slot must end by closing time and split ranges stay separate", () => {
    const split = { ...settings, weeklyHours: { tue: [["09:00", "09:30"], ["13:00", "14:00"]] as [string, string][] } };
    expect(iso(openSlots({ settings: split, now, busy: [], to: at("2026-11-18T00:00:00Z") }))).toEqual([
      "2026-11-17T13:00:00Z", "2026-11-17T17:00:00Z", "2026-11-17T17:30:00Z",
    ]);
  });

  test("respect minimum notice and the booking horizon", () => {
    const daily = { ...settings, weeklyHours: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map(day => [day, [["09:00", "10:00"]]])) };
    const slots = iso(openSlots({ settings: { ...daily, noticeMinutes: 25 * 60, horizonDays: 3 }, now, busy: [] }));
    // Notice ends Tuesday 09:00 local exactly; the horizon ends Thursday 08:00 local.
    expect(slots).toEqual(["2026-11-17T13:00:00Z", "2026-11-17T13:30:00Z", "2026-11-18T13:00:00Z", "2026-11-18T13:30:00Z"]);
    expect(openSlots({ settings: daily, now, busy: [], from: now, to: now + 3_600_000 })).toEqual([]);
  });

  test("clip to the requested range", () => {
    const slots = openSlots({ settings, now, busy: [], from: at("2026-11-17T13:30:00Z"), to: at("2026-11-17T14:30:00Z") });
    expect(iso(slots)).toEqual(["2026-11-17T13:30:00Z", "2026-11-17T14:00:00Z"]);
  });

  test("exclude any slot that overlaps a busy interval, even partly", () => {
    const busy = [{ start: at("2026-11-17T13:15:00Z"), end: at("2026-11-17T13:45:00Z") }];
    expect(iso(openSlots({ settings, now, busy, to: at("2026-11-18T00:00:00Z") }))).toEqual([
      "2026-11-17T14:00:00Z", "2026-11-17T14:30:00Z",
    ]);
    const touching = [{ start: at("2026-11-17T12:00:00Z"), end: at("2026-11-17T13:00:00Z") }];
    expect(openSlots({ settings, now, busy: touching, to: at("2026-11-18T00:00:00Z") })).toHaveLength(4);
  });

  test("handle the spring-forward gap without inventing or losing real time", () => {
    const sunday = { ...settings, weeklyHours: { sun: [["00:00", "04:00"]] as [string, string][] }, noticeMinutes: 0 };
    const slots = openSlots({ settings: sunday, now: at("2026-03-07T12:00:00Z"), busy: [], to: at("2026-03-09T00:00:00Z") });
    // 02:00-03:00 does not exist on 2026-03-08 in Halifax: three real hours, six slots.
    expect(iso(slots)).toEqual([
      "2026-03-08T04:00:00Z", "2026-03-08T04:30:00Z", "2026-03-08T05:00:00Z",
      "2026-03-08T05:30:00Z", "2026-03-08T06:00:00Z", "2026-03-08T06:30:00Z",
    ]);
  });

  test("walk every calendar day across the fall-back change", () => {
    const daily = { ...settings, weeklyHours: { sat: [["09:00", "09:30"]], sun: [["09:00", "09:30"]], mon: [["09:00", "09:30"]] } as MeetingSettingsValue["weeklyHours"], noticeMinutes: 0 };
    const slots = openSlots({ settings: daily, now: at("2026-10-31T00:00:00Z"), busy: [], to: at("2026-11-03T00:00:00Z") });
    expect(iso(slots)).toEqual(["2026-10-31T12:00:00Z", "2026-11-01T13:00:00Z", "2026-11-02T13:00:00Z"]);
  });

  test("weekly hours only allow :00/:30 boundaries", () => {
    expect(weeklyHoursSchema.safeParse({ mon: [["09:15", "10:00"]] }).success).toBe(false);
    expect(weeklyHoursSchema.safeParse({ mon: [["10:00", "09:00"]] }).success).toBe(false);
    expect(weeklyHoursSchema.safeParse({ mon: [["22:00", "24:00"]] }).success).toBe(true);
  });
});

describe("task busy intervals", () => {
  const todo = (fields: Partial<Todo>) => ({ state: "open", allDay: false, start: null, end: null, ...fields }) as Todo;

  test("block timed and all-day events, preserve longer buffers and ignore cancelled or unscheduled tasks", () => {
    expect(taskBusyIntervals([
      todo({ start: "2026-11-17T14:00:00Z", end: "2026-11-17T14:30:00Z", beforeMinutes: 5, afterMinutes: 30 }),
      todo({ state: "closed", start: "2026-11-17T13:00:00Z", end: "2026-11-17T13:30:00Z" }),
      todo({ allDay: true, start: "2026-11-17T00:00:00Z", end: "2026-11-18T00:00:00Z" }),
      todo({}),
    ])).toEqual([
      { start: at("2026-11-17T13:45:00Z"), end: at("2026-11-17T15:00:00Z") },
      { start: at("2026-11-16T23:45:00Z"), end: at("2026-11-18T00:15:00Z") },
    ]);
  });
});

test("a timed habit near midnight blocks bookings on the following date", () => {
  const projection = parseHabits(JSON.stringify({
    stacks: [{ id: "night", name: "Night", anchor: "23:50", durationMinutes: 30, days: "daily" }],
    habits: [{ id: "read", name: "Read", stack: "night", status: "building" }],
  }));
  const range = { start: at("2026-11-17T04:00:00Z"), end: at("2026-11-17T04:30:00Z") };
  expect(habitBusyIntervals(projection, range)).toEqual([
    { start: at("2026-11-17T03:35:00Z"), end: at("2026-11-17T04:15:00Z") },
  ]);
});

test("a habit ending in the repeated Halifax hour blocks both occurrences", () => {
  const projection = parseHabits(JSON.stringify({
    stacks: [{ id: "night", name: "Night", anchor: "01:00", durationMinutes: 30 }],
    habits: [{ id: "read", name: "Read", stack: "night", status: "building" }],
  }));
  const range = { start: at("2026-11-01T03:00:00Z"), end: at("2026-11-01T07:00:00Z") };
  expect(habitBusyIntervals(projection, range)).toEqual([
    { start: at("2026-11-01T03:45:00Z"), end: at("2026-11-01T05:45:00Z") },
  ]);
});
