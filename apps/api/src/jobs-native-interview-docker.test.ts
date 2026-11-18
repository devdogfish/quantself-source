import { expect, test } from "bun:test";
import { createAgentApiKey, createApiKey } from "@quantself/auth";
import { OWNER_INGRESS_HEADER } from "@quantself/auth/owner-ingress";
import { prisma } from "@quantself/db";
import { createApp } from "./app";
import {
  jobInterviewOutput, jobLifecycleOutput, nativeJobInterviewDetail, nativeJobInterviewListOutput, scheduleJobInterviewOutput,
} from "./jobs-lifecycle-contract";
import { scheduleInFreshJobsApi, undoInFreshJobsApi } from "../../../scripts/jobs/fixtures/native-appointment-restart";
import { todoGitHub, type Todo } from "./todos-github";

test.skipIf(process.env.QUANTSELF_NATIVE_INTERVIEW_FIXTURE !== "1")(
  "scoped CLI resolves a reply, changes lifecycle and schedules a native Appointment with audited Undo and replay",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.hostname !== "127.0.0.1" || !database.port || database.pathname !== "/native_interview_fixture") {
      throw Error("Use the disposable Docker database native_interview_fixture.");
    }

    const owner = { id: "native-interview-fixture-owner", name: "Fixture Owner", email: "native-interview@example.test" };
    const historicalJobId = "b81f7db0-2eda-48ae-9937-f97bc1997395";
    const foreignJobId = crypto.randomUUID();
    const ownerJobId = crypto.randomUUID();
    const competingSesId = "0100010000000001-fixture-competing-000000";
    const foreignAppointmentId = crypto.randomUUID();
    const origin = "https://qs.girke.dev";
    const proof = "7f".repeat(32);
    const ownerProof = { [OWNER_INGRESS_HEADER]: proof };
    const oldToken = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    const oldOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const previousActivation = process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS;
    const oldConfirmedId = "c063028d-5cb8-478e-ae12-a8015d0938a5";
    const oldPendingId = "df8f0ed7-d5cc-4d7f-b82b-3507c5729589";
    const time = (day: number, hour = 14) => ({
      start: `2026-11-${day}T${hour}:00:00Z`, end: `2026-11-${day}T${hour}:30:00Z`,
    });
    const writerCalls: string[] = [];
    const app = createApp({
      emitAccessLog() {},
      todos: { ...todoGitHub, write: async (_clientId, command) => {
        writerCalls.push(command.commandId);
        return { commandId: command.commandId, todo: { number: 96 + writerCalls.length } as Todo,
          outcomes: { issue: "saved", type: "saved", timing: "saved", Category: "saved", URL: "saved" }, message: "Saved", retryable: false };
      } },
    });
    let lostKey: string | undefined;
    const requests: [method: string, pathname: string, status: number][] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      let response = await app.fetch(request);
      if (lostKey && request.headers.get("idempotency-key") === lostKey && response.ok) {
        lostKey = undefined;
        await response.arrayBuffer();
        response = Response.json({ message: "Fixture lost the committed response." }, { status: 503 });
      }
      requests.push([request.method, new URL(request.url).pathname, response.status]);
      return response;
    } });

    async function cli(key: string, args: string[]) {
      const child = Bun.spawn([Bun.which("bun")!, "--no-env-file", "packages/cli/src/index.ts", ...args], {
        env: { PATH: process.env.PATH, QUANTSELF_API_URL: server.url.origin, QUANTSELF_API_KEY: key },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, output, error] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, body: JSON.parse(code === 0 ? output : error) };
    }
    const jobPath = (id: string) => "/api/v1/jobs/applications/" + id;
    const schedule = (secret: string, input: object, id = historicalJobId, key = crypto.randomUUID()) =>
      cli(secret, ["scheduleJobInterview", "--path", JSON.stringify({ id }), "--body", JSON.stringify(input), "--idempotency-key", key]);

    try {
      process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
      process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const [{ client, secret }, otherAgent, wrongGrant, ordinaryKey] = await Promise.all([
        createAgentApiKey({ name: "Sam", userId: owner.id, permissionIds: ["jobs:read", "jobs:schedule-interview"] }),
        createAgentApiKey({ name: "Another Agent", userId: owner.id, permissionIds: ["jobs:schedule-interview"] }),
        createAgentApiKey({ name: "General Jobs writer", userId: owner.id, permissionIds: ["jobs:read", "jobs:write", "todos:write"] }),
        createApiKey({ name: "Regular client", userId: owner.id, preset: "custom", permissionIds: ["jobs:schedule-interview", "jobs:write"] }),
      ]);
      const ownerRequest = (path: string, body?: object, method = body ? "POST" : "GET", headers?: Record<string, string>) => app.request(origin + path, {
        method, headers: { ...ownerProof, origin, ...(body && { "content-type": "application/json" }), ...headers },
        ...(body && { body: JSON.stringify(body) }),
      });
      const undo = (auditId: string) => ownerRequest(`/api/v1/agent-audit/${auditId}/undo`, undefined, "POST");
      const range = "/api/v1/jobs/interview-appointments";
      const appointmentWindow = "?from=2026-11-23T00:00:00Z&to=2026-11-25T00:00:00Z";
      const edit = (id: string, command: object, key = crypto.randomUUID(), requestOrigin = origin) =>
        ownerRequest(range + "/" + id, command, "PATCH", { "idempotency-key": key, origin: requestOrigin });

      const listing = await cli(secret, ["getJobLifecycle", "--path", JSON.stringify({ id: historicalJobId })]);
      expect(listing).toMatchObject({ code: 0, body: { revision: 2, appointments: [{ source: "github", id: oldConfirmedId, todoNumber: 42 }] } });
      expect(await prisma.jobInterview.findUnique({ where: { id: oldPendingId } })).toMatchObject({ source: "github", todoNumber: null });
      const seed = { company: "Test company", role: "Tester", resumeTrack: "web" as const, status: "applied" as const };
      await prisma.jobApplication.createMany({ data: [
        { ...seed, ownerId: "different-owner", id: foreignJobId, sourceKey: "foreign", sourceUrl: "https://example.test/foreign" },
        { ...seed, ownerId: owner.id, id: ownerJobId, sesMessageId: competingSesId,
          sourceKey: "owner-job", sourceUrl: "https://example.test/owner" },
      ] });

      const foreignTime = { startAt: new Date(time(23).start), endAt: new Date(time(23).end) };
      await prisma.jobInterview.create({ data: {
        id: foreignAppointmentId, ownerId: "different-owner", applicationId: foreignJobId, ...foreignTime,
        title: "Foreign interview", applicationUrl: "https://example.test/foreign", source: "native",
        appointment: { create: foreignTime },
      } });

      delete process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS;
      expect((await schedule(secret, { ...time(23), expectedRevision: 2 })).body.status).toBe(503);
      expect(writerCalls).toEqual([]);
      process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS = "1";
      expect((await schedule(wrongGrant.secret, { ...time(23), expectedRevision: 2 })).body.status).toBe(403);
      expect((await schedule(ordinaryKey.secret, { ...time(23), expectedRevision: 2 })).body.status).toBe(403);
      expect((await schedule(secret, { ...time(23), expectedRevision: 0 }, foreignJobId)).body.status).toBe(404);
      expect((await schedule(secret, { ...time(23), expectedRevision: 1 })).body.status).toBe(409);

      const appKey = { ownerId_id: { ownerId: owner.id, id: historicalJobId } };
      await prisma.jobApplication.update({ where: appKey, data: { lastOwnerEditedAt: new Date() } });
      expect((await schedule(secret, { ...time(23), expectedRevision: 2 })).body).toMatchObject({
        status: 409, message: expect.stringContaining("last 3 minutes"),
      });
      await prisma.jobApplication.update({ where: appKey, data: { lastOwnerEditedAt: new Date(Date.now() - 181_000) } });

      expect((await schedule(secret, { ...time(21), expectedRevision: 2 })).body).toMatchObject({
        appointment: { source: "github", id: oldConfirmedId, todoNumber: 42 },
      });
      expect((await schedule(secret, { ...time(22), expectedRevision: 2 })).body.status).toBe(503);
      expect(writerCalls).toEqual([]);

      const commandId = crypto.randomUUID();
      lostKey = commandId;
      const command = { ...time(23), expectedRevision: 2 };
      expect((await schedule(secret, command, historicalJobId, commandId)).body.status).toBe(503);
      const utcEquivalent = { start: "2026-11-23T10:00:00-04:00", end: "2026-11-23T10:30:00-04:00", expectedRevision: 2 };
      const [replay, equivalent] = await Promise.all([
        schedule(secret, utcEquivalent, historicalJobId, commandId), schedule(secret, command),
      ]);
      expect(replay).toEqual(equivalent);
      expect(replay.code).toBe(0);
      const created = scheduleJobInterviewOutput.parse(replay.body);
      const createdAuditId = created.auditId!;
      expect(typeof createdAuditId).toBe("string");
      expect(created.appointment).toMatchObject({ source: "native", revision: 1, cancelledAt: null });
      const audit = await prisma.agentWriteAudit.findUniqueOrThrow({ where: { id: createdAuditId } });
      expect(audit).toMatchObject({ ownerId: owner.id, resourceType: "jobInterviewAppointment", clientId: client.id, revisionBefore: 0, revisionAfter: 1 });
      const other = await schedule(otherAgent.secret, command);
      expect(other.body).toEqual({ appointment: created.appointment });
      expect((await schedule(secret, { ...command, end: "2026-11-23T15:00:00Z" })).body.status).toBe(409);
      expect((await schedule(secret, { ...time(24), expectedRevision: 2 }, historicalJobId, commandId)).body.status).toBe(409);

      const [a, b] = await Promise.all([schedule(secret, { ...time(24), expectedRevision: 2 }), schedule(secret, { ...time(24), expectedRevision: 2 })]);
      expect(a.code).toBe(0);
      expect(a).toEqual(b);
      expect(await prisma.agentWriteAudit.count({ where: { ownerId: owner.id, resourceType: "jobInterviewAppointment" } })).toBe(2);
      const ownerCreated = jobInterviewOutput.parse(await (await ownerRequest(jobPath(ownerJobId) + "/interviews", time(25))).json());
      expect(ownerCreated.source).toBe("native");
      expect(writerCalls).toEqual([]);

      const firstPage = nativeJobInterviewListOutput.parse(await (await ownerRequest(range + appointmentWindow + "&limit=1")).json());
      expect(firstPage).toMatchObject({ appointments: [{ id: created.appointment.id }], nextCursor: { afterId: created.appointment.id } });
      const next = new URLSearchParams(firstPage.nextCursor!);
      expect(await (await ownerRequest(range + appointmentWindow + "&" + next)).json()).toMatchObject({ appointments: [{ id: a.body.appointment.id }], nextCursor: null });
      expect((await ownerRequest(range + "?from=2026-11-23T00:00:00Z&to=2028-11-23T00:00:00Z")).status).toBe(400);
      const appointmentId = created.appointment.id;
      const current = nativeJobInterviewDetail.parse(await (await ownerRequest(range + "/" + appointmentId)).json());
      expect(current).toMatchObject({ alertMinutes: 10, beforeMinutes: 0, revision: 1 });
      expect((await fetch(server.url.origin + range + appointmentWindow, { headers: { "x-api-key": secret } })).status).toBe(403);
      expect((await ownerRequest(range + "/" + foreignAppointmentId)).status).toBe(404);
      const beforeStart = "?from=2026-11-23T13:00:00Z&to=2026-11-23T14:00:00Z";
      expect(await (await ownerRequest(range + beforeStart)).json()).toEqual({ appointments: [], nextCursor: null });

      const prep = { action: "update", expectedRevision: 1, beforeMinutes: 15 };
      for (const key of [wrongGrant.secret, ordinaryKey.secret]) {
        expect((await app.request(origin + range + "/" + appointmentId, {
          method: "PATCH", headers: { "x-api-key": key, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(prep),
        })).status).toBe(403);
      }
      expect((await edit(appointmentId, prep, crypto.randomUUID(), "https://foreign.example.test")).status).toBe(403);
      expect((await ownerRequest(range + "/" + appointmentId, prep, "PATCH")).status).toBe(400);
      for (const id of [foreignAppointmentId, oldConfirmedId, crypto.randomUUID()]) {
        expect((await edit(id, prep)).status).toBe(404);
      }
      for (const invalid of [
        { action: "update", expectedRevision: 1 }, { ...prep, start: time(26).start },
        { ...prep, start: time(26).end, end: time(26).start }, { ...prep, beforeMinutes: 1441 },
        { ...prep, alertMinutes: 0 }, { ...prep, action: "cancel" },
      ]) {
        expect((await edit(appointmentId, invalid)).status).toBe(400);
      }
      for (const occupied of [time(21), time(22), time(24)]) {
        expect((await edit(appointmentId, { action: "update", expectedRevision: 1, ...occupied })).status).toBe(409);
      }
      expect(await (await ownerRequest(jobPath(historicalJobId) + "/interviews", time(22))).json()).toMatchObject({
        source: "github", id: oldPendingId, todoNumber: 97,
      });
      expect(writerCalls).toEqual([oldPendingId]);
      expect((await edit(appointmentId, { ...prep, expectedRevision: 2 })).status).toBe(409);

      const prepReply = await edit(appointmentId, prep);
      expect(prepReply.status).toBe(200);
      const prepared = nativeJobInterviewDetail.parse(await prepReply.json());
      expect(prepared).toMatchObject({ revision: 2, beforeMinutes: 15, alertMinutes: 10, start: current.start });
      const refreshed = nativeJobInterviewDetail.parse(await (await ownerRequest(range + "/" + appointmentId)).json());
      expect(refreshed).toEqual(prepared);
      // A prep-only edit keeps the same event start. The pending alert is stale by revision alone.
      expect(refreshed.revision).not.toBe(current.revision);
      expect(await (await ownerRequest(range + beforeStart)).json()).toMatchObject({ appointments: [{ id: appointmentId }] });
      expect((await undo(createdAuditId)).status).toBe(409);
      expect(await prisma.agentWriteAudit.findUnique({ where: { id: createdAuditId } })).toMatchObject({ undoneAt: null });

      const movedTime = time(26);
      const move = { action: "update", expectedRevision: 2, ...movedTime, afterMinutes: 35, alertMinutes: null };
      const moveKey = crypto.randomUUID();
      lostKey = moveKey;
      const lost = await fetch(server.url.origin + range + "/" + appointmentId, {
        method: "PATCH", headers: { ...ownerProof, origin, "content-type": "application/json", "idempotency-key": moveKey },
        body: JSON.stringify(move),
      });
      expect(lost.status).toBe(503);
      const moveReply = await edit(appointmentId, {
        ...move, start: "2026-11-26T10:00:00-04:00", end: "2026-11-26T10:30:00-04:00",
      }, moveKey);
      expect(moveReply.status).toBe(200);
      const moved = nativeJobInterviewDetail.parse(await moveReply.json());
      expect(moved).toMatchObject({
        id: appointmentId, start: new Date(movedTime.start).toISOString(), end: new Date(movedTime.end).toISOString(),
        afterMinutes: 35, beforeMinutes: 15, revision: 3, alertMinutes: null,
      });
      expect((await edit(appointmentId, { ...move, afterMinutes: 20 }, moveKey)).status).toBe(409);
      expect((await schedule(secret, { ...movedTime, expectedRevision: 2 })).body.status).toBe(409);
      expect((await ownerRequest(jobPath(historicalJobId) + "/interviews", movedTime)).status).toBe(409);
      const originalReceipt = await schedule(secret, command, historicalJobId, commandId);
      expect(originalReceipt.body).toEqual(created);
      const currentReceipt = await schedule(secret, command);
      expect(currentReceipt.body).toMatchObject({ appointment: { id: appointmentId, revision: 3, start: moved.start } });

      const contestedTime = time(27);
      const [competingMove, competingCreate] = await Promise.all([
        edit(ownerCreated.id, { action: "update", expectedRevision: 1, ...contestedTime }),
        schedule(secret, { ...contestedTime, expectedRevision: 0 }, ownerJobId),
      ]);
      expect([competingMove.status, competingCreate.body.status ?? 200].sort()).toEqual([200, 409]);

      const competingUndos = await Promise.all([undo(a.body.auditId), undo(a.body.auditId)]);
      expect(competingUndos.map(result => result.status)).toEqual([200, 200]);
      expect(await competingUndos[0].json()).toEqual(await competingUndos[1].json());
      expect(await (await ownerRequest(range + "/" + a.body.appointment.id)).json()).toMatchObject({ cancelledAt: expect.any(String), revision: 2 });
      expect(await (await ownerRequest(range + appointmentWindow)).json()).toEqual({ appointments: [], nextCursor: null });
      expect((await schedule(secret, { ...time(24), expectedRevision: 2 })).body.appointment).toMatchObject({
        id: a.body.appointment.id, cancelledAt: expect.any(String),
      });
      delete process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS;
      expect((await ownerRequest(jobPath(historicalJobId) + "/interviews", movedTime)).status).toBe(409);
      const cancel = { action: "cancel", expectedRevision: 3 };
      const cancelKey = crypto.randomUUID();
      const cancelReply = await edit(appointmentId, cancel, cancelKey);
      expect(cancelReply.status).toBe(200);
      const cancelled = nativeJobInterviewDetail.parse(await cancelReply.json());
      expect(cancelled.revision).toBe(4);
      expect(cancelled.cancelledAt).toEqual(expect.any(String));
      expect(await (await edit(appointmentId, cancel, cancelKey)).json()).toEqual(cancelled);
      expect((await edit(appointmentId, { ...prep, expectedRevision: 4 })).status).toBe(409);
      expect(await (await ownerRequest(range + "/" + appointmentId)).json()).toEqual(cancelled);
      expect(await (await ownerRequest(range + "?from=2026-11-26T00:00:00Z&to=2026-11-27T00:00:00Z")).json())
        .toEqual({ appointments: [], nextCursor: null });
      expect(await (await ownerRequest(jobPath(historicalJobId) + "/interviews", time(23))).json()).toMatchObject({
        source: "native", id: appointmentId, start: moved.start, revision: 4, cancelledAt: cancelled.cancelledAt,
      });
      expect(await (await ownerRequest(jobPath(historicalJobId) + "/interviews", time(24))).json()).toMatchObject({
        source: "native", id: a.body.appointment.id, cancelledAt: expect.any(String),
      });
      expect(writerCalls).toEqual([oldPendingId]);
      const originalSlot = await prisma.jobInterview.findUniqueOrThrow({
        where: { id: appointmentId }, select: { startAt: true, endAt: true },
      });
      expect(originalSlot).toEqual({ startAt: new Date(command.start), endAt: new Date(command.end) });
      const legacyPath = jobPath(historicalJobId) + "/interviews";
      const legacyReply = await ownerRequest(legacyPath, time(28));
      expect(legacyReply.status).toBe(200);
      const legacy = jobInterviewOutput.parse(await legacyReply.json());
      expect(legacy).toMatchObject({ source: "github", todoNumber: 98 });
      expect(await (await ownerRequest(legacyPath, time(28))).json()).toEqual(legacy);
      expect(writerCalls).toEqual([oldPendingId, legacy.id]);

      process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS = "1";
      const replyJobId = "c59894f1-0ca9-4db2-90f1-351ae026a196";
      const replyAddress = "luigi.k7mq@luigigirke.com";
      const replySesId = "0100010000000196-fixture-reply-chain-000000";
      const appliedAt = new Date("2026-11-14T12:00:00Z");
      await prisma.jobApplication.create({ data: {
        ...seed, ownerId: owner.id, id: replyJobId, sourceKey: "reply-chain-196", sourceUrl: "https://example.test/reply-chain",
        applicationAddress: replyAddress, sesMessageId: replySesId, appliedAt, receiptCode: "confirmation_message",
        revision: 4, approvedRevision: 4,
      } });
      const replyAgent = await createAgentApiKey({ name: "Reply fixture Agent", userId: owner.id, permissionIds: ["jobs:read", "jobs:write"] });
      const replyLookup = (sesId: string) => cli(replyAgent.secret, ["resolveJobApplicationReply", "--body", JSON.stringify({
        address: replyAddress, inReplyTo: `<${sesId}@email.amazonses.com>`,
      })]);
      const ownerHttp = (path: string, method = "GET") => fetch(server.url.origin + path, { method, headers: { ...ownerProof, origin } });
      const candidateIds = [replyJobId, ownerJobId];
      const snapshot = () => Promise.all([
        prisma.jobApplication.findMany({ where: { ownerId: owner.id, id: { in: candidateIds } }, orderBy: { id: "asc" } }),
        prisma.agentWriteAudit.count({ where: { ownerId: owner.id } }),
        prisma.jobEvent.count({ where: { ownerId: owner.id, applicationId: { in: candidateIds } } }),
        prisma.jobInterview.count({ where: { ownerId: owner.id, applicationId: { in: candidateIds } } }),
      ]);

      const firstReplyRequest = requests.length;
      const replyStarted = performance.now();
      const beforeConflict = await snapshot();
      expect((await replyLookup(competingSesId)).body).toEqual(expect.objectContaining({ status: 404 }));
      expect(await snapshot()).toEqual(beforeConflict);

      const resolved = await replyLookup(replySesId);
      expect(resolved).toEqual({ code: 0, body: { id: replyJobId } });
      const id = resolved.body.id as string;
      const pathArg = JSON.stringify({ id });
      const readLifecycle = () => cli(replyAgent.secret, ["getJobLifecycle", "--path", pathArg]);
      const initial = jobLifecycleOutput.parse((await readLifecycle()).body);
      expect(initial).toMatchObject({ application: { id, status: "applied" }, revision: 0, sourceReplyLinked: false, appointments: [] });

      const sourceReply = { folder: "INBOX/Fixture", uid: 196 };
      const change = (expectedRevision: number, key = crypto.randomUUID()) => cli(replyAgent.secret, [
        "patchJobApplication", "--path", pathArg,
        "--body", JSON.stringify({ status: "interviewing", expectedRevision, sourceReply }), "--idempotency-key", key,
      ]);
      const replyKey = crypto.randomUUID();
      lostKey = replyKey;
      expect((await change(initial.revision, replyKey)).body.status).toBe(503);
      // The retry starts a new CLI process and sends the identical body and key.
      const acknowledged = jobLifecycleOutput.parse((await change(initial.revision, replyKey)).body);
      expect(acknowledged).toMatchObject({ application: { id, status: "interviewing" }, revision: 1, sourceReplyLinked: true });
      if (!acknowledged.auditId) throw Error("The Agent status update must return its audit ID.");
      const statusAudit = await prisma.agentWriteAudit.findUniqueOrThrow({ where: { id: acknowledged.auditId } });
      expect(statusAudit).toMatchObject({
        ownerId: owner.id, resourceId: id, resourceType: "jobApplication", clientId: replyAgent.client.id,
        revisionBefore: 0, revisionAfter: 1, before: { status: "applied", sourceReply: null },
        after: { status: "interviewing", sourceReply }, undoneAt: null,
      });
      expect(await prisma.agentWriteAudit.count({ where: { ownerId: owner.id, resourceId: id } })).toBe(1);
      expect((await change(initial.revision)).body).toEqual(expect.objectContaining({
        status: 409, message: expect.stringContaining("lifecycle revision changed"),
      }));

      const proposedTime = { ...time(29), expectedRevision: acknowledged.revision };
      expect((await schedule(replyAgent.secret, proposedTime, id)).body.status).toBe(403);
      const reservationKey = crypto.randomUUID();
      const equivalentTime = {
        start: "2026-11-29T10:00:00-04:00", end: "2026-11-29T10:30:00-04:00", expectedRevision: acknowledged.revision,
      };
      const scheduling = jobPath(id) + "/interviews/native";
      async function scheduleInFreshApi(input: typeof proposedTime) {
        const result = await scheduleInFreshJobsApi(database.href, secret, reservationKey, id, input);
        requests.push(["POST", scheduling, result.status]);
        return result;
      }

      const firstApi = await scheduleInFreshApi(proposedTime);
      const restartedApi = await scheduleInFreshApi(equivalentTime);
      const reservation = firstApi.result;
      expect(restartedApi.pid).not.toBe(firstApi.pid);
      expect(restartedApi.result).toEqual(reservation);
      expect(reservation.appointment).toMatchObject({ source: "native", revision: 1, cancelledAt: null });
      if (!reservation.auditId) throw Error("The Agent reservation must return its audit ID.");
      expect(await prisma.agentWriteAudit.findUnique({ where: { id: reservation.auditId } })).toMatchObject({
        clientId: client.id, resourceId: reservation.appointment.id, resourceType: "jobInterviewAppointment",
      });
      const interview = { ownerId: owner.id, applicationId: id };
      expect(await prisma.jobInterview.count({ where: interview })).toBe(1);
      expect(await prisma.jobInterviewAppointment.findMany({ where: { interview }, select: { id: true } }))
        .toEqual([{ id: reservation.appointment.id }]);
      console.info("Appointment replay after API restart", JSON.stringify({
        applicationId: id, appointmentId: reservation.appointment.id,
        processes: [firstApi, restartedApi].map(({ pid, startupMs, requestMs }) => ({ pid, startupMs, requestMs })),
        requests: 2, appointmentRows: 1,
      }));

      const undoPath = `/api/v1/agent-audit/${statusAudit.id}/undo`;
      async function undoInFreshApi(dropResponse = false) {
        const result = await undoInFreshJobsApi(database.href, statusAudit.id, origin, proof, dropResponse);
        requests.push(["POST", undoPath, result.status]);
        return result;
      }
      const lostUndo = await undoInFreshApi(true);
      expect(lostUndo).toMatchObject({ status: 503, result: { message: "Fixture lost the committed response." } });
      const committedUndo = await prisma.agentWriteAudit.findUniqueOrThrow({ where: { id: statusAudit.id } });
      expect(committedUndo.undoneAt).toBeInstanceOf(Date);
      const undoReplay = await undoInFreshApi();
      expect(undoReplay).toMatchObject({
        status: 200, result: { audit: { id: statusAudit.id, undoneAt: committedUndo.undoneAt!.toISOString() } },
      });
      const undone = jobLifecycleOutput.parse((await readLifecycle()).body);
      expect(undone).toMatchObject({ application: { id, status: "applied" }, revision: 2, sourceReplyLinked: false });
      expect(undone.appointments).toEqual([reservation.appointment]);

      const beforeHold = await snapshot();
      expect((await change(undone.revision)).body).toEqual(expect.objectContaining({
        status: 409, message: expect.stringContaining("last 3 minutes"),
      }));
      expect(await snapshot()).toEqual(beforeHold);
      // Advance the synthetic Owner edit timestamp after proving the real hold.
      const replyRecord = { ownerId_id: { ownerId: owner.id, id } };
      await prisma.jobApplication.update({ where: replyRecord, data: { lastOwnerEditedAt: new Date(Date.now() - 181_000) } });
      const reapplied = jobLifecycleOutput.parse((await change(undone.revision)).body);
      expect(reapplied).toMatchObject({ application: { id, status: "interviewing" }, revision: 3, sourceReplyLinked: true });
      expect(reapplied.auditId).toBeString();
      expect(reapplied.auditId).not.toBe(statusAudit.id);
      const lateUndoReplay = await undoInFreshApi();
      expect(lateUndoReplay.status).toBe(200);
      expect(lateUndoReplay.result).toEqual(undoReplay.result);
      const undoProcesses = [lostUndo, undoReplay, lateUndoReplay];
      expect(new Set(undoProcesses.map(({ pid }) => pid)).size).toBe(3);
      expect(await prisma.jobApplication.findUnique({ where: replyRecord })).toMatchObject({
        status: "interviewing", lifecycleRevision: 3, sourceReply,
        revision: 4, approvedRevision: 4, appliedAt, receiptCode: "confirmation_message", sesMessageId: replySesId,
      });
      console.info("Owner lifecycle Undo after API restart", JSON.stringify({
        applicationId: id, auditId: statusAudit.id, appointmentId: reservation.appointment.id,
        processes: undoProcesses.map(({ pid, startupMs, requestMs, status }) => ({ pid, startupMs, requestMs, status })),
        requests: undoProcesses.length, undoEvents: 1,
      }));
      const events = await prisma.jobEvent.findMany({ where: { ownerId: owner.id, applicationId: id }, select: { kind: true } });
      expect(events.map(event => event.kind).sort()).toEqual(["lifecycle_changed", "lifecycle_changed", "lifecycle_undone"]);
      expect(writerCalls).toEqual([oldPendingId, legacy.id]);

      const detailPath = range + "/" + reservation.appointment.id;
      const appointment = nativeJobInterviewDetail.parse(await (await ownerHttp(detailPath)).json());
      expect(appointment).toMatchObject({ applicationId: id, id: reservation.appointment.id, revision: 1, cancelledAt: null });
      const replyPath = "/api/v1/jobs/applications/resolve-reply";
      const lifecycle = jobPath(id) + "/lifecycle";
      const trace = requests.slice(firstReplyRequest);
      expect(trace).toEqual([
        ["POST", replyPath, 404], ["POST", replyPath, 200], ["GET", lifecycle, 200],
        ["PATCH", jobPath(id), 503], ["PATCH", jobPath(id), 200], ["PATCH", jobPath(id), 409],
        ["POST", scheduling, 403], ["POST", scheduling, 200], ["POST", scheduling, 200],
        ["POST", undoPath, 503], ["POST", undoPath, 200], ["GET", lifecycle, 200],
        ["PATCH", jobPath(id), 409], ["PATCH", jobPath(id), 200], ["POST", undoPath, 200], ["GET", detailPath, 200],
      ]);
      console.info("Reply chain receipt", JSON.stringify({
        applicationId: id, appointmentId: appointment.id, statusAuditId: statusAudit.id,
        states: [initial, acknowledged, undone, reapplied].map(value => [value.application.status, value.revision]),
        requests: trace.map(([method, , status]) => [method, status]), elapsedMs: Math.round(performance.now() - replyStarted),
      }));
    } finally {
      if (oldToken === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = oldToken;
      if (oldOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = oldOrigin;
      if (previousActivation === undefined) delete process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS;
      else process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS = previousActivation;
      server.stop(true);
      await prisma.$disconnect();
    }
  },
  30_000,
);
