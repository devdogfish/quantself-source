import { expect, test } from "bun:test";
import { editDeadlineBody, readTodoDeadline } from "./todos-deadline";

test("deadline metadata preserves evidence, independent extensions, and Halifax date", () => {
  const evidence = 'Notes\n\n<!-- quantself:schedule {"preserved":true} -->';
  const body = editDeadlineBody(evidence, "2026-11-01", "2026-11-02T03:30:00Z");
  expect(body).toContain(evidence);
  expect(readTodoDeadline(body, "2026-11-01")).toEqual({ deadlineAt: "2026-11-02T03:30:00Z", deadlineError: null });
  expect(readTodoDeadline(body, "2026-11-02").deadlineError).toContain("changed outside");
  expect(editDeadlineBody(body, null, null)).toBe(evidence);
  expect(() => editDeadlineBody(evidence, "2026-11-02", "2026-11-02T03:30:00Z")).toThrow("Due date");
});
test("malformed or duplicated deadline extensions are surfaced without destructive rewrites", () => {
  for (const body of ['<!-- quantself:deadline invalid -->', '<!-- quantself:deadline', '<!-- quantself:deadline {} --><!-- quantself:deadline {} -->']) {
    expect(readTodoDeadline(body, "2026-11-02").deadlineError).not.toBeNull();
    expect(() => editDeadlineBody(body, null, null)).toThrow();
  }
});
