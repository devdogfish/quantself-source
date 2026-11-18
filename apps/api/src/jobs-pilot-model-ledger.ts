import type { Prisma } from "@quantself/db/generated/prisma/client";
import { fingerprintIdempotentRequest } from "./idempotency";
import { JobsError } from "./jobs-error";
import { jobsPilotMoneyCap, reserveJobsPilotAllowance, settleJobsPilotAllowance } from "./jobs-pilot-allowance";
import { jobsPilotPolicyDigest, type JobsPilotLedger } from "./jobs-pilot-dispatch";
import { lockJobsPilotPermit } from "./jobs-pilot-permit";
import { jobsPilotCanonicalUsage } from "./jobs-pilot-usage";

type Transaction = Prisma.TransactionClient;
type Target = Parameters<JobsPilotLedger["reserve"]>[1];
type Phase = Exclude<JobsPilotLedger["phase"], "screen">;

function bindingMatches(permit: Awaited<ReturnType<typeof lockJobsPilotPermit>>, target: Target) {
  return permit.applicationId === target.applicationId && permit.revision === target.revision;
}

async function lockModelPermit(tx: Transaction, target: Target) {
  try {
    const permit = await lockJobsPilotPermit(tx, target);
    return bindingMatches(permit, target) ? permit : null;
  } catch (error) {
    if (error instanceof JobsError && error.status === 404) return null;
    throw error;
  }
}

// The server supplies the approved hashes. Recovery needs only the phase and stored binding.
export function jobsPilotModelLedger(phase: Phase, approval?: { requestDigest: string; policyDigest: string }): JobsPilotLedger {
  const permitWhere = (target: Target) => ({ ownerId: target.ownerId, permitId: target.permitId });
  const whereFor = (target: Target, kind = phase) => ({ ownerId_permitId_phase: { ...permitWhere(target), phase: kind } });

  return {
    phase,
    async reserve(tx, target, policy, now) {
      if (!approval || !/^[a-f0-9]{64}$/.test(approval.requestDigest) || jobsPilotPolicyDigest(policy) !== approval.policyDigest ||
        policy.inputTokens > 30_000 || policy.maxOutputTokens > 1_200 || policy.maximumNanoUsd > jobsPilotMoneyCap) return null;
      const permit = await lockModelPermit(tx, target);
      if (!permit?.allowanceId || permit.revokedAt || permit.expiresAt <= now || !permit.settledKeepResultId) return null;
      const allowance = { ownerId: target.ownerId, allowanceId: permit.allowanceId };
      const previous = phase === "enrich"
        ? await tx.jobPilotScreenAttempt.findFirst({ where: {
          ...permitWhere(target), allowanceId: allowance.allowanceId, id: permit.settledKeepResultId, chargedNanoUsd: { not: null },
        }, select: { id: true } })
        : await tx.jobPilotModelAttempt.findUnique({ where: {
          ...whereFor(target, "enrich"), allowanceId: allowance.allowanceId, reportedAt: { not: null },
        }, select: { resultId: true } });
      if (!previous || await tx.jobPilotModelAttempt.findUnique({ where: whereFor(target), select: { phase: true } })) return null;
      if (!await reserveJobsPilotAllowance(tx, allowance, phase, policy.maximumNanoUsd)) return null;
      await tx.jobPilotModelAttempt.create({
        data: {
          ...permitWhere(target), allowanceId: allowance.allowanceId, phase, workerId: target.workerId,
          ...approval, model: policy.model, inputTokens: policy.inputTokens, maxOutputTokens: policy.maxOutputTokens,
          inputNanoUsdPerToken: policy.inputNanoUsdPerToken, outputNanoUsdPerToken: policy.outputNanoUsdPerToken,
          reservedNanoUsd: policy.maximumNanoUsd,
        },
        select: { phase: true },
      });
      return approval.requestDigest;
    },
    async beginDispatch(tx, target, digest, claim, now) {
      if (!("workId" in claim)) return null;
      const permit = await lockModelPermit(tx, target);
      if (!permit?.allowanceId || permit.revokedAt || permit.expiresAt <= now) return null;
      const { count } = await tx.jobPilotModelAttempt.updateMany({
        where: { ...permitWhere(target), phase, allowanceId: permit.allowanceId, workerId: target.workerId, requestDigest: digest, resultId: null },
        data: claim,
      });
      return count === 1 ? permit.expiresAt : null;
    },
    async recordReply(tx, target, reply) {
      if (!await lockModelPermit(tx, target)) return false;
      const where = whereFor(target);
      const { requestId, usage, chargeNanoUsd } = reply;
      const attempt = await tx.jobPilotModelAttempt.findUnique({ where });
      if (!requestId.trim() || !jobsPilotCanonicalUsage.safeParse(usage).success ||
        !attempt || attempt.workerId !== target.workerId || attempt.resultId !== usage.resultId ||
        attempt.requestDigest !== usage.requestDigest || attempt.model !== usage.model ||
        attempt.inputTokens !== usage.inputTokens || usage.outputTokens < 1 || usage.outputTokens > attempt.maxOutputTokens ||
        chargeNanoUsd !== BigInt(usage.inputTokens) * attempt.inputNanoUsdPerToken + BigInt(usage.outputTokens) * attempt.outputNanoUsdPerToken ||
        chargeNanoUsd > attempt.reservedNanoUsd) return false;
      if (attempt.chargedNanoUsd !== null) {
        return attempt.providerRequestId === requestId && attempt.chargedNanoUsd === chargeNanoUsd &&
          fingerprintIdempotentRequest({ usage: attempt.usage, result: attempt.result }) ===
          fingerprintIdempotentRequest({ usage, result: reply.result });
      }
      await settleJobsPilotAllowance(tx, { ownerId: target.ownerId, allowanceId: attempt.allowanceId }, attempt.reservedNanoUsd, chargeNanoUsd);
      await tx.jobPilotModelAttempt.update({
        where, data: { chargedNanoUsd: chargeNanoUsd, providerRequestId: requestId, usage, result: reply.result as Prisma.InputJsonObject },
        select: { phase: true },
      });
      return true;
    },
    async readReport(tx, target) {
      const permit = await lockModelPermit(tx, target);
      if (!permit) return null;
      const attempt = await tx.jobPilotModelAttempt.findUnique({ where: whereFor(target) });
      if (!attempt?.resultId || attempt.workerId !== target.workerId || attempt.chargedNanoUsd === null) return null;
      if (attempt.reportedAt) return { state: "reported", resultId: attempt.resultId };
      if (permit.revokedAt || !permit.allowanceId || permit.allowanceId !== attempt.allowanceId) return null;
      const claim = attempt.workId && attempt.leaseTokenHash
        ? { workId: attempt.workId, leaseTokenHash: attempt.leaseTokenHash, resultId: attempt.resultId }
        : null;
      return { state: "replied", resultId: attempt.resultId, result: attempt.result, claim, permitExpiresAt: permit.expiresAt };
    },
    async settleReport(tx, target, resultId, now) {
      const permit = await lockModelPermit(tx, target);
      if (!permit?.allowanceId || permit.revokedAt || permit.expiresAt <= now) return false;
      const { count } = await tx.jobPilotModelAttempt.updateMany({
        where: {
          ...permitWhere(target), phase, allowanceId: permit.allowanceId, workerId: target.workerId,
          resultId, reportedAt: null, chargedNanoUsd: { not: null },
        },
        data: { reportedAt: now },
      });
      return count === 1;
    },
  };
}
