import { createHash } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { AgentWriteAudit, PrismaClient } from "@quantself/db/generated/prisma/client";
import { jsonAuthorizationFailure } from "./authorization-response";
import { personalAssistantCaptureResource, personalCaptureCommandId } from "./personal-capture-provenance";
import { TodoDelegationError } from "./todo-delegation";
import type { Todo, TodoReader } from "./todos-github";
import { personalCaptureRevision, personalMailSourceSchema, TodoWriteError, type TodoCommand } from "./todos-write";

export const personalAssistantCapturePath = "/api/v1/personal-assistant/captures";
export { personalAssistantCaptureResource } from "./personal-capture-provenance";
const permission = "personal-assistant:create";
const source = personalMailSourceSchema;
const title = z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const instant = z.iso.datetime({ offset: true });
const captureInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todo"), title, source }).strict(),
  z.object({ kind: z.literal("appointment"), title, source, start: instant, end: instant }).strict()
    .refine(({ start, end }) => {
      const duration = Date.parse(end) - Date.parse(start);
      return duration > 0 && duration <= 370 * 86_400_000;
    }, { path: ["end"], message: "End must be after start and within the supported 370-day calendar range." }),
]).openapi("PersonalAssistantCapture");
const captureReceipt = z.object({
  auditId: z.uuid(),
  commandId: z.uuid(),
  kind: z.enum(["todo", "appointment"]),
  number: z.number().int().positive().safe(),
  undone: z.boolean(),
}).openapi("PersonalAssistantCaptureReceipt");
const storedCapture = captureReceipt.pick({ kind: true, number: true }).extend({
  fingerprint: z.string(),
  sourceRevision: z.string(),
  saveRevision: z.string(),
});
type Env = { Variables: { accessContext: AccessContext | null } };

export async function personalCaptureUndoId(db: PrismaClient, access: AccessContext, todo: Todo) {
  if (access.client.kind !== "web" || !access.permissions.includes("todos:write") || todo.trashed) return;
  const id = personalCaptureCommandId(todo.body);
  if (!id) return;
  return (await db.agentWriteAudit.findUnique({
    where: { id, ownerId: access.owner.id, resourceType: personalAssistantCaptureResource, resourceId: todo.id, undoneAt: null },
    select: { id: true },
  }))?.id;
}

