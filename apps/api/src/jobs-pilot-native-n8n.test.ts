import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@hono/zod-openapi";
import { criteria, importBody, posting, result, screenBody } from "../../../automation/n8n/jobs-feed/smoke/pilot-posting.mjs";
import { MODEL } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { parseResumeDocument, resumeHeader } from "../../../scripts/jobs/resume-document";

const workspaceId = "wrkspc_Fixture";
const fixtureKey = "offline-fixture";
const providerHost = "api.anthropic.com";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const charges = { screen: 11_200_000n, enrich: 12_200_000n, tailor: 12_200_000n };
const policy = {
  id: "synthetic-model-policy", model: "synthetic", inputTokens: 100, maxOutputTokens: 384,
  inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n, maximumNanoUsd: 60_000_000n,
};
const briefFields = {
  doing: "Edit pages.", remote: "not_stated", companySize: { people: null, label: "Unknown" }, automatable: "medium",
  humanContact: { level: "low", note: "Some coordination" }, meetings: { level: "rare", note: "As needed" },
};
const enrichment = { ...briefFields, eligible: true, verdict: "review", pay: null, dueDate: null, ineligibleReason: null };
const summaryMarkdown = "- Maintained product pages\n- Updated catalogs\n- Reviewed publication details";
const intakeReceipt = z.object({ applicationId: z.uuid(), revision: z.literal(0) });

