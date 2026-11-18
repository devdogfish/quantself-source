import { createTestDom } from "@/components/shared/test-dom";
import { expect, mock, test } from "bun:test";
import { act, useState, useSyncExternalStore } from "react";
import { TodoBrowserError, type LiveTodo } from "../todo-live";
import { createTodoDelegateQueue, projectTodoDelegate, type Delegate } from "../todo-delegate-queue";
import { createTodoHistory } from "../todo-history";
import { createTodoDecisionQueue, projectTodoDecision } from "../todo-decision-queue";
import { ReturnHandBackDialog } from "../todo-handback";
import type { ViewActions, ViewTask } from "./view-model";

mock.module("next/link", () => ({ default: (props: React.ComponentProps<"a">) => <a {...props} /> }));
const dom = createTestDom();

const base: LiveTodo = {
  id: "I_1", databaseId: 1, repository: "x/tasks", number: 1, title: "Renew passport", body: null, state: "open", closureReason: null,
  url: "https://github.com/x/tasks/issues/1", updatedAt: "2026-11-13T12:00:00Z", labels: [], fields: { Commitment: "Active" }, fieldValues: [],
  scheduleError: null, start: null, end: null, allDay: false, fixed: false,
};
const todos: LiveTodo[] = [
  base,
  { ...base, id: "I_2", number: 2, title: "Port habit charts", delegation: { delegate: { id: "sam", name: "Sam" }, state: "working", revision: 1 } },
  { ...base, id: "I_3", number: 3, title: "Summarise sleep papers", labels: ["ready-for-human"], comments: [{ id: 2, body: "Draft ready with 9 sources", url: "u", updatedAt: "b" }] },
  { ...base, id: "I_4", number: 4, title: "Find a climbing gym", fields: { Commitment: "Inbox" }, updatedAt: "2026-11-13T13:00:00Z" },
  { ...base, id: "I_5", number: 5, title: "Old idea", fields: { Commitment: "Someday" } },
];

function spyActions() {
  const calls: string[] = [];
  const actions: ViewActions = {
    readOnly: false,
    toggleDone: (t: ViewTask) => calls.push(`done:${t.number}`),
    setCommitment: (t: ViewTask, to) => calls.push(`commit:${t.number}:${to}`),
    togglePriority: (t: ViewTask) => calls.push(`priority:${t.number}`),
    open: (t: ViewTask) => calls.push(`open:${t.number}`),
    add: () => calls.push("add"),
    undo: () => calls.push("undo"),
  };
  return { calls, actions };
}
const button = (name: string) => [...dom.container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim().startsWith(name));

