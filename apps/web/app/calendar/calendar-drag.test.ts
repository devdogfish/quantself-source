import { expect, test } from "bun:test";
import { snapCalendarStart } from "./calendar-drag";
const normal = { shiftKey: false, metaKey: false };
test("grid steps and precision precedence", () => {
  expect(snapCalendarStart(560, 30, [], normal)).toBe(555);
  expect(snapCalendarStart(560, 30, [], { ...normal, metaKey: true })).toBe(560);
  expect(snapCalendarStart(562.2, 30, [], { shiftKey: true, metaKey: true })).toBe(562);
});
test("either edge touches off-grid neighbors without changing duration", () => {
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 563 }], normal)).toBe(563);
  expect(snapCalendarStart(560, 30, [{ start: 589, end: 610 }], normal)).toBe(559);
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 562 }], { ...normal, metaKey: true })).toBe(562);
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 563 }], { ...normal, metaKey: true })).toBe(560);
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 563 }], { ...normal, shiftKey: true })).toBe(560);
});
test("reject crowded magnets, choose nearest valid boundary, and break ties consistently", () => {
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 563 }, { start: 590, end: 620 }], normal)).toBe(555);
  expect(snapCalendarStart(560, 30, [{ start: 530, end: 558 }, { start: 592, end: 620 }], normal)).toBe(558);
  expect(snapCalendarStart(561, 30, [{ start: 530, end: 558 }, { start: 592, end: 620 }], normal)).toBe(562);
});
test("clamp to day bounds, including durations not divisible by the grid", () => {
  expect(snapCalendarStart(-20, 30, [], normal)).toBe(0);
  expect(snapCalendarStart(1440, 37, [], normal)).toBe(1403);
  expect(snapCalendarStart(2, 30, [{ start: 20, end: 40 }], normal)).toBe(0);
});

test("resize anchors the opposite edge, snaps to neighbors, and respects precision", async () => {
  const { snapCalendarEdge } = await import("./calendar-drag");
  expect(snapCalendarEdge(560, "start", 600, [], normal)).toBe(555);
  expect(snapCalendarEdge(560, "end", 540, [], normal)).toBe(555);
  expect(snapCalendarEdge(560, "start", 600, [{ start: 520, end: 562 }], normal)).toBe(562);
  expect(snapCalendarEdge(560, "end", 540, [{ start: 562, end: 600 }], normal)).toBe(562);
  expect(snapCalendarEdge(560, "end", 540, [{ start: 562, end: 600 }, { start: 550, end: 558 }], normal)).toBe(555);
  expect(snapCalendarEdge(560, "end", 540, [{ start: 562, end: 600 }], { ...normal, metaKey: true })).toBe(562);
  expect(snapCalendarEdge(560, "end", 540, [{ start: 562, end: 600 }], { ...normal, shiftKey: true })).toBe(560);
  expect(snapCalendarEdge(800, "start", 600, [], normal)).toBe(795);
  expect(snapCalendarEdge(400, "end", 540, [], normal)).toBe(405);
  expect(snapCalendarEdge(-40, "start", 600, [], normal)).toBe(0);
  expect(snapCalendarEdge(1500, "end", 540, [], normal)).toBe(1440);
});

test("crossed handles snap on their new side and can cross back", async () => {
  const { snapCalendarEdge } = await import("./calendar-drag");
  expect(snapCalendarEdge(620, "start", 600, [{ start: 622, end: 650 }], normal)).toBe(622);
  expect(snapCalendarEdge(520, "end", 540, [{ start: 490, end: 518 }], normal)).toBe(518);
  expect(snapCalendarEdge(580, "start", 600, [], normal)).toBe(585);
  expect(snapCalendarEdge(560, "end", 540, [], normal)).toBe(555);
  expect(snapCalendarEdge(600, "start", 600, [], normal)).toBe(599);
  expect(snapCalendarEdge(540, "end", 540, [], normal)).toBe(541);
  expect(snapCalendarEdge(1440, "start", 1440, [], normal)).toBe(1439);
  expect(snapCalendarEdge(0, "end", 0, [], normal)).toBe(1);
});

test("resize spans wall-calendar days with destination magnets and valid chronological bounds", async () => {
  const { snapCalendarEdge } = await import("./calendar-drag");
  const limits = { min: -1440, max: 2880 };
  expect(snapCalendarEdge(2000, "end", 540, [], normal, limits)).toBe(1995);
  expect(snapCalendarEdge(-880, "start", 600, [], normal, limits)).toBe(-885);
  expect(snapCalendarEdge(2000, "end", 540, [{ start: 2002, end: 2050 }], normal, limits)).toBe(2002);
  expect(snapCalendarEdge(2000, "end", 540, [{ start: 2002, end: 2050 }, { start: 1900, end: 1950 }], normal, limits)).toBe(1995);
  expect(snapCalendarEdge(600, "start", 600, [], normal, limits)).toBe(599);
});
