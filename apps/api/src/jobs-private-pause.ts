import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { JobApplication, Prisma } from "@quantself/db/generated/prisma/client";
import { privateFieldRequirement } from "./jobs-private-fields-contract";

export const privatePauseSchema = z.strictObject({
  approvalRevision: z.number().int().positive(),
  snapshot: z.string().regex(/^[0-9a-f]{64}$/),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  fields: z.array(privateFieldRequirement).min(1).max(40),
  keys: z.array(z.string()).min(1).max(40),
});

export const hashJobWorkToken = (value: string) => createHash("sha256").update(value).digest("hex");

export const approvedJobSnapshot = (job: Pick<JobApplication, "id" | "summary" | "resumeTrack" | "sourceUrl" | "company" | "role"> & { resumeMarkdown?: string | null }) =>
  hashJobWorkToken(JSON.stringify([job.id, job.summary, job.resumeTrack, job.sourceUrl, job.company, job.role, ...(job.resumeMarkdown ? [job.resumeMarkdown] : [])]));

export function readPrivatePauseFieldKeys(job: Parameters<typeof approvedJobSnapshot>[0] &
  Pick<JobApplication, "status" | "issueCode" | "privatePause" | "approvedRevision">) {
  if (job.status !== "needs_attention" || job.issueCode !== "manual_required") return;
  const pause = privatePauseSchema.safeParse(job.privatePause).data;
  if (pause && pause.approvalRevision === job.approvedRevision && pause.snapshot === approvedJobSnapshot(job)) {
    return pause.fields.map(field => field.key);
  }
}

// Take the same lock before reading a claimed pause or writing private field rows.
// Read Committed then sees the winner's complete transaction, even after waiting.
export async function lockPrivateJobDetails(tx: Prisma.TransactionClient, ownerId: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${"jobs-private-details:" + ownerId}, 0))`;
}
