import { readTodoJson, type LiveTodo } from "./todo-live";

// Share only an in-flight read. No task-data TTL or authorization cache.
const pending = new Map<string, Promise<{ todo: LiveTodo }>>();
// Invalidate coalescing across an authorization boundary; existing consumers still
// discard their own obsolete responses. No completed data is retained here.
export function invalidateTodoDetailReads() { pending.clear(); }
export function readTodoDetail(number: number, revision?: string | null) {
  const key = `${number}:${revision ?? ""}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = readTodoJson<{ todo: LiveTodo }>(`/api/v1/todos/${number}`);
  pending.set(key, request);
  void request.finally(() => { if (pending.get(key) === request) pending.delete(key); }).catch(() => {});
  return request;
}
