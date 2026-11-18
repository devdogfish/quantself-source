import { z } from "@hono/zod-openapi";
import { applicationAddressPattern, sesMessageIdPattern } from "../../../scripts/jobs/application-address";
import { issueCode, jobStatus, resumeTrack } from "./jobs-contract";
import { jobsBrief } from "./jobs-work-contract";
import { maxResumeMarkdown } from "../../../scripts/jobs/resume-document";

const id = z.uuid();
const revision = z.number().int().nonnegative();
const verdict = z.enum(["strong", "review", "weak"]);
export const jobsApplicationsTab = z.enum(["all", "review", "progress", "attention", "applied", "closed"]);

export const jobsReviewableInput = z.object({
  tab: jobsApplicationsTab.optional(),
  q: z.string().trim().max(120).optional(),
  track: resumeTrack.optional(),
  status: jobStatus.optional(),
  due: z.enum(["overdue", "week", "fortnight", "none"]).optional(),
  verdict: verdict.optional(),
  sort: z.enum(["due", "match", "updated"]).optional(),
});

export const jobsApplicationsInput = jobsReviewableInput.extend({
  page: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(15),
});

export const jobsReviewableOutput = z.object({ ids: z.array(id) });
export const jobsApplicationAddressInput = z.strictObject({
  address: z.string().regex(applicationAddressPattern).describe("Exact registered Application Address."),
});
export const jobsApplicationAddressOutput = z.strictObject({ id });

const sesReplyHeaderToken = /^<([a-zA-Z0-9-]{1,256})@email\.amazonses\.com>$/;
const sesReplyEvidence = z.union([
  z.string().regex(sesMessageIdPattern),
  z.string().regex(sesReplyHeaderToken),
]).transform(value => sesReplyHeaderToken.exec(value)?.[1] ?? value)
  .describe("Exact recorded SES ID or one complete <id@email.amazonses.com> token.");

export const jobsApplicationReplyInput = z.union([
  jobsApplicationAddressInput.extend({ inReplyTo: sesReplyEvidence.optional() }),
  z.strictObject({ inReplyTo: sesReplyEvidence }),
]);

export const jobsReviewSessionInput = z.object({
  ids: z.string().transform(value => value.split(",")).pipe(z.array(id).min(1)),
});

export const jobReviewRow = z.object({
  id, company: z.string(), role: z.string(), track: resumeTrack,
  status: jobStatus, issue: issueCode.nullable(), verdict: verdict.nullable(), dueAt: z.iso.datetime().nullable(),
  source: z.string().nullable(), sourceUrl: z.url(), updatedAt: z.iso.datetime(), appliedAt: z.iso.datetime().nullable(),
});
export const jobReviewApplicationDetail = jobReviewRow.extend({
  brief: jobsBrief.nullable(), postingText: z.string(), revision, approvedRevision: revision.nullable(),
  summaryMarkdown: z.string(), resumeMarkdown: z.string(), pdfUrl: z.string().nullable(),
  privatePauseFieldKeys: z.array(z.string()).optional(),
}).openapi("JobReviewApplicationDetail");

export const jobsReviewSessionOutput = z.object({ items: z.array(jobReviewApplicationDetail) });
export const jobsApplicationsOutput = z.object({
  rows: z.array(jobReviewRow), total: z.number().int().nonnegative(), pageSize: z.number().int().positive(),
  tabCounts: z.record(jobsApplicationsTab, z.number().int().nonnegative()),
});
export const jobsApplicationsExportInput = jobsReviewableInput.extend({ format: z.enum(["ids", "csv"]) });
export const jobsApplicationsExportOutput = z.union([
  z.object({ ids: z.array(id) }),
  z.object({ rows: z.array(jobReviewRow.pick({ id: true, company: true, role: true, status: true, updatedAt: true })
    .extend({ location: z.string().nullable() })) }),
]);
export const jobsReviewEditInput = z.strictObject({
  expectedRevision: revision.max(2_147_483_646),
  summaryMarkdown: z.string().trim().min(1).max(2_000).optional(),
  resumeMarkdown: z.string().min(1).max(maxResumeMarkdown).optional(),
}).refine(({ summaryMarkdown, resumeMarkdown }) => summaryMarkdown !== undefined || resumeMarkdown !== undefined);
export const jobsReviewApplicationOutput = z.object({ application: jobReviewApplicationDetail });
export const jobsPostingDetailsInput = z.strictObject({
  expectedRevision: revision.max(2_147_483_647),
  previousText: z.string().max(12_000),
  postingText: z.string().trim().min(1).max(12_000),
  sourceWordCount: z.number().int().positive().max(100_000),
}).refine(value => value.postingText.split(/\s+/u).length < value.sourceWordCount, {
  path: ["postingText"], message: "Keep the digest shorter than the employer's posting.",
});
export const jobsSaveBriefInput = z.strictObject({
  expectedRevision: revision.max(2_147_483_647),
  brief: jobsBrief,
});
export const jobsReviewPatchOutput = jobsReviewApplicationOutput.extend({ auditId: id.optional() });
export const jobsReviewApprovalOutput = z.object({ application: jobReviewRow });
export type JobsReviewableQuery = z.output<typeof jobsReviewableInput>;
export type JobsApplicationsQuery = z.output<typeof jobsApplicationsInput>;
export type JobsApplicationsPage = z.output<typeof jobsApplicationsOutput>;
export type JobsReviewSession = z.output<typeof jobsReviewSessionOutput>;
export type JobsReviewEdit = z.output<typeof jobsReviewEditInput>;
export type JobsPostingDetails = z.output<typeof jobsPostingDetailsInput>;
export type JobsSaveBrief = z.output<typeof jobsSaveBriefInput>;
