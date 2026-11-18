import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import type { CurrencyConverter } from "./budget-fx";
import { jobsModelRequest, parseJobsEnrichmentResult } from "./jobs-model-request";
import { jobsPilotCanonicalUsage, jobsPilotTokenCount, type JobsPilotUsage, type JobsPilotUsageBinding } from "./jobs-pilot-usage";
import { hashJobWorkToken } from "./jobs-private-pause";
import { jobsSummaryOutput } from "./jobs-work-contract";
import { claimHeldJobsModelWork, completeHeldJobsModelWork, withJobsWorkTransaction } from "./jobs-work-service";

type Target = { permitId: string; ownerId: string; applicationId: string; revision: number; workerId: string };
type Policy = {
  id: string; model: string; inputTokens: number; maxOutputTokens: number;
  inputNanoUsdPerToken: bigint; outputNanoUsdPerToken: bigint; maximumNanoUsd: bigint;
};
type ModelKind = "enrich" | "tailor";
type ProviderReply = { requestId: string; output: string; usage?: unknown };
type Reply = { requestId: string; result: unknown; usage: JobsPilotUsage; chargeNanoUsd: bigint };
type Transaction = Prisma.TransactionClient;
type Claim = { workId: string; leaseTokenHash: string; resultId: string };
type StoredReport = { state: "reported"; resultId: string } |
  { state: "replied"; resultId: string; claim: Claim | null; result: unknown; permitExpiresAt: Date };

export type JobsPilotLedger = {
  phase: "screen" | ModelKind;
  reserve(tx: Transaction, target: Target, policy: Policy, now: Date): Promise<string | null>;
  beginDispatch(tx: Transaction, target: Target, digest: string, claim: Claim | { resultId: string }, now: Date): Promise<Date | null>;
  recordReply(tx: Transaction, target: Target, reply: Reply): Promise<boolean>;
  readReport(tx: Transaction, target: Target): Promise<StoredReport | null>;
  settleReport(tx: Transaction, target: Target, resultId: string, now: Date): Promise<boolean>;
};

export function jobsPilotPolicyDigest(policy: Policy) {
  return createHash("sha256").update(JSON.stringify([
    policy.id, policy.model, policy.inputTokens, policy.maxOutputTokens, policy.inputNanoUsdPerToken.toString(),
    policy.outputNanoUsdPerToken.toString(), policy.maximumNanoUsd.toString(),
  ])).digest("hex");
}

function priceUsage(policy: Policy, inputTokens: number, outputTokens: number) {
  return BigInt(inputTokens) * policy.inputNanoUsdPerToken + BigInt(outputTokens) * policy.outputNanoUsdPerToken;
}

export function jobsPilotRequestBody(policy: Policy, input: unknown, kind: ModelKind = "enrich") {
  return JSON.stringify({ model: policy.model, maxOutputTokens: policy.maxOutputTokens, ...jobsModelRequest(kind, input) });
}

export function readJobsPilotReply(policy: Policy, binding: JobsPilotUsageBinding,
  { requestId, output, usage: rawUsage }: ProviderReply, parseResult: (value: unknown) => unknown): Reply | null {
  try {
    const usage = jobsPilotCanonicalUsage.parse(rawUsage);
    if (!requestId.trim() || usage.model !== policy.model || usage.requestDigest !== binding.requestDigest ||
        usage.resultId !== binding.resultId || usage.inputTokens !== policy.inputTokens ||
        usage.outputTokens > policy.maxOutputTokens) return null;
    return { requestId, result: parseResult(JSON.parse(output)), usage,
      chargeNanoUsd: priceUsage(policy, usage.inputTokens, usage.outputTokens) };
  } catch {
    return null;
  }
}

class PilotDenied extends Error {}

