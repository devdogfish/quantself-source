import type { components } from "@/lib/generated/quantself-api-schema";
import { TodoBrowserError, type LiveTodo } from "./todo-live";

export type OwnerReply = components["schemas"]["TodoOwnerReply"];
type Delegation = components["schemas"]["TodoDelegation"];
export type HandBackDecision = { decision: "accept" } | { decision: "return"; reply: OwnerReply };
type Receipt = { delegation: Delegation; sourceRevision?: string; auditId?: string };
type Ticket = { auditId?: string };
type Intent = {
  id: string; delegation: Delegation; closure?: "open" | "completed";
  decision?: HandBackDecision; ticket: Ticket; sourceRevision?: string; expectedRevision?: number;
  payload?: object;
};
type Entry = { task: LiveTodo; confirmed: Receipt; intents: Intent[]; running: boolean; error?: string; reconcile?: () => void };
type Projection = { delegation: Delegation; closure?: Intent["closure"]; sourceRevision?: string; pending: boolean; retry: boolean; error?: string };

async function send(path: string, body: object | undefined): Promise<Receipt> {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new TodoBrowserError(result?.message ?? "Decision could not be saved.", response.status, 0);
  if (!result?.delegation) throw new Error("Decision receipt is missing.");
  return result;
}

export function createTodoDecisionQueue(onRejected: (id: string) => void, dispatch = send) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = new Map<string, Projection>();
  function publish() {
    snapshot = new Map([...entries].map(([id, entry]) => {
      const latest = entry.intents.at(-1);
      const previous = entry.confirmed;
      return [id, { delegation: latest?.delegation ?? previous.delegation,
        closure: latest?.closure ?? (previous.sourceRevision ? previous.delegation.state === "handed_back" ? "completed" : "open" : undefined),
        sourceRevision: previous.sourceRevision, pending: !!latest, retry: !!latest && !!entry.error, error: entry.error }];
    }));
    for (const listener of listeners) listener();
  }
  async function persist(entry: Entry) {
    if (entry.running) return;
    entry.running = true;
    entry.error = undefined;
    publish();
    try {
      while (entry.intents.length) {
        const intent = entry.intents[0];
        if (intent.decision) {
          intent.payload ??= { ...intent.decision, commandId: intent.id, todoId: entry.task.id,
            expectedRevision: intent.expectedRevision ?? entry.confirmed.delegation.revision,
            ...(intent.decision.decision === "accept" && { sourceRevision: intent.sourceRevision ?? entry.confirmed.sourceRevision ?? entry.task.updatedAt }),
          };
        }
        const path = intent.decision
          ? `/api/v1/todos/${entry.task.number}/hand-back/decision`
          : `/api/v1/agent-audit/${intent.ticket.auditId}/undo`;
        if (!intent.decision && !intent.ticket.auditId) throw Error("The decision audit is unavailable.");
        const saved = await dispatch(path, intent.payload);
        if (intent.decision) intent.ticket.auditId = saved.auditId;
        entry.confirmed = { ...saved, sourceRevision: saved.sourceRevision ?? entry.confirmed.sourceRevision };
        entry.intents.shift();
        publish();
      }
    } catch (error) {
      if (error instanceof TodoBrowserError && [400, 401, 403, 404, 409].includes(error.status)) {
        entry.intents = [];
        entry.error = error.message;
        onRejected(entry.task.id);
        entry.reconcile?.();
      } else entry.error = "Decision unconfirmed. Retry the same decision.";
    } finally { entry.running = false; publish(); }
  }
  function enqueue(task: LiveTodo, intent: Intent, reconcile?: () => void) {
    let entry = entries.get(task.id);
    if (!entry || (!entry.intents.length && task.delegation!.revision > entry.confirmed.delegation.revision)) {
      entry = { task, confirmed: { delegation: task.delegation! }, intents: [], running: false, reconcile };
      entries.set(task.id, entry);
    }
    entry.intents.push(intent);
    if (entry.running || (entry.error && entry.intents.length > 1)) publish();
    else void persist(entry);
  }
  function decide(task: LiveTodo, decision: HandBackDecision, reconcile?: () => void) {
    const before = task.delegation;
    if (!before?.delegate || !before.handBack || before.state !== "waiting_on_owner" || entries.get(task.id)?.intents.length) return;
    const after: Delegation = decision.decision === "accept"
      ? { ...before, state: "handed_back", pendingDecision: undefined }
      : { delegate: before.delegate, state: "working", revision: before.revision, ownerReply: decision.reply };
    let ticket: Ticket = {};
    const submit = (replay = false) => {
      ticket = {};
      enqueue(task, { id: crypto.randomUUID(), decision, ticket, delegation: after, sourceRevision: replay ? undefined : task.updatedAt,
        closure: decision.decision === "accept" ? "completed" : undefined }, reconcile);
    };
    submit();
    return (direction: "undo" | "redo") => {
      if (direction === "redo") submit(true);
      else enqueue(task, { id: crypto.randomUUID(), ticket, delegation: before,
        closure: decision.decision === "accept" ? "open" : undefined }, reconcile);
    };
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    decide,
    resume(task: LiveTodo, reconcile?: () => void) {
      const before = task.delegation;
      const pending = before?.pendingDecision;
      if (!before || !pending || entries.get(task.id)?.intents.length) return;
      const accept = pending.kind === "accept";
      enqueue(task, { id: pending.commandId, sourceRevision: pending.sourceRevision, expectedRevision: before.revision,
        decision: accept ? { decision: "accept" } : undefined, ticket: { auditId: pending.auditId ?? undefined },
        delegation: { ...before, pendingDecision: undefined, state: accept ? "handed_back" : "waiting_on_owner" },
        closure: accept ? "completed" : "open",
      }, reconcile);
    },
    retry(id: string) { const entry = entries.get(id); if (entry?.intents.length) return persist(entry); },
  };
}

export function projectTodoDecision(todo: LiveTodo, snapshot: ReturnType<ReturnType<typeof createTodoDecisionQueue>["getSnapshot"]>): LiveTodo {
  const local = snapshot.get(todo.id);
  if (!local || (!local.pending && (todo.delegation?.revision ?? 0) > local.delegation.revision)) return todo;
  if (!local.pending && todo.delegation?.pendingDecision && todo.delegation.revision === local.delegation.revision) return todo;
  const overrideClosure = local.closure && (local.pending || !!local.sourceRevision && todo.updatedAt <= local.sourceRevision);
  const delegation = !local.pending && todo.delegation?.revision === local.delegation.revision ? todo.delegation : local.delegation;
  return { ...todo, delegation,
    ...(overrideClosure && { state: local.closure === "completed" ? "closed" : "open", closureReason: local.closure === "completed" ? "completed" : null }),
    ...(!local.pending && local.sourceRevision && todo.updatedAt < local.sourceRevision && { updatedAt: local.sourceRevision }),
  };
}
