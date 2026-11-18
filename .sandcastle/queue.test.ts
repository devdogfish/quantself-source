import { describe, expect, test } from "bun:test";
import { selectReady, type QueueIssue } from "./queue.mjs";

const issue = (number: number, body = "## Blocked by\n\n- #157\n- #158\n\n## Notes\n") =>
  ({ number, body, title: "Migration", state: "OPEN",
    labels: [{ name: "Sandcastle" }, { name: "ready-afk" }] }) satisfies QueueIssue;
const states = new Map([[157, "CLOSED"], [158, "CLOSED"], [159, "CLOSED"], [166, "OPEN"]]);

describe("queue", () => {
  test("requires both labels and all declared blockers closed for any issue number", () => {
    const missingLabel = { ...issue(161, "## Blocked by\n- #159"), labels: [{ name: "Sandcastle" }] };
    expect(selectReady([issue(160), missingLabel, issue(167, "## Blocked by\n- #166"),
      issue(177), issue(162, "## Blocked by\n- #157"), issue(163, "## Blocked by\n- #157\n- #158\n- #999")], states))
      .toEqual([issue(160), issue(177), issue(162, "## Blocked by\n- #157")]);
  });
  test("accepts an explicit empty blocker section and rejects absent or unknown blockers", () => {
    const unblocked = issue(235, "## Blocked by\n\nNone\n\n## Parent\n#171");
    expect(selectReady([unblocked, issue(236, "## Parent\n#171"),
      issue(237, "## Blocked by\n- #999")], states)).toEqual([unblocked]);
  });
  test("unlocks the specialist only after its collection dependency closes", () => {
    const specialist = issue(167, "## Blocked by\n- #166");
    expect(selectReady([specialist], new Map([...states, [166, "CLOSED"]]))).toEqual([specialist]);
  });
});
