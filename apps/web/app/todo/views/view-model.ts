// Maps live GitHub-backed tasks onto the states the To-Do views show (#171).
import type { LiveTodo } from "../todo-live";
import { todoTask, type Task } from "../todo-projection";
import type { DelegateControls } from "../todo-delegate-picker";
import type { DecisionControls } from "../todo-handback";

export type ViewStatus =
  | "inbox"     // captured, not committed
  | "todo"      // Active, yours
  | "approve"   // proposed for an agent (ready-for-agent), waiting for your approval
  | "queued"    // approved, waiting for the runner
  | "running"   // agent working
  | "needs-you" // agent handed back (ready-for-human)
  | "someday"
  | "done"
  | "closed";   // not planned / duplicate

export type ViewTask = {
  id: string;
  number: number;
  title: string;
  url: string;
  category?: string;
  top: boolean;
  status: ViewStatus;
  delegated: boolean;
  dueLabel?: string;
  dueToday: boolean;
  overdue: boolean;
  start?: string;      // HH:MM on its planned date
  plannedDate?: string;
  minutes?: number;
  agentNote?: string;  // latest runner/agent update, plain text
  updatedAt: string;
  pending: boolean;
  task: Task;          // existing projection, for existing actions
  source: LiveTodo;
};

export function viewStatus(todo: LiveTodo): ViewStatus {
  if (todo.delegation?.pendingDecision) return "needs-you";
  if (todo.state === "closed") return todo.closureReason === "completed" ? "done" : "closed";
  if (todo.delegation?.state === "waiting_on_owner" && todo.delegation.handBack) return "needs-you";
  if (todo.delegation?.state === "working" && todo.delegation.delegate) return "running";
  switch (todo.fields.Commitment) {
    case "Active": return "todo";
    case "Someday": return "someday";
    default: return "inbox";
  }
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit" });
const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function dueOf(todo: LiveTodo, today: string): { date?: string; label?: string } {
  const date = todo.deadlineAt ? dayFormatter.format(new Date(todo.deadlineAt)) : typeof todo.fields.Due === "string" ? todo.fields.Due : undefined;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {};
  const diff = dayDiff(today, date);
  const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : diff > 1 && diff < 7 ? weekday.format(new Date(`${date}T12:00:00Z`)) : date.slice(5).replace("-", "/");
  return { date, label };
}

function plain(markdown: string) {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#+\s*/gm, "").replace(/[*_`>[\]]/g, "").replace(/\(https?:[^)]+\)/g, "").replace(/\s+/g, " ").trim();
}

export function latestAgentNote(todo: LiveTodo): string | undefined {
  const comments = (todo.comments ?? []).filter((c) => !/^\s*<!-- quantself:source\b/.test(c.body));
  const last = comments.at(-1);
  if (!last) return undefined;
  const text = plain(last.body);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text || undefined;
}

export function toViewTask(todo: LiveTodo, today: string): ViewTask {
  const task = todoTask(todo);
  const status = viewStatus(todo);
  const due = dueOf(todo, today);
  return {
    id: todo.id,
    number: todo.number,
    title: todo.title,
    url: todo.url,
    category: typeof todo.fields.Category === "string" && todo.fields.Category ? todo.fields.Category : undefined,
    top: todo.fields["Top priority"] === "Yes",
    status,
    delegated: status === "running" || status === "needs-you",
    dueLabel: due.label,
    dueToday: due.date === today,
    overdue: !!due.date && due.date < today && status !== "done",
    start: task.start || undefined,
    plannedDate: task.plannedDate,
    minutes: task.unknownDuration ? undefined : task.minutes || undefined,
    updatedAt: todo.updatedAt,
    pending: !!todo.optimistic,
    task,
    source: todo,
  };
}

// "What needs doing vs. not": one grouping all views share.
export type Bucket = "needs-you" | "yours" | "agents" | "inbox" | "someday" | "done";
export function bucketOf(t: ViewTask): Bucket | null {
  switch (t.status) {
    case "needs-you": case "approve": return "needs-you";
    case "todo": return "yours";
    case "queued": case "running": return "agents";
    case "inbox": return "inbox";
    case "someday": return "someday";
    case "done": return "done";
    default: return null;
  }
}

export function sortForFocus(a: ViewTask, b: ViewTask) {
  return Number(b.top) - Number(a.top) || Number(b.overdue) - Number(a.overdue) || Number(b.dueToday) - Number(a.dueToday);
}

export const statusLabel: Record<ViewStatus, string> = {
  inbox: "Inbox", todo: "Todo", approve: "Approve delegation", queued: "Queued for agent", running: "Agent working",
  "needs-you": "Ready for you", someday: "Someday", done: "Done", closed: "Closed",
};

// Actions the views can take. Implemented by the workspace with its existing optimistic queue and history.
export type ViewActions = {
  readOnly: boolean;
  delegates?: DelegateControls;
  decisions?: DecisionControls;
  activityTimestamp?: number;
  toggleDone: (t: ViewTask) => void;
  setCommitment: (t: ViewTask, to: "Inbox" | "Active" | "Someday") => void;
  togglePriority: (t: ViewTask) => void;
  open: (t: ViewTask) => void;
  add: () => void;
  undo: () => void;
};