test("List groups Agent work from the stored delegate", async () => {
  const { TodoViews } = await import("./todo-space");
  const { actions } = spyActions();
  await dom.render(<TodoViews layout="list" todos={todos} today="2026-11-13" actions={actions} loading={false} />);
  const groups = [...dom.container.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"));
  expect(groups).toEqual(["Todo"]);
  await dom.click(button("Delegated")!);
  expect(dom.container.textContent).toContain("Port habit charts");
  expect(dom.container.textContent).toContain("Sam");
  expect(dom.container.textContent).not.toContain("Renew passport");
});

test("Triage handles one item at a time with keys", async () => {
  const { TodoViews } = await import("./todo-space");
  const { calls, actions } = spyActions();
  await dom.render(<TodoViews layout="triage" todos={todos} today="2026-11-13" actions={actions} loading={false} />);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" })); });
  expect(dom.container.querySelector("h2")?.textContent).toBe("Find a climbing gym");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" })); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "h" })); });
  expect(calls).toEqual(["commit:4:Active", "commit:4:Someday"]);
});

test("Board columns show the working delegate by name", async () => {
  const { TodoViews } = await import("./todo-space");
  await dom.render(<TodoViews layout="board" todos={todos} today="2026-11-13" actions={spyActions().actions} loading={false} />);
  const column = (name: string) => dom.container.querySelector(`[role="group"][aria-label="${name}"]`)?.textContent ?? "";
  expect(column("Todo")).toContain("Renew passport");
  expect(column("With agents")).toContain("Sam");
  expect(column("Todo")).toContain("Summarise sleep papers");
  expect(dom.container.textContent).not.toContain("Old idea");
});

test("the Board and history stay optimistic through delayed responses, retry and conflict", async () => {
  const { TodoViews } = await import("./todo-space");
  const history = createTodoHistory();
  const sam = { id: "sam", name: "Sam" };
  const stacy = { id: "stacy", name: "Stacy" };
  type Command = { commandId: string; expectedRevision: number; delegateId: string | null };
  const calls: Command[] = [];
  const finishes: Array<{ resolve(result: { delegation: NonNullable<LiveTodo["delegation"]> }): void; reject(error: Error): void }> = [];
  const queue = createTodoDelegateQueue(id => history.discardLocal(id), async (_number, command) => {
    calls.push(command);
    return new Promise((resolve, reject) => finishes.push({ resolve, reject }));
  }, async () => ({ agents: [sam, stacy] }));
  const { actions } = spyActions();
  function Board() {
    const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    return <TodoViews layout="board" todos={[projectTodoDelegate(base, snapshot)]} today="2026-11-13" loading={false} actions={{
      ...actions, delegates: { available: true, directory: snapshot, load: () => void queue.loadAgents(), change(todo, after) {
        const before = todo.delegation?.delegate ?? null;
        if (queue.change(todo, before, after)) history.recordLocal({ key: todo.id, apply(direction) {
          if (direction === "undo") queue.change(todo, after, before);
          else queue.change(todo, before, after);
        } });
      } },
    }} />;
  }
  await dom.render(<Board />);
  const trigger = () => button("Delegate to… Renew passport")!;
  const pick = async (name: string) => {
    await dom.click(trigger());
    const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.trim() === name);
    expect(option).toBeDefined();
    await dom.click(option!);
  };
  const settle = (index: number, delegate: Delegate | null, revision: number) => act(async () => {
    finishes[index].resolve({ delegation: { delegate, revision, state: delegate ? "working" : null } });
  });
  await pick("Sam");
  expect(trigger().textContent).toContain("Sam");
  expect(calls).toHaveLength(1);
  await pick("Stacy");
  expect(trigger().textContent).toContain("Stacy");
  expect(calls).toHaveLength(1);
  await act(async () => { history.replayLocal("undo"); });
  expect(trigger().textContent).toContain("Sam");
  await act(async () => { history.replayLocal("redo"); });
  expect(trigger().textContent).toContain("Stacy");
  await settle(0, sam, 1);
  expect(trigger().textContent).toContain("Stacy");
  expect(calls[1]).toMatchObject({ expectedRevision: 1, delegateId: "stacy" });

  await act(async () => { finishes[1].reject(Error("Disconnected")); });
  expect(queue.getSnapshot().entries.get(base.id)?.retryable).toBe(true);
  expect(trigger().textContent).toContain("Stacy");
  await act(async () => { void queue.retry(base.id); });
  expect(calls[2]).toEqual(calls[1]);
  await act(async () => { finishes[2].reject(new TodoBrowserError("Delegation changed", 409, 0)); });
  expect(trigger().textContent).toContain("Sam");
  expect(history.getSnapshot().canUndo).toBe(false);
});

test("loading without tasks shows a status, not an empty page", async () => {
  const { TodoViews } = await import("./todo-space");
  await dom.render(<TodoViews layout="today" todos={[]} today="2026-11-13" actions={spyActions().actions} loading />);
  expect(dom.container.querySelector('[role="status"]')?.textContent).toBe("Loading tasks…");
});

