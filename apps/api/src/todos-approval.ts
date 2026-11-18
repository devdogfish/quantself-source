import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Todo, TodoReader } from "./todos-github";
import {
  TodoWriteError,
  type CommandJournal,
  type TodoWriteResult,
} from "./todos-write";

export const todoApprovalSchema = z
  .object({
    commandId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z.enum(["execute", "wait"]),
    confirmed: z.literal(true),
  })
  .strict()
  .openapi("TodoApproval");
export type TodoApproval = z.infer<typeof todoApprovalSchema>;
export function approvalRevision(todo: Todo, tasks: Todo[]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        todo: { ...todo, approvalRevision: undefined },
        prerequisites: tasks
          .map((t) => ({
            id: t.id,
            state: t.state,
            closureReason: t.closureReason,
            duplicateOf: t.duplicateOf,
            blockedBy: t.blockedBy,
            relationshipError: t.relationshipError,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
}
export function createTodoApprover(
  reader: TodoReader,
  journal: CommandJournal,
  send: (path: string, method: string, body?: unknown) => Promise<unknown>,
) {
  return async (
    clientId: string,
    number: number,
    input: TodoApproval,
  ): Promise<TodoWriteResult> => {
    todoApprovalSchema.parse(input);
    const todo = await reader.detail(number);
    const tasks = await reader.list();
    if (input.revision !== approvalRevision(todo, tasks))
      throw new TodoWriteError(
        "STALE_APPROVAL",
        "Task, brief or prerequisites changed. Review again.",
      );
    if (
      todo.state !== "open" ||
      todo.trashed ||
      todo.issueType === "Decision" ||
      todo.labels.some((l) => l.startsWith("wayfinder:")) ||
      !todo.labels.includes("ready-for-agent") ||
      todo.labels.some((l) =>
        ["agent:implement", "agent:queued", "agent:in-progress"].includes(l),
      )
    )
      throw new TodoWriteError(
        "INVALID_APPROVAL",
        "Only an open delegation proposal can be approved.",
      );
    if (
      todo.relationshipError ||
      !todo.blockedBy ||
      !todo.comments ||
      todo.readiness !== (input.intent === "execute" ? "ready" : "blocked")
    )
      throw new TodoWriteError(
        "INVALID_APPROVAL",
        "Refresh prerequisites; execute ready work or approve waiting for blocked work.",
      );
    if (!todo.comments.some((c) => /agent brief/i.test(c.body)))
      throw new TodoWriteError(
        "INVALID_APPROVAL",
        "Prepare an Agent Brief comment before approval.",
      );
    // Reserve the reviewed revision globally, not just per Client/command. Never replay a consumed trigger.
    const commandReceipt = await journal.reserve(
      `approval-command:${todo.repository}:${clientId}:${input.commandId}`,
      input.revision,
    );
    if (!commandReceipt.fresh)
      throw new TodoWriteError(
        "REPLAYED_APPROVAL",
        "Approval command already attempted. Refresh and review again.",
      );
    const receipt = await journal.reserve(
      `approval:${todo.repository}:${todo.id}:${input.revision}`,
      `${clientId}:${input.commandId}:${input.intent}`,
    );
    if (!receipt.fresh)
      throw new TodoWriteError(
        "REPLAYED_APPROVAL",
        "Approval already attempted. Refresh and review current runner state.",
      );
    // Receipt writes can wait on storage. Revalidate after reservation so changes
    // during that wait cannot dispatch an approval for an outdated review.
    const latest = await reader.detail(number);
    const latestTasks = await reader.list();
    if (input.revision !== approvalRevision(latest, latestTasks))
      throw new TodoWriteError(
        "STALE_APPROVAL",
        "Task, brief or prerequisites changed. Review again.",
      );
    const label =
      input.intent === "execute" ? "agent:implement" : "agent:queued";
    let outcome: "saved" | "uncertain" = "uncertain";
    try {
      await send(`/repos/${todo.repository}/issues/${number}/labels`, "POST", {
        labels: [label],
      });
      const current = await reader.detail(number);
      if (current.labels.includes(label)) outcome = "saved";
      return {
        commandId: input.commandId,
        todo: current,
        outcomes: { approval: outcome },
        retryable: false,
        message:
          outcome === "saved"
            ? "Approval recorded. The separate runner owns execution and queue release. External actions require their own authority."
            : "Approval may have been consumed or failed. Inspect runner progress before approving again.",
      };
    } catch {
      return {
        commandId: input.commandId,
        todo,
        outcomes: { approval: "uncertain" },
        retryable: false,
        message:
          "Approval outcome uncertain. Refresh and inspect runner progress; this approval cannot be replayed.",
      };
    }
  };
}
