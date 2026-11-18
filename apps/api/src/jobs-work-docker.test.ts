import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { jobsClient } from "../../web/app/jobs/jobs-client";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsAddApplicationOutput } from "./jobs-owner-contract";
import { hashJobWorkToken } from "./jobs-private-pause";
import { jobsWorkClaimOutput, jobsWorkerPath } from "./jobs-work-contract";

const codex = "c".repeat(32);
const runner = "m".repeat(32);
const registryToken = "r".repeat(32);
const address = "luigi.h7mq@luigigirke.com";
const resumeMarkdown = `${resumeHeader}## Summary\n\n- Edit product pages\n\n## Experience\n\n- Published catalog updates\n`;
const summaryMarkdown = "- Published product pages\n- Maintained catalog listings\n- Edited landing pages";

// Run against the same disposable Docker database as the Jobs write fixture.
test.skipIf(process.env.QUANTSELF_JOBS_WORK_FIXTURE !== "1")("internal Jobs work replays accepted reports and pins the PDF through submission", async () => {
  const connection = new URL(process.env.DATABASE_URL ?? "");
  if (connection.protocol !== "postgresql:" || connection.hostname !== "127.0.0.1" || !connection.port || connection.pathname !== "/jobs_write_fixture") {
    throw new Error("Use a disposable Jobs write Docker database.");
  }
  const { prisma } = await import("@quantself/db");
  const { createApp } = await import("./app");
  const { resolveJobSubmission } = await import("./jobs-owner-write");
  const { recordTrackedApplicationSent } = await import("./tracked-links-store");
  const ownerId = `jobs-worker-fixture-${randomUUID()}`;
  const owner = { id: ownerId, name: "Fixture", email: `${ownerId}@example.test` };
  let applicationId = "";
  const trackedIds: string[] = [];
  const importDate = "2001-01-02";
  const fxKey = `ecb:USD:CAD:${importDate}`;
  const pdf = Buffer.from("%PDF-1.7\nsynthetic resume bytes");
  const digest = createHash("sha256").update(pdf).digest("hex");
  const originalEncryptionKey = process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY;
  let now = new Date();
  let puts = 0;
  const stored = new Map<string, Buffer>();
  const app = createApp({
    emitAccessLog: () => {},
    trackedLinks: { token: scope => scope === "application" ? registryToken : undefined },
    resolveAccessContext: async headers => {
      const kind = headers.get("x-fixture-client");
      return kind === "web" || kind === "api-key" ? {
        owner, client: { kind, id: ownerId, name: "Fixture" }, permissions: ["jobs:read", "jobs:write", "jobs:execute"],
      } : null;
    },
    jobsWorkers: {
      db: prisma,
      now: () => now,
      secrets: () => ({ codex, runner }),
      pdfStore: {
        async put(key, bytes) { puts++; stored.set(key, Buffer.from(bytes)); return key; },
        async open(key) { return new Response(stored.get(key), { headers: { "Content-Type": "application/pdf" } }); },
      },
    },
  });
  function post(path: string, secret: string, body: unknown) {
    return app.request(jobsWorkerPath + path, {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }
  function ownerRequest(method: string, path: string, body?: unknown, idempotencyKey = randomUUID()) {
    return app.request("/api/v1/jobs" + path, {
      method,
      headers: { Origin: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin, "x-fixture-client": "web",
        "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const ownerWrite = (method: string, path: string, body: unknown) =>
    ownerRequest(method, `/applications/${applicationId}${path}`, body);
  async function claim(secret: string, ...kinds: string[]) {
    const response = await post("/work/claim", secret, { workerId: "fixture", kinds, supportsOwnerAttestation: true });
    expect(response.status).toBe(200);
    return jobsWorkClaimOutput.parse(await response.json()).work;
  }
  function advancePast(leaseUntil: string) { now = new Date(Date.parse(leaseUntil) + 1); }
  async function accepted(response: Response | Promise<Response>) {
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: true });
  }
  async function registerApplicationLink(id: string, revision: number) {
    const response = await app.request("/api/v1/tracked-links/applications", {
      method: "POST", headers: { "X-API-Key": registryToken, "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: id, company: "Example", role: "Editor", track: "web-cms", revision }),
    });
    expect(response.ok).toBe(true);
    trackedIds.push(id);
    const link = await prisma.trackedLink.findUniqueOrThrow({ where: { applicationId: id } });
    expect(await response.json()).toEqual({ code: link.code });
    expect(link.sentAt).toBeNull();
  }
  const readTrackedSend = async (id: string) => (await prisma.trackedLink.findUniqueOrThrow({
    where: { applicationId: id }, select: { sentAt: true },
  })).sentAt;

  try {
    process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY = Buffer.alloc(32, 7).toString("base64url");
    await prisma.user.create({ data: owner });
    await prisma.authOwner.create({ data: { id: "singleton", userId: ownerId } });
    const quote = { base: "USD", quote: "CAD", rate: "1.25", requestedDate: importDate, rateDate: importDate,
      fetchedAt: now.toISOString(), source: "frankfurter-v2", provider: "ecb" };
    await prisma.budgetFxRate.create({ data: { key: fxKey, data: quote } });
    const listing = { sourceUrl: "https://example.test/job", company: "Example", role: "Editor", track: "web",
      postingText: "Publish product pages remotely from Canada.", resumeMarkdown };
    const addKey = randomUUID();
    const added = await ownerRequest("POST", "/applications", listing, addKey);
    expect(added.status).toBe(200);
    const initial = jobsAddApplicationOutput.parse(await added.json());
    expect(initial).toMatchObject({ duplicate: false, application: { status: "draft" } });
    applicationId = initial.application.id;
    expect(await (await ownerRequest("POST", "/applications", listing, addKey)).json()).toEqual(initial);
    expect(await (await ownerRequest("POST", "/applications", { ...listing, sourceUrl: listing.sourceUrl + "?utm_source=fixture" })).json())
      .toEqual({ ...initial, duplicate: true });
    const keyedImport = await app.request("/api/v1/jobs/applications/import", {
      method: "POST", headers: { "x-fixture-client": "api-key", "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ applications: [listing, listing] }),
    });
    expect(keyedImport.status).toBe(200);
    expect(await keyedImport.json()).toEqual({ imported: 0, duplicates: 2 });
    expect((await ownerRequest("POST", "/import", { applications: [listing] })).status).toBe(404);
    expect((await ownerRequest("POST", "/work/claim", { kind: "submit" })).status).toBe(404);
    await prisma.jobApplication.update({ where: { ownerId_id: { ownerId, id: applicationId } }, data: {
      applicationAddress: address, createdAt: new Date(importDate),
    } });
    now = new Date();

    expect((await post("/work/claim", "wrong", { workerId: "fixture", kinds: ["enrich"] })).status).toBe(401);
    expect((await post("/work/claim", codex, { workerId: "fixture", kinds: ["enrich", "render"] })).status).toBe(403);
    expect((await post("/work/claim", codex, { workerId: "fixture", kinds: ["submit"] })).status).toBe(403);
    expect((await post("/work/claim", runner, { workerId: "fixture", kinds: ["revise"] })).status).toBe(403);
    expect((await post("/runner/heartbeat", codex, { host: "fixture-mac" })).status).toBe(403);
    const pauseBeforePairing = await ownerRequest("PATCH", "/runner", { paused: true });
    expect(pauseBeforePairing.status).toBe(200);
    expect(await pauseBeforePairing.json()).toEqual({ runner: { host: null, lastHeartbeatAt: null, state: "paused" } });
    await accepted(post("/runner/heartbeat", runner, { host: "fixture-mac" }));
    expect(await prisma.jobRunner.findUnique({ where: { ownerId } })).toMatchObject({ host: "fixture-mac", lastHeartbeatAt: now, paused: true });

    const enrich = await claim(codex, "enrich");
    if (enrich?.kind !== "enrich") throw new Error("Expected enrich work.");
    expect(Object.keys(enrich.input).sort()).toEqual(["candidateContext", "postingText", "track"]);
    const enrichResult = { resultId: randomUUID(), leaseToken: enrich.leaseToken, result: {
      doing: "Publish product pages.", remote: "confirmed", companySize: { people: 10, label: "10 people" },
      automatable: "medium", humanContact: { level: "low", note: "Requests from marketing" },
      meetings: { level: "rare", note: "Monthly planning" }, eligible: true, pay: { min: 41_600, max: 62_400, currency: "USD", period: "year" },
      verdict: "strong", dueDate: null,
    } };
    const enrichPath = `/work/${enrich.id}/complete`;
    expect((await post(enrichPath, runner, enrichResult)).status).toBe(403);
    await Promise.all([accepted(post(enrichPath, codex, enrichResult)), accepted(post(enrichPath, codex, enrichResult))]);
    advancePast(enrich.leaseUntil);
    await accepted(post(enrichPath, codex, enrichResult));
    expect((await post(enrichPath, codex, { ...enrichResult, result: { ...enrichResult.result, verdict: "weak" } })).status).toBe(409);
    expect((await prisma.jobEvent.findMany({ where: { applicationId, kind: "enriched" } })).map(event => event.payload))
      .toEqual([expect.objectContaining({ quote })]);

    const original = await claim(codex, "tailor");
    if (original?.kind !== "tailor") throw new Error("Expected tailor work.");
    expect(original.input.brief.pay).toMatchObject({ hourlyCad: { min: 25, max: 37.5 }, converted: true });
    advancePast(original.leaseUntil);
    const replacement = await claim(codex, "tailor");
    if (replacement?.kind !== "tailor") throw new Error("Expected replacement tailor work.");
    expect(replacement.id).toBe(original.id);
    expect(replacement.leaseToken).not.toBe(original.leaseToken);
    const tailorPath = `/work/${original.id}/complete`;
    const lostLeaseReport = { resultId: randomUUID(), leaseToken: original.leaseToken, result: { summaryMarkdown } };
    expect((await post(tailorPath, codex, lostLeaseReport)).status).toBe(409);

    const failPath = `/work/${replacement.id}/fail`;
    const rateLimit = { resultId: randomUUID(), leaseToken: replacement.leaseToken, code: "rate_limited" };
    await accepted(post(failPath, codex, rateLimit));
    expect(await claim(codex, "tailor")).toBeNull();
    advancePast(replacement.leaseUntil);
    const resumed = await claim(codex, "tailor");
    if (resumed?.kind !== "tailor") throw new Error("Expected resumed tailor work.");
    await accepted(post(failPath, codex, rateLimit));
    expect((await post(failPath, codex, { ...rateLimit, resultId: randomUUID() })).status).toBe(409);
    // The rejected stale attempt did not consume its result ID, so the active attempt can commit.
    await accepted(post(tailorPath, codex, { ...lostLeaseReport, leaseToken: resumed.leaseToken }));
    expect(await prisma.jobEvent.count({ where: { applicationId, kind: "work_failed" } })).toBe(1);

    const decisionPath = `/applications/${applicationId}/decision`;
    const skipKey = randomUUID();
    const skip = { action: "skip", expectedRevision: 1 };
    expect(await (await ownerRequest("POST", decisionPath, skip, skipKey)).json()).toMatchObject({ application: { status: "skipped" } });
    expect(await (await ownerRequest("POST", decisionPath, skip, skipKey)).json()).toMatchObject({ application: { status: "skipped" } });
    expect((await ownerRequest("POST", decisionPath, { ...skip, action: "later" }, skipKey)).status).toBe(409);
    expect(await prisma.jobEvent.count({ where: { applicationId, kind: "skipped" } })).toBe(1);
    expect(await (await ownerRequest("POST", decisionPath, { ...skip, action: "reopen" })).json()).toMatchObject({ application: { status: "review" } });
    expect(await claim(runner, "render")).toBeNull();
    await prisma.jobWorkItem.create({ data: { ownerId, applicationId, revision: 1, kind: "render", availableAt: now } });
    expect(await claim(runner, "render")).toBeNull();
    expect((await ownerWrite("POST", "/decision", { action: "approve", expectedRevision: 1 })).status).toBe(200);
    const originalRender = await claim(runner, "render");
    if (originalRender?.kind !== "render") throw new Error("Expected approved render work.");
    const editedSummary = summaryMarkdown + "\n- Improved listing quality";
    const edit = await ownerWrite("PATCH", "", { expectedRevision: 1, summaryMarkdown: editedSummary });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ application: { revision: 2, approvedRevision: null } });
    expect(await claim(runner, "render")).toBeNull();
    expect((await ownerWrite("POST", "/decision", { action: "approve", expectedRevision: 1 })).status).toBe(409);
    const approval = await ownerWrite("POST", "/decision", { action: "approve", expectedRevision: 2 });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ application: { status: "approved" } });
    expect(await claim(runner, "submit")).toBeNull();
    const render = await claim(runner, "render", "submit");
    if (render?.kind !== "render") throw new Error("Expected render work.");
    expect(render.input).toMatchObject({ applicationAddress: address, summaryMarkdown: editedSummary });
    const fieldResponse = await post(`/work/${render.id}/private-fields`, runner, { leaseToken: render.leaseToken });
    expect(fieldResponse.status).toBe(200);
    expect(await fieldResponse.json()).toMatchObject({ fields: [{ key: "email", value: address }] });
    const leaseHeaders = (work: { id: string; leaseToken: string }) => ({
      Authorization: `Bearer ${runner}`, "x-job-work-id": work.id, "x-job-lease-token": work.leaseToken,
    });
    const pdfPath = (revision: number) => `${jobsWorkerPath}/applications/${applicationId}/revisions/${revision}/pdf`;
    const upload = (work: typeof render, hash: string) => app.request(pdfPath(work.revision), {
      method: "PUT", headers: { ...leaseHeaders(work), "Content-Type": "application/pdf", "x-content-sha256": hash }, body: pdf,
    });
    expect((await upload(originalRender, digest)).status).toBe(409);
    expect((await upload(render, "0".repeat(64))).status).toBe(400);
    await accepted(upload(render, digest));
    const ownerPdf = `/applications/${applicationId}/resume.pdf`;
    const downloadedByOwner = await ownerRequest("GET", ownerPdf + "?revision=2");
    expect(downloadedByOwner.status).toBe(200);
    expect(Buffer.from(await downloadedByOwner.arrayBuffer())).toEqual(pdf);
    expect((await ownerRequest("GET", ownerPdf + "?revision=1")).status).toBe(409);
    expect((await app.request("/api/v1/jobs" + ownerPdf, { headers: { "x-fixture-client": "api-key" } })).status).toBe(403);
    advancePast(render.leaseUntil);
    await accepted(upload(render, digest));
    expect(puts).toBe(1);
    expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: applicationId } } }))
      .toMatchObject({ status: "queued", approvedRevision: 2, approvedPreviewDigest: digest });

    await accepted(post("/runner/heartbeat", runner, { host: "fixture-mac" }));
    expect(await claim(runner, "submit")).toBeNull();
    expect((await ownerRequest("PATCH", "/runner", { paused: false })).status).toBe(200);

    const pausedWork = await claim(runner, "submit");
    if (pausedWork?.kind !== "submit") throw new Error("Expected initial submit work.");
    const label = "Preferred catalog tool?";
    const key = "question." + createHash("sha256").update(label).digest("hex");
    const requirement = { key, label, type: "text", scope: { kind: "listing", applicationId } };
    const manualPath = `/work/${pausedWork.id}/fail`;
    const manual = { resultId: randomUUID(), leaseToken: pausedWork.leaseToken, code: "manual_required", requirements: [requirement] };
    await accepted(post(manualPath, runner, manual));
    expect(await claim(runner, "submit")).toBeNull();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) =>
      app.request(String(input), { ...init, headers: { "x-fixture-client": "web" } })) as typeof fetch;
    try {
      const { application } = await jobsClient.application(applicationId);
      expect(application).toMatchObject({
        id: applicationId, track: "web", status: "needs_attention", issue: "manual_required", verdict: "strong", revision: 2,
        postingText: "Publish product pages remotely from Canada.", summaryMarkdown: editedSummary,
        approvedRevision: 2, privatePauseFieldKeys: [key], brief: { doing: "Publish product pages." },
        pdfUrl: "/api/v1/jobs" + ownerPdf + "?revision=2",
      });
      expect(application.resumeMarkdown).toContain(resumeHeader);
      expect(application).not.toHaveProperty("privatePause");
      expect(application).not.toHaveProperty("summary");
      await expect(jobsClient.application(randomUUID())).rejects.toMatchObject({ status: 404 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const keyDetail = await app.request(`/api/v1/jobs/applications/${applicationId}`, { headers: { "x-fixture-client": "api-key" } });
    expect(keyDetail.status).toBe(200);
    const keyBody = await keyDetail.json();
    expect(keyBody).toMatchObject({ application: {
      track: "web", issue: "manual_required", postingText: "Publish product pages remotely from Canada.", resumeMarkdown: "", pdfUrl: null,
    } });
    expect(keyBody).not.toHaveProperty("application.privatePauseFieldKeys");

    const fields = await prisma.jobPrivateField.findMany({ where: { ownerId, scopeKey: `listing:${applicationId}`, key } });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ hasValue: false, ciphertext: null });
    const answer = { ...requirement, expectedVersion: fields[0].version, value: "Synthetic catalog tool" };
    const answered = await ownerRequest("PATCH", "/private-fields", { fields: [answer] });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ resumedApplicationIds: [applicationId] });
    expect((await ownerRequest("PATCH", "/private-fields", { fields: [answer] })).status).toBe(409);
    const encrypted = await prisma.jobPrivateField.findFirstOrThrow({ where: { ownerId, key } });
    expect(encrypted.ciphertext).toStartWith("v1.");
    expect(encrypted.ciphertext).not.toContain(answer.value);
    const exact = await ownerRequest("POST", "/private-fields/values", { applicationId });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ fields: [expect.objectContaining({ key, value: answer.value })] });

    const submit = await claim(runner, "submit");
    if (submit?.kind !== "submit") throw new Error("Expected approved submit work.");
    expect(submit).toMatchObject({ id: pausedWork.id, revision: pausedWork.revision });
    expect(submit.leaseToken).not.toBe(pausedWork.leaseToken);
    await accepted(post(manualPath, runner, manual));
    expect((await post(manualPath, runner, { ...manual, resultId: randomUUID() })).status).toBe(409);
    expect(await prisma.jobEvent.count({ where: { applicationId, kind: "private_details_resumed" } })).toBe(1);
    expect(submit.input.sha256).toBe(digest);
    const downloaded = await app.request(pdfPath(submit.revision), { headers: leaseHeaders(submit) });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(pdf);
    const submitPath = `/work/${submit.id}/complete`;
    await registerApplicationLink(applicationId, submit.revision);
    const sesMessageId = `Fixture-${randomUUID()}`;
    const submitResult = { resultId: randomUUID(), leaseToken: submit.leaseToken, result: {
      receipt: { code: "confirmation_message", capturedAt: now.toISOString(), sesMessageId },
    } };
    expect((await post(submitPath, runner, submitResult)).status).toBe(409);
    expect(await readTrackedSend(applicationId)).toBeNull();
    const eventPath = `/submissions/${applicationId}/events`;
    const event = { eventId: randomUUID(), workId: submit.id, leaseToken: submit.leaseToken, step: "submit_started", state: "running" };
    const sesStart = { ...event, channel: "ses" };
    await accepted(post(eventPath, runner, sesStart));
    await accepted(post(eventPath, runner, sesStart));
    expect((await post(eventPath, runner, event)).status).toBe(409);
    expect((await post(eventPath, runner, { ...event, eventId: randomUUID() })).status).toBe(409);
    advancePast(submit.leaseUntil);
    expect(await claim(runner, "submit")).toBeNull();
    expect((await post(eventPath, runner, { ...event, eventId: randomUUID(), step: "submitted", state: "done" })).status).toBe(409);
    expect((await app.request(pdfPath(submit.revision), { headers: leaseHeaders(submit) })).status).toBe(409);
    expect(await readTrackedSend(applicationId)).toBeNull();
    const { code, capturedAt } = submitResult.result.receipt;
    expect((await post(submitPath, runner, { ...submitResult, result: { receipt: { code, capturedAt } } })).status).toBe(409);
    await accepted(post(submitPath, runner, submitResult));
    await accepted(post(submitPath, runner, submitResult));
    expect(await claim(runner, "submit")).toBeNull();
    expect(await prisma.jobEvent.count({ where: { applicationId, kind: "receipt_recorded" } })).toBe(1);
    const where = { ownerId_id: { ownerId, id: applicationId } };
    const applied = await prisma.jobApplication.findUniqueOrThrow({ where });
    const firstSentAt = new Date(submitResult.result.receipt.capturedAt);
    expect(applied).toMatchObject({ status: "applied", receipt: submitResult.result.receipt, sesMessageId, appliedAt: firstSentAt });
    expect(await readTrackedSend(applicationId)).toEqual(firstSentAt);
    await prisma.$transaction(tx => recordTrackedApplicationSent(tx, applicationId, now));
    expect(await readTrackedSend(applicationId)).toEqual(firstSentAt);

    const uncertainId = randomUUID();
    const uncertainRevision = { ownerId, applicationId: uncertainId, revision: 2 };
    await prisma.jobApplication.create({ data: {
      ownerId, id: uncertainId, company: "Example", role: "Second editor", sourceKey: "worker-fixture-uncertain",
      sourceUrl: "https://example.test/second-job", resumeTrack: "web", revision: 2,
      approvedRevision: 2, approvedPreviewDigest: digest, status: "needs_attention", issueCode: "submission_uncertain",
    } });
    await prisma.jobRevision.create({ data: {
      ...uncertainRevision, summaryMarkdown, resumeMarkdown, pdfSha256: digest, pdfReference: [...stored.keys()][0],
    } });
    const previousLeaseTokenHash = hashJobWorkToken(randomUUID());
    const previousResultId = randomUUID();
    const priorAttempt = await prisma.jobWorkItem.create({ data: {
      ...uncertainRevision, kind: "submit", state: "failed", failureCode: "submission_uncertain",
      attempts: 1, leaseTokenHash: previousLeaseTokenHash, resultId: previousResultId,
    } });
    await prisma.jobEvent.create({ data: {
      ...uncertainRevision, kind: "submit_started", payload: {
        workId: priorAttempt.id, attempt: 1, step: "submit_started", state: "running", channel: "ses",
      },
    } });
    await registerApplicationLink(uncertainId, 2);
    const submissions = await ownerRequest("GET", "/submissions");
    expect(submissions.status).toBe(200);
    expect(await submissions.json()).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ id: applicationId, status: "applied", receipt: "confirmation_message" }),
      expect.objectContaining({ id: uncertainId, status: "needs_attention", issue: "submission_uncertain" }),
    ]) });
    const overview = await ownerRequest("GET", "/overview");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ pipeline: { drafted: 2, approved: 2, applied: 1 } });
    expect(await claim(runner, "submit")).toBeNull();
    const resolvePath = `/submissions/${uncertainId}/resolve`;
    expect((await ownerRequest("POST", resolvePath, { action: "requeue" })).status).toBe(409);
    const resolveKey = randomUUID();
    expect((await ownerRequest("POST", resolvePath, { action: "mark_not_sent" })).status).toBe(409);
    const inspected = await prisma.jobApplication.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: uncertainId } } });
    const resolution = { action: "mark_not_sent", expectedUpdatedAt: inspected.updatedAt.toISOString() };
    const resolved = await ownerRequest("POST", resolvePath, resolution, resolveKey);
    expect(resolved.status).toBe(200);
    const settled = await resolved.json();
    expect(settled).toMatchObject({ submission: { id: uncertainId, status: "queued", approvedRevision: 2 } });
    expect(await (await ownerRequest("POST", resolvePath, resolution, resolveKey)).json()).toEqual(settled);
    expect((await ownerRequest("POST", resolvePath, { action: "mark_applied" }, resolveKey)).status).toBe(409);
    expect(await prisma.jobEvent.count({ where: { applicationId: uncertainId, kind: "submission_resolved" } })).toBe(1);
    expect(await readTrackedSend(uncertainId)).toBeNull();
    const otherId = randomUUID();
    const otherRevision = { ...uncertainRevision, applicationId: otherId };
    await prisma.jobApplication.create({ data: {
      ownerId, id: otherId, company: "Example", role: "Unrelated editor", sourceKey: "worker-fixture-ordinary",
      sourceUrl: "https://example.test/other-job", resumeTrack: "web", revision: 2,
      approvedRevision: 2, approvedPreviewDigest: digest, status: "queued",
    } });
    await prisma.jobRevision.create({ data: {
      ...otherRevision, summaryMarkdown, resumeMarkdown, pdfSha256: digest, pdfReference: [...stored.keys()][0],
    } });
    await prisma.jobWorkItem.create({ data: { ...otherRevision, kind: "submit", availableAt: now } });
    const legacyClaim = await post("/work/claim", runner, { workerId: "legacy-fixture", kinds: ["submit"] });
    expect(legacyClaim.status).toBe(200);
    const legacy = jobsWorkClaimOutput.parse(await legacyClaim.json()).work;
    expect(legacy).toMatchObject({ applicationId: otherId, kind: "submit" });
    expect(legacy).not.toHaveProperty("attempt");
    expect(legacy).not.toHaveProperty("ownerAttestation");
    const oldPoll = await post("/work/claim", runner, { workerId: "legacy-fixture", kinds: ["submit"] });
    expect(await oldPoll.json()).toEqual({ work: null });
    if (legacy?.kind !== "submit") throw new Error("Expected ordinary submit work.");
    const otherEvents = `/submissions/${otherId}/events`;
    const otherResolve = `/submissions/${otherId}/resolve`;
    await accepted(post(otherEvents, runner, {
      ...event, eventId: randomUUID(), workId: legacy.id, leaseToken: legacy.leaseToken,
    }));
    await accepted(post(`/work/${legacy.id}/fail`, runner, {
      resultId: randomUUID(), leaseToken: legacy.leaseToken, code: "submission_uncertain",
    }));
    expect((await ownerRequest("POST", otherResolve, { action: "mark_not_sent" })).status).toBe(200);
    const browserPoll = await post("/work/claim", runner, { workerId: "legacy-fixture", kinds: ["submit"] });
    const browserRetry = jobsWorkClaimOutput.parse(await browserPoll.json()).work;
    expect(browserRetry).toMatchObject({ applicationId: otherId, id: legacy.id, kind: "submit" });
    expect(browserRetry).not.toHaveProperty("ownerAttestation");
    expect(browserRetry).not.toHaveProperty("attempt");

    const originalAttestation = {
      previousWorkId: priorAttempt.id, previousAttempt: 1, previousResultId, previousLeaseTokenHash,
      approvedRevision: 2, sha256: digest, resolvedAt: expect.any(String),
    };
    for (const [attempt, code, action] of [
      [2, "runner_unavailable", "requeue"],
      [3, "submission_uncertain", "mark_not_sent"],
    ] as const) {
      const prestart = await claim(runner, "submit");
      expect(prestart).toMatchObject({ applicationId: uncertainId, attempt, ownerAttestation: originalAttestation });
      if (prestart?.kind !== "submit") throw new Error("Expected reconciled submit work.");
      await accepted(post(`/work/${prestart.id}/fail`, runner, {
        resultId: randomUUID(), leaseToken: prestart.leaseToken, code,
      }));
      const retry = await ownerRequest("POST", resolvePath, { action });
      expect(retry.status).toBe(200);
    }
    const confirmedRetry = await claim(runner, "submit");
    expect(confirmedRetry).toMatchObject({
      applicationId: uncertainId, revision: 2, input: { sha256: digest }, attempt: 4, ownerAttestation: originalAttestation,
    });
    if (confirmedRetry?.kind !== "submit") throw new Error("Expected reconciled submit work.");
    await prisma.trackedLink.delete({ where: { applicationId: uncertainId } });
    await accepted(post(`/submissions/${uncertainId}/events`, runner, {
      ...event, eventId: randomUUID(), workId: confirmedRetry.id, leaseToken: confirmedRetry.leaseToken,
    }));
    expect(await prisma.jobWorkItem.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: confirmedRetry.id } } }))
      .toMatchObject({ payload: {} });
    const retryPath = `/work/${confirmedRetry.id}/complete`;
    const retryResult = {
      ...submitResult, resultId: randomUUID(), leaseToken: confirmedRetry.leaseToken,
    };
    expect((await post(retryPath, runner, retryResult)).status).toBe(409);
    await accepted(post(retryPath, runner, { ...retryResult, result: { receipt: { code, capturedAt } } }));
    expect(await prisma.trackedLink.findUnique({ where: { applicationId: uncertainId } })).toBeNull();
    expect(await claim(runner, "submit")).toBeNull();

    if (browserRetry?.kind !== "submit") throw new Error("Expected ordinary browser retry.");
    await accepted(post(`/work/${browserRetry.id}/fail`, runner, {
      resultId: randomUUID(), leaseToken: browserRetry.leaseToken, code: "runner_unavailable",
    }));
    expect((await ownerRequest("POST", otherResolve, { action: "requeue" })).status).toBe(200);
    const preflight = await claim(runner, "submit");
    if (preflight?.kind !== "submit" || preflight.applicationId !== otherId) throw new Error("Expected SES preflight work.");
    const claimedEvent = {
      eventId: randomUUID(), workId: preflight.id, leaseToken: preflight.leaseToken,
      step: "runner_claimed", state: "done", channel: "ses",
    };
    await accepted(post(otherEvents, runner, claimedEvent));
    await accepted(post(otherEvents, runner, claimedEvent));
    const preflightExpired = new Date(Date.now() - 1);
    const otherWhere = { ownerId_id: { ownerId, id: otherId } };
    await prisma.jobWorkItem.update({ where: { ownerId_id: { ownerId, id: preflight.id } }, data: { leaseUntil: preflightExpired } });
    const preflightApplication = await prisma.jobApplication.update({ where: otherWhere, data: { submitLeaseUntil: preflightExpired } });
    expect((await ownerRequest("POST", otherResolve, { action: "mark_not_sent" })).status).toBe(409);
    expect((await ownerRequest("POST", otherResolve, {
      action: "mark_not_sent", expectedUpdatedAt: preflightApplication.updatedAt.toISOString(),
    })).status).toBe(200);
    const recoveredPreflight = await claim(runner, "submit");
    expect(recoveredPreflight).toMatchObject({
      applicationId: otherId, attempt: 4, ownerAttestation: {
        previousWorkId: preflight.id, previousAttempt: 3, previousLeaseTokenHash: hashJobWorkToken(preflight.leaseToken),
        approvedRevision: 2, sha256: digest,
      },
    });
    expect(recoveredPreflight).not.toHaveProperty("ownerAttestation.previousResultId");

    const ownerConfirmedId = randomUUID();
    const ownerConfirmedKey = { ownerId_id: { ownerId, id: ownerConfirmedId } };
    await prisma.jobApplication.create({ data: {
      ownerId, id: ownerConfirmedId, company: "Example", role: "Third editor", sourceKey: "worker-fixture-owner-confirmed",
      sourceUrl: "https://example.test/third-job", resumeTrack: "web", status: "needs_attention", issueCode: "submission_uncertain",
    } });
    await registerApplicationLink(ownerConfirmedId, 1);
    const confirmation = { action: "mark_applied", confirmation: "Synthetic employer receipt" } as const;
    await expect(prisma.$transaction(async tx => {
      await resolveJobSubmission(tx, ownerId, ownerConfirmedId, confirmation);
      throw new Error("Fixture interrupted the transaction");
    })).rejects.toThrow("Fixture interrupted the transaction");
    expect(await readTrackedSend(ownerConfirmedId)).toBeNull();
    expect(await prisma.jobApplication.findUniqueOrThrow({ where: ownerConfirmedKey })).toMatchObject({ status: "needs_attention", appliedAt: null });

    const confirmationKey = randomUUID();
    const ownerPath = `/submissions/${ownerConfirmedId}/resolve`;
    const confirmed = await ownerRequest("POST", ownerPath, confirmation, confirmationKey);
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json();
    expect(confirmedBody).toMatchObject({ submission: { id: ownerConfirmedId, status: "applied" } });
    expect(await (await ownerRequest("POST", ownerPath, confirmation, confirmationKey)).json()).toEqual(confirmedBody);
    const ownerApplied = await prisma.jobApplication.findUniqueOrThrow({ where: ownerConfirmedKey });
    expect(ownerApplied.appliedAt).not.toBeNull();
    expect(await readTrackedSend(ownerConfirmedId)).toEqual(ownerApplied.appliedAt);
    expect(await prisma.jobEvent.count({ where: { applicationId: ownerConfirmedId, kind: "submission_resolved" } })).toBe(1);
  } finally {
    if (originalEncryptionKey === undefined) delete process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY;
    else process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY = originalEncryptionKey;
    await prisma.apiIdempotencyKey.deleteMany({ where: { OR: [{ clientId: ownerId }, { clientId: { startsWith: `jobs-worker:${ownerId}:` } }] } });
    await prisma.trackedLink.deleteMany({ where: { applicationId: { in: trackedIds } } });
    await prisma.jobApplication.deleteMany({ where: { ownerId } });
    await prisma.jobPrivateField.deleteMany({ where: { ownerId } });
    await prisma.jobRunner.deleteMany({ where: { ownerId } });
    await prisma.authOwner.deleteMany({ where: { userId: ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.budgetFxRate.deleteMany({ where: { key: fxKey } });
    await prisma.$disconnect();
  }
}, 25_000);
