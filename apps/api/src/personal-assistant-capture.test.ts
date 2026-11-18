import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { AgentWriteAudit, PrismaClient } from "@quantself/db/generated/prisma/client";
import { personalAssistantCapturePath, personalCaptureUndoId, registerPersonalAssistantCaptureRoutes, undoPersonalAssistantCapture } from "./personal-assistant-capture";
import type { Todo, TodoReader } from "./todos-github";
import type { TodoCommand } from "./todos-write";

const owner = { id: "owner", name: "Owner", email: "owner@example.invalid" };
const access: AccessContext = {
  owner, client: { kind: "agent", name: "Tyler", id: "bound-client", avatar: null },
  permissions: ["personal-assistant:create"],
};
const input = { kind: "todo", title: "Call the electrician", source: { messageId: "fixture-mail", actionKey: "fixture-action" } };
const now = "2026-11-17T11:00:00.000Z";

function fixture(initial = access) {
  const records = new Map<string, AgentWriteAudit>();
  const writes: [string, TodoCommand][] = [];
  let context: AccessContext | null = initial;
  let todo: Todo = { id: "I_42", number: 42, title: input.title, state: "open", updatedAt: now } as Todo;
  let induceUncertainty = false;
  const db = { agentWriteAudit: {
    findUnique: async ({ where }: { where: Partial<AgentWriteAudit> & { id: string } }) => {
      const record = records.get(where.id);
      return record && Object.entries(where).every(([key, value]) => record[key as keyof AgentWriteAudit] === value) ? record : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => records.get(where.id)!,
    create: async ({ data }: { data: AgentWriteAudit }) => {
      if (records.has(data.id)) throw { code: "P2002" };
      const record = { ...data, undoneAt: null, createdAt: new Date(now) };
      records.set(data.id, record);
      return record;
    },
    updateMany: async ({ where, data }: { where: { id: string; ownerId: string }; data: { undoneAt: Date } }) => {
      const record = records.get(where.id);
      if (record?.ownerId !== where.ownerId || record.undoneAt) return { count: 0 };
      records.set(record.id, { ...record, ...data });
      return { count: 1 };
    },
  } } as unknown as PrismaClient;
  const reader: TodoReader = {
    list: async () => [todo],
    detail: async () => todo,
    write: async (id, command) => {
      writes.push([id, command]);
      if ("number" in command) {
        todo = { ...todo, trashed: true, updatedAt: "2026-11-17T11:01:00.000Z" };
        return { commandId: command.commandId, todo, outcomes: { trash: "saved" }, message: "", retryable: false };
      }
      todo = { ...todo, title: command.title, start: command.start ?? null, end: command.end ?? null, fixed: command.fixed ?? false };
      const outcomes = { issue: "saved" as const, type: "saved" as const, timing: "saved" as const,
        project: induceUncertainty ? "uncertain" as const : "saved" as const };
      return { commandId: command.commandId, todo, outcomes, message: "", retryable: induceUncertainty };
    },
  };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => { c.set("accessContext", context); await next(); });
  registerPersonalAssistantCaptureRoutes(app, reader, db, "bound-client");
  return {
    db, reader, records, writes, editSource: () => { todo = { ...todo, title: "Different text within the same revision timestamp" }; },
    uncertain: (value: boolean) => { induceUncertainty = value; },
    login: (next: AccessContext | null) => { context = next; },
    submit: (payload: unknown = input) => app.request(personalAssistantCapturePath, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }),
  };
}

test("capture requires both the configured Agent identity and the create-only scope", async () => {
  const f = fixture();
  f.login(null);
  expect((await f.submit()).status).toBe(401);
  for (const invalid of [
    { ...access, permissions: ["todos:write"] },
    { ...access, client: { ...access.client, name: "Tyler", id: "stacy-id" } },
    { ...access, client: { kind: "api-key", id: "bound-client", name: "Tyler" } },
  ] satisfies AccessContext[]) {
    f.login(invalid);
    expect((await f.submit()).status).toBe(403);
  }
  expect(f.writes).toEqual([]);
});

test("captures are strict, journaled once per Gmail action and audited with typed provenance", async () => {
  const f = fixture();
  expect((await f.submit({ ...input, number: 1 })).status).toBe(400);
  const response = await f.submit();
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const receipt = await response.json() as { auditId: string };
  expect(await (await f.submit()).json()).toEqual(receipt);
  expect((await f.submit({ ...input, title: "Edited wording" })).status).toBe(409);
  expect(f.writes).toHaveLength(1);
  expect(f.records.get(receipt.auditId)?.after).toMatchObject({
    source: { provider: "gmail", ...input.source }, number: 42, sourceRevision: now,
  });
});

