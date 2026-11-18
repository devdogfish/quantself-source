import { z } from "zod";
import type { Todo } from "./todos-github";

const metadata = z.object({ version: z.literal(1), reopen: z.boolean() }).strict();
const block = /<!-- quantself:trash\b([\s\S]*?)-->/g;

// GitHub remains authoritative. Trash never deletes the issue or its history.
export function readTodoTrash(body: string | null, lifecycle?: { state: string; closureReason: string | null; duplicateOf?: unknown }) {
  const matches = [...(body ?? "").matchAll(block)];
  if (!matches.length && !(body ?? "").includes("<!-- quantself:trash"))
    return { trashed: lifecycle?.state === "closed" && lifecycle.closureReason === "not_planned" && !lifecycle.duplicateOf, reopen: lifecycle?.state === "closed" && lifecycle.closureReason === "not_planned" && !lifecycle.duplicateOf, trashError: null };
  try {
    if (matches.length !== 1 || (body ?? "").split("<!-- quantself:trash").length !== 2) throw Error();
    const value = metadata.parse(JSON.parse(matches[0][1]!.trim()));
    return { trashed: true, reopen: value.reopen, trashError: null };
  } catch {
    return { trashed: true, reopen: false, trashError: "Invalid trash metadata. Repair it on GitHub before restoring." };
  }
}

export function trashIssuePatch(todo: Todo, trashed: boolean) {
  const current = readTodoTrash(todo.body, todo);
  if (current.trashError) throw Error(current.trashError);
  if (trashed) {
    const body = `${todo.body ?? ""}${todo.body ? "\n\n" : ""}<!-- quantself:trash ${JSON.stringify({ version: 1, reopen: todo.state === "open" })} -->`;
    return { body, ...(todo.state === "open" ? { state: "closed", state_reason: "not_planned" } : {}) };
  }
  // Restore former open tasks, while preserving later external completion changes.
  return {
    body: (todo.body ?? "").replace(/(?:\n\n)?<!-- quantself:trash\b[\s\S]*?-->/, ""),
    ...(current.reopen && todo.state === "closed" && todo.closureReason === "not_planned" ? { state: "open" } : {}),
  };
}
