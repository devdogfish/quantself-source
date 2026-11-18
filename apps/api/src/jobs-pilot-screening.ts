import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { prepareQuantselfBatches } from "../../../automation/n8n/jobs-feed/quantself/quantself.mjs";
import { settleScreenResponse } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { fingerprintIdempotentRequest } from "./idempotency";
import { JobsError } from "./jobs-error";
import { jobsPilotMoneyCap, reserveJobsPilotAllowance, settleJobsPilotAllowance } from "./jobs-pilot-allowance";
import type { JobsImportApplication } from "./jobs-owner-contract";
import { parseHeldJobsPosting } from "./jobs-owner-write";
import { jobsPilotAnthropicApproval, jobsPilotAnthropicRequestLimit, readAnthropicPilotReceipt } from "./jobs-pilot-anthropic-receipt";
import { authorizeJobsPilotPermit, lockJobsPilotPermit, type JobsPilotPostingTarget } from "./jobs-pilot-permit";
import { jobsPilotScreenInputCap, jobsPilotScreenOutputCap, jobsPilotScreenPosting, prepareJobsPilotScreenRequest } from "./jobs-pilot-screen-request";

type ScreenApproval = {
  requestDigest: string;
  postingDigest: string;
  workspaceId: string;
  maxInputTokens: number;
  inputNanoUsdPerToken: bigint;
  outputNanoUsdPerToken: bigint;
};

