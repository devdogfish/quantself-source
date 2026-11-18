import { z } from "zod";

export const jobsPilotTokenCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const jobsPilotCanonicalUsage = z.strictObject({
  model: z.string(), requestDigest: z.string(), resultId: z.string(),
  inputTokens: jobsPilotTokenCount, outputTokens: jobsPilotTokenCount,
});
export type JobsPilotUsage = z.output<typeof jobsPilotCanonicalUsage>;
export type JobsPilotUsageBinding = Pick<JobsPilotUsage, "requestDigest" | "resultId">;
export type JobsPilotReceipt = { requestId: string; output: string; usage: JobsPilotUsage };