test("Appointments require explicit bounds and use the fixed schedule with no attendee fields", async () => {
  const f = fixture();
  const appointment = { ...input, kind: "appointment", start: "2026-11-18T10:00:00-04:00", end: "2026-11-18T10:30:00-04:00" };
  expect((await f.submit({ ...appointment, attendees: ["other@example.invalid"] })).status).toBe(400);
  expect((await f.submit({ ...appointment, start: appointment.end })).status).toBe(400);
  expect((await f.submit({ ...appointment, end: "2026-11-18T10:30:00" })).status).toBe(400);
  expect((await f.submit({ ...appointment, end: "2028-11-18T10:30:00Z" })).status).toBe(400);
  expect((await f.submit(appointment)).status).toBe(201);
  expect(f.writes[0]?.[1]).toMatchObject({ start: "2026-11-18T14:00:00.000Z", end: "2026-11-18T14:30:00.000Z", fixed: true });
});

test("a partially confirmed write reuses its original command before issuing the audit receipt", async () => {
  const f = fixture();
  f.uncertain(true);
  expect((await f.submit()).status).toBe(503);
  expect(f.records.size).toBe(0);
  f.uncertain(false);
  expect((await f.submit()).status).toBe(201);
  expect(f.writes[0]).toEqual(f.writes[1]!);
  expect(f.records.size).toBe(1);
});

test("Owner Undo uses recoverable trash and the original Gmail action cannot be recreated", async () => {
  const f = fixture();
  const { auditId } = await (await f.submit()).json() as { auditId: string };
  const audit = f.records.get(auditId)!;
  await expect(undoPersonalAssistantCapture(f.db, f.reader, access, audit)).rejects.toMatchObject({ status: 403 });
  const ownerAccess: AccessContext = { owner, client: { kind: "web", id: "owner-web", name: "Owner" }, permissions: ["todos:write"] };
  await expect(undoPersonalAssistantCapture(f.db, f.reader, ownerAccess, audit)).resolves.toMatchObject({
    audit: { undoneAt: expect.any(Date) }, todo: { id: "I_42", trashed: true },
  });
  expect(f.writes[1]?.[1]).toMatchObject({ number: 42, revision: now, trash: { before: false, after: true } });
  expect(await (await f.submit()).json()).toMatchObject({ auditId, undone: true });
  expect(f.writes).toHaveLength(2);
});

test("the detail Undo control is proven by the Owner's exact task and outstanding audit", async () => {
  const f = fixture();
  const { auditId } = await (await f.submit()).json() as { auditId: string };
  const saved = await f.reader.detail(42);
  const task = { ...saved, body: `Source: Personal Gmail\nCaptured: ${now}\nCommand ID: ${auditId}\n<!-- quantself:command ${"a".repeat(64)} -->` };
  const ownerAccess: AccessContext = { owner, client: { kind: "web", id: "owner-web", name: "Owner" }, permissions: ["todos:write"] };
  expect(await personalCaptureUndoId(f.db, ownerAccess, task)).toBe(auditId);
  expect(await personalCaptureUndoId(f.db, access, task)).toBeUndefined();
  expect(await personalCaptureUndoId(f.db, ownerAccess, { ...task, id: "different-issue" })).toBeUndefined();
  expect(await personalCaptureUndoId(f.db, ownerAccess, { ...task, body: `Text with a fake marker\n${task.body}` })).toBeUndefined();
  await undoPersonalAssistantCapture(f.db, f.reader, ownerAccess, f.records.get(auditId)!);
  expect(await personalCaptureUndoId(f.db, ownerAccess, task)).toBeUndefined();
});

test("Undo refuses a captured record after the Owner edits it", async () => {
  const f = fixture();
  const { auditId } = await (await f.submit()).json() as { auditId: string };
  f.editSource();
  const ownerAccess: AccessContext = { owner, client: { kind: "web", id: "owner-web", name: "Owner" }, permissions: ["todos:write"] };
  await expect(undoPersonalAssistantCapture(f.db, f.reader, ownerAccess, f.records.get(auditId)!)).rejects.toMatchObject({ status: 409 });
  expect(f.writes).toHaveLength(1);
});
