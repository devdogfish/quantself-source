import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { todoGitHub, type Todo } from "./todos-github";
import { jobLifecycleOutput, jobInterviewOutput } from "./jobs-lifecycle-contract";
import { jobsSubmissionsOutput } from "./jobs-operations-read";
import { jobsApplicationsOutput } from "./jobs-review-contract";
import type { TodoCommand, TodoWriteResult } from "./todos-write";

test.skipIf(process.env.QUANTSELF_JOBS_LIFECYCLE_FIXTURE !== "1")(
  "validates lifecycle, filters records, protects Agent Undo and reconciles one linked appointment",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_lifecycle_fixture") {
      throw new Error("Use a disposable Jobs lifecycle fixture database.");
    }
    const [{ prisma }, { createApp }] = await Promise.all([import("@quantself/db"), import("./app")]);
    const owner = { id: randomUUID(), name: "Fixture Owner", email: "jobs-owner@example.test" };
    const id = randomUUID(), otherId = randomUUID(), draftId = randomUUID();
    const base = "https://quantself.example.test";
    const calls: TodoCommand[] = [];
    const appointmentIds = new Set<string>();
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: async headers => {
        const kind = headers.get("x-fixture-client") === "agent" ? "agent" : "web";
        return { owner, client: { kind, id: kind, name: kind, avatar: null }, permissions: ["jobs:read", "jobs:write", "todos:write"] };
      },
      todos: { ...todoGitHub, write: async (_clientId, command): Promise<TodoWriteResult> => {
        calls.push(command);
        appointmentIds.add(command.commandId);
        if (calls.length === 1) return { commandId: command.commandId, todo: null,
          outcomes: { issue: "uncertain" }, message: "No acknowledgement", retryable: true };
        return { commandId: command.commandId, todo: { number: 82 } as Todo,
          outcomes: { issue: "saved", type: "saved", timing: "saved", Category: "saved", URL: "saved" }, message: "Saved", retryable: false };
      } },
    });
    const previousRoundcube = process.env.QUANTSELF_JOBS_ROUNDCUBE_URL;
    process.env.QUANTSELF_JOBS_ROUNDCUBE_URL = "https://roundcube.example.test/mail/";
    const jobsPath = "/api/v1/jobs/applications";
    const application = (target: string) => jobsPath + "/" + target;
    const lifecycle = (target: string) => application(target) + "/lifecycle";
    const call = (path: string, method = "GET", data?: unknown, kind = "web", key = randomUUID()) => app.request(base + path, {
      method, body: data === undefined ? undefined : JSON.stringify(data),
      headers: { origin: new URL(process.env.BETTER_AUTH_URL ?? base).origin,
        "content-type": "application/json", "idempotency-key": key, "x-fixture-client": kind },
    });
    try {
      await prisma.jobApplication.createMany({ data: [
        { ownerId: owner.id, id, company: "Fixture Labs", role: "Editor", sourceKey: "fixture-main", sourceUrl: "https://example.test/main",
          resumeTrack: "web", status: "applied", appliedAt: new Date("2026-11-14T18:00:00Z"), approvedRevision: 4, revision: 4, receiptCode: "confirmation_page" },
        { ownerId: owner.id, id: otherId, company: "Other Studio", role: "Tester", sourceKey: "fixture-other", sourceUrl: "https://example.test/other",
          resumeTrack: "engineering", status: "applied", appliedAt: new Date("2026-11-14T18:00:00Z") },
        { ownerId: owner.id, id: draftId, company: "Draft Co", role: "Tester", sourceKey: "fixture-draft", sourceUrl: "https://example.test/draft",
          resumeTrack: "admin", status: "draft" },
      ] });
      expect((await call(application(draftId), "PATCH", { status: "offer", expectedRevision: 0 })).status).toBe(409);
      expect((await call(application(id), "PATCH", { status: "interviewing", expectedRevision: 0,
        sourceReply: { folder: "INBOX", uid: 1, url: "https://evil.example.test/" } })).status).toBe(400);
      const payload = { status: "interviewing", expectedRevision: 0, sourceReply: { folder: "INBOX/R&D + notes", uid: 42 } };
      const key = randomUUID();
      const changed = await call(application(id), "PATCH", payload, "agent", key);
      expect(changed.status).toBe(200);
      const acknowledged = jobLifecycleOutput.parse(await changed.json());
      expect(acknowledged).toMatchObject({ application: { status: "interviewing", id }, revision: 1, sourceReplyLinked: true, sourceReplyUrl: null });
      expect(jobLifecycleOutput.parse(await (await call(application(id), "PATCH", payload, "agent", key)).json()).auditId).toBe(acknowledged.auditId);
      expect((await call(application(id), "PATCH", { status: "offer", expectedRevision: 0 }, "agent")).status).toBe(409);
      const detail = jobLifecycleOutput.parse(await (await call(lifecycle(id))).json());
      if (!detail.sourceReplyUrl) throw new Error("The Owner needs the original reply link.");
      const original = new URL(detail.sourceReplyUrl);
      expect(original.origin).toBe("https://roundcube.example.test");
      expect(Object.fromEntries(original.searchParams)).toEqual({ _task: "mail", _action: "show", _mbox: "INBOX/R&D + notes", _uid: "42" });
      const records = jobsApplicationsOutput.parse(await (await call(jobsPath + "?status=interviewing&track=web")).json());
      expect(records.rows.map(row => row.id)).toEqual([id]);
      expect(jobsApplicationsOutput.parse(await (await call(jobsPath + "?status=interviewing&track=engineering")).json()).total).toBe(0);

      const submissions = jobsSubmissionsOutput.parse(await (await call("/api/v1/jobs/submissions")).json());
      expect(submissions.items.find(item => item.id === id)).toMatchObject({ status: "applied", receipt: "confirmation_page" });

      const start = "2026-11-20T10:00:00-04:00", end = "2026-11-20T10:30:00-04:00";
      const appointments = jobsPath + "/" + id + "/interviews";
      expect((await call(appointments, "POST", { start, end }, "agent")).status).toBe(403);
      const results = await Promise.all([
        call(appointments, "POST", { start, end }),
        call(appointments, "POST", { start: "2026-11-20T14:00:00Z", end: "2026-11-20T14:30:00Z" }),
      ]);
      expect(results.map(result => result.status).sort()).toEqual([200, 503]);
      const saved = results.find(result => result.ok);
      if (!saved) throw new Error("The replay must confirm the original appointment.");
      const appointment = jobInterviewOutput.parse(await saved.json());
      expect(appointment).toMatchObject({ todoNumber: 82, start: "2026-11-20T14:00:00.000Z", end: "2026-11-20T14:30:00.000Z" });
      expect(await (await call(appointments, "POST", { start, end })).json()).toEqual(appointment);
      expect((await call(appointments, "POST", { start, end: "2026-11-20T15:00:00Z" })).status).toBe(409);
      expect(appointmentIds.size).toBe(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[0]).toMatchObject({ fixed: true, allDay: false, fields: { Category: "Job search", URL: base + "/jobs/applications?applicationId=" + id } });
      expect(jobLifecycleOutput.parse(await (await call(lifecycle(id))).json()).appointments).toEqual([appointment]);

      const undo = "/api/v1/agent-audit/" + acknowledged.auditId + "/undo";
      expect((await call(undo, "POST")).status).toBe(200);
      expect((await call(undo, "POST")).status).toBe(200);
      expect(await (await call(lifecycle(id))).json()).toMatchObject({
        application: { status: "applied" }, revision: 2, sourceReplyLinked: false, appointments: [appointment],
      });
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId: owner.id, id } } }))
        .toMatchObject({ revision: 4, approvedRevision: 4, appliedAt: new Date("2026-11-14T18:00:00Z") });
      expect((await call(application(id), "PATCH", { status: "offer", expectedRevision: 2 }, "agent")).status).toBe(409);

      const later = jobLifecycleOutput.parse(await (await call(application(otherId), "PATCH", { status: "offer", expectedRevision: 0 }, "agent")).json());
      expect(later.auditId).toBeString();
      expect((await call(application(otherId), "PATCH", { status: "withdrawn", expectedRevision: 1 })).status).toBe(200);
      expect((await call("/api/v1/agent-audit/" + later.auditId + "/undo", "POST")).status).toBe(409);
      expect((await call(application(otherId), "PATCH", { status: "interviewing", expectedRevision: 2 })).status).toBe(409);
    } finally {
      if (previousRoundcube === undefined) delete process.env.QUANTSELF_JOBS_ROUNDCUBE_URL;
      else process.env.QUANTSELF_JOBS_ROUNDCUBE_URL = previousRoundcube;
      await prisma.$disconnect();
    }
  },
  15_000,
);