// Internal offline entrypoint. Only the Docker fixture supplies a grant ledger and provider.
export async function runJobsPilotModelWork(db: PrismaClient, target: Target, { ledger, policy, fakeProvider, now, kind = "enrich" }: {
  ledger: JobsPilotLedger;
  policy: Policy;
  fakeProvider: (body: string, binding: JobsPilotUsageBinding) => Promise<ProviderReply>;
  now: () => Date;
  kind?: ModelKind;
}): Promise<"denied" | "uncertain" | "replied"> {
  if (ledger.phase !== kind || !policy.id || !policy.model || !jobsPilotTokenCount.safeParse(policy.inputTokens).success ||
      !jobsPilotTokenCount.safeParse(policy.maxOutputTokens).success || policy.inputNanoUsdPerToken <= 0n ||
      policy.outputNanoUsdPerToken <= 0n || priceUsage(policy, policy.inputTokens, policy.maxOutputTokens) > policy.maximumNanoUsd) {
    return "denied";
  }

  let dispatch: { body: string; deadline: number; binding: JobsPilotUsageBinding };
  try {
    dispatch = await withJobsWorkTransaction(db, async tx => {
      const approvedDigest = await ledger.reserve(tx, target, policy, now());
      if (!approvedDigest) throw new PilotDenied();
      const { work } = await claimHeldJobsModelWork(tx, { ownerId: target.ownerId, role: "codex" }, target, now(), kind);
      if (work?.kind !== kind || (work.kind === "enrich" && work.input.publicPosting)) throw new PilotDenied();

      const body = jobsPilotRequestBody(policy, work.input, kind);
      const digest = createHash("sha256").update(body).digest("hex");
      const dispatchAt = now();
      const leaseUntil = Date.parse(work.leaseUntil);
      if (digest !== approvedDigest || leaseUntil <= dispatchAt.getTime()) throw new PilotDenied();
      const claim = { workId: work.id, leaseTokenHash: hashJobWorkToken(work.leaseToken), resultId: randomUUID() };
      const permitExpiresAt = await ledger.beginDispatch(tx, target, digest, claim, dispatchAt);
      if (!permitExpiresAt) throw new PilotDenied();
      return { body, deadline: Math.min(leaseUntil, permitExpiresAt.getTime()), binding: { requestDigest: digest, resultId: claim.resultId } };
    });
  } catch (error) {
    if (error instanceof PilotDenied) return "denied";
    throw error;
  }

  let reply: Reply | null;
  try {
    // The committed reservation stays in place if time ran out while SQL or commit completed.
    if (!(now().getTime() < dispatch.deadline)) return "uncertain";
    reply = readJobsPilotReply(policy, dispatch.binding, await fakeProvider(dispatch.body, dispatch.binding),
      kind === "enrich" ? parseJobsEnrichmentResult : value => jobsSummaryOutput.parse(value));
  } catch {
    return "uncertain";
  }
  if (!reply) return "uncertain";
  const verifiedReply = reply;
  return await withJobsWorkTransaction(db, tx => ledger.recordReply(tx, target, verifiedReply)) ? "replied" : "uncertain";
}

// Offline reporting can only consume the result and exact claim recorded by dispatch.
export async function reportJobsPilotModelWork(db: PrismaClient, target: Target, { ledger, rates, now, kind = "enrich" }: {
  ledger: JobsPilotLedger;
  rates: CurrencyConverter;
  now: () => Date;
  kind?: ModelKind;
}): Promise<{ resultId: string } | null> {
  if (ledger.phase !== kind) return null;
  try {
    return await withJobsWorkTransaction(db, async tx => {
      const stored = await ledger.readReport(tx, target);
      if (!stored) return null;
      if (stored.state === "reported") return { resultId: stored.resultId };
      const reportAt = now();
      if (!stored.claim || stored.permitExpiresAt <= reportAt) return null;
      const result = kind === "enrich" ? parseJobsEnrichmentResult(stored.result) : jobsSummaryOutput.parse(stored.result);
      if (!await completeHeldJobsModelWork(tx, target, stored.claim, result, reportAt, rates, kind)) return null;
      if (!await ledger.settleReport(tx, target, stored.claim.resultId, now())) throw new PilotDenied();
      return { resultId: stored.claim.resultId };
    });
  } catch (error) {
    if (error instanceof PilotDenied) return null;
    throw error;
  }
}
