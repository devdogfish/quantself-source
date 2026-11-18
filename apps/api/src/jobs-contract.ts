import { z } from "@hono/zod-openapi";
import { maxResumeMarkdown } from "../../../scripts/jobs/resume-document";
export { resumeTrack } from "./jobs-common-contract";

export const jobStatus = z.enum([
  "draft", "review", "approved", "queued", "submitting", "applied", "skipped", "disqualified", "saved_for_later", "rejected", "needs_attention", "interviewing", "offer", "withdrawn",
]).openapi("JobApplicationStatus");
export const resumeMarkdown = z.string().min(1).max(maxResumeMarkdown);
export const issueCode = z.enum([
  "model_error", "unsupported_portal", "manual_required", "runner_unavailable", "submission_uncertain",
]).openapi("JobIssueCode");
export const receiptCode = z.enum(["confirmation_page", "confirmation_message"]).openapi("JobReceiptCode");
export const jobIdInput = z.object({ id: z.uuid() });
export const idempotencyHeader = z.object({ "idempotency-key": z.string().trim().min(1).max(200) });
