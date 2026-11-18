import { z } from "zod";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";
import type { jobsPilotReviewInput } from "./jobs-owner-contract";
import { authorizeJobsPilotReview } from "./jobs-pilot-permit";

const pilotReviewPayload = z.object({ pilotReview: z.object({ permitId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }) });
export const pilotReviewOf = (payload: unknown) => pilotReviewPayload.safeParse(payload).data?.pilotReview;

export async function reviewJobsPilotCandidate(tx: Prisma.TransactionClient, ownerId: string, permitId: string,
  input: z.output<typeof jobsPilotReviewInput>) {
  const { applicationId, expectedRevision: revision, action } = input;
  const key = { ownerId, applicationId, revision };
  const sourceIdentity = await authorizeJobsPilotReview(tx, { ...key, permitId });
  const preparing = action === "prepare";
  const sha256 = preparing ? null : input.sha256;
  const job = await tx.jobApplication.findUnique({ where: {
    ownerId_id: { ownerId, id: applicationId }, revision, approvedRevision: revision,
    status: preparing ? "approved" : "queued", approvedPreviewDigest: sha256, pilotHeldAt: { not: null },
    providerPostings: { some: { sourceIdentity } },
  }, select: { updatedAt: true } });
  if (!job) throw new JobsError(409, "The held application, approval or PDF changed. Refresh before continuing.");
  if (!preparing && !await tx.jobRevision.findUnique({ where: {
    ownerId_applicationId_revision: key, pdfSha256: sha256, pdfReference: { not: null },
  }, select: { revision: true } })) throw new JobsError(409, "The approved PDF is unavailable.");
  const changed = await tx.jobApplication.updateMany({ where: {
    ownerId, id: applicationId, revision, updatedAt: job.updatedAt,
  }, data: { lastOwnerEditedAt: new Date() } });
  if (changed.count !== 1) throw new JobsError(409, "The application changed. Refresh before continuing.");
  const kind = preparing ? "render" : "submit";
  const work = await tx.jobWorkItem.findUnique({ where: {
    ownerId_applicationId_kind_revision: { ...key, kind }, state: "queued",
  }, select: { id: true, payload: true } });
  if (!work || pilotReviewOf(work.payload)) throw new JobsError(409, "This pilot work is already authorized or is no longer queued.");
  const payload = work.payload && typeof work.payload === "object" && !Array.isArray(work.payload) ? work.payload : {};
  await tx.jobWorkItem.update({ where: { ownerId_id: { ownerId, id: work.id }, state: "queued" }, data: {
    payload: { ...payload, pilotReview: { permitId, sha256 } },
  } });
  await tx.jobEvent.create({ data: {
    ...key, kind: preparing ? "pilot_preview_authorized" : "pilot_submission_released", payload: { permitId, workId: work.id, sha256 },
  } });
  return { action, applicationId, revision, workId: work.id, sha256 };
}
