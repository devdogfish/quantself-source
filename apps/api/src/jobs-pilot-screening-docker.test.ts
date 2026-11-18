import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { ANTHROPIC_MESSAGES_URL, buildScreenRequest, MODEL } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { parseResumeDocument, resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsBrief } from "./jobs-work-contract";
import { parseJobsEnrichmentResult } from "./jobs-model-request";
import { inspectJobsPilotBilling } from "./jobs-pilot-billing-preflight";

const criteria = "Canadian web publishing";
const workspaceId = "wrkspc_Fixture";
const keep = { decision: "keep", category: "web", fitNote: "Maintains product pages." };
const maximum = 52_240_000n;
const charge = 11_200_000n;
const modelCharge = 12_200_000n;
const modelPolicy = {
  id: "synthetic-model-policy", model: "synthetic", inputTokens: 100, maxOutputTokens: 384,
  inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n, maximumNanoUsd: 60_000_000n,
};
const enrichment = {
  doing: "Edit pages.", remote: "not_stated", companySize: { people: null, label: "Unknown" }, automatable: "medium",
  humanContact: { level: "low", note: "Some coordination" }, meetings: { level: "rare", note: "As needed" },
  eligible: true, verdict: "review", pay: null, dueDate: null, ineligibleReason: null,
};
const postingFor = (id: number) => ({
  sourceIdentity: `greenhouse:global:screen-fixture:${id}`,
  sourceUrl: `https://job-boards.greenhouse.io/screen-fixture/jobs/${id}`,
  company: "Example Publishing", role: "Web Editor", description: "Maintain product pages.", location: "Remote Canada",
});

