import { todoDeadlineAtSchema, readTodoDeadline, editDeadlineBody, deadlineDate, readStoredDeadline } from "./todos-deadline";
import { readTaskDescription, taskDescriptionSpan } from "./todos-description";
import { prepMinutesSchema, todoInstantSchema, todoTimingSchema, readTodoSchedule, editScheduleBody, emptyTiming, timingOf, shiftTaskTiming } from "./todos-schedule";
import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Todo, TodoReader } from "./todos-github";
import { overlaps, type Interval } from "./meetings-availability";
import { readTodoTrash, trashIssuePatch } from "./todos-trash";

// Accept queued commands from pre-rename clients while keeping the public schema
// canonical. Supplying both names is deliberately left invalid for strict parsing.
export function normalizeTodoCategoryCommand<T>(command: T): T {
  if (!command || typeof command !== "object" || !("fields" in command)) return command;
  const fields = command.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.hasOwn(fields, "Area") || Object.hasOwn(fields, "Category")) return command;
  return { ...command, fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name === "Area" ? "Category" : name, value])) };
}
const normalizeCategoryFields = (fields: unknown) => normalizeTodoCategoryCommand({ fields }).fields;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
const facts = z
  .object({
    Location: z.string().max(2000).nullable().optional(),
    URL: z.string().max(2000).nullable().optional(),
    Client: z.string().min(1).nullable().optional(),
    Category: z
      .string().min(1).max(100)
      .nullable()
      .optional(),
    Due: date.nullable().optional(),
    Estimate: z.number().int().positive().nullable().optional(),
    "Cost of waiting": z.enum(["Low", "Medium", "High"]).nullable().optional(),
    "Waiting since": date.nullable().optional(),
  })
  .strict();
const commitment = z.enum(["Inbox", "Active", "Someday"]);
const closure = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("open") }).strict(),
  z.object({ outcome: z.literal("completed") }).strict(),
  z.object({ outcome: z.literal("not_planned") }).strict(),
  z
    .object({
      outcome: z.literal("duplicate"),
      number: z.number().int().positive().safe(),
    })
    .strict(),
]);
const title = z.string().trim().min(1).max(256);
const text = z
  .string()
  .max(50000)
  .refine(
    (v) => !v.includes("<!--"),
    "Managed metadata cannot be edited as description.",
  );
const commandId = z.string().uuid();
const todoProvenanceSchema = z
  .object({
    captureId: z.string().uuid(),
    conversationId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(256),
    operationId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(256),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("TodoProvenance");
const timingInput = {
  start: todoInstantSchema.optional(), end: todoInstantSchema.optional(),
  allDay: z.boolean().optional(), fixed: z.boolean().optional(),
  beforeMinutes: prepMinutesSchema.optional(), afterMinutes: prepMinutesSchema.optional(),
};
const hasTiming = (input: { start?: unknown; end?: unknown; allDay?: unknown; fixed?: unknown; beforeMinutes?: number; afterMinutes?: number; shiftMinutes?: unknown }) =>
  input.start !== undefined || input.end !== undefined || input.allDay !== undefined || input.fixed !== undefined || input.shiftMinutes !== undefined || input.beforeMinutes !== undefined || input.afterMinutes !== undefined;
function validateTiming(input: { start?: string | null; end?: string | null; allDay?: boolean; fixed?: boolean; beforeMinutes?: number; afterMinutes?: number; shiftMinutes?: number }, context: z.RefinementCtx) {
  if (!hasTiming(input)) return;
  if (input.shiftMinutes !== undefined) {
    if ([input.start, input.end, input.allDay, input.fixed, input.beforeMinutes, input.afterMinutes].some(value => value !== undefined))
      context.addIssue({ code: "custom", path: ["shiftMinutes"], message: "A relative shift preserves the existing range and flags. Do not combine it with start, end, allDay or fixed." });
    return;
  }
  if (input.start === undefined && input.end === undefined && input.allDay === undefined && input.fixed === undefined) return;
  if (input.start === undefined || input.end === undefined) {
    if (input.start === null || input.end === null || (input.start === undefined && input.end === undefined)) context.addIssue({ code: "custom", path: ["start"], message: "Clear both bounds, or supply a non-null bound." });
    return;
  }
  const result = todoTimingSchema.safeParse(input);
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
}
export const todoCreateSchema = z
  .object({
    commandId,
    title,
    description: text.describe("Task description / event notes. Editable prose, excluding managed metadata.").optional(),
    fields: z.preprocess(normalizeCategoryFields, facts).optional(),
    deadlineAt: todoDeadlineAtSchema.optional(),
    ...timingInput,
  })
  .strict()
  .superRefine((input, ctx) => { validateTiming(input, ctx); if (input.deadlineAt && deadlineDate(input.deadlineAt) !== input.fields?.Due) ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "Deadline time requires its matching Due date." }); if ((input.beforeMinutes || input.afterMinutes) && ((!input.start && !input.end) || input.allDay)) ctx.addIssue({ code: "custom", message: "Prep time requires a timed event." }); })
  .openapi("TodoCreate");
const change = <T extends z.ZodType>(schema: T) =>
  z.object({ before: schema, after: schema }).strict();