function captureIdentity(ownerId: string, from: z.infer<typeof source>) {
  // Use one ID for the durable writer reservation and Owner Undo receipt.
  const bytes = createHash("sha256").update(JSON.stringify(["personal-assistant:gmail:v1", ownerId, from.messageId, from.actionKey])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
}

function replayCapture(record: AgentWriteAudit, fingerprint: string) {
  const saved = storedCapture.safeParse(record.after);
  if (record.resourceType !== personalAssistantCaptureResource || !saved.success || saved.data.fingerprint !== fingerprint)
    throw new TodoWriteError("IDEMPOTENCY_CONFLICT", "This Gmail action already has a different capture.");
  return {
    auditId: record.id,
    commandId: record.id,
    kind: saved.data.kind,
    number: saved.data.number,
    undone: record.undoneAt !== null,
  };
}

export function registerPersonalAssistantCaptureRoutes(
  app: OpenAPIHono<Env>,
  todos: TodoReader,
  db: PrismaClient = prisma,
  clientId = process.env.QUANTSELF_PERSONAL_ASSISTANT_CLIENT_ID,
) {
  const failure = {
    description: "Capture refused or unconfirmed.",
    content: { "application/json": {
      schema: z.object({ code: z.string(), message: z.string() }),
      example: { code: "CAPTURE_UNCONFIRMED", message: "Capture is unconfirmed. Retry the exact source and input." },
    } },
  };
  app.openapi(createRoute({
    method: "post",
    path: personalAssistantCapturePath,
    operationId: "createPersonalAssistantCapture",
    tags: ["To-Dos"],
    summary: "Capture one Gmail action for the Personal Assistant",
    description: "Authentication: X-API-Key for the configured Personal Assistant Agent client. Required permissions: personal-assistant:create. Inputs: stable Gmail message ID and action key, task title, and explicit offset start and end for an Appointment. Success response: one saved record and Owner Undo audit ID. Failure responses: invalid input, denied, conflicting action or timing, or unconfirmed submission. Side effects: adds one private Quantself To-Do or fixed Appointment, with no invitations. Destructive: no. Retry safety: submit the same source and input after an uncertain outcome. Never allocate a replacement action key for an uncertain capture.",
    security: [{ apiKeyAuth: [] }],
    "x-required-permissions": [permission],
    "x-destructive": false,
    request: { body: { required: true, content: { "application/json": { schema: captureInput, example: { kind: "todo", title: "Call the plumber", source: { messageId: "gmail-fixture", actionKey: "call-plumber" } } } } } },
    responses: {
      201: {
        description: "Saved personal capture or a replay of its current receipt.",
        content: { "application/json": {
          schema: captureReceipt,
          example: { auditId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", kind: "todo", number: 42, undone: false },
        } },
      },
      400: failure, 401: failure, 403: failure, 409: failure, 503: failure,
    },
  }), async context => {
    context.header("Cache-Control", "private, no-store");
    const access = context.get("accessContext");
    const auth = authorizeAccessContext(access, permission);
    if (!auth.ok) return jsonAuthorizationFailure(context, auth.error);
    if (!clientId || auth.accessContext.client.kind !== "agent" || auth.accessContext.client.id !== clientId) {
      return context.json({ code: "FORBIDDEN", message: "The Personal Assistant client is required." }, 403);
    }
    const input = context.req.valid("json");
    const ownerId = auth.accessContext.owner.id;
    const id = captureIdentity(ownerId, input.source);
    const timing = input.kind === "appointment" ? {
      start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString(), fixed: true,
    } : {};
    const command: TodoCommand = {
      commandId: id, title: input.title, personalMail: { ...input.source, ownerId }, ...timing,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify([input.kind, input.title, timing])).digest("hex");
    const where = { id, ownerId };
    try {
      const existing = await db.agentWriteAudit.findUnique({ where });
      if (existing) return context.json(replayCapture(existing, fingerprint), 201);
      if (!todos.write) throw new TodoWriteError("CAPTURE_UNAVAILABLE", "Personal capture is unavailable.", 503);
      // The namespace is stable across key rotation. Only this route uses it.
      const { todo, outcomes } = await todos.write(`personal-assistant:${ownerId}`, command);
      if (!todo || outcomes.issue !== "saved" || outcomes.type !== "saved" ||
          outcomes.project !== "saved" || input.kind === "appointment" && outcomes.timing !== "saved") {
        throw new TodoWriteError("CAPTURE_UNCONFIRMED", "Capture is unconfirmed. Retry the exact source and input.", 503);
      }
      if (todo.title !== input.title || todo.trashed || todo.state !== "open" ||
          input.kind === "appointment" && (todo.start !== command.start || todo.end !== command.end || !todo.fixed)) {
        throw new TodoWriteError("CAPTURE_CHANGED", "The captured record has already changed.");
      }
      let receipt;
      try {
        receipt = await db.agentWriteAudit.create({ data: {
          ...where, clientId, clientName: auth.accessContext.client.name,
          resourceType: personalAssistantCaptureResource, resourceId: todo.id, revisionBefore: 0, revisionAfter: 1,
          before: {}, after: { kind: input.kind, number: todo.number, title: input.title, ...timing,
            source: { provider: "gmail", ...input.source }, sourceRevision: todo.updatedAt,
            saveRevision: personalCaptureRevision(todo), fingerprint },
        } });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        receipt = await db.agentWriteAudit.findUniqueOrThrow({ where });
      }
      return context.json(replayCapture(receipt, fingerprint), 201);
    } catch (error) {
      if (error instanceof TodoWriteError) return context.json({ code: error.code, message: error.message }, error.status);
      return context.json({ code: "CAPTURE_UNCONFIRMED", message: "Capture is unconfirmed. Retry the exact source and input." }, 503);
    }
  });
}

export async function undoPersonalAssistantCapture(db: PrismaClient, todos: TodoReader | undefined, access: AccessContext, audit: AgentWriteAudit) {
  if (access.client.kind !== "web" || !access.permissions.includes("todos:write") || audit.ownerId !== access.owner.id)
    throw new TodoDelegationError(403, "An Owner Session with To-Do Write is required for Undo.");
  const saved = storedCapture.safeParse(audit.after);
  if (!saved.success) throw new TodoDelegationError(409, "The original capture receipt is invalid.");
  if (!todos?.write) throw new TodoDelegationError(503, "Capture Undo is temporarily unavailable.");
  try {
    const current = await todos.detail(saved.data.number);
    if (current.id !== audit.resourceId || !audit.undoneAt && !current.trashed && personalCaptureRevision(current) !== saved.data.saveRevision)
      throw new TodoDelegationError(409, "The captured record changed after creation.");
    if (audit.undoneAt) return { audit, todo: current };
    const result = await todos.write(`personal-assistant-undo:${access.owner.id}`, {
      commandId: audit.id, number: current.number, revision: saved.data.sourceRevision,
      personalUndoRevision: saved.data.saveRevision, trash: { before: false, after: true },
    });
    if (result.outcomes.trash === "conflict") throw new TodoDelegationError(409, "The captured record changed after creation.");
    if (result.outcomes.trash !== "saved" || result.todo?.id !== audit.resourceId || !result.todo.trashed)
      throw new TodoDelegationError(503, "Undo is unconfirmed. Retry this same audit entry.");
    const where = { id: audit.id, ownerId: access.owner.id };
    await db.agentWriteAudit.updateMany({ where: { ...where, undoneAt: null }, data: { undoneAt: new Date() } });
    return { audit: await db.agentWriteAudit.findUniqueOrThrow({ where }), todo: result.todo, cacheGeneration: result.cacheGeneration };
  } catch (error) {
    if (error instanceof TodoDelegationError) throw error;
    throw new TodoDelegationError(503, "Undo is unconfirmed. Retry this same audit entry.");
  }
}