test.skipIf(process.env.QUANTSELF_JOBS_NATIVE_N8N_FIXTURE !== "1")(
  "pinned n8n to native TLS screening, exact held import replay and Review",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    const tlsDir = process.env.QUANTSELF_JOBS_PILOT_NATIVE_TLS_DIR;
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/jobs_pilot_screen_fixture" ||
        process.platform !== "linux" || !tlsDir || Object.values(networkInterfaces()).flat().some(address => address && !address.internal)) {
      throw new Error("Use the disposable loopback n8n and native TLS runtime.");
    }
    const addresses = (await lookup(providerHost, { all: true })).map(record => record.address);
    expect(addresses).toContain("127.0.0.1");
    expect(addresses.every(address => address === "127.0.0.1" || address === "::1")).toBe(true);
    const [{ prisma }, { fingerprintIdempotentRequest }, { issueJobsPilotPermit },
      { createJobsPilotGateway }, { jobsBrief }, { jobsPilotModelLedger },
      { jobsPilotPolicyDigest, jobsPilotRequestBody, reportJobsPilotModelWork, runJobsPilotModelWork }] = await Promise.all([
      import("@quantself/db"), import("./idempotency"), import("./jobs-pilot-permit"),
      import("./jobs-pilot-gateway"), import("./jobs-work-contract"), import("./jobs-pilot-model-ledger"), import("./jobs-pilot-dispatch"),
    ]);
    const owner = { id: randomUUID(), email: "native-n8n-owner@example.test", name: "Synthetic Owner" };
    const ownerId = owner.id;
    const scope = await prisma.$transaction(async tx => {
      const permit = await issueJobsPilotPermit(tx, ownerId, {
        sourceIdentity: posting.sourceIdentity, expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      const allowance = await tx.jobPilotAllowance.create({ data: { ownerId, limitNanoUsd: 100_000_000n } });
      await tx.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: permit.id } }, data: { allowanceId: allowance.id } });
      return { permitId: permit.id, allowanceId: allowance.id };
    });
    const target = { ownerId, permitId: scope.permitId, sourceIdentity: posting.sourceIdentity };
    const timestamps = { boardReady: 0, tlsPosts: 0, tlsMs: 0, screenMs: 0, importsMs: [] as number[], workerMs: {} as Record<string, number> };
    const elapsed = (start: number) => Math.round(performance.now() - start);
    const received = Promise.withResolvers<z.output<typeof intakeReceipt>>();
    const imports: z.output<typeof intakeReceipt>[] = [];
    const templateDir = await mkdtemp(join(tmpdir(), "jobs-native-n8n-"));
    const template = parseResumeDocument(`${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained catalogs\n`).markdown;
    await writeFile(join(templateDir, "web.md"), template);
    process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = templateDir;
    const gatewayKey = randomUUID();
    const provider = Bun.serve({
      hostname: "127.0.0.1", port: 443, tls: { cert: Bun.file(join(tlsDir, "good-chain.pem")), key: Bun.file(join(tlsDir, "good.key")) },
      async fetch(request) {
        timestamps.tlsPosts++;
        expect(new URL(request.url).pathname).toBe("/v1/messages");
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-api-key")).toBe(fixtureKey);
        expect(await request.text()).toBe(screenBody);
        const hold = await prisma.jobPilotAllowance.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: scope.allowanceId } } });
        expect(hold).toMatchObject({ heldNanoUsd: 52_240_000n, spentNanoUsd: 0n, screenCalls: 1 });
        return Response.json({
          id: "msg_fixture", type: "message", role: "assistant", model: MODEL, stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(result) }],
          usage: { input_tokens: 90, output_tokens: 20, service_tier: "standard", speed: "standard", inference_geo: "global" },
        }, { headers: { "anthropic-workspace-id": workspaceId, "request-id": "req_nativeN8nFixture" } });
      },
    });
    const pilot = createJobsPilotGateway({ db: prisma, target, key: gatewayKey,
      access: { owner, client: { kind: "api-key", id: "native-n8n-fixture", name: "Offline n8n" }, permissions: ["jobs:import-tailored"] },
      approved: { posting, criteria, approval: {
        workspaceId, requestDigest: digest(screenBody), postingDigest: fingerprintIdempotentRequest({ posting }),
        maxInputTokens: 100, inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n,
      } }, transport: { workspaceId, apiKey: fixtureKey, request: (async (url, options) => {
        const sentAt = performance.now();
        const response = await fetch(url, options);
        timestamps.tlsMs = elapsed(sentAt);
        return response;
      }) as typeof fetch }, onImported: receipt => imports.push(receipt),
    });
    const gateway = Bun.serve({
      hostname: "127.0.0.1", port: 3001,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return new Response("ok");
        if (path === "/ready") {
          timestamps.boardReady++;
          return Response.json({ permit: scope.permitId, key: gatewayKey });
        }
        if (request.method === "POST" && ["/expire", "/restore"].includes(path) && request.headers.get("x-jobs-pilot-key") === gatewayKey) {
          await prisma.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: scope.permitId } }, data: {
            expiresAt: new Date(Date.now() + (path === "/expire" ? -1_000 : 300_000)),
          } });
          return new Response(null, { status: 204 });
        }
        const started = performance.now();
        const response = await pilot(request);
        if (path === "/screen" && response.ok) timestamps.screenMs = elapsed(started);
        if (path === "/held-import" && response.ok) {
          timestamps.importsMs.push(elapsed(started));
          if (imports.length === 2) received.resolve(intakeReceipt.parse(imports[1]));
        }
        return response;
      },
    });
    try {
      const draft = await received.promise;
      expect(imports).toEqual([draft, draft]);
      expect(timestamps.tlsPosts).toBe(1);
      const worker = { ...target, ...draft, workerId: "native-n8n-fixture" };
      const brief = jobsBrief.parse({ ...briefFields, pay: { hourlyCad: null, original: null, converted: false } });
      const rates = { async convertMany() { throw new Error("Unexpected FX request"); } };
      const now = () => new Date();
      let modelCalls = 0;
      for (const kind of ["enrich", "tailor"] as const) {
        const body = jobsPilotRequestBody(policy, kind === "enrich"
          ? { track: "web", candidateContext: "", postingText: JSON.parse(importBody).applications[0].postingText }
          : { track: "web", candidateContext: "", brief, resumeMarkdown: template }, kind);
        const ledger = jobsPilotModelLedger(kind, { requestDigest: digest(body), policyDigest: jobsPilotPolicyDigest(policy) });
        const started = performance.now();
        expect(await runJobsPilotModelWork(prisma, worker, { ledger, policy, now, kind, async fakeProvider(raw, binding) {
          modelCalls++;
          expect(raw).toBe(body);
          return { requestId: randomUUID(), output: JSON.stringify(kind === "enrich" ? enrichment : { summaryMarkdown }),
            usage: { ...binding, model: policy.model, inputTokens: 100, outputTokens: 20 } };
        } })).toBe("replied");
        expect(await reportJobsPilotModelWork(prisma, worker, { ledger, kind, rates, now })).not.toBeNull();
        timestamps.workerMs[kind] = elapsed(started);
      }
      const [allowance, permit, screen, model, application, revisions, work, commands, events] = await Promise.all([
        prisma.jobPilotAllowance.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: scope.allowanceId } } }),
        prisma.jobPilotPermit.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: scope.permitId } } }),
        prisma.jobPilotScreenAttempt.findUniqueOrThrow({ where: { ownerId_permitId: { ownerId, permitId: scope.permitId } },
          select: { id: true, requestDigest: true, providerRequestId: true, reservedNanoUsd: true, chargedNanoUsd: true, settledAt: true } }),
        prisma.jobPilotModelAttempt.findMany({ where: { ownerId, permitId: scope.permitId }, orderBy: { phase: "asc" },
          select: { phase: true, resultId: true, workId: true, chargedNanoUsd: true, reservedNanoUsd: true, reportedAt: true } }),
        prisma.jobApplication.findMany({ where: { ownerId }, select: { id: true, status: true, revision: true, pilotHeldAt: true } }),
        prisma.jobRevision.findMany({ where: { ownerId, applicationId: draft.applicationId }, select: { revision: true, author: true } }),
        prisma.jobWorkItem.findMany({ where: { ownerId, applicationId: draft.applicationId }, orderBy: { kind: "asc" },
          select: { id: true, kind: true, state: true, revision: true, resultId: true } }),
        prisma.apiIdempotencyKey.count({ where: { operation: "importScreenedJobsPilotDraft", clientId: "native-n8n-fixture" } }),
        prisma.jobEvent.findMany({ where: { ownerId, applicationId: draft.applicationId }, select: { kind: true, revision: true } }),
      ]);
      expect(allowance).toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 35_600_000n, screenCalls: 1, enrichCalls: 1, tailorCalls: 1 });
      expect(permit).toMatchObject({ applicationId: draft.applicationId, sourceIdentity: posting.sourceIdentity, revision: 0, settledKeepResultId: screen.id });
      expect(model.map(row => row.chargedNanoUsd)).toEqual([charges.enrich, charges.tailor]);
      expect(application).toEqual([{ id: draft.applicationId, status: "review", revision: 1, pilotHeldAt: expect.any(Date) }]);
      expect(revisions).toEqual([{ revision: 1, author: "agent" }]);
      expect(work.map(row => [row.kind, row.state])).toEqual([["enrich", "done"], ["tailor", "done"]]);
      expect(events.map(row => row.kind).sort()).toEqual(["enriched", "imported", "tailored"]);
      expect(commands).toBe(1);
      expect(modelCalls).toBe(2);
      console.info("Jobs pilot native n8n " + JSON.stringify({ ...scope, sourceIdentity: posting.sourceIdentity, onlyLoopback: true,
        addresses, timestamps, modelCalls, allowance, screen, model, application, revisions, work, commands, events },
      (_, value) => typeof value === "bigint" ? value.toString() : value));
    } finally {
      await gateway.stop();
      await provider.stop(true);
      await rm(templateDir, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  120_000,
);