test.skipIf(process.env.QUANTSELF_JOBS_PILOT_SCREEN_FIXTURE !== "1")(
  "one durable allowance covers the exact screen, held enrichment and tailoring across restart",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.hostname !== "127.0.0.1" || database.protocol !== "postgresql:" ||
      !database.port || database.pathname !== "/jobs_pilot_screen_fixture") {
      throw new Error("Use a disposable Docker jobs_pilot_screen_fixture database.");
    }
    const [{ prisma }, { fingerprintIdempotentRequest }, { issueJobsPilotPermit, revokeJobsPilotPermit },
      { reserveJobsPilotScreen, settleJobsPilotScreen }, { importScreenedJobsPilotDraft },
      { jobsPilotModelLedger }, { jobsPilotPolicyDigest, jobsPilotRequestBody, readJobsPilotReply, reportJobsPilotModelWork, runJobsPilotModelWork },
      { withJobsWorkTransaction }, { dispatchJobsPilotScreen }, { createJobsPilotGateway }] = await Promise.all([
      import("@quantself/db"), import("./idempotency"), import("./jobs-pilot-permit"),
      import("./jobs-pilot-screening"), import("./jobs-owner-write"),
      import("./jobs-pilot-model-ledger"), import("./jobs-pilot-dispatch"), import("./jobs-work-service"), import("./jobs-pilot-anthropic-transport"),
      import("./jobs-pilot-gateway"),
    ]);
    const ownerId = randomUUID();
    const expiresAt = new Date(Date.now() + 300_000);
    const issue = async (id: number, limitOrAllowance: bigint | string = 60_000_000n) => {
      const posting = postingFor(id);
      const permit = await prisma.$transaction(async tx => {
        const issued = await issueJobsPilotPermit(tx, ownerId, { sourceIdentity: posting.sourceIdentity, expiresAt: expiresAt.toISOString() });
        const allowanceId = typeof limitOrAllowance === "string" ? limitOrAllowance :
          (await tx.jobPilotAllowance.create({ data: { ownerId, limitNanoUsd: limitOrAllowance }, select: { id: true } })).id;
        await tx.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: issued.id } }, data: { allowanceId } });
        return { ...issued, allowanceId };
      });
      return {
        allowanceId: permit.allowanceId,
        target: { permitId: permit.id, ownerId, sourceIdentity: posting.sourceIdentity },
        input: {
          posting, criteria,
          approval: {
            requestDigest: createHash("sha256").update(JSON.stringify(buildScreenRequest(posting, criteria))).digest("hex"),
            postingDigest: fingerprintIdempotentRequest({ posting }), workspaceId, maxInputTokens: 100,
            inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n,
          },
        },
      };
    };
    type Screen = Awaited<ReturnType<typeof issue>>;
    const result = (reservation: { body: Uint8Array; resultId: string }, output: unknown = keep,
      requestId = "req_" + randomUUID().replaceAll("-", "")) => ({
      status: 200, headers: new Headers({ "anthropic-workspace-id": workspaceId, "request-id": requestId }),
      sent: { body: reservation.body, resultId: reservation.resultId },
      body: {
        id: "msg_fixture", type: "message", role: "assistant", model: MODEL, stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: { input_tokens: 90, output_tokens: 20, service_tier: "standard", speed: "standard", inference_geo: "global" },
      },
    });
    const reserve = async ({ target, input }: Screen) => {
      const granted = await reserveJobsPilotScreen(prisma, target, input);
      if (!granted) throw new Error("Expected new reservation.");
      return granted;
    };
    const rowFor = ({ target }: Screen) => prisma.jobPilotScreenAttempt.findUniqueOrThrow({
      where: { ownerId_permitId: { ownerId, permitId: target.permitId } },
    });
    const permitFor = ({ target }: Screen) => prisma.jobPilotPermit.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: target.permitId } },
    });
    const balance = ({ allowanceId }: Screen) => prisma.jobPilotAllowance.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: allowanceId } },
      select: { heldNanoUsd: true, spentNanoUsd: true, screenCalls: true, enrichCalls: true, tailorCalls: true },
    });
    const fault = new Error("Fixture transaction acknowledgement lost");
    const faultDb = (when: "before" | "after", shouldFail = () => true) => new Proxy(prisma, {
      get(client, property, receiver) {
        if (property !== "$transaction") return Reflect.get(client, property, receiver);
        return async <T>(execute: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
          const fail = shouldFail();
          const value = await client.$transaction(async tx => {
            const output = await execute(tx);
            if (fail && when === "before") throw fault;
            return output;
          }, options);
          if (fail && when === "after") throw fault;
          return value;
        };
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "qs-pilot-screen-"));
    const priorTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    try {
      process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = directory;
      const template = parseResumeDocument(`${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained catalogs\n`).markdown;
      await writeFile(join(directory, "web.md"), template);
      const screen = await issue(197, 100_000_000n);
      const { target, input } = screen;
      await expect(reserveJobsPilotScreen(prisma, { ...target, sourceIdentity: postingFor(198).sourceIdentity }, input)).rejects.toMatchObject({ status: 409 });
      await expect(reserveJobsPilotScreen(prisma, target, {
        ...input, posting: { ...input.posting, sourceUrl: input.posting.sourceUrl + "?gh_jid=198" },
      })).rejects.toMatchObject({ status: 400 });
      await expect(reserveJobsPilotScreen(prisma, target, { ...input, criteria: "Changed criteria" })).rejects.toMatchObject({ status: 409 });
      await expect(reserveJobsPilotScreen(prisma, target, { ...input, posting: { ...input.posting, sourceLabel: "Changed label" } })).rejects.toMatchObject({ status: 409 });
      const short = await issue(196, maximum - 1n);
      await expect(reserveJobsPilotScreen(prisma, short.target, short.input)).rejects.toMatchObject({ status: 409 });
      expect(await prisma.jobPilotScreenAttempt.count({ where: { ownerId } })).toBe(0);
      const competing = await Promise.all([reserveJobsPilotScreen(prisma, target, input), reserveJobsPilotScreen(prisma, target, input)]);
      expect(competing.filter(Boolean)).toHaveLength(1);
      const dispatch = competing.find(value => value !== null)!;
      expect(await rowFor(screen)).toMatchObject({ id: dispatch.resultId, reservedNanoUsd: maximum, chargedNanoUsd: null });
      expect(await balance(screen)).toMatchObject({ heldNanoUsd: maximum, spentNanoUsd: 0n, screenCalls: 1 });
      const reply = result(dispatch);
      for (const rejected of [
        { ...reply, status: 429 },
        { ...reply, headers: new Headers({ "anthropic-workspace-id": "wrkspc_Other", "request-id": "req_Mismatch" }) },
        { ...reply, sent: { ...reply.sent, body: Buffer.concat([dispatch.body, Buffer.from(" ")]) } },
        { ...reply, sent: { ...reply.sent, resultId: randomUUID() } },
        { ...reply, body: { ...reply.body, usage: { ...reply.body.usage, input_tokens: 101 } } },
      ]) expect(await settleJobsPilotScreen(prisma, target, rejected)).toBeNull();
      await expect(settleJobsPilotScreen(prisma, { ...target, sourceIdentity: postingFor(198).sourceIdentity }, reply))
        .rejects.toMatchObject({ status: 404 });
      await expect(settleJobsPilotScreen(prisma, { ...target, ownerId: randomUUID() }, reply)).rejects.toMatchObject({ status: 404 });
      await expect(settleJobsPilotScreen(faultDb("before"), target, reply)).rejects.toBe(fault);
      expect(await rowFor(screen)).toMatchObject({ reservedNanoUsd: maximum, chargedNanoUsd: null, settledAt: null });
      expect(await permitFor(screen)).toMatchObject({ settledKeepResultId: null, screenedPostingDigest: null });
      expect(await reserveJobsPilotScreen(prisma, target, input)).toBeNull();
      await expect(settleJobsPilotScreen(faultDb("after"), target, reply)).rejects.toBe(fault);
      const durable = await rowFor(screen);
      expect(durable).toMatchObject({
        reservedNanoUsd: maximum, chargedNanoUsd: charge, providerRequestId: reply.headers.get("request-id"), inputTokens: 90, outputTokens: 20,
      });
      const settled = await settleJobsPilotScreen(prisma, target, reply);
      expect(settled).toMatchObject({ resultId: dispatch.resultId, chargeNanoUsd: charge, posting: {
        sourceIdentity: target.sourceIdentity, track: "web", postingText: "Fit note (web): Maintains product pages.\n\nMaintain product pages.",
      } });
      expect(await settleJobsPilotScreen(prisma, target, reply)).toEqual(settled);
      expect(await settleJobsPilotScreen(prisma, target, result(dispatch, { ...keep, fitNote: "Altered." }, durable.providerRequestId!))).toBeNull();
      expect(await rowFor(screen)).toEqual(durable);
      if (!settled?.posting) throw new Error("Expected an attached keep.");
      expect(durable.intakePosting).toEqual(settled.posting);
      expect(await permitFor(screen)).toMatchObject({
        settledKeepResultId: dispatch.resultId, screenedPostingDigest: fingerprintIdempotentRequest({ posting: settled.posting }),
      });
      const draft = await prisma.$transaction(tx => importScreenedJobsPilotDraft(tx, ownerId, target.permitId, settled.posting));
      expect(draft.revision).toBe(0);
      expect(await permitFor(screen)).toMatchObject({ applicationId: draft.applicationId, revision: 0 });
      const worker = { ...target, ...draft, workerId: "fixture-worker" };
      const now = () => new Date();
      const rates = { async convertMany() { throw new Error("Unexpected fixture FX request"); } };
      const { eligible: _eligible, verdict: _verdict, ineligibleReason: _reason, dueDate: _due, pay: _pay, ...briefFields } = enrichment;
      const brief = jobsBrief.parse({ ...briefFields, pay: { hourlyCad: null, original: null, converted: false } });
      const enrichBody = jobsPilotRequestBody(modelPolicy, { track: "web", candidateContext: "", postingText: settled.posting.postingText });
      const tailorBody = jobsPilotRequestBody(modelPolicy, { track: "web", candidateContext: "", brief, resumeMarkdown: template }, "tailor");
      const modelLedger = (phase: "enrich" | "tailor", body: string, policy = modelPolicy) => jobsPilotModelLedger(phase, {
        requestDigest: createHash("sha256").update(body).digest("hex"), policyDigest: jobsPilotPolicyDigest(policy),
      });
      const modelReply = (binding: { resultId: string; requestDigest: string }, output: unknown) => ({
        requestId: randomUUID(), output: JSON.stringify(output),
        usage: { ...binding, model: modelPolicy.model, inputTokens: 100, outputTokens: 20 },
      });
      const enrich = modelLedger("enrich", enrichBody);
      const tailor = modelLedger("tailor", tailorBody);
      const unexpected = async () => { throw new Error("Unexpected provider call"); };
      expect(await runJobsPilotModelWork(prisma, worker, { ledger: tailor, policy: modelPolicy, fakeProvider: unexpected, now, kind: "tailor" })).toBe("denied");
      const oversized = { ...modelPolicy, maxOutputTokens: 1_201, outputNanoUsdPerToken: 100n };
      expect(await runJobsPilotModelWork(prisma, worker, { ledger: modelLedger("enrich", enrichBody, oversized),
        policy: oversized, fakeProvider: unexpected, now })).toBe("denied");
      const second = await issue(205, screen.allowanceId);
      let dropReplyAck = false;
      await expect(runJobsPilotModelWork(faultDb("after", () => dropReplyAck), worker, {
        ledger: enrich, policy: modelPolicy, now, async fakeProvider(body, binding) {
          expect(body).toBe(enrichBody);
          expect(await balance(screen)).toMatchObject({ heldNanoUsd: 60_000_000n, spentNanoUsd: charge, enrichCalls: 1 });
          await expect(reserveJobsPilotScreen(prisma, second.target, second.input)).rejects.toMatchObject({ status: 409 });
          dropReplyAck = true;
          return modelReply(binding, enrichment);
        },
      })).rejects.toBe(fault);
      expect(await balance(screen)).toEqual({ heldNanoUsd: 0n, spentNanoUsd: charge + modelCharge, screenCalls: 1, enrichCalls: 1, tailorCalls: 0 });
      expect(await runJobsPilotModelWork(prisma, worker, { ledger: enrich, policy: modelPolicy, fakeProvider: unexpected, now })).toBe("denied");
      expect(await runJobsPilotModelWork(prisma, worker, { ledger: tailor, policy: modelPolicy, fakeProvider: unexpected, now, kind: "tailor" })).toBe("denied");

      const reportInNewProcess = async (kind: "enrich" | "tailor") => {
        const child = Bun.spawn([process.execPath, "-e", `
          import { prisma } from "./packages/db/index.ts";
          import { jobsPilotModelLedger } from "./apps/api/src/jobs-pilot-model-ledger.ts";
          import { reportJobsPilotModelWork } from "./apps/api/src/jobs-pilot-dispatch.ts";
          const { target, kind } = await Bun.stdin.json();
          const result = await reportJobsPilotModelWork(prisma, target, {
            kind, ledger: jobsPilotModelLedger(kind), now: () => new Date(),
            rates: { async convertMany() { throw new Error("Unexpected FX request"); } },
          });
          console.log(JSON.stringify(result));
          await prisma.$disconnect();
        `], { stdin: new Response(JSON.stringify({ target: worker, kind })), stdout: "pipe", stderr: "inherit" });
        const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        expect(exitCode).toBe(0);
        return JSON.parse(output);
      };
      const recoveredEnrich = await reportInNewProcess("enrich");
      expect(recoveredEnrich).toMatchObject({ resultId: expect.any(String) });
      expect(await balance(screen)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: charge + modelCharge });

      expect(await runJobsPilotModelWork(prisma, worker, { kind: "tailor", ledger: tailor, policy: modelPolicy, now,
        async fakeProvider(body, binding) {
          expect(body).toBe(tailorBody);
          expect(await balance(screen)).toMatchObject({ heldNanoUsd: 60_000_000n, spentNanoUsd: charge + modelCharge, tailorCalls: 1 });
          return modelReply(binding, { summaryMarkdown: "- Maintained product pages\n- Updated catalogs\n- Reviewed publication details" });
        },
      })).toBe("replied");
      await expect(reportJobsPilotModelWork(faultDb("after"), worker, { ledger: tailor, kind: "tailor", rates, now })).rejects.toBe(fault);
      expect(await reportInNewProcess("tailor")).toMatchObject({ resultId: expect.any(String) });
      expect(await prisma.jobApplication.findFirst({ where: { ownerId, id: draft.applicationId }, select: { status: true, revision: true } }))
        .toEqual({ status: "review", revision: 1 });
      expect(await prisma.jobRevision.count({ where: { ownerId, applicationId: draft.applicationId } })).toBe(1);
      expect(await balance(screen)).toEqual({ heldNanoUsd: 0n, spentNanoUsd: charge + 2n * modelCharge, screenCalls: 1, enrichCalls: 1, tailorCalls: 1 });
      const secondReceipt = result(await reserve(second), { decision: "skip", category: "none", fitNote: "Poor fit." });
      expect(await settleJobsPilotScreen(prisma, second.target, secondReceipt)).toMatchObject({ chargeNanoUsd: charge, posting: null });
      const third = await issue(206, screen.allowanceId);
      await expect(reserveJobsPilotScreen(prisma, third.target, third.input)).rejects.toMatchObject({ status: 409 });
      expect(await balance(screen)).toEqual({ heldNanoUsd: 0n, spentNanoUsd: 2n * charge + 2n * modelCharge, screenCalls: 2, enrichCalls: 1, tailorCalls: 1 });

      const revoked = await issue(198);
      const revokedDispatch = await reserve(revoked);
      expect(revokedDispatch.body).toEqual(dispatch.body);
      expect(await settleJobsPilotScreen(prisma, revoked.target, reply)).toBeNull();
      await expect(settleJobsPilotScreen(prisma, revoked.target, result(revokedDispatch, keep, durable.providerRequestId!)))
        .rejects.toMatchObject({ code: "P2002" });
      expect(await rowFor(revoked)).toMatchObject({ chargedNanoUsd: null, reservedNanoUsd: maximum });
      await prisma.$transaction(tx => revokeJobsPilotPermit(tx, ownerId, revoked.target.permitId));
      await expect(reserveJobsPilotScreen(prisma, revoked.target, revoked.input)).rejects.toMatchObject({ status: 409 });
      expect(await settleJobsPilotScreen(prisma, revoked.target, result(revokedDispatch))).toMatchObject({ chargeNanoUsd: charge, posting: null });
      expect((await permitFor(revoked)).settledKeepResultId).toBeNull();
      const expired = await issue(199);
      const expiredDispatch = await reserve(expired);
      const deadline = () => expiresAt;
      await expect(reserveJobsPilotScreen(prisma, expired.target, expired.input, deadline)).rejects.toMatchObject({ status: 409 });
      expect(await settleJobsPilotScreen(prisma, expired.target, result(expiredDispatch), deadline)).toMatchObject({ chargeNanoUsd: charge, posting: null });
      expect((await permitFor(expired)).settledKeepResultId).toBeNull();

      const uncertain = await issue(200);
      await expect(reserveJobsPilotScreen(faultDb("after"), uncertain.target, uncertain.input)).rejects.toBe(fault);
      expect(await reserveJobsPilotScreen(prisma, uncertain.target, uncertain.input)).toBeNull();
      expect(await rowFor(uncertain)).toMatchObject({ reservedNanoUsd: maximum, chargedNanoUsd: null, providerRequestId: null });

      const skipped = await issue(201);
      const skipReceipt = result(await reserve(skipped), { decision: "skip", category: "none", fitNote: "Poor fit." });
      const skipReplay = await Promise.all([
        settleJobsPilotScreen(prisma, skipped.target, skipReceipt), settleJobsPilotScreen(prisma, skipped.target, skipReceipt),
      ]);
      expect(skipReplay[0]).toMatchObject({ chargeNanoUsd: charge, posting: null });
      expect(skipReplay[1]).toEqual(skipReplay[0]);
      expect((await permitFor(skipped)).settledKeepResultId).toBeNull();
      const malformed = await issue(202);
      expect(await settleJobsPilotScreen(prisma, malformed.target, result(await reserve(malformed), { decision: "maybe" })))
        .toMatchObject({ chargeNanoUsd: charge, posting: null });
      expect((await permitFor(malformed)).settledKeepResultId).toBeNull();
      const lateAcknowledgement = await issue(203, maximum);
      let timeChecks = 0;
      const timeAtCommit = () => ++timeChecks > 2 ? expiresAt : new Date(expiresAt.getTime() - 1);
      expect(await reserveJobsPilotScreen(prisma, lateAcknowledgement.target, lateAcknowledgement.input, timeAtCommit)).toBeNull();
      expect(await rowFor(lateAcknowledgement)).toMatchObject({ reservedNanoUsd: maximum, chargedNanoUsd: null });

      const uncertainWork = await issue(207, 100_000_000n);
      const otherPermit = await issue(208, uncertainWork.allowanceId);
      const competingPermits = await Promise.allSettled([reserve(uncertainWork), reserve(otherPermit)]);
      expect(competingPermits.map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await balance(uncertainWork)).toMatchObject({ heldNanoUsd: maximum, spentNanoUsd: 0n, screenCalls: 1 });
      const firstWon = competingPermits[0].status === "fulfilled";
      const winner = firstWon ? uncertainWork : otherPermit;
      const winningReservation = competingPermits[firstWon ? 0 : 1];
      if (winningReservation.status !== "fulfilled") throw new Error("Expected one allowance winner.");
      const keepAfterRace = await settleJobsPilotScreen(prisma, winner.target, result(winningReservation.value));
      if (!keepAfterRace?.posting) throw new Error("Expected a second held draft.");
      const secondDraft = await prisma.$transaction(tx => importScreenedJobsPilotDraft(tx, ownerId, winner.target.permitId, keepAfterRace.posting));
      const uncertainWorker = { ...winner.target, ...secondDraft, workerId: worker.workerId };
      let delayedReply: ReturnType<typeof readJobsPilotReply> = null;
      expect(await runJobsPilotModelWork(prisma, uncertainWorker, { ledger: enrich, policy: modelPolicy, now,
        async fakeProvider(_, binding) {
          delayedReply = readJobsPilotReply(modelPolicy, binding, modelReply(binding, enrichment), parseJobsEnrichmentResult);
          throw new Error("Fixture response unavailable");
        },
      })).toBe("uncertain");
      expect(await balance(winner)).toMatchObject({ heldNanoUsd: 60_000_000n, spentNanoUsd: charge, enrichCalls: 1 });
      expect(await runJobsPilotModelWork(prisma, uncertainWorker, { ledger: enrich, policy: modelPolicy, fakeProvider: unexpected, now })).toBe("denied");
      expect(await balance(winner)).toMatchObject({ heldNanoUsd: 60_000_000n, spentNanoUsd: charge });
      await prisma.$transaction(tx => revokeJobsPilotPermit(tx, ownerId, winner.target.permitId));
      const replyAfterTimeout = delayedReply as ReturnType<typeof readJobsPilotReply>;
      if (!replyAfterTimeout) throw new Error("Missing trusted late fixture reply.");
      const recoveryLedger = jobsPilotModelLedger("enrich");
      expect(await withJobsWorkTransaction(prisma, tx => recoveryLedger.recordReply(tx, {
        ...uncertainWorker, workerId: "other-worker",
      }, replyAfterTimeout))).toBe(false);
      expect(await balance(winner)).toMatchObject({ heldNanoUsd: 60_000_000n, spentNanoUsd: charge });
      for (let replayIndex = 0; replayIndex < 2; replayIndex++) {
        expect(await withJobsWorkTransaction(prisma, tx => recoveryLedger.recordReply(tx, uncertainWorker, replyAfterTimeout))).toBe(true);
        expect(await balance(winner)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: charge + modelCharge, enrichCalls: 1 });
      }
      expect(await reportJobsPilotModelWork(prisma, uncertainWorker, { ledger: recoveryLedger, rates, now })).toBeNull();
      expect(await prisma.jobApplication.count({ where: { ownerId } })).toBe(2);

      const transportScreen = await issue(209, maximum);
      let sends = 0;
      const preflight = inspectJobsPilotBilling({ sourceIdentity: transportScreen.target.sourceIdentity,
        posting: transportScreen.input.posting, criteria, previousScreen: "none", estimatedInputTokens: 90 });
      expect(preflight).toMatchObject({ decision: "blocked", postingDigest: transportScreen.input.approval.postingDigest,
        request: { sha256: transportScreen.input.approval.requestDigest } });
      const fixtureApproved = { ...transportScreen.input, approval: { ...transportScreen.input.approval,
        requestDigest: preflight.request.sha256, postingDigest: preflight.postingDigest,
      } };
      const bounded = { ...fixtureApproved, approval: { ...fixtureApproved.approval,
        maxInputTokens: preflight.publicModelBound.inputTokens,
        inputNanoUsdPerToken: BigInt(preflight.publicModelBound.inputNanoUsdPerToken),
        outputNanoUsdPerToken: BigInt(preflight.publicModelBound.outputNanoUsdPerToken),
      } };
      await expect(dispatchJobsPilotScreen(prisma, transportScreen.target, bounded, {
        workspaceId, apiKey: "offline-fixture", request: (async (_url, _options): Promise<Response> => {
          sends++;
          throw new Error("Unexpected dispatch");
        }) as typeof fetch,
      })).rejects.toMatchObject({ status: 409 });
      expect(sends).toBe(0);
      expect(await balance(transportScreen)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 0n, screenCalls: 0 });
      let lostSettlementAck = false;
      const settlementDb = faultDb("after", () => {
        if (!sends || lostSettlementAck) return false;
        lostSettlementAck = true;
        return true;
      });
      const accepted = await dispatchJobsPilotScreen(settlementDb, transportScreen.target, fixtureApproved, {
        workspaceId, apiKey: "offline-fixture", request: (async (url, options) => {
          sends++;
          expect(url).toBe(ANTHROPIC_MESSAGES_URL);
          const attempt = await rowFor(transportScreen);
          expect(attempt.chargedNanoUsd).toBeNull();
          expect(options?.body).toBeInstanceOf(Uint8Array);
          expect(createHash("sha256").update(options?.body as Uint8Array).digest("hex")).toBe(attempt.requestDigest);
          expect(await balance(transportScreen)).toMatchObject({ heldNanoUsd: maximum, spentNanoUsd: 0n, screenCalls: 1 });
          const fixtureResponse = result({ resultId: attempt.id, body: Buffer.from(options?.body as Uint8Array) });
          fixtureResponse.headers.set("content-type", "application/json");
          const reply = new Response(JSON.stringify(fixtureResponse.body), { headers: fixtureResponse.headers });
          Object.defineProperty(reply, "url", { value: ANTHROPIC_MESSAGES_URL });
          return reply;
        }) as typeof fetch,
      });
      expect(accepted).toMatchObject({ chargeNanoUsd: charge, posting: { sourceIdentity: transportScreen.target.sourceIdentity } });
      expect(lostSettlementAck).toBe(true);
      expect(sends).toBe(1);
      expect(await balance(transportScreen)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: charge, screenCalls: 1 });

      const timedOut = await issue(210, maximum);
      let timeoutSignal: AbortSignal | null | undefined;
      const unavailable = {
        workspaceId, apiKey: "offline-fixture", timeoutMs: 15, request: ((_, options) => {
          sends++;
          timeoutSignal = options?.signal;
          return new Promise<Response>(() => {});
        }) as typeof fetch,
      };
      expect(await dispatchJobsPilotScreen(prisma, timedOut.target, timedOut.input, unavailable)).toBeNull();
      expect(timeoutSignal?.aborted).toBe(true);
      expect(await dispatchJobsPilotScreen(prisma, timedOut.target, timedOut.input, unavailable)).toBeNull();
      expect(sends).toBe(2);
      expect(await balance(timedOut)).toMatchObject({ heldNanoUsd: maximum, spentNanoUsd: 0n, screenCalls: 1 });
      expect((await permitFor(timedOut)).settledKeepResultId).toBeNull();
      expect(inspectJobsPilotBilling({ sourceIdentity: timedOut.target.sourceIdentity, posting: timedOut.input.posting,
        criteria, previousScreen: "uncertain" }).reasons).toContain("unresolved_charge_keep_full_hold_no_retry");

      const original = await issue(216, 100_000_000n);
      const replacement = await issue(216, original.allowanceId);
      const anotherPosting = await issue(217, original.allowanceId);
      const newAllowance = await issue(216, 100_000_000n);
      const pilotInput = ({ input }: Screen) => ({
        ...input, approval: { ...input.approval, inputNanoUsdPerToken: 1_000n, outputNanoUsdPerToken: 5_000n },
      });
      const pilotMaximum = 2_020_000n;
      const sendsBeforeReplacement = sends;
      expect(await dispatchJobsPilotScreen(prisma, original.target, pilotInput(original), unavailable)).toBeNull();
      await prisma.$transaction(tx => revokeJobsPilotPermit(tx, ownerId, original.target.permitId));
      const contenders = [replacement, anotherPosting, newAllowance];
      const blockedStarted = performance.now();
      const blocked = await Promise.allSettled(contenders.map(candidate =>
        dispatchJobsPilotScreen(prisma, candidate.target, pilotInput(candidate), unavailable)));
      const blockedMs = performance.now() - blockedStarted;
      expect(sends - sendsBeforeReplacement).toBe(1);
      expect(blocked).toEqual(Array(3).fill(expect.objectContaining({
        status: "rejected", reason: expect.objectContaining({ status: 409 }),
      })));
      expect(await balance(original)).toMatchObject({ heldNanoUsd: pilotMaximum, spentNanoUsd: 0n, screenCalls: 1 });
      expect(await balance(newAllowance)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 0n, screenCalls: 0 });
      expect(await prisma.jobPilotScreenAttempt.count({
        where: { ownerId, permitId: { in: contenders.map(({ target }) => target.permitId) } },
      })).toBe(0);

      const originalAttempt = await rowFor(original);
      const reconciled = await settleJobsPilotScreen(prisma, original.target, result({
        resultId: originalAttempt.id,
        body: Buffer.from(JSON.stringify(buildScreenRequest(original.input.posting, criteria))),
      }, { decision: "skip", category: "none", fitNote: "Poor fit." }));
      expect(reconciled).toMatchObject({ chargeNanoUsd: 190_000n, posting: null });
      expect(await balance(original)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 190_000n, screenCalls: 1 });

      // Each contender has enough funds and a call slot. Only one can reserve this posting.
      const retryStarted = performance.now();
      const retried = await Promise.allSettled([replacement, newAllowance].map(candidate =>
        reserveJobsPilotScreen(prisma, candidate.target, pilotInput(candidate))));
      const retryMs = performance.now() - retryStarted;
      expect(retried.filter(entry => entry.status === "fulfilled" && entry.value !== null)).toHaveLength(1);
      expect(retried.filter(entry => entry.status === "rejected" && entry.reason?.status === 409)).toHaveLength(1);

      const pendingNext = await issue(218, skipped.allowanceId);
      expect(await dispatchJobsPilotScreen(prisma, pendingNext.target, pilotInput(pendingNext), unavailable)).toBeNull();
      const sendsBeforeReplay = sends;
      const replayBalance = await balance(skipped);
      expect(replayBalance).toMatchObject({ heldNanoUsd: pilotMaximum, spentNanoUsd: charge, screenCalls: 2 });
      const key = "offline-fixture-" + randomUUID();
      const gateway = createJobsPilotGateway({
        db: prisma, target: skipped.target, key, approved: skipped.input, transport: unavailable,
        access: {
          owner: { id: ownerId, name: "Synthetic Owner", email: "offline-fixture@example.test" },
          client: { kind: "api-key", id: "offline-fixture", name: "Offline fixture" },
          permissions: ["jobs:import-tailored"],
        },
      });
      const replayStarted = performance.now();
      const screenReplay = await gateway(new Request("http://localhost/screen", {
        method: "POST", headers: {
          "content-type": "application/json", "x-jobs-pilot-key": key, "x-jobs-pilot-permit": skipped.target.permitId,
        },
        body: JSON.stringify({ sourceIdentity: skipped.target.sourceIdentity }),
      }));
      const replayMs = performance.now() - replayStarted;
      expect(screenReplay.status).toBe(409);
      expect(await screenReplay.json()).toEqual({ message: "Pilot screening is unavailable or requires reconciliation." });
      expect(sends).toBe(sendsBeforeReplay);
      expect(await settleJobsPilotScreen(prisma, skipped.target, skipReceipt)).toEqual(skipReplay[0]);
      expect(await balance(skipped)).toEqual(replayBalance);
      console.info("Jobs pilot replacement admission", JSON.stringify({
        blocked: { attempts: blocked.length, elapsedMs: Math.round(blockedMs) },
        retry: { attempts: retried.length, elapsedMs: Math.round(retryMs) },
        replay: { status: screenReplay.status, elapsedMs: Math.round(replayMs), sends: sends - sendsBeforeReplay },
      }));

      const nativeTls = process.env.QUANTSELF_JOBS_PILOT_NATIVE_TLS_DIR;
      if (nativeTls) {
        if (process.platform !== "linux" || Object.values(networkInterfaces()).flat().some(address => address && !address.internal)) {
          throw new Error("Native TLS fixture requires a loopback-only Linux network namespace.");
        }
        const providerHost = new URL(ANTHROPIC_MESSAGES_URL).hostname;
        const addresses = (await lookup(providerHost, { all: true })).map(record => record.address);
        expect(addresses).toContain("127.0.0.1");
        expect(addresses.every(address => address === "127.0.0.1" || address === "::1")).toBe(true);
        const cases = [
          { name: "trusted", certificate: "good", id: 211 },
          { name: "wrong-host", certificate: "wrong-host", id: 212 },
          { name: "untrusted", certificate: "untrusted", id: 213 },
          { name: "redirect", certificate: "good", id: 214 },
          { name: "legacy-custom-host-check", certificate: "wrong-host", id: 215 },
        ];
        const evidence = [];
        for (const { name, certificate, id } of cases) {
          const screened = await issue(id, maximum);
          const inbound: string[] = [];
          const plaintext: Buffer[] = [];
          const rawClosed = Promise.withResolvers<void>();
          const shouldParseHttp = name === "trusted" || name === "redirect";
          let digestMatched = false, keyMatched = false, bodyBytes = 0;
          const tls = { cert: Bun.file(join(nativeTls, certificate + "-chain.pem")), key: Bun.file(join(nativeTls, certificate + ".key")) };
          // Raw TLS records application bytes even if a partial request never reaches an HTTP handler.
          const server = shouldParseHttp ? Bun.serve({
            hostname: "127.0.0.1", port: 443, tls,
            async fetch(request) {
              const path = new URL(request.url).pathname;
              inbound.push(request.method + " " + path);
              if (path !== "/v1/messages") return new Response(null, { status: 404 });
              const body = new Uint8Array(await request.arrayBuffer());
              bodyBytes = body.byteLength;
              digestMatched = createHash("sha256").update(body).digest("hex") === screened.input.approval.requestDigest;
              keyMatched = request.headers.get("x-api-key") === "offline-fixture";
              if (!digestMatched || !keyMatched) return new Response(null, { status: 400 });
              if (name === "redirect") {
                return new Response(null, { status: 307, headers: { location: `https://${providerHost}/redirect-target` } });
              }
              const attempt = await rowFor(screened);
              const fixtureResponse = result({ body, resultId: attempt.id });
              return Response.json(fixtureResponse.body, { headers: fixtureResponse.headers });
            },
          }) : Bun.listen({
            hostname: "127.0.0.1", port: 443, tls,
            socket: {
              data(socket, chunk) {
                plaintext.push(Buffer.from(chunk));
                const raw = Buffer.concat(plaintext);
                const boundary = raw.indexOf("\r\n\r\n");
                if (boundary < 0) return;
                const match = /^content-length: (\d+)\r?$/im.exec(raw.subarray(0, boundary).toString());
                if (match && raw.length >= boundary + 4 + Number(match[1])) {
                  socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
              },
              close() { rawClosed.resolve(); },
            },
          });
          let clientRequests = 0, nativeError: string | undefined;
          try {
            const actualFetch = (async (url: string | URL | Request, options?: BunFetchRequestInit) => {
              clientRequests++;
              try {
                if (name !== "legacy-custom-host-check") return await fetch(url, options);
                return await fetch(url, { ...options, tls: { ...options?.tls,
                  checkServerIdentity: (hostname: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert),
                } });
              } catch (error) {
                const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
                nativeError = error instanceof Error ? code || error.message : undefined;
                throw error;
              }
            }) as typeof fetch;
            const settlement = await dispatchJobsPilotScreen(prisma, screened.target, screened.input, {
              request: actualFetch, apiKey: "offline-fixture", workspaceId, timeoutMs: 3_000,
            });
            if (!shouldParseHttp) {
              const closed = await Promise.race([rawClosed.promise.then(() => true), Bun.sleep(1_000).then(() => false)]);
              expect(closed).toBe(true);
            }
            const raw = Buffer.concat(plaintext);
            const divider = raw.indexOf("\r\n\r\n");
            if (divider >= 0) {
              const header = raw.subarray(0, divider).toString();
              inbound.push(header.split("\r\n")[0].replace(/ HTTP\/1\.[01]$/, ""));
              keyMatched = /^x-api-key: offline-fixture\r?$/im.test(header);
              const body = raw.subarray(divider + 4);
              bodyBytes = body.length;
              digestMatched = createHash("sha256").update(body).digest("hex") === screened.input.approval.requestDigest;
            }
            expect(clientRequests).toBe(1);
            if (name === "trusted") {
              expect(settlement).toMatchObject({ chargeNanoUsd: charge, posting: { sourceIdentity: screened.target.sourceIdentity } });
              expect(await balance(screened)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: charge, screenCalls: 1 });
              expect(nativeError).toBeUndefined();
            } else {
              expect(settlement).toBeNull();
              expect(await balance(screened)).toMatchObject({ heldNanoUsd: maximum, spentNanoUsd: 0n, screenCalls: 1 });
              expect((await permitFor(screened)).settledKeepResultId).toBeNull();
              if (name === "redirect") expect(nativeError).toMatch(/redirect/i);
              else expect(nativeError).toBe(name === "untrusted" ? "UNABLE_TO_VERIFY_LEAF_SIGNATURE" : "ERR_TLS_CERT_ALTNAME_INVALID");
            }
            const reached = shouldParseHttp || name === "legacy-custom-host-check";
            expect(inbound).toEqual(reached ? ["POST /v1/messages"] : []);
            expect(keyMatched).toBe(reached);
            expect(digestMatched).toBe(reached);
            if (!reached) expect(raw.length).toBe(0);
            evidence.push({ name, clientRequests, inbound, keyMatched, digestMatched, bodyBytes,
              plaintextBytes: shouldParseHttp ? null : raw.length, error: nativeError ?? null,
              chargeNanoUsd: (settlement?.chargeNanoUsd ?? 0n).toString() });
          } finally {
            await server.stop(true);
          }
        }
        let proxyConnections = 0, proxyClientRequests = 0;
        const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
          open() { proxyConnections++; },
          data(socket) { socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); },
        } });
        const previousProxy = process.env.HTTPS_PROXY;
        try {
          const proxied = await issue(216, maximum);
          process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
          const result = await dispatchJobsPilotScreen(prisma, proxied.target, proxied.input, {
            request: ((url, options) => { proxyClientRequests++; return fetch(url, options); }) as typeof fetch,
            apiKey: "offline-fixture", workspaceId,
          });
          expect(result).toBeNull();
          expect(proxyClientRequests).toBe(0);
          expect(proxyConnections).toBe(0);
          expect(await balance(proxied)).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 0n, screenCalls: 0 });
        } finally {
          if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
          else process.env.HTTPS_PROXY = previousProxy;
          proxy.stop(true);
        }
        console.info("Jobs pilot native TLS " + JSON.stringify({
          bunVersion: Bun.version, host: providerHost, addresses, onlyLoopback: true, cases: evidence,
          proxyConfigured: { clientRequests: proxyClientRequests, proxyConnections },
        }));
      }
    } finally {
      if (priorTemplates === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
      else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = priorTemplates;
      await rm(directory, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
