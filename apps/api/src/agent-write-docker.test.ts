import { expect, test } from "bun:test";
import { createAgentApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "@quantself/auth";
import { OWNER_INGRESS_HEADER } from "@quantself/auth/owner-ingress";
import { prisma } from "@quantself/db";
import { createApp } from "./app";
import type { Todo } from "./todos-github";

test.skipIf(process.env.AGENT_WRITE_DOCKER_TEST !== "1")(
  "scoped Agent key, Owner hands-off, transactional audit, concurrent edits and conditional Undo",
  async () => {
    const owner = { id: crypto.randomUUID(), name: "Agent write fixture", email: "agent-write-fixture@example.com" };
    const url = "https://qs.girke.dev";
    const proof = "7d".repeat(32);
    const oldToken = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    const oldOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const editKeys: string[] = [];
    const app = createApp({
      emitAccessLog: () => {},
    });

    try {
      process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
      process.env.QUANTSELF_PUBLIC_ORIGIN = url;
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const { client, secret } = await createAgentApiKey({
        name: "Sam Lee", avatar: "https://example.com/sam.png", userId: owner.id,
        permissionIds: ["jobs:read", "jobs:write"],
      });
      const readOnly = await createAgentApiKey({
        name: "Read Only", userId: owner.id, permissionIds: ["jobs:read"],
      });
      const jsonHeaders = { "content-type": "application/json" };
      const ownerHeaders = { ...jsonHeaders, [OWNER_INGRESS_HEADER]: proof, origin: url };
      const agentHeaders = { ...jsonHeaders, "x-api-key": secret };
      const access = await app.request(`${url}/api/v1/access-context`, { headers: agentHeaders });
      expect(await access.json()).toMatchObject({ client, permissions: ["jobs:read", "jobs:write"] });

      const job = await prisma.jobApplication.create({
        data: {
          ownerId: owner.id, sourceKey: "agent-test", sourceUrl: "https://example.com/jobs/1",
          company: "Example Studio", role: "Web Engineer", resumeTrack: "web",
        },
      });
      const jobPath = `${url}/api/v1/jobs/applications/${job.id}`;
      const auditPath = `${url}/api/v1/agent-audit`;
      const edit = (expectedRevision: number, summary: string, headers: Record<string, string> = agentHeaders) => {
        const key = crypto.randomUUID();
        editKeys.push(key);
        return app.request(jobPath, {
          method: "PATCH",
          headers: { ...headers, "idempotency-key": key },
          body: JSON.stringify({ expectedRevision, summaryMarkdown: `- ${summary}` }),
        });
      };
      const undo = (id: string, headers: Record<string, string> = ownerHeaders) =>
        app.request(`${auditPath}/${id}/undo`, { method: "POST", headers });

      expect((await edit(1, "Forbidden", { ...agentHeaders, "x-api-key": readOnly.secret })).status).toBe(403);
      const read = await app.request(jobPath, { headers: agentHeaders });
      expect(await read.json()).toMatchObject({ application: { revision: 1 } });

      // Simultaneous edits using one revision produce exactly one audited write.
      const responses = await Promise.all([edit(1, "First draft"), edit(1, "Second draft")]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const saved = await responses.find(response => response.ok)!.json() as {
        auditId: string; application: { revision: number; summaryMarkdown: string };
      };
      expect(saved.application.revision).toBe(2);
      expect((await app.request(auditPath, { headers: agentHeaders })).status).toBe(403);
      const timeline = await app.request(`${auditPath}?limit=1`, { headers: ownerHeaders });
      expect(await timeline.json()).toMatchObject({
        audits: [{
          id: saved.auditId, clientId: client.id, clientName: "Sam Lee",
          resourceId: job.id, revisionBefore: 1, revisionAfter: 2,
          before: { summary: "" }, after: { summary: saved.application.summaryMarkdown }, undoneAt: null,
        }],
        nextCursor: null,
      });
      expect((await undo(saved.auditId, agentHeaders)).status).toBe(403);
      expect((await undo(saved.auditId, {})).status).toBe(401);
      expect((await undo(saved.auditId, { [OWNER_INGRESS_HEADER]: proof })).status).toBe(403);
      const undoResponses = await Promise.all([undo(saved.auditId), undo(saved.auditId)]);
      expect(undoResponses.map(response => response.status)).toEqual([200, 200]);
      const undonePayload = await undoResponses[0].json() as { audit: { undoneAt: string } };
      expect(await undoResponses[1].json()).toEqual(undonePayload);
      expect(undonePayload.audit.undoneAt).toEqual(expect.any(String));
      expect(await (await undo(saved.auditId)).json()).toEqual(undonePayload);
      expect(await (await app.request(jobPath, { headers: agentHeaders })).json()).toMatchObject({
        application: { revision: 3, summaryMarkdown: "", status: "draft" },
      });
      const handsOff = await edit(3, "Too soon");
      expect(handsOff.status).toBe(409);
      expect(await handsOff.json()).toMatchObject({ message: expect.stringContaining("last 3 minutes") });

      // Advance past the hands-off window without waiting three minutes.
      await prisma.jobApplication.update({ where: { ownerId_id: { ownerId: owner.id, id: job.id } }, data: {
        lastOwnerEditedAt: new Date(Date.now() - 180_001),
      } });
      const second = await edit(3, "Agent again");
      expect(second.status).toBe(200);
      const { auditId } = await second.json() as { auditId: string };
      expect((await edit(4, "Owner correction", ownerHeaders)).status).toBe(200);
      expect((await undo(auditId)).status).toBe(409);
      expect(await (await app.request(jobPath, { headers: agentHeaders })).json()).toMatchObject({
        application: { revision: 5, summaryMarkdown: "- Owner correction" },
      });
      const ownerHandsOff = await edit(5, "Too soon after Owner correction");
      expect(ownerHandsOff.status).toBe(409);
      expect(await ownerHandsOff.json()).toMatchObject({ message: expect.stringContaining("last 3 minutes") });

      type AuditPage = { audits: { id: string }[]; nextCursor: string | null };
      const page = await (await app.request(`${auditPath}?limit=1`, { headers: ownerHeaders })).json() as AuditPage;
      expect(page.audits.map(audit => audit.id)).toEqual([auditId]);
      expect(page.nextCursor).toBe(auditId);
      const older = await (await app.request(`${auditPath}?limit=1&cursor=${page.nextCursor}`, { headers: ownerHeaders })).json() as AuditPage;
      expect(older.audits.map(audit => audit.id)).toEqual([saved.auditId]);
      expect(older.nextCursor).toBeNull();
    } finally {
      if (oldToken === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = oldToken;
      if (oldOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = oldOrigin;
      await prisma.$transaction([
        prisma.apiIdempotencyKey.deleteMany({ where: { idempotencyKey: { in: editKeys } } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.jobApplication.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apikey.deleteMany({ where: { referenceId: owner.id } }),
        prisma.authOwner.deleteMany({ where: { userId: owner.id } }),
        prisma.user.deleteMany({ where: { id: owner.id } }),
      ]);
      await prisma.$disconnect();
    }
  },
);

test.skipIf(process.env.AGENT_WRITE_DOCKER_TEST !== "1")(
  "trusted ingress uses the existing Owner without a session and keeps Agent permissions and key management independent",
  async () => {
    const oldToken = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    const oldOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const proof = "7e".repeat(32);
    const origin = "https://qs.girke.dev";
    const trusted = { [OWNER_INGRESS_HEADER]: proof };
    const owner = { id: crypto.randomUUID(), name: "Existing owner", email: "legacy-owner@example.com" };
    const todo: Todo = {
      id: `fixture-${crypto.randomUUID()}`, databaseId: 1, number: 1, title: "Fixture task",
      repository: "fixture/tasks", url: "https://example.test/tasks/1",
      body: null, state: "open", closureReason: null, updatedAt: "2026-11-14T00:00:00Z",
      labels: [], fields: {}, fieldValues: [], start: null, end: null, allDay: false, fixed: false, scheduleError: null,
    };
    const app = createApp({
      emitAccessLog: () => {},
      todos: { list: async () => [todo], detail: async () => todo },
      todoDelegation: { db: prisma },
    });
    const access = (headers: Record<string, string>) => app.request(`${origin}/api/v1/access-context`, { headers });
    const undo = (headers: Record<string, string>) =>
      app.request(`${origin}/api/v1/agent-audit/${crypto.randomUUID()}/undo`, { method: "POST", headers });
    const delegates = (headers: Record<string, string>) => app.request(`${origin}/api/v1/todo-delegates`, { headers });
    try {
      process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
      process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
      expect((await access(trusted)).status).toBe(401); // Never creates a missing Owner.
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const sessionCount = () => prisma.session.count({ where: { userId: owner.id } });
      const retainedSession = await prisma.session.create({
        data: { id: crypto.randomUUID(), token: crypto.randomUUID(), userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
      });
      const cookie = `better-auth.session_token=${retainedSession.token}`;
      for (const headers of [
        {},
        { cookie },
        { "tailscale-user-login": owner.email, "x-forwarded-for": "100.64.1.2" },
        { [OWNER_INGRESS_HEADER]: `${proof}, ${proof}` },
        { [OWNER_INGRESS_HEADER]: "8e".repeat(32), cookie },
      ]) {
        expect((await access(headers as Record<string, string>)).status).toBe(401);
      }
      const ownerResponse = await access(trusted);
      expect(ownerResponse.status).toBe(200);
      expect(ownerResponse.headers.get("cache-control")).toBe("private, no-store");
      expect(ownerResponse.headers.get("set-cookie")).toBeNull();
      expect(await ownerResponse.json()).toMatchObject({ owner, client: { kind: "web" } });
      for (const extra of [{}, { origin: "null" }, { origin: "https://foreign.example" }]) {
        expect((await undo({ ...trusted, ...extra } as Record<string, string>)).status).toBe(403);
      }
      expect((await undo({ ...trusted, origin })).status).toBe(404);
      expect((await app.request("/api/health")).status).toBe(200);
      for (const path of ["/api/auth/ok", "/api/auth/get-session", "/api/owner-setup/state"]) {
        expect((await app.request(path, { headers: { ...trusted, cookie } })).status).toBe(404);
      }

      const key = await createAgentApiKey({ userId: owner.id, name: "Existing Agent", permissionIds: ["jobs:read"] });
      const explicitKey = { ...trusted, "x-api-key": key.secret };
      expect(await (await access(explicitKey)).json()).toMatchObject({ owner, client: key.client, permissions: ["jobs:read"] });
      expect((await access({ ...trusted, "x-api-key": "invalid" })).status).toBe(401);
      expect((await undo({ ...explicitKey, origin })).status).toBe(403);
      const listed = await listApiKeys({ userId: owner.id });
      expect(listed).toMatchObject([{ id: key.credential.id, agentClient: key.client }]);
      expect(JSON.stringify(listed)).not.toContain(key.secret);
      expect(await listApiKeys({ userId: "non-owner" })).toEqual([]);
      await expect(revokeApiKey({ credentialId: key.credential.id, userId: "non-owner" })).rejects.toThrow("API key not found.");
      const rotated = await rotateApiKey({ credentialId: key.credential.id, overlapMinutes: 15, userId: owner.id });
      expect(await (await access({ "x-api-key": rotated.secret })).json()).toMatchObject({ client: key.client, permissions: ["jobs:read"] });
      await revokeApiKey({ credentialId: rotated.credential.id, userId: owner.id });
      expect((await access({ "x-api-key": rotated.secret })).status).toBe(401);

      const eligible = await createAgentApiKey({ userId: owner.id, name: "To-do Agent", permissionIds: ["todos:read"] });
      const delegate = { id: eligible.client.id, name: eligible.client.name };
      expect((await delegates({})).status).toBe(401);
      expect((await delegates({ "x-api-key": eligible.secret })).status).toBe(403);
      const directory = await delegates(trusted);
      expect(directory.status).toBe(200);
      expect(await directory.json()).toEqual({ agents: [delegate] });

      const assigned = await app.request(`${origin}/api/v1/todos/1/delegation`, {
        method: "PATCH",
        headers: { ...trusted, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), todoId: todo.id, expectedRevision: 0, delegateId: delegate.id }),
      });
      expect(assigned.status).toBe(200);
      expect(await assigned.json()).toMatchObject({ delegation: { delegate, revision: 1 }, auditId: expect.any(String) });
      expect(await sessionCount()).toBe(1);
      expect(await prisma.session.findUnique({ where: { id: retainedSession.id } })).toEqual(retainedSession);
    } finally {
      if (oldToken === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = oldToken;
      if (oldOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = oldOrigin;
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: { ownerId: owner.id, todoId: todo.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apiIdempotencyKey.deleteMany({ where: { clientId: owner.id, operation: "setTodoDelegate" } }),
        prisma.apikey.deleteMany({ where: { referenceId: owner.id } }),
        prisma.session.deleteMany({ where: { userId: owner.id } }),
        prisma.authOwner.deleteMany({ where: { userId: owner.id } }),
        prisma.user.deleteMany({ where: { id: owner.id } }),
      ]);
      await prisma.$disconnect();
    }
  },
);
