import type { Prisma } from "@quantself/db/generated/prisma/client";

export const jobsPilotMoneyCap = 100_000_000n;
export const jobsPilotScreenCallCap = 2;
type Allowance = { ownerId: string; allowanceId: string };
type Phase = "screen" | "enrich" | "tailor";

export async function reserveJobsPilotAllowance(tx: Prisma.TransactionClient, target: Allowance, phase: Phase, amount: bigint) {
  if (amount <= 0n || amount > jobsPilotMoneyCap) return false;
  return 1 === await tx.$executeRaw`
    UPDATE "job_pilot_allowance"
    SET "heldNanoUsd" = "heldNanoUsd" + ${amount},
      "screenCalls" = "screenCalls" + (${phase} = 'screen')::int,
      "enrichCalls" = "enrichCalls" + (${phase} = 'enrich')::int,
      "tailorCalls" = "tailorCalls" + (${phase} = 'tailor')::int
    WHERE "ownerId" = ${target.ownerId} AND id = ${target.allowanceId}::uuid
      AND "heldNanoUsd" <= "limitNanoUsd" - "spentNanoUsd" - ${amount}
      AND "screenCalls" + (${phase} = 'screen')::int <= ${jobsPilotScreenCallCap}
      AND "enrichCalls" + (${phase} = 'enrich')::int <= 1
      AND "tailorCalls" + (${phase} = 'tailor')::int <= 1
  `;
}

// Call only while holding the attempt's permit lock, in the same transaction as its first charge.
export async function settleJobsPilotAllowance(tx: Prisma.TransactionClient, target: Allowance, reserved: bigint, charged: bigint) {
  if (charged <= 0n || charged > reserved || 1 !== await tx.$executeRaw`
    UPDATE "job_pilot_allowance"
    SET "heldNanoUsd" = "heldNanoUsd" - ${reserved}, "spentNanoUsd" = "spentNanoUsd" + ${charged}
    WHERE "ownerId" = ${target.ownerId} AND id = ${target.allowanceId}::uuid AND "heldNanoUsd" >= ${reserved}
  `) throw new Error("Jobs pilot allowance does not cover the recorded attempt.");
}
