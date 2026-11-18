import type { Prisma } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";
import { canonicalGreenhousePosting } from "./jobs-provider-import";

type Transaction = Prisma.TransactionClient;
export type JobsPilotPostingTarget = { ownerId: string; permitId: string; sourceIdentity: string };
type PostingTarget = JobsPilotPostingTarget;
type HeldTarget = PostingTarget & { applicationId: string; revision: number };
type PermitState = {
  sourceIdentity: string;
  expiresAt: Date; revokedAt: Date | null; applicationId: string | null; revision: number | null;
  settledKeepResultId: string | null; screenedPostingDigest: string | null; allowanceId: string | null;
};

async function requireUnimportedPosting(tx: Transaction, ownerId: string, sourceIdentity: string) {
  const [, , board, postingId] = sourceIdentity.split(":");
  const { sourceKey } = canonicalGreenhousePosting(board, postingId);
  const [match] = await tx.$queryRaw<{ imported: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "job_provider_posting" WHERE "ownerId" = ${ownerId} AND "sourceIdentity" = ${sourceIdentity}
    ) OR EXISTS (
      SELECT 1 FROM "job_application" WHERE "ownerId" = ${ownerId} AND "sourceKey" = ${sourceKey}
    ) AS imported
  `;
  if (match.imported) throw new JobsError(409, "The approved posting already has a Jobs application.");
}

export async function issueJobsPilotPermit(tx: Transaction, ownerId: string, { sourceIdentity, expiresAt }: {
  sourceIdentity: string; expiresAt: string;
}) {
  await requireUnimportedPosting(tx, ownerId, sourceIdentity);
  const issuedAt = new Date();
  const expires = new Date(expiresAt);
  if (expires <= issuedAt) throw new JobsError(400, "The pilot permit must expire in the future.");
  const permit = await tx.jobPilotPermit.create({
    data: { ownerId, sourceIdentity, issuedAt, expiresAt: expires },
    select: { id: true, sourceIdentity: true, expiresAt: true },
  });
  return { ...permit, expiresAt: permit.expiresAt.toISOString() };
}

export async function revokeJobsPilotPermit(tx: Transaction, ownerId: string, id: string) {
  const [permit] = await tx.$queryRaw<{ revokedAt: Date }[]>`
    UPDATE "job_pilot_permit"
    SET "revokedAt" = COALESCE("revokedAt", clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "ownerId" = ${ownerId} AND id = ${id}::uuid
    RETURNING "revokedAt"
  `;
  if (!permit) throw new JobsError(404, "Pilot permit not found.");
  return { id, revokedAt: permit.revokedAt.toISOString() };
}

export async function lockJobsPilotPermit(tx: Transaction, target: Omit<PostingTarget, "sourceIdentity"> & { sourceIdentity?: string }) {
  const [permit] = await tx.$queryRaw<PermitState[]>`
    SELECT "sourceIdentity", "expiresAt", "revokedAt", "applicationId", revision, "settledKeepResultId", "screenedPostingDigest", "allowanceId"
    FROM "job_pilot_permit"
    WHERE "ownerId" = ${target.ownerId} AND id = ${target.permitId}::uuid
      AND (${target.sourceIdentity ?? null}::text IS NULL OR "sourceIdentity" = ${target.sourceIdentity ?? null})
    FOR UPDATE
  `;
  if (!permit) throw new JobsError(404, "Pilot permit not found for this posting.");
  return permit;
}

function requireActive(permit: PermitState, now: () => Date) {
  if (permit.revokedAt || permit.expiresAt <= now()) throw new JobsError(409, "The pilot permit expired or was revoked.");
}

export async function authorizeJobsPilotReview(tx: Transaction, target: Omit<HeldTarget, "sourceIdentity">) {
  const permit = await lockJobsPilotPermit(tx, target);
  requireActive(permit, () => new Date());
  if (permit.applicationId !== target.applicationId || permit.revision === null || permit.revision >= target.revision ||
      !permit.settledKeepResultId || !permit.allowanceId) {
    throw new JobsError(409, "The pilot permit is not bound to this reviewed application.");
  }
  return permit.sourceIdentity;
}

async function lockHeldDraft(tx: Transaction, target: HeldTarget) {
  const [draft] = await tx.$queryRaw<{ id: string }[]>`
    SELECT draft.id
    FROM "job_provider_posting" AS posting
    JOIN "job_application" AS draft ON draft."ownerId" = posting."ownerId" AND draft.id = posting."applicationId"
    WHERE posting."ownerId" = ${target.ownerId} AND posting."sourceIdentity" = ${target.sourceIdentity}
      AND draft.id = ${target.applicationId} AND draft.revision = ${target.revision}
      AND draft.status = 'draft' AND draft."pilotHeldAt" IS NOT NULL
    FOR UPDATE OF draft, posting
  `;
  if (!draft) throw new JobsError(409, "The pilot draft or its revision changed.");
}

function requireBinding(permit: PermitState, target: PostingTarget | HeldTarget) {
  if ("applicationId" in target
    ? permit.applicationId !== target.applicationId || permit.revision !== target.revision
    : permit.applicationId !== null) {
    throw new JobsError(409, "The pilot permit is bound to a different stage or draft revision.");
  }
}

// Hold these locks in the transaction that authorizes a new operation.
export async function authorizeJobsPilotPermit(tx: Transaction, target: PostingTarget | HeldTarget, now = () => new Date()) {
  const permit = await lockJobsPilotPermit(tx, target);
  requireActive(permit, now);
  requireBinding(permit, target);
  if ("applicationId" in target) await lockHeldDraft(tx, target);
  else {
    if (permit.settledKeepResultId) throw new JobsError(409, "The pilot posting already has a settled keep result.");
    await requireUnimportedPosting(tx, target.ownerId, target.sourceIdentity);
  }
  requireActive(permit, now);
  return { expiresAt: permit.expiresAt, allowanceId: permit.allowanceId };
}

export async function authorizeJobsPilotIntake(tx: Transaction, target: PostingTarget, postingDigest: string, now: () => Date) {
  const permit = await lockJobsPilotPermit(tx, target);
  requireActive(permit, now);
  requireBinding(permit, target);
  if (!permit.settledKeepResultId || permit.screenedPostingDigest !== postingDigest) {
    throw new JobsError(409, "The pilot permit has no settled keep result for this posting.");
  }
}

// Bind inside the held draft writer's transaction, after it verifies screening settlement.
export async function bindJobsPilotDraft(tx: Transaction, target: HeldTarget, now = () => new Date()) {
  const permit = await lockJobsPilotPermit(tx, target);
  requireActive(permit, now);
  if (permit.applicationId !== null) {
    requireBinding(permit, target);
  } else if (target.revision !== 0) {
    throw new JobsError(409, "The pilot permit requires a newly imported held draft.");
  }
  await lockHeldDraft(tx, target);
  requireActive(permit, now);
  if (permit.applicationId !== null) return;
  await tx.jobPilotPermit.update({
    where: { ownerId_id: { ownerId: target.ownerId, id: target.permitId } },
    data: { applicationId: target.applicationId, revision: target.revision },
    select: { id: true },
  });
}