export const todoEditSchema = z
  .object({
    commandId,
    agentBrief: z
      .object({
        goal: text.min(1),
        inputs: text.min(1),
        output: text.min(1),
        constraints: text.min(1),
        doneWhen: text.min(1),
      })
      .strict()
      .optional(),
    title: change(title).optional(),
    description: change(text).optional(),
    closure: change(closure).optional(),
    trash: change(z.boolean()).optional(),
    deadlineAt: change(todoDeadlineAtSchema).optional(),
    relationships: z
      .array(
        z
          .object({
            kind: z.enum(["blockedBy", "children"]),
            number: z.number().int().positive().safe(),
            before: z.boolean(),
            after: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (v) => new Set(v.map((e) => `${e.kind}:${e.number}`)).size === v.length,
        "Duplicate edge edits.",
      )
      .optional(),
    shiftMinutes: z.number().int().safe().min(-5256000).max(5256000).refine(value => value !== 0, "Shift must be nonzero.").describe("Move both existing bounds by this signed elapsed-minute delta, preserving duration. Operation only; not stored. Do not supply start/end or flags with a shift.").optional(),
    revision: z.string().min(1).describe("Last-read updatedAt; required when changing timing, deadline time or Trash.").optional(),
    ...timingInput,
    fields: z.preprocess(normalizeCategoryFields, z
      .object({
        Commitment: change(commitment.nullable()).optional(),
        Rank: change(z.number().finite().nullable()).optional(),
        "Top priority": change(z.enum(["Yes", "No"]).nullable()).optional(),
        Location: change(facts.shape.Location.unwrap()).optional(),
        URL: change(facts.shape.URL.unwrap()).optional(),
        Client: change(facts.shape.Client.unwrap()).optional(),
        Category: change(facts.shape.Category.unwrap()).optional(),
        Due: change(facts.shape.Due.unwrap()).optional(),
        Estimate: change(facts.shape.Estimate.unwrap()).optional(),
        "Cost of waiting": change(
          facts.shape["Cost of waiting"].unwrap(),
        ).optional(),
        "Waiting since": change(
          facts.shape["Waiting since"].unwrap(),
        ).optional(),
      })
      .strict())
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.agentBrief ||
      v.relationships ||
      v.title ||
      v.description ||
      v.closure ||
      v.trash ||
      v.deadlineAt ||
      hasTiming(v) ||
      Object.keys(v.fields ?? {}).length > 0,
    "Supply at least one change.",
  )
  .refine(
    (v) => !hasTiming(v) || !!v.revision,
    { message: "Timing changes require the last-seen revision from todo.updatedAt.", path: ["revision"] },
  )
  .refine(v => !v.deadlineAt || !!v.revision, "Deadline time changes require the current revision.")
  .refine(v => !v.trash || (!!v.revision && v.trash.before !== v.trash.after), "Trash and restore require the current revision and a changed trash value.")
  .refine(v => !v.trash || Object.keys(v).every(key => ["commandId", "number", "revision", "trash"].includes(key)), "Submit trash or restore separately from other edits.")
  .superRefine(validateTiming)
  .openapi("TodoEdit");
export type TodoCreate = z.infer<typeof todoCreateSchema>;
export type TodoEdit = z.infer<typeof todoEditSchema>;
export const personalMailSourceSchema = z.object({
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  actionKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
export type TodoCommand = (TodoCreate | (TodoEdit & { number: number })) & {
  provenance?: z.infer<typeof todoProvenanceSchema>;
  closureGuard?: { todoId: string; sourceRevision: string };
  personalMail?: z.infer<typeof personalMailSourceSchema> & { ownerId: string };
  personalUndoRevision?: string;
};
const outcome = z.enum([
  "saved",
  "conflict",
  "uncertain",
  "failed",
  "not-attempted",
]);
export const todoWriteResultSchema = (schema: z.ZodType<Todo>) =>
  z
    .object({
      commandId,
      cacheGeneration: z.number().int().nonnegative().optional(),
      todo: z.union([schema, z.null()]),
      outcomes: z.record(z.string(), outcome),
      message: z.string(),
      retryable: z.boolean(),
    })
    .openapi("TodoWriteResult");
export type TodoWriteResult = {
  commandId: string;
  cacheGeneration?: number;
  todo: Todo | null;
  outcomes: Record<string, z.infer<typeof outcome>>;
  message: string;
  retryable: boolean;
};
export class TodoWriteError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 409 | 503 = 409,
  ) {
    super(message);
  }
}
class LifecycleRefused extends Error {}
type Receipt = {
  categoryOptions?: { id?: number; name: string; color: string; description?: string | null; priority?: number }[];
  attempted?: boolean;
  number?: number;
  done: Record<string, boolean>;
  timingBefore?: ReturnType<typeof timingOf>;
  deadlineBefore?: ReturnType<typeof readStoredDeadline>;
  projectAttempts?: number;
  lifecycleAttempted?: boolean;
  lifecycleRejected?: boolean;
  lifecycleVerifiedRevision?: string;
  trashAttempted?: boolean;
  personalOverlap?: boolean;
  provenanceAttempted?: boolean;
  relationshipAttempts?: Record<string, boolean>;
};
export type CommandJournal = {
  reserve(
    key: string,
    hash: string,
  ): Promise<{ fresh: boolean; hash: string; state: Receipt }>;
  save(key: string, state: Receipt): Promise<void>;
  claimLifecycle?(key: string, before: Receipt, after: Receipt): Promise<boolean>;
};
// Receipts only: task facts stay on GitHub. Reserve commits BEFORE any remote create.
export const todoCommandJournal: CommandJournal = {
  async reserve(key, hash) {
    const { prisma } = await import("@quantself/db");
    const where = {
      clientId_operation_idempotencyKey: {
        clientId: "todos",
        operation: "task-facts",
        idempotencyKey: key,
      },
    };
    try {
      await prisma.apiIdempotencyKey.create({
        data: {
          ...where.clientId_operation_idempotencyKey,
          requestFingerprint: hash,
          responseBody: { done: {} },
        },
      });
      return { fresh: true, hash, state: { done: {} } };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const row = await prisma.apiIdempotencyKey.findUniqueOrThrow({ where });
      return {
        fresh: false,
        hash: row.requestFingerprint,
        state: row.responseBody as Receipt,
      };
    }
  },
  async save(key, state) {
    const { prisma } = await import("@quantself/db");
    await prisma.apiIdempotencyKey.update({
      where: {
        clientId_operation_idempotencyKey: {
          clientId: "todos",
          operation: "task-facts",
          idempotencyKey: key,
        },
      },
      data: { responseBody: JSON.parse(JSON.stringify(state)) },
    });
  },
  async claimLifecycle(key, before, after) {
    const { prisma } = await import("@quantself/db");
    const claimed = await prisma.apiIdempotencyKey.updateMany({
      where: { clientId: "todos", operation: "task-facts", idempotencyKey: key, responseBody: { equals: JSON.parse(JSON.stringify(before)) } },
      data: { responseBody: JSON.parse(JSON.stringify(after)) },
    });
    return claimed.count === 1;
  },
};
type Connection = {
  repository: string;
  definitions: {
    id: number;
    name: string;
    data_type: string;
    options?: { name: string }[];
  }[];
  request(path: string, method: string, body?: any): Promise<any>;
  syncProject(id: string): Promise<void>;
};
export type TodoWriter = (
  clientId: string,
  command: TodoCommand,
) => Promise<TodoWriteResult>;
function canonical(value: unknown): string {
  return JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, JSON.parse(canonical(v))]),
        )
      : (value ?? null),
  );
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function personalCaptureRevision(todo: Todo) {
  const { id, title, body, state, closureReason, fields, updatedAt } = todo;
  const ids = (items: { id: string }[] = []) => items.map(item => item.id).sort();
  return digest(canonical({
    id, title, body, state, closureReason, fields, updatedAt, labels: [...(todo.labels ?? [])].sort(),
    parent: todo.parent?.id, children: ids(todo.children), blockedBy: ids(todo.blockedBy),
    comments: (todo.comments ?? []).map(({ id, body }) => ({ id, body })).sort((left, right) => left.id - right.id),
  }));
}

