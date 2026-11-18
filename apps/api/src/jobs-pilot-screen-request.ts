import { createHash } from "node:crypto";
import { z } from "zod";
import { buildScreenRequest } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { fingerprintIdempotentRequest } from "./idempotency-fingerprint";
import { canonicalJobUrl } from "./jobs-application";
import { JobsError } from "./jobs-error";
import { jobsGreenhouseSourceIdentity } from "./jobs-owner-contract";
import { greenhouseHostedKey } from "./jobs-provider-import";

export const jobsPilotScreenInputCap = 20_000;
export const jobsPilotScreenOutputCap = 384;

export const jobsPilotScreenPosting = z.strictObject({
  sourceIdentity: jobsGreenhouseSourceIdentity,
  sourceUrl: z.string().min(1).max(2_048),
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(12_000),
  location: z.string().max(200).optional(),
  workplaceType: z.string().max(100).optional(),
  employmentType: z.string().max(100).optional(),
  postedAt: z.string().max(100).optional(),
  salary: z.string().max(200).optional(),
  sourceLabel: z.string().max(120).optional(),
});

export function prepareJobsPilotScreenRequest(sourceIdentity: string, input: unknown, criteria: string) {
  const posting = jobsPilotScreenPosting.parse(input);
  const source = canonicalJobUrl(posting.sourceUrl);
  if (posting.sourceIdentity !== sourceIdentity || new URL(source.sourceUrl).protocol !== "https:" ||
      source.sourceKey !== greenhouseHostedKey(source.sourceUrl, posting.sourceIdentity)) {
    throw new JobsError(409, "Screening requires the exact permitted Greenhouse posting.");
  }
  const request = buildScreenRequest(posting, criteria);
  const body = Buffer.from(JSON.stringify(request));
  const requestDigest = createHash("sha256").update(body).digest("hex");
  const postingDigest = fingerprintIdempotentRequest({ posting });
  return { posting, request, body, requestDigest, postingDigest };
}