// The approval is server-supplied. Only a newly committed reservation returns bytes.
// No runtime owns provider transport or a verified billed-input bound yet.
export async function reserveJobsPilotScreen(db: PrismaClient, target: JobsPilotPostingTarget, input: {
  posting: unknown; criteria: string; approval: ScreenApproval;
}, now = () => new Date()) {
  const prepared = prepareJobsPilotScreenRequest(target.sourceIdentity, input.posting, input.criteria);
  const { posting, request, body } = prepared;
  if (body.byteLength > jobsPilotAnthropicRequestLimit) return null;
  const { requestDigest, postingDigest, workspaceId, maxInputTokens, inputNanoUsdPerToken, outputNanoUsdPerToken } = input.approval;
  const maxOutputTokens = request.max_tokens;
  const resultId = randomUUID();
  const receiptApproval = { resultId, requestDigest, workspaceId, model: request.model, maxInputTokens, maxOutputTokens };
  if (requestDigest !== prepared.requestDigest ||
      postingDigest !== prepared.postingDigest ||
      !jobsPilotAnthropicApproval.safeParse(receiptApproval).success ||
      maxInputTokens > jobsPilotScreenInputCap || maxOutputTokens > jobsPilotScreenOutputCap || inputNanoUsdPerToken <= 0n || outputNanoUsdPerToken <= 0n) {
    throw new JobsError(409, "Screening does not match the approved request and pricing policy.");
  }
  const reservedNanoUsd = BigInt(maxInputTokens) * inputNanoUsdPerToken + BigInt(maxOutputTokens) * outputNanoUsdPerToken;
  if (reservedNanoUsd > jobsPilotMoneyCap) {
    throw new JobsError(409, "The screening reservation exceeds the approved allowance.");
  }

  const reserved = await db.$transaction(async tx => {
    // Replacement permits can point to different allowances. Serialize screen admission before reading prior attempts.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"jobs-pilot-screen:" + target.ownerId}, 0))`;
    const { expiresAt, allowanceId } = await authorizeJobsPilotPermit(tx, target, now);
    if (!allowanceId) throw new JobsError(409, "The screening permit has no shared allowance.");
    const { count } = await tx.jobPilotScreenAttempt.createMany({
      data: {
        ownerId: target.ownerId, permitId: target.permitId, id: resultId, allowanceId, requestDigest, workspaceId,
        model: request.model, posting, maxInputTokens, maxOutputTokens, inputNanoUsdPerToken, outputNanoUsdPerToken, reservedNanoUsd,
      },
      skipDuplicates: true,
    });
    if (count !== 1) return null;
    const [prior] = await tx.$queryRaw<{ unresolved: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM "job_pilot_screen_attempt" AS attempt
        JOIN "job_pilot_permit" AS permit
          ON permit."ownerId" = attempt."ownerId" AND permit.id = attempt."permitId"
        WHERE attempt."ownerId" = ${target.ownerId} AND attempt."permitId" <> ${target.permitId}::uuid
          AND attempt."chargedNanoUsd" IS NULL
          AND (attempt."allowanceId" = ${allowanceId}::uuid OR permit."sourceIdentity" = ${target.sourceIdentity})
      ) AS unresolved
    `;
    if (prior.unresolved) throw new JobsError(409, "A previous pilot screen requires billing reconciliation.");
    if (!await reserveJobsPilotAllowance(tx, { ownerId: target.ownerId, allowanceId }, "screen", reservedNanoUsd)) {
      throw new JobsError(409, "The screening reservation exceeds the shared allowance or call cap.");
    }
    return { resultId, body, expiresAt, receiptApproval };
  }, { isolationLevel: "ReadCommitted" });
  // A late acknowledgement leaves the reservation intact and yields no dispatch bytes.
  return reserved && reserved.expiresAt > now() ? reserved : null;
}

function screenedImport(posting: unknown, response: Parameters<typeof readAnthropicPilotReceipt>[1], attemptId: string) {
  const result = settleScreenResponse({ statusCode: response.status, body: response.body });
  if (!result.ok || result.result.decision !== "keep") return null;
  const candidate = { ...jobsPilotScreenPosting.parse(posting), ...result.result };
  try {
    const [{ body }] = prepareQuantselfBatches([candidate], attemptId);
    return parseHeldJobsPosting(body.applications[0], candidate.sourceIdentity);
  } catch (error) {
    if (error instanceof JobsError) return null;
    throw error;
  }
}

// Only the trusted first-party transport can submit a response to this internal seam.
export async function settleJobsPilotScreen(db: PrismaClient, target: JobsPilotPostingTarget,
  response: Parameters<typeof readAnthropicPilotReceipt>[1], now = () => new Date()) {
  return db.$transaction(async tx => {
    const permit = await lockJobsPilotPermit(tx, target);
    const where = { ownerId_permitId: { ownerId: target.ownerId, permitId: target.permitId } };
    const attempt = await tx.jobPilotScreenAttempt.findUnique({ where });
    if (!attempt) return null;
    const { id: resultId, requestDigest, workspaceId, model, maxInputTokens, maxOutputTokens } = attempt;
    const receipt = readAnthropicPilotReceipt({ resultId, requestDigest, workspaceId, model, maxInputTokens, maxOutputTokens }, response);
    if (!receipt) return null;
    const receiptDigest = fingerprintIdempotentRequest(receipt);
    if (attempt.chargedNanoUsd !== null) {
      if (attempt.receiptDigest !== receiptDigest) return null;
      return { resultId, chargeNanoUsd: attempt.chargedNanoUsd, posting: attempt.intakePosting as JobsImportApplication | null };
    }

    const { inputTokens, outputTokens } = receipt.usage;
    const chargeNanoUsd = BigInt(inputTokens) * attempt.inputNanoUsdPerToken + BigInt(outputTokens) * attempt.outputNanoUsdPerToken;
    if (chargeNanoUsd > attempt.reservedNanoUsd) return null;
    const posting = screenedImport(attempt.posting, response, resultId);
    if (attempt.allowanceId) {
      await settleJobsPilotAllowance(tx, { ownerId: target.ownerId, allowanceId: attempt.allowanceId }, attempt.reservedNanoUsd, chargeNanoUsd);
    }
    const settledAt = now();
    const attached = posting && attempt.allowanceId && permit.allowanceId === attempt.allowanceId &&
      !permit.revokedAt && permit.expiresAt > settledAt &&
      !permit.applicationId && !permit.settledKeepResultId ? posting : null;
    await tx.jobPilotScreenAttempt.update({
      where, data: {
        chargedNanoUsd: chargeNanoUsd, providerRequestId: receipt.requestId, receiptDigest, settledAt, inputTokens, outputTokens,
        ...(attached && { intakePosting: attached }),
      },
      select: { id: true },
    });
    if (attached) {
      await tx.jobPilotPermit.update({
        where: { ownerId_id: { ownerId: target.ownerId, id: target.permitId } },
        data: { settledKeepResultId: resultId, screenedPostingDigest: fingerprintIdempotentRequest({ posting: attached }) },
        select: { id: true },
      });
    }
    return { resultId, chargeNanoUsd, posting: attached };
  });
}