async function personalCalendarBusy(ownerId: string, range: Interval) {
  const { prismaMeetingStore } = await import("./meetings-store");
  return (await prismaMeetingStore().calendarBusyBetween(ownerId, range)).some(interval => overlaps(interval, range));
}

export function createTodoWriter({
  reader,
  connect,
  journal = todoCommandJournal,
  checkPersonalCalendar = personalCalendarBusy,
}: {
  reader: TodoReader;
  connect: () => Promise<Connection>;
  journal?: CommandJournal;
  checkPersonalCalendar?: typeof personalCalendarBusy;
}): TodoWriter {
  let queue: Promise<unknown> = Promise.resolve();
  return (clientId, command) => {
    const result = queue.then(() => execute(clientId, command));
    queue = result.catch(() => {});
    return result;
  };
  async function execute(
    clientId: string,
    inputCommand: TodoCommand,
  ): Promise<TodoWriteResult> {
    const command = normalizeTodoCategoryCommand(inputCommand);
    const edit = "number" in command;
    // Validation also runs here for callers other than HTTP.
    if (edit) {
      const { number, provenance, closureGuard, personalUndoRevision, ...patch } = command;
      todoEditSchema.parse(patch);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new TodoWriteError("INVALID_TASK", "Invalid issue number.", 400);
    } else {
      const { provenance, closureGuard, personalMail, ...input } = command;
      todoCreateSchema.parse(input);
      if (personalMail) personalMailSourceSchema.extend({ ownerId: z.string().min(1) }).parse(personalMail);
    }
    if (command.provenance) todoProvenanceSchema.parse(command.provenance);
    const timingRequested = hasTiming(command);
    const desiredTiming = (current: ReturnType<typeof timingOf> = emptyTiming()): ReturnType<typeof timingOf> => {
      if ("shiftMinutes" in command && command.shiftMinutes !== undefined) {
        try { return shiftTaskTiming(current, command.shiftMinutes); }
        catch (error) { throw new TodoWriteError("INVALID_TIMING", (error as Error).message, 400); }
      }
      let start = command.start === undefined ? current.start : command.start;
      let end = command.end === undefined ? current.end : command.end;
      if (start && !end && command.end === undefined) end = new Date(Date.parse(start) + 30 * 60000).toISOString();
      if (end && !start && command.start === undefined) start = new Date(Date.parse(end) - 30 * 60000).toISOString();
      return timingOf(todoTimingSchema.parse({ start, end,
      allDay: command.allDay ?? (command.start !== null ? current.allDay : false), fixed: command.fixed ?? (command.start !== null ? current.fixed : false),
      ...(command.start === null || command.allDay ? {} : { beforeMinutes: command.beforeMinutes ?? current.beforeMinutes, afterMinutes: command.afterMinutes ?? current.afterMinutes }),
    }));
    };
    if (command.fields?.Category !== undefined && reader.categories) await reader.categories.list();
    const config = await connect();
    const suppliedFields = command.fields ?? {};
    for (const [name, input] of Object.entries(suppliedFields)) {
      const value = edit ? (input as { after: unknown }).after : input;
      const definition = config.definitions.find((f) => f.name === name);
      if (
        !definition ||
        (value !== null &&
          definition.data_type === "single_select" &&
          !definition.options?.some((o) => o.name === value))
      )
        throw new TodoWriteError(
          "INVALID_FIELD",
          `Unknown option or field: ${name}.`,
          400,
        );
    }
    const key = digest(`${config.repository}:${clientId}:${command.commandId}`);
    const fingerprint = digest(canonical(command));
    const reservation = await journal.reserve(key, fingerprint);
    // Retain old command fingerprints across the public field rename. Only the
    // exact legacy spelling of this same payload is accepted, never another edit.
    const legacyCommand = command.fields && Object.hasOwn(command.fields, "Category")
      ? { ...command, fields: Object.fromEntries(Object.entries(command.fields).map(([name, value]) => [name === "Category" ? "Area" : name, value])) }
      : command;
    if (reservation.hash !== fingerprint && reservation.hash !== digest(canonical(legacyCommand)))
      throw new TodoWriteError(
        "IDEMPOTENCY_CONFLICT",
        "Command ID already used with different input.",
      );
    const state = reservation.state;
    const personalOverlap = () => new TodoWriteError("OVERLAP_REVIEW_REQUIRED", "An existing calendar entry overlaps this Appointment. Ask the Owner to choose the time.");
    if (state.personalOverlap) throw personalOverlap();
    if (Object.hasOwn(state.done, "Area")) {
      state.done.Category ??= state.done.Area!;
      delete state.done.Area;
    }
    const outcomes: TodoWriteResult["outcomes"] = {};
    const relationshipFailures: string[] = [];
    const persist = () => journal.save(key, state);
    async function claimGuardedLifecycle(field: "lifecycleAttempted" | "lifecycleRejected") {
      const next = { ...state, [field]: true };
      if (journal.claimLifecycle && !await journal.claimLifecycle(key, state, next)) return false;
      state[field] = true;
      if (!journal.claimLifecycle) await persist();
      return true;
    }
    let todo: Todo | null = null;
    const marker = `<!-- quantself:command ${key} -->`;
    const basePath = `/repos/${config.repository}/issues`;
    if (!edit) {
      if (!state.number) {
        // Scan the authoritative collection, including closed issues, before any retry.
        const tasks = await reader.list("capture");
        const matches = tasks.filter((t) => t.body?.includes(marker));
        if (matches.length > 1)
          throw new TodoWriteError(
            "CREATE_CONFLICT",
            "Multiple issues match this command. Reconcile on GitHub.",
          );
        state.number = matches[0]?.number;
        if (!state.number && (reservation.fresh || command.personalMail && !state.attempted)) {
          if (command.personalMail && command.start && command.end) {
            const from = Date.parse(command.start);
            const to = Date.parse(command.end);
            const overlap = tasks.some(t => t.state === "open" && !t.trashed && !t.allDay && t.start && t.end &&
              from < Date.parse(t.end) + (t.afterMinutes ?? 0) * 60_000 &&
              Date.parse(t.start) - (t.beforeMinutes ?? 0) * 60_000 < to);
            if (overlap || await checkPersonalCalendar(command.personalMail.ownerId, { start: from, end: to })) {
              if (journal.claimLifecycle && !await journal.claimLifecycle(key, state, { ...state, personalOverlap: true }))
                throw new TodoWriteError("CREATE_CONFLICT", "Appointment confirmation is in progress. Retry the same input.");
              state.personalOverlap = true;
              if (!journal.claimLifecycle) await persist();
              throw personalOverlap();
            }
          }
          if (command.personalMail && journal.claimLifecycle && !await journal.claimLifecycle(key, state, { ...state, attempted: true }))
            throw new TodoWriteError("CREATE_CONFLICT", "Capture confirmation is in progress. Retry the same input.");
          state.attempted = true;
          if (!command.personalMail || !journal.claimLifecycle) await persist();
          try {
            const created = await config.request(basePath, "POST", {
              title: command.title,
              type: "Task",
              labels: ["task", "needs-triage"],
              body: (() => {
                const source = command.personalMail ? "Personal Gmail" : "client message";
                let body = `Source: ${source}\nCaptured: ${new Date().toISOString()}\nCommand ID: ${command.commandId}\n${marker}\n\n${command.description ?? ""}`;
                return timingRequested ? editScheduleBody(body, desiredTiming()) : body;
              })(),
            });
            state.number = created.number;
            if (created.type?.name !== "Task") outcomes.type = "failed";
          } catch {
            const matches = (await reader.list("capture")).filter((t) =>
              t.body?.includes(marker),
            );
            if (matches.length === 1) state.number = matches[0].number;
          }
        }
        await persist();
      }
      if (!state.number)
        return {
          commandId: command.commandId,
          todo: null,
          outcomes: { issue: "uncertain", project: "not-attempted" },
          message:
            "Creation uncertain. Retry this command to reconcile; no second issue will be created. If absent, inspect GitHub before using a new command.",
          retryable: true,
        };
    }
    const number = edit ? command.number : state.number!;
    todo = await reader.detail(number);
    let afterTiming: ReturnType<typeof timingOf>;
    try { afterTiming = desiredTiming(state.timingBefore ?? timingOf(todo)); } catch (error) { throw new TodoWriteError("INVALID_TIMING", (error as Error).message, 400); }
    const deadlineChange = command.deadlineAt === undefined ? undefined : edit ? command.deadlineAt as { before: string | null; after: string | null } : { before: null, after: command.deadlineAt as string | null };
    if (deadlineChange && state.deadlineBefore === undefined) {
      if (edit && (command.revision !== todo.updatedAt || readTodoDeadline(todo.body, todo.fields.Due).deadlineAt !== deadlineChange.before)) outcomes.deadlineAt = "conflict";
      else {
        const due = command.fields?.Due === undefined ? todo.fields.Due : edit ? (command.fields.Due as { after: string | null }).after : command.fields.Due;
        try {
          editDeadlineBody(todo.body, due, deadlineChange.after);
          state.deadlineBefore = readStoredDeadline(todo.body);
          await persist();
        } catch (error) { throw new TodoWriteError("INVALID_DEADLINE", (error as Error).message, 400); }
      }
    }
    if (timingRequested && state.timingBefore === undefined) {
      if (edit && command.revision !== todo.updatedAt) outcomes.timing = "conflict";
      else { state.timingBefore = edit ? timingOf(todo) : emptyTiming(); await persist(); }
    }
    outcomes.issue = "saved";
    if (!edit) {
      outcomes.type = todo.issueType === "Task" ? "saved" : "failed";
      const verified =
        todo.title === command.title &&
        todo.body?.includes(marker) &&
        (!command.description || todo.body.includes(command.description)) &&
        ["task", "needs-triage"].every((label) =>
          todo!.labels.includes(label),
        ) &&
        !todo.labels.some((label) =>
          ["agent:implement", "agent:queued"].includes(label),
        );
      outcomes.issue = state.done.issue || verified ? "saved" : "uncertain";
      if (verified && !state.done.issue) {
        state.done.issue = true;
        await persist();
      }
    }
    const path = `${basePath}/${number}`;
    async function apply(
      name: string,
      before: unknown,
      after: unknown,
      read: (t: Todo) => unknown,
      write: () => Promise<void>,
    ) {
      try {
        todo = await reader.detail(number);
        const current = read(todo);
        if (name === "closure" && command.closureGuard) {
          if (state.lifecycleRejected) { outcomes[name] = "conflict"; return; }
          const { todoId, sourceRevision } = command.closureGuard;
          if (todo.id !== todoId || todo.trashed || (state.lifecycleVerifiedRevision && todo.updatedAt !== state.lifecycleVerifiedRevision) ||
            (!state.lifecycleAttempted && (todo.updatedAt !== sourceRevision || canonical(current) !== canonical(before)))) {
            const rejected = state.lifecycleAttempted || await claimGuardedLifecycle("lifecycleRejected");
            outcomes[name] = rejected ? "conflict" : "uncertain";
            return;
          }
        }
        if (canonical(current) === canonical(after)) {
          outcomes[name] = "saved";
          state.done[name] = true;
          if (name === "closure" && command.closureGuard) state.lifecycleVerifiedRevision = todo.updatedAt;
          await persist();
          return;
        }
        if (state.done[name] || canonical(current) !== canonical(before)) {
          outcomes[name] = "conflict";
          return;
        }
        // Never send a lifecycle transition twice after an ambiguous response/read.
        // A later explicit reopen must not be undone by replaying the old close.
        if (name === "closure" && state.lifecycleAttempted) {
          outcomes[name] = "uncertain";
          return;
        }
        if (name === "trash" && state.trashAttempted) {
          outcomes[name] = "uncertain";
          return;
        }
        if (name.startsWith("blockedBy:") || name.startsWith("children:")) {
          if (state.relationshipAttempts?.[name]) {
            outcomes[name] = "uncertain";
            return;
          }
          (state.relationshipAttempts ??= {})[name] = true;
          await persist();
        }
        if (name === "closure") {
          if (command.closureGuard) {
            if (!await claimGuardedLifecycle("lifecycleAttempted")) { outcomes[name] = "uncertain"; return; }
          } else {
            state.lifecycleAttempted = true;
            await persist();
          }
        }
        if (name === "trash") {
          state.trashAttempted = true;
          await persist();
        }
        try {
          await write();
        } catch (error) {
          if (name === "closure" && command.closureGuard && error instanceof LifecycleRefused) {
            state.lifecycleRejected = true;
            await persist();
            outcomes[name] = "failed";
            return;
          }
          /* Verify even when the response was lost. */
        }
        todo = await reader.detail(number);
        outcomes[name] =
          canonical(read(todo)) === canonical(after) ? "saved" : "uncertain";
        if (outcomes[name] === "saved") {
          state.done[name] = true;
          if (name === "closure" && command.closureGuard) state.lifecycleVerifiedRevision = todo.updatedAt;
          await persist();
        }
      } catch {
        outcomes[name] = "uncertain";
      }
    }
    if (edit && command.trash) {
      const current = readTodoTrash(todo.body, todo);
      if (current.trashError || (current.trashed !== command.trash.after && !state.trashAttempted &&
          (todo.updatedAt !== command.revision || command.personalUndoRevision && personalCaptureRevision(todo) !== command.personalUndoRevision))) {
        outcomes.trash = "conflict";
      } else {
        await apply("trash", command.trash.before, command.trash.after,
          task => readTodoTrash(task.body, task).trashed,
          async () => {
            if (todo!.updatedAt !== command.revision || command.personalUndoRevision && personalCaptureRevision(todo!) !== command.personalUndoRevision)
              throw Error("Task changed; refresh before trashing or restoring.");
            await config.request(path, "PATCH", trashIssuePatch(todo!, command.trash!.after));
          });
      }
    }
    if (edit && command.agentBrief) {
      if (
        todo.issueType === "Decision" ||
        todo.labels.some((l) => l.startsWith("wayfinder:"))
      )
        throw new TodoWriteError(
          "INVALID_BRIEF",
          "Decision issues use wayfinder labels, not delegation briefs.",
          400,
        );
      const marker = `<!-- quantself:brief ${key} -->`;
      const current = await reader.detail(number);
      if (current.comments?.some((c) => c.body.includes(marker)))
        outcomes.agentBrief = "saved";
      else if (state.attempted) outcomes.agentBrief = "uncertain";
      else {
        state.attempted = true;
        await persist();
        const brief = command.agentBrief;
        try {
          await config.request(`${path}/comments`, "POST", {
            body: `${marker}\n## Agent Brief\n\nGoal: ${brief.goal}\n\nInputs: ${brief.inputs}\n\nOutput / destination: ${brief.output}\n\nConstraints: ${brief.constraints}\n\nDone-when: ${brief.doneWhen}`,
          });
        } catch {
          /* Reconcile from current comments. */
        }
        todo = await reader.detail(number);
        outcomes.agentBrief = todo.comments?.some((c) =>
          c.body.includes(marker),
        )
          ? "saved"
          : "uncertain";
      }
    }
    if (edit && command.relationships) {
      for (const edge of command.relationships) {
        const name = `${edge.kind}:${edge.number}`;
        try {
          const target = await reader.detail(edge.number);
          if (
            !target ||
            target.repository !== config.repository ||
            target.number === number
          )
            throw new TodoWriteError(
              "INVALID_RELATIONSHIP",
              "Target must be another task in the permitted repository.",
              400,
            );
          if (edge.after) {
            const graph = await reader.list("relationships");
            const sourceId = todo.id;
            const seen = new Set<string>();
            const reaches = (id: string): boolean => {
              if (id === sourceId) return true;
              if (seen.has(id)) return false;
              seen.add(id);
              const node = graph.find((t) => t.id === id);
              const relationships = node?.[edge.kind];
              if (!node || node.relationshipError || !relationships)
                throw new TodoWriteError(
                  "INVALID_RELATIONSHIP",
                  "Cannot validate graph. Refresh and retry.",
                  400,
                );
              return relationships.some((target) => reaches(target.id));
            };
            if (reaches(target.id))
              throw new TodoWriteError(
                "RELATIONSHIP_CYCLE",
                "Relationship would create a cycle.",
                400,
              );
          }
          await apply(
            name,
            edge.before,
            edge.after,
            (t) => {
              const relationships = t[edge.kind];
              if (t.relationshipError || !relationships)
                throw Error("Relationships unavailable");
              return relationships.some(
                (reference) => reference.id === target.id,
              );
            },
            async () => {
              const suffix =
                edge.kind === "blockedBy"
                  ? "dependencies/blocked_by"
                  : "sub_issues";
              if (edge.kind === "children" && !edge.after)
                await config.request(`${path}/sub_issue`, "DELETE", {
                  sub_issue_id: target.databaseId,
                });
              else
                await config.request(
                  `${path}/${suffix}${edge.after ? "" : `/${target.databaseId}`}`,
                  edge.after ? "POST" : "DELETE",
                  edge.after ? { issue_id: target.databaseId } : undefined,
                );
            },
          );
        } catch (error) {
          outcomes[name] = "failed";
          relationshipFailures.push(
            `${name}: ${error instanceof Error ? error.message : "Target unavailable"}`,
          );
        }
      }
    }
    if (edit && command.closure) {
      const { before, after } = command.closure;
      let target: Todo | undefined;
      if (after.outcome === "duplicate") {
        if (after.number === number)
          throw new TodoWriteError(
            "INVALID_DUPLICATE",
            "A task cannot duplicate itself.",
            400,
          );
        target = await reader.detail(after.number);
        if (
          target.repository !== config.repository ||
          target.closureReason === "duplicate"
        )
          throw new TodoWriteError(
            "INVALID_DUPLICATE",
            "Choose a canonical task in this repository, not another duplicate.",
            400,
          );
      }
      await apply(
        "closure",
        before,
        after,
        (t) => {
          if (t.state === "open") return { outcome: "open" };
          return t.closureReason === "duplicate"
            ? {
                outcome: "duplicate",
                number:
                  t.duplicateOf?.repository === config.repository
                    ? t.duplicateOf.number
                    : null,
              }
            : { outcome: t.closureReason };
        },
        async () => {
          const input =
            after.outcome === "open"
              ? { issueId: todo!.id }
              : {
                  issueId: todo!.id,
                  stateReason: after.outcome.toUpperCase(),
                  ...(target ? { duplicateIssueId: target.id } : {}),
                };
          const query =
            after.outcome === "open"
              ? "mutation($input:ReopenIssueInput!){reopenIssue(input:$input){issue{id}}}"
              : "mutation($input:CloseIssueInput!){closeIssue(input:$input){issue{id}}}";
          const response = await config.request("/graphql", "POST", {
            query,
            variables: { input },
          });
          if (!response.data && Array.isArray(response.errors) && response.errors.length && response.errors.every((error: { type?: string }) =>
            ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND", "UNPROCESSABLE", "VALIDATION"].includes(error.type ?? ""))) {
            throw new LifecycleRefused("GitHub refused the lifecycle change");
          }
          if (response.errors?.length || !response.data)
            throw Error("Lifecycle write rejected");
        },
      );
    }
    if (edit && command.title) {
      const { before, after } = command.title;
      await apply(
        "title",
        before,
        after,
        (t) => t.title,
        () => config.request(path, "PATCH", { title: after }),
      );
    }
    if (edit && command.description) {
      const { before, after } = command.description;
      const prose = (t: Todo) => taskDescriptionSpan(t.body);
      const read = (t: Todo) => {
        const { text, body } = prose(t);
        if (before && body.includes(before) && !text.includes(before))
          return null;
        // Whole-description edits must win over substring matching: shortening
        // prose can leave `after` inside `before`, even multiple times.
        const description = text.trimEnd();
        if (description === after) return after;
        if (description === before) return before;
        if (before === "")
          return after !== "" && text.includes(after) ? after : "";
        if (
          before &&
          after &&
          !after.includes(before) &&
          !before.includes(after) &&
          text.includes(before) &&
          text.includes(after)
        )
          return null;
        // For a partial shortening, occurrences of `after` inside the old
        // fragment are not evidence that the replacement has already saved.
        if (after && before.includes(after) && text.split(before).length === 2)
          return text.split(after).length === before.split(after).length
            ? before
            : null;
        if (after && text.split(after).length === 2) return after;
        if (text.split(before).length === 2) return before;
        if (!after && !text.includes(before)) return after;
        return null;
      };
      await apply("description", before, after, read, async () => {
        const { body, offset, text } = prose(todo!);
        const position = offset + (before ? text.indexOf(before) : text.length);
        const next =
          body.slice(0, position) +
          after +
          body.slice(position + before.length);
        if (next.length > 65536) throw Error("Body too large");
        await config.request(path, "PATCH", { body: next });
      });
    }

    let scheduleMessage: string | null = null;
    if (timingRequested && outcomes.timing !== "conflict") {
      const read = (task: Todo) => {
        const parsed = readTodoSchedule(task.body);
        if (parsed.scheduleError) throw Error(parsed.scheduleError);
        return timingOf(parsed);
      };
      try {
        todoTimingSchema.parse(afterTiming);
        await apply("timing", state.timingBefore ?? emptyTiming(), afterTiming, read, async () => {
          await config.request(path, "PATCH", { body: editScheduleBody(todo!.body, afterTiming) });
        });
      } catch (error) {
        outcomes.timing = "conflict";
        scheduleMessage = (error as Error).message;
      }
    }

    const fields = edit
      ? suppliedFields
      : { Commitment: "Inbox", ...suppliedFields };
    const entries = Object.entries(fields);
    if (entries.length) {
      // One fresh precondition snapshot and one readback for all independent fields.
      // Do not send unchanged/conflicting fields in the bulk mutation.
      const pending: { name: string; id: number; after: string | number | null }[] = [];
      try {
        const checkPriority = entries.some(([name, input]) => name === "Top priority" &&
          (edit ? (input as { after: unknown }).after : input) === "Yes");
        const [current, tasks] = await Promise.all([
          reader.detail(number), checkPriority ? reader.list("priority") : Promise.resolve([]),
        ]);
        todo = current;
        for (const [name, input] of entries) {
          const { before, after } = edit
            ? input as { before: string | number | null; after: string | number | null }
            : { before: null, after: input as string | number | null };
          const value = todo.fields[name] ?? null;
          if (canonical(value) === canonical(after)) {
            outcomes[name] = "saved";
            state.done[name] = true;
          } else if (state.done[name] || canonical(value) !== canonical(before) ||
            (name === "Top priority" && after === "Yes" && tasks.filter(t => t.fields["Top priority"] === "Yes").length >= 3)) {
            outcomes[name] = "conflict";
          } else pending.push({ name, id: config.definitions.find(f => f.name === name)!.id, after });
        }
        await persist();
        if (pending.length) {
          const updates = pending.filter(field => field.after !== null);
          const operations = [
            ...(updates.length ? [() => config.request(`${path}/issue-field-values`, "POST", {
              issue_field_values: updates.map(field => ({ field_id: field.id, value: field.after })),
            })] : []),
            ...pending.filter(field => field.after === null).map(field =>
              () => config.request(`${path}/issue-field-values/${field.id}`, "DELETE")),
          ];
          // Deletes have separate endpoints. Bound their concurrency; reconcile even
          // after a rejected/lost response instead of assuming the entire batch failed.
          for (let offset = 0; offset < operations.length; offset += 4)
            await Promise.allSettled(operations.slice(offset, offset + 4).map(operation => operation()));
          todo = await reader.detail(number);
          for (const field of pending) {
            outcomes[field.name] = canonical(todo.fields[field.name] ?? null) === canonical(field.after) ? "saved" : "uncertain";
            if (outcomes[field.name] === "saved") state.done[field.name] = true;
          }
          await persist();
        }
      } catch {
        for (const [name] of entries)
          if (!outcomes[name]) outcomes[name] = "uncertain";
      }
    }
    if (deadlineChange && outcomes.deadlineAt !== "conflict") {
      const after = deadlineChange.after ? { version: 1, date: deadlineDate(deadlineChange.after), at: deadlineChange.after } : null;
      if (after && todo.fields.Due !== after.date) outcomes.deadlineAt = "conflict";
      else await apply("deadlineAt", state.deadlineBefore ?? null, after,
        task => readStoredDeadline(task.body),
        async () => { await config.request(path, "PATCH", { body: editDeadlineBody(todo!.body, todo!.fields.Due, deadlineChange.after) }); });
    }
    if (!edit) {
      if (state.done.project) outcomes.project = "saved";
      else if ((state.projectAttempts ?? 0) >= 3) outcomes.project = "failed";
      else {
        state.projectAttempts = (state.projectAttempts ?? 0) + 1;
        await persist();
        try {
          await config.syncProject(todo.id);
          state.done.project = true;
          outcomes.project = "saved";
          await persist();
          // Personal Undo records the authoritative snapshot after Project sync.
          if (command.personalMail) todo = await reader.detail(number);
        } catch {
          outcomes.project = "failed";
        }
      }
    }
    if (command.provenance) {
      const source = command.provenance;
      const sourceMarker = `<!-- quantself:source ${key} -->`;
      const recorded = (task: Todo) =>
        task.comments?.some((c) => c.body.includes(sourceMarker));
      todo = await reader.detail(number);
      if (recorded(todo)) outcomes.provenance = "saved";
      else if (state.provenanceAttempted) outcomes.provenance = "uncertain";
      else {
        state.provenanceAttempted = true;
        await persist();
        try {
          await config.request(`${path}/comments`, "POST", {
            body: `${sourceMarker}\nSource: Jarvis conversation (evidence only)\nCaptured: ${source.capturedAt}\nCapture ID: ${source.captureId}\nConversation ID: ${source.conversationId}\nTool operation ID: ${source.operationId}\nOriginal transcript/audio: /api/v1/todo-captures/${source.captureId} (authenticated; final archive may be pending).`,
          });
        } catch {
          /* Reconcile lost responses without repeating a comment. */
        }
        todo = await reader.detail(number);
        outcomes.provenance = recorded(todo) ? "saved" : "uncertain";
      }
    }

    const complete = Object.values(outcomes).every((v) => v === "saved");
    const retryable = Object.entries(outcomes).some(
      ([name, status]) =>
        status === "uncertain" ||
        (status === "failed" &&
          name === "project" &&
          (state.projectAttempts ?? 0) < 3),
    );
    let message =
      "Some changes need attention. Review individual outcomes; retry the same command to reconcile uncertain operations.";
    if (
      edit &&
      timingRequested &&
      readTodoSchedule(todo?.body ?? null).scheduleError
    )
      message = readTodoSchedule(todo?.body ?? null).scheduleError!;
    if (scheduleMessage) message = scheduleMessage;
    if (complete) {
      message = edit && command.trash ? command.trash.after ? "Task moved to recoverable trash." : "Task restored from trash." : "Task saved.";
    } else if (
      outcomes.project === "failed" &&
      (state.projectAttempts ?? 0) >= 3
    ) {
      message =
        "Task save outcomes shown below. Project sync exhausted three attempts; reconcile membership on GitHub.";
    }
    return {
      commandId: command.commandId,
      todo: todo ? { ...todo, description: readTaskDescription(todo.body) } : null,
      outcomes,
      message: [message, ...relationshipFailures].join(" "),
      retryable,
    };
  }
}
