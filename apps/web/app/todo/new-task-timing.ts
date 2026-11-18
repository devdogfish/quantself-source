import type { LiveTodo } from "./todo-live";
import { localDateTime } from "./todo-timing";

/** Scan the sorted occupied intervals once; includes prep and cross-midnight work. */
export function newTaskTiming(todos: readonly LiveTodo[], now = Date.now()) {
  const duration = 30 * 60000;
  let start = Math.floor(now / 60000) * 60000 + 60000;
  const occupied = todos.filter(todo => todo.state === "open" && !todo.trashed && todo.start && todo.end)
    .map(todo => ({ start: Date.parse(todo.start!) - (todo.beforeMinutes ?? 0) * 60000, end: Date.parse(todo.end!) + (todo.afterMinutes ?? 0) * 60000 }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > start)
    .sort((a, b) => a.start - b.start);
  for (const range of occupied) {
    if (range.start >= start + duration) break;
    if (range.end > start) start = Math.ceil(range.end / 60000) * 60000;
  }
  return { start: localDateTime(start), end: localDateTime(start + duration), allDay: false };
}
