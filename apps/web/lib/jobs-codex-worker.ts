import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import { jobsModelRequest, parseJobsEnrichmentResult } from "../../api/src/jobs-model-request";
import { codexWorkKinds, jobsSummaryOutput } from "../../api/src/jobs-work-contract";
import { getPublicPosting, publicPostingUnavailable, sanitizePublicPostingText } from "../../../scripts/jobs/public-posting";
import type { CodexWork, JobsWorkClient, WorkReport } from "../../../scripts/jobs/work-client";
import type { createJobsWorkOutbox } from "../../../scripts/jobs/work-outbox";

const codexEnv = ["CODEX_HOME", "HOME", "PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "SSL_CERT_DIR", "SSL_CERT_FILE"] as const;

type CodexModel = (input: { prompt: string; outputSchema: unknown; signal: AbortSignal }) => Promise<string>;

export function createJobsCodexModel({ workingDirectory, model, environment = process.env }: {
  workingDirectory: string; model?: string; environment?: NodeJS.ProcessEnv;
}): CodexModel {
  const env = Object.fromEntries(codexEnv.flatMap(key => environment[key] ? [[key, environment[key]!]] : []));
  const codex = new Codex({ env });
  return async ({ prompt, outputSchema, signal }) => {
    await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const thread = codex.startThread({
      model, workingDirectory, approvalPolicy: "never", sandboxMode: "read-only", skipGitRepoCheck: true,
      networkAccessEnabled: false, webSearchEnabled: false,
    });
    return (await thread.run(prompt, { outputSchema, signal })).finalResponse;
  };
}

async function modelInput(work: CodexWork) {
  if (work.kind !== "enrich" || !work.input.publicPosting) return work.input;
  const { track, candidateContext, publicPosting: { sourceUrl, role } } = work.input;
  const postingText = await getPublicPosting(sourceUrl);
  return {
    track, candidateContext, postingText,
    ...(postingText === publicPostingUnavailable && { role: sanitizePublicPostingText(role) }),
  };
}

async function modelReport(work: CodexWork, runModel: CodexModel, signal: AbortSignal): Promise<WorkReport> {
  const body = { leaseToken: work.leaseToken, resultId: randomUUID() };
  try {
    const input = await modelInput(work);
    const json: unknown = JSON.parse(await runModel({ ...jobsModelRequest(work.kind, input), signal }));
    if (work.kind === "enrich") {
      const result = parseJobsEnrichmentResult(json);
      const source = "postingText" in input ? input.postingText.trim() : "";
      const doing = result.doing.trim();
      const usable = source && source !== publicPostingUnavailable && doing.length < source.length &&
        doing.split(/\s+/u).length < source.split(/\s+/u).length;
      return { id: work.id, action: "complete", kind: work.kind, body: { ...body, result: { ...result, doing: usable ? doing : "" } } };
    }
    const result = jobsSummaryOutput.parse(json);
    const lines = result.summaryMarkdown.split(/\r?\n/);
    if (lines.length < 3 || lines.length > 5 || !lines.every(line => /^[-*+] \S/.test(line))) throw new Error("invalid_summary_bullets");
    return { id: work.id, action: "complete", kind: work.kind, body: { ...body, result } };
  } catch (error) {
    const limited = error instanceof Error && /\b429\b|rate.limit|usage limit/i.test(error.message);
    return { id: work.id, action: "fail", body: { ...body, code: limited ? "rate_limited" : "model_error" } };
  }
}

export async function runJobsCodexBatch({ api, outbox, runModel, workerId, limit = 20, now = Date.now }: {
  api: Pick<JobsWorkClient, "claim">;
  outbox: ReturnType<typeof createJobsWorkOutbox>;
  runModel: CodexModel;
  workerId: string;
  limit?: number;
  now?: () => number;
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("invalid_jobs_worker_limit");
  await outbox.drain();
  const totals = { claimed: 0, completed: 0, failed: 0, rateLimited: false };
  for (let index = 0; index < limit; index++) {
    const work = await api.claim({ workerId, kinds: [...codexWorkKinds] });
    if (!work) break;
    if (work.kind === "render" || work.kind === "submit") throw new Error("invalid_codex_jobs_claim");
    totals.claimed++;
    const remaining = Date.parse(work.leaseUntil) - now() - 5_000;
    if (remaining <= 0) break;
    const report = await modelReport(work, runModel, AbortSignal.timeout(Math.min(remaining, 10 * 60_000)));
    if (report.action === "fail") {
      totals.failed++;
      totals.rateLimited = report.body.code === "rate_limited";
    } else {
      totals.completed++;
    }
    await outbox.report(report);
    if (totals.rateLimited) break;
  }
  return totals;
}