test("Triage keyboard Return and Accept update the task before the server replies", async () => {
  const { TodoViews } = await import("./todo-space");
  const history = createTodoHistory();
  const sam = { id: "sam", name: "Sam" };
  const waiting = { delegate: sam, revision: 2, state: "waiting_on_owner" as const,
    handBack: { kind: "question" as const, question: "Which file should I use?", choices: ["Draft", "Final"] } };
  const first: LiveTodo = { ...base, delegation: waiting };
  const second: LiveTodo = { ...first, id: "I_other", number: 19, title: "Other hand-back", updatedAt: "2026-11-12T00:00:00Z" };
  type Receipt = { delegation: NonNullable<LiveTodo["delegation"]>; auditId?: string; sourceRevision?: string };
  const requests: Array<{ path: string; body?: object; resolve(receipt: Receipt): void; reject(error: Error): void }> = [];
  const queue = createTodoDecisionQueue(id => history.discardLocal(id), (path, body) => new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })));
  function Triage() {
    const [returning, setReturning] = useState<LiveTodo | null>(null);
    const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    const controls: NonNullable<ViewActions["decisions"]> = {
      available: true, busy: todo => !!snapshot.get(todo.id)?.pending,
      decide(todo, action) { const apply = queue.decide(todo, action); if (apply) history.recordLocal({ key: todo.id, apply }); },
      returnToAgent: setReturning, resume: () => {},
    };
    return <>
      <TodoViews layout="triage" todos={[first, second].map(todo => projectTodoDecision(todo, snapshot))} today="2026-11-13" loading={false} actions={{ ...spyActions().actions, decisions: controls }} />
      {returning && <ReturnHandBackDialog todo={returning} close={() => setReturning(null)} send={reply => {
        controls.decide(returning, { decision: "return", reply }); setReturning(null);
      }} />}
    </>;
  }
  const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
  const heading = () => dom.container.querySelector("h2")?.textContent;
  await dom.render(<Triage />);
  expect(heading()).toBe(first.title);
  expect(dom.container.textContent).toContain(waiting.handBack.question);
  await press("r");
  const choice = [...document.querySelectorAll("button")].find(button => button.textContent === "Final");
  expect(choice).toBeDefined();
  await dom.click(choice!);
  expect(heading()).toBe(second.title);
  expect(requests[0].body).toMatchObject({ decision: "return", reply: { kind: "choice", choice: "Final" }, expectedRevision: 2 });
  await act(async () => { history.replayLocal("undo"); });
  expect(heading()).toBe(first.title);
  expect(requests).toHaveLength(1);
  await act(async () => { requests[0].resolve({ delegation: { delegate: sam, state: "working", revision: 3 }, auditId: "return-audit" }); });
  expect(heading()).toBe(first.title);
  expect(requests[1].path).toBe("/api/v1/agent-audit/return-audit/undo");
  await act(async () => { requests[1].resolve({ delegation: { ...waiting, revision: 4 } }); });
  await press("a");
  expect(heading()).toBe(second.title);
  expect(requests[2].body).toMatchObject({ decision: "accept", expectedRevision: 4, sourceRevision: first.updatedAt });
  await act(async () => { requests[2].reject(new TodoBrowserError("Close unconfirmed", 503, 0)); });
  expect(heading()).toBe(second.title);
  await act(async () => { void queue.retry(first.id); });
  expect(requests[3].body).toEqual(requests[2].body);
  await act(async () => { requests[3].resolve({ delegation: { ...waiting, state: "handed_back", revision: 5 }, auditId: "accept-audit", sourceRevision: "2026-11-13T12:01:00Z" }); });
  expect(projectTodoDecision(first, queue.getSnapshot())).toMatchObject({ state: "closed", closureReason: "completed" });
});

test("the requested views show Delegate progress and only configured Bot HQ links without a request", async () => {
  const { TodoViews } = await import("./todo-space");
  const botHqUrl = "https://bot-hq.example.test/agents/sam";
  const lastActivityAt = "2026-11-13T11:00:00Z";
  const staleAt = "2026-11-13T13:00:00Z";
  const working: LiveTodo = {
    ...base, delegation: { delegate: { id: "sam", name: "Sam" }, state: "working", revision: 1,
      activity: { lastActivityAt, staleAt, stale: false, botHqUrl } },
  };
  const another: LiveTodo = {
    ...working, id: "I_2", number: 2, title: "Review calendar", updatedAt: "2026-11-12T12:00:00Z",
    delegation: { delegate: { id: "stacy", name: "Stacy" }, state: "working", revision: 1,
      activity: { lastActivityAt: null, stale: false, botHqUrl: null } },
  };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests++; throw Error("Rendering cannot call Bot HQ"); }, { preconnect: originalFetch.preconnect });
  try {
    for (const layout of ["list", "today", "board", "triage"] as const) {
      const render = (activityTimestamp: number) => dom.render(<TodoViews key={layout} layout={layout} todos={[working, another]}
        today="2026-11-13" loading={false} actions={{ ...spyActions().actions, activityTimestamp }} />);
      await render(Date.parse(staleAt) - 1);
      if (layout === "list") await dom.click(button("Delegated")!);
      if (layout === "triage") await dom.click([...dom.container.querySelectorAll('button[role="tab"]')].find(tab => tab.textContent?.startsWith("With agents"))!);
      expect(dom.container.textContent).toContain("Sam");
      expect(dom.container.textContent).toContain("Working");
      expect(dom.container.querySelector(`time[datetime="${lastActivityAt}"]`)).not.toBeNull();
      expect(dom.container.querySelectorAll(`a[href="${botHqUrl}"]`)).toHaveLength(1);
      expect(dom.container.querySelector(`a[href="${botHqUrl}"]`)?.textContent?.trim()).toBe("Open in Bot HQ");
      expect(dom.container.textContent).not.toContain("Stale");
      await render(Date.parse(staleAt));
      expect(dom.container.textContent).toContain("Stale");
      if (layout === "triage") await dom.click([...dom.container.querySelectorAll("button")].find(button => button.textContent?.includes("Review calendar"))!);
      expect(dom.container.textContent).toContain("Stacy");
      expect(dom.container.textContent).toContain("No activity yet");
      expect(dom.container.querySelectorAll('a[href^="https://bot-hq.example.test/"]')).toHaveLength(layout === "triage" ? 0 : 1);
    }
    expect(requests).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
