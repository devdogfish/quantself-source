import type { Todo } from "./todos-github";

// Only delivered work releases a prerequisite. Unknown/external targets fail closed.
export function deriveReadiness(tasks: Todo[]): Todo[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function delivered(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const task = byId.get(id);
    if (!task || task.trashed || task.state !== "closed") return false;
    if (task.closureReason === "duplicate")
      return !!task.duplicateOf && delivered(task.duplicateOf.id, seen);
    return task.closureReason === "completed";
  }
  return tasks.map((task) => ({
    ...task,
    readiness:
      task.relationshipError ||
      (task.blockedBy ?? []).some((blocker) => !delivered(blocker.id))
        ? "blocked"
        : "ready",
  }));
}
