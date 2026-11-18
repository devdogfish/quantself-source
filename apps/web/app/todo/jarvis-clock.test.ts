import { expect, test } from "bun:test";
import { jarvisContextMessage } from "./jarvis-ui";

const screen = { page: "/todo", calendarView: "day" as const, date: "2026-10-27", selectedTask: null, panel: null };
const contextAt = (instant: string) => JSON.parse(jarvisContextMessage(screen, new Date(instant)).split("): ")[1]);

test("Jarvis distinguishes Halifax today from UTC tomorrow and the viewed calendar date", () => {
  const context = contextAt("2026-10-27T01:55:00Z");
  expect(context.date).toBe("2026-10-27");
  expect(context.clock).toEqual({ timeZone: "America/Halifax", today: "2026-10-26", localTime: "22:55", utcOffset: "-03:00" });
});

test("Jarvis today changes at Halifax midnight, including winter offset", () => {
  expect(contextAt("2026-10-27T02:59:59Z").clock.today).toBe("2026-10-26");
  expect(contextAt("2026-10-27T03:00:00Z").clock).toMatchObject({ today: "2026-10-27", localTime: "00:00" });
  expect(contextAt("2026-12-27T03:55:00Z").clock).toEqual({ timeZone: "America/Halifax", today: "2026-12-26", localTime: "23:55", utcOffset: "-04:00" });
});
