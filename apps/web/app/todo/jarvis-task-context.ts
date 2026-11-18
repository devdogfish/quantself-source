import type { LiveTodo } from "./todo-live";
import type { JarvisUiContext } from "./jarvis-ui";
import { localDateTime } from "./todo-timing";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dateAt = (value: string) => localDateTime(value).slice(0, 10);
function inRange(todo: LiveTodo, from: string, through: string) {
  const due = todo.fields.Due;
  if (typeof due === "string" && due >= from && due <= through) return true;
  return !!todo.start && !!todo.end && dateAt(todo.start) <= through && dateAt(new Date(Date.parse(todo.end) - 1).toISOString()) >= from;
}
export function jarvisTaskContext(input: {
  context: JarvisUiContext; todos: LiveTodo[]; visibleTodos: LiveTodo[];
  today: string; status: string; detail?: LiveTodo | null; unavailableNumbers?: readonly number[];
}): JarvisUiContext {
  const { context, todos, visibleTodos, today, status, detail, unavailableNumbers = [] } = input;
  if (status === "denied") return { ...context, selectedTask: null, visibleTasks: [], nextSevenDays: [], categories: [], categoryFilter: { filter: "all" }, taskFreshness: status };
  let from = context.date ?? today, through = from;
  if (context.calendarView === "week") {
    from = shift(from, -new Date(`${from}T12:00:00Z`).getUTCDay()); through = shift(from, 6);
  } else if (context.calendarView === "month") {
    from = from.slice(0, 7) + "-01";
    const next = new Date(`${from}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    through = shift(next.toISOString().slice(0, 10), -1);
  } else if (context.calendarView === "year") { from = from.slice(0, 4) + "-01-01"; through = from.slice(0, 4) + "-12-31"; }
  const usable = (todo: LiveTodo) => !todo.trashed && !todo.optimistic && todo.number > 0 && !unavailableNumbers.includes(todo.number);
  const selectionBlocked = !!context.selectedTask && (context.selectedTask.number <= 0 || unavailableNumbers.includes(context.selectedTask.number) || todos.some(todo => todo.number === context.selectedTask?.number && (todo.trashed || todo.optimistic)));
  const selected = todos.find(todo => usable(todo) && todo.number === context.selectedTask?.number);
  const selectedFacts = detail && usable(detail) && detail.number === context.selectedTask?.number && (!selected || detail.updatedAt === selected.updatedAt)
    ? { ...detail, ...Object.fromEntries(Object.entries(selected ?? {}).filter(([, value]) => value !== undefined)) } as LiveTodo : selected;
  return {
    ...context,
    selectedTask: context.selectedTask && !selectionBlocked ? { number: context.selectedTask.number, title: selectedFacts?.title ?? context.selectedTask.title, ...(selectedFacts ? { facts: selectedFacts } : {}) } : null,
    visibleTasks: visibleTodos.filter(todo => usable(todo) && (context.calendarView === "list" || inRange(todo, from, through))).map(todo => ({
      number: todo.number, title: todo.title,
      description: (todo.description ?? todo.body?.split("<!--")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    })),
    nextSevenDays: todos.filter(todo => usable(todo) && todo.state === "open" && inRange(todo, today, shift(today, 6))).map(todo => ({
      number: todo.number, title: todo.title,
      when: todo.start ? todo.allDay ? `${dateAt(todo.start)} all day` : `${localDateTime(todo.start)} – ${localDateTime(todo.end)}` : `Due ${todo.fields.Due}`,
    })),
    taskFreshness: status,
  };
}
