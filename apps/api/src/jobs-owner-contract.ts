import { z } from "@hono/zod-openapi";
import { resumeMarkdown, resumeTrack } from "./jobs-contract";
import { submissionOutput } from "./jobs-operations-read";
import { jobReviewRow } from "./jobs-review-contract";
import { jobsRunnerKeyPattern } from "./jobs-runner-pairing";

const revision = z.number().int().min(0).max(2_147_483_646);
const expectedRevision = { expectedRevision: revision };
export const jobsOwnerDecision = z.discriminatedUnion("action", [
  z.strictObject({ ...expectedRevision, action: z.enum(["approve", "skip", "later", "retry_draft", "reopen"]) }),
  z.strictObject({ ...expectedRevision, action: z.literal("reject"), reasons: z.array(z.string().trim().min(1).max(160)).min(1).max(10) }),
  z.strictObject({ ...expectedRevision, action: z.literal("revise"), instructions: z.string().trim().min(1).max(1_000) }),
]);

export const jobsAddApplicationInput = z.strictObject({
  sourceUrl: z.string().trim().min(1).max(2_048), company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(200), track: resumeTrack, postingText: z.string().trim().min(1).max(12_000),
  source: z.string().trim().min(1).max(120).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  salary: z.string().trim().max(200).nullable().optional(),
  dueAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable().optional(),
  resumeMarkdown: resumeMarkdown.optional(),
});
export const jobsAddApplicationOutput = z.object({ application: jobReviewRow, duplicate: z.boolean() });
export const jobsGreenhouseSourceIdentity = z.string().regex(/^greenhouse:global:[a-z0-9_-]{1,120}:[1-9][0-9]{0,15}$/);
const jobsImportApplication = jobsAddApplicationInput.extend({
  sourceIdentity: jobsGreenhouseSourceIdentity.optional()
    .openapi({ description: "Public Greenhouse board and posting identity for new draft imports." }),
  recordedStatus: z.enum(["applied", "disqualified", "rejected", "saved_for_later", "skipped"]).optional(),
}).refine(row => !row.sourceIdentity || !row.recordedStatus, { message: "Provider identity is for drafts.", path: ["sourceIdentity"] });
export const jobsImportApplicationsInput = z.strictObject({ applications: z.array(jobsImportApplication).min(1).max(100) });
export const jobsImportApplicationsOutput = z.object({ imported: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative() });

export const jobsPilotPermitInput = z.strictObject({
  sourceIdentity: jobsGreenhouseSourceIdentity, expiresAt: z.iso.datetime({ offset: true }),
});
export const jobsPilotPermitOutput = z.object({
  id: z.uuid(), sourceIdentity: jobsGreenhouseSourceIdentity, expiresAt: z.iso.datetime(),
});
export const jobsPilotRevocationOutput = z.object({ id: z.uuid(), revokedAt: z.iso.datetime() });
export const jobsPilotReviewInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare"), applicationId: z.uuid(), ...expectedRevision }),
  z.strictObject({ action: z.literal("release"), applicationId: z.uuid(), ...expectedRevision, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const jobsPilotReviewOutput = z.object({
  action: z.enum(["prepare", "release"]), applicationId: z.uuid(), revision, workId: z.uuid(), sha256: z.string().nullable(),
});

const runner = z.object({
  state: z.enum(["idle", "submitting", "paused", "offline"]),
  host: z.string().nullable(), lastHeartbeatAt: z.iso.datetime().nullable(),
});
export const jobsRunnerOutput = z.object({ runner });
export const jobsRunnerPauseInput = z.strictObject({ paused: z.boolean() });
export const jobsRunnerPairingOutput = z.object({ key: z.string().regex(jobsRunnerKeyPattern) });

export const jobsResolveInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["requeue", "skip"]) }),
  z.strictObject({ action: z.literal("mark_not_sent"), expectedUpdatedAt: z.iso.datetime().optional() }),
  z.strictObject({
    action: z.literal("mark_applied"), confirmation: z.string().trim().min(1).max(2_000).optional(),
    expectedUpdatedAt: z.iso.datetime().optional(),
  }),
]);
export const jobsResolveOutput = z.object({ submission: submissionOutput });

export type JobsOwnerDecision = z.output<typeof jobsOwnerDecision>;
export type JobsAddApplicationInput = z.output<typeof jobsAddApplicationInput>;
export type JobsImportApplication = z.output<typeof jobsImportApplication>;
export type JobsResolution = z.output<typeof jobsResolveInput>;
