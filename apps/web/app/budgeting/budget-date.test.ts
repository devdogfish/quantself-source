import { expect, test } from "bun:test";
import { budgetToday } from "./budget-date";

test("budget day is an ISO key at the Halifax midnight boundary", () => {
  expect(budgetToday(new Date("2026-11-14T03:59:59Z"))).toBe("2026-11-13");
  expect(budgetToday(new Date("2026-11-14T04:00:00Z"))).toBe("2026-11-14");
  expect(budgetToday(new Date("2026-07-14T03:00:00Z"))).toBe("2026-07-14");
});
