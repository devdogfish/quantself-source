import { isAbsolute } from "node:path";
import { z } from "zod";
import { readPrivatePostingFile } from "../../../scripts/jobs/private-posting-file";
import { JobsError } from "./jobs-error";

const host = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
const rule = z.strictObject({
  canonicalHost: host,
  aliases: z.array(host).min(1).max(8),
  path: z.string().max(200).regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
  postingIdParameter: z.string().max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
});
const config = z.strictObject({ version: z.literal(1), rules: z.array(rule).max(32) });
export type JobsPrivateSourceRule = z.output<typeof rule>;

export function readJobsPrivateSourceRules(path = process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE): JobsPrivateSourceRule[] {
  if (path === undefined) return [];
  const unavailable = new JobsError(503, "Private Jobs source rules are unavailable or invalid.");
  if (!isAbsolute(path)) throw unavailable;

  try {
    const { rules } = config.parse(readPrivatePostingFile(path, {
      maxBytes: 32 * 1024, errorCode: "invalid_jobs_source_rules",
    }));
    const routes = rules.flatMap(rule => [rule.canonicalHost, ...rule.aliases].map(host => host + rule.path));
    if (new Set(routes).size !== routes.length) throw unavailable;
    return rules;
  } catch {
    throw unavailable;
  }
}
