import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { TodoViews } from "./todo-space";
import type { ViewActions } from "./view-model";

const dom = createTestDom();

test("the Owner Inbox shows Agent-created To-dos and reconciles an Undo that loses to a later edit", async () => {
  const fixture = { id: "fixture", title: "Call the plumber", note: "", completed: false, revision: 1, auditId: "audit" };
  const other = { ...fixture, id: "other", title: "Book a table", auditId: "other-audit" };
  const actions: ViewActions = {
    readOnly: false, toggleDone() {}, setCommitment() {}, togglePriority() {}, open() {}, add() {}, undo() {},
  };
  const fetchBefore = globalThis.fetch;
  const calls: string[] = [];
  let finishUndo!: (response: Response) => void;
  let finishOtherUndo!: (response: Response) => void;
  globalThis.fetch = (async (path: string) => {
    calls.push(path);
    if (path === "/api/v1/agent-inbox-todos?state=inbox") return Response.json({ todos: [fixture, other], nextCursor: null });
    if (path === "/api/v1/agent-audit/audit/undo") return new Promise<Response>(resolve => { finishUndo = resolve; });
    if (path === "/api/v1/agent-audit/other-audit/undo") return new Promise<Response>(resolve => { finishOtherUndo = resolve; });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const undoButtons = () => [...dom.container.querySelectorAll("button")].filter(button => button.textContent === "Undo creation");

  try {
    await dom.render(<TodoViews layout="list" todos={[]} today="2026-11-17" actions={actions} loading={false} agentInbox={{ canWrite: true }} />);
    expect(calls).toEqual([]);
    const inboxTab = [...dom.container.querySelectorAll("button")].find(button => button.textContent === "Inbox")!;
    await dom.click(inboxTab);
    const inbox = dom.container.querySelector('[role="group"][aria-label="Inbox"]')!;
    expect(inbox.textContent).toContain(fixture.title);
    expect(calls).toEqual(["/api/v1/agent-inbox-todos?state=inbox"]);

    await dom.click(undoButtons()[0]!);
    expect(inbox.textContent).not.toContain(fixture.title);
    expect(inbox.textContent).toContain(other.title);
    await dom.click(undoButtons()[0]!);
    expect(inbox.textContent).not.toContain(other.title);
    await act(async () => finishOtherUndo(Response.json({ audit: { id: other.auditId, undoneAt: "2026-11-17T12:00:00Z" } })));
    await act(async () => finishUndo(Response.json({ message: "The To-do changed after creation." }, { status: 409 })));
    expect(inbox.textContent).toContain(fixture.title);
    expect(inbox.textContent).not.toContain(other.title);
    expect(inbox.querySelector('[role="alert"]')?.textContent).toContain("The To-do changed");
    expect(calls).toHaveLength(3);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});
