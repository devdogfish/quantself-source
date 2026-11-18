import { expect, test } from "bun:test";
import type { LiveTodo } from "../todo-live";
import { bucketOf, dueOf, latestAgentNote, toViewTask, viewStatus } from "./view-model";

const todo: LiveTodo = {
  id: "I_view", databaseId: 1, repository: "example/tasks", number: 7, title: "Renew passport", body: null,
  state: "open", closureReason: null, url: "https://github.com/example/tasks/issues/7", updatedAt: "2026-11-13T12:00:00Z",
  labels: [], fields: {}, fieldValues: [], scheduleError: null, start: null, end: null, allDay: false, fixed: false,
};
const today = "2026-11-13";

test("commitment and closure map to view states", () => {
  expect(viewStatus(todo)).toBe("inbox");
  expect(viewStatus({ ...todo, fields: { Commitment: "Active" } })).toBe("todo");
  expect(viewStatus({ ...todo, fields: { Commitment: "Someday" } })).toBe("someday");
  expect(viewStatus({ ...todo, state: "closed", closureReason: "completed" })).toBe("done");
  expect(viewStatus({ ...todo, state: "closed", closureReason: "not_planned" })).toBe("closed");
});

test("only the stored delegate and state move a task into Agent work", () => {
  const active = { ...todo, fields: { Commitment: "Active" as const } };
  expect(viewStatus({ ...active, labels: ["ready-for-agent", "agent:queued", "ready-for-human"] })).toBe("todo");
  const working = { ...active, delegation: { delegate: { id: "sam", name: "Sam" }, state: "working" as const, revision: 1 } };
  expect(viewStatus(working)).toBe("running");
  expect(bucketOf(toViewTask(working, today))).toBe("agents");
  expect(viewStatus({ ...working, delegation: { delegate: null, state: null, revision: 2 } })).toBe("todo");
});

test("buckets answer what needs doing", () => {
  const b = (labels: string[], fields: LiveTodo["fields"] = {}) => bucketOf(toViewTask({ ...todo, labels, fields }, today));
  expect(b(["ready-for-human"])).toBe("inbox");
  expect(b([], { Commitment: "Active" })).toBe("yours");
  expect(b([])).toBe("inbox");
  expect(bucketOf(toViewTask({ ...todo, state: "closed", closureReason: "duplicate" }, today))).toBeNull();
});

test("due labels use the Halifax calendar date", () => {
  expect(dueOf({ ...todo, fields: { Due: "2026-11-13" } }, today)).toEqual({ date: "2026-11-13", label: "Today" });
  expect(dueOf({ ...todo, fields: { Due: "2026-11-14" } }, today).label).toBe("Tomorrow");
  expect(dueOf({ ...todo, deadlineAt: "2026-11-14T02:00:00Z" }, today).date).toBe("2026-11-13");
  const view = toViewTask({ ...todo, fields: { Due: "2026-11-10", Commitment: "Active" } }, today);
  expect(view.overdue).toBe(true);
  expect(view.dueToday).toBe(false);
});

test("agent note is the latest update as plain text, skipping source evidence", () => {
  const comments = [
    { id: 1, body: "**Agent Brief**\n\nGoal: x", url: "u", updatedAt: "a" },
    { id: 2, body: "Opened [PR #12](https://github.com/x/y/pull/12) for review", url: "u", updatedAt: "b" },
    { id: 3, body: "<!-- quantself:source v1 -->\ntranscript", url: "u", updatedAt: "c" },
  ];
  expect(latestAgentNote({ ...todo, comments })).toBe("Opened PR #12 for review");
  expect(toViewTask({ ...todo, comments }, today).agentNote).toBeUndefined();
});
