import { z } from "zod";
import { applicationAddressPattern, sesMessageIdPattern } from "../../../scripts/jobs/application-address";
import { maxResumeMarkdown } from "../../../scripts/jobs/resume-document";
import { issueCode, receiptCode } from "./jobs-contract";
import { resumeTrack } from "./jobs-common-contract";
import { candidateContextOutput } from "./jobs-candidate-context";
import { registerPrivateRequirementsInput, resolvedPrivateFieldsOutput } from "./jobs-private-fields-contract";

export const jobsWorkerPath = "/api/internal/jobs";
export const codexWorkKinds = ["enrich", "tailor", "revise"] as const;
export const runnerWorkKinds = ["render", "submit"] as const;
export const jobsWorkKind = z.enum([...codexWorkKinds, ...runnerWorkKinds]);

const id = z.uuid();
const revision = z.number().int().nonnegative();
const lease = { leaseToken: z.string().min(16).max(200) };
const result = { ...lease, resultId: id };
const workerName = z.string().trim().min(1).max(120);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const attempt = z.number().int().positive();
const summaryMarkdown = z.string().trim().min(1).max(2_000);
const resumeMarkdown = z.string().min(1).max(maxResumeMarkdown);

export const jobsWorkClaimInput = z.strictObject({
  workerId: workerName,
  kinds: z.array(jobsWorkKind).min(1).max(jobsWorkKind.options.length).refine(kinds => new Set(kinds).size === kinds.length),
  supportsOwnerAttestation: z.boolean().optional(),
});

const level = z.enum(["low", "medium", "high"]);
const briefFields = {
  doing: z.string(), remote: z.enum(["confirmed", "hybrid", "onsite", "not_stated"]),
  companySize: z.strictObject({ people: z.number().int().nonnegative().nullable(), label: z.string() }),
  automatable: level,
  humanContact: z.strictObject({ level, note: z.string() }),
  meetings: z.strictObject({ level: z.enum(["rare", "weekly", "daily"]), note: z.string() }),
};

const amountRange = { min: z.number().nonnegative(), max: z.number().nonnegative() };
export const jobsEnrichOutput = z.strictObject({
  ...briefFields,
  eligible: z.boolean(), ineligibleReason: z.string().nullable().optional(),
  pay: z.strictObject({ ...amountRange, currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(["hour", "week", "month", "year"]) }).nullable(),
  verdict: z.enum(["strong", "review", "weak"]), dueDate: z.iso.date().nullable(),
});

export const jobsBrief = z.strictObject({
  ...briefFields,
  pay: z.strictObject({ hourlyCad: z.strictObject(amountRange).nullable(), original: z.string().nullable(), converted: z.boolean() }),
});
export const jobsSummaryOutput = z.strictObject({ summaryMarkdown });

const claim = { id, applicationId: id, revision, ...lease, leaseUntil: z.iso.datetime() };
const modelInput = { track: resumeTrack, candidateContext: candidateContextOutput.shape.markdown };
const publicPosting = z.strictObject({
  sourceUrl: z.url().max(2_048).refine(url => URL.parse(url)?.hostname === "weworkremotely.com"),
  role: z.string().min(1).max(200),
});
const tailorInput = { ...modelInput, brief: jobsBrief, resumeMarkdown };
const localInput = {
  track: resumeTrack, company: z.string(), role: z.string(), sourceUrl: z.url(), applicationAddress: z.string().regex(applicationAddressPattern),
};
export const jobsOwnerAttestation = z.strictObject({
  previousWorkId: id, previousAttempt: attempt, previousResultId: id.optional(), previousLeaseTokenHash: sha256,
  approvedRevision: revision, sha256, resolvedAt: z.iso.datetime(),
});
export const jobsWorkClaimOutput = z.strictObject({ work: z.discriminatedUnion("kind", [
  z.strictObject({ ...claim, kind: z.literal("enrich"), input: z.strictObject({ ...modelInput, postingText: z.string().max(12_000), publicPosting: publicPosting.optional() }) }),
  z.strictObject({ ...claim, kind: z.literal("tailor"), input: z.strictObject(tailorInput) }),
  z.strictObject({ ...claim, kind: z.literal("revise"), input: z.strictObject({ ...tailorInput, summaryMarkdown, instructions: z.string().trim().min(1).max(1_000) }) }),
  z.strictObject({ ...claim, kind: z.literal("render"), input: z.strictObject({ ...localInput, summaryMarkdown, resumeMarkdown }) }),
  z.strictObject({
    ...claim, kind: z.literal("submit"), input: z.strictObject({ ...localInput, sha256 }),
    attempt: attempt.optional(), ownerAttestation: jobsOwnerAttestation.optional(),
  }).refine(({ id, attempt, revision, input, ownerAttestation }) => !ownerAttestation ||
    (ownerAttestation.previousWorkId === id && attempt !== undefined && ownerAttestation.previousAttempt < attempt &&
      ownerAttestation.approvedRevision === revision && ownerAttestation.sha256 === input.sha256)),
]).nullable() });

// The result schema is selected using the authenticated claim's kind. PDF PUT settles render work.
const submitReceipt = z.strictObject({
  code: receiptCode, capturedAt: z.iso.datetime(), sesMessageId: z.string().regex(sesMessageIdPattern).optional(),
}).refine(receipt => receipt.sesMessageId === undefined || receipt.code === "confirmation_message", {
  path: ["sesMessageId"], message: "An SES Message-ID requires a confirmation message receipt.",
});
const submitOutput = z.strictObject({ receipt: submitReceipt });
export const jobsWorkCompleteInput = {
  enrich: z.strictObject({ ...result, result: jobsEnrichOutput }),
  tailor: z.strictObject({ ...result, result: jobsSummaryOutput }),
  revise: z.strictObject({ ...result, result: jobsSummaryOutput }),
  submit: z.strictObject({ ...result, result: submitOutput }),
};
export const jobsWorkFailInput = z.union([
  z.strictObject({ ...result, code: z.literal("runner_unavailable"), emailNotSent: z.literal(true) }),
  z.strictObject({ ...result, code: z.literal("manual_required"), requirements: registerPrivateRequirementsInput.shape.fields.optional() }),
  z.strictObject({ ...result, code: z.enum([...issueCode.options.filter(code => code !== "manual_required"), "rate_limited"]) }),
]);
export const jobsWorkResultOutput = z.strictObject({ accepted: z.literal(true) });

// JSON claims use leaseToken in the body. Binary requests carry the same credential in headers.
export const jobsWorkPdfHeaders = z.object({ "x-job-work-id": id, "x-job-lease-token": lease.leaseToken });
export const jobsWorkPdfUploadHeaders = jobsWorkPdfHeaders.extend({ "x-content-sha256": sha256 });
export const jobsWorkPrivateFieldsInput = z.strictObject(lease);
export const jobsWorkPrivateFieldsOutput = resolvedPrivateFieldsOutput;

export const jobsRunnerHeartbeatInput = z.strictObject({ host: workerName });
export const jobsSubmissionEventInput = z.strictObject({
  ...lease, workId: id, eventId: id,
  step: z.enum(["runner_claimed", "portal_opened", "form_filled", "submit_started", "submitted", "receipt_captured"]),
  state: z.enum(["running", "done", "failed"]),
  durationMs: z.number().int().nonnegative().optional(),
  code: issueCode.optional(),
  channel: z.literal("ses").optional(),
}).refine(event => !event.channel ||
  (event.step === "runner_claimed" && event.state === "done") ||
  (event.step === "submit_started" && event.state !== "failed"), {
  path: ["channel"], message: "SES channel requires completed preflight or a submission start.",
});
