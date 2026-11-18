import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createJobsWorkClient } from "../../../scripts/jobs/work-client";
import { createJobsWorkOutbox } from "../../../scripts/jobs/work-outbox";
import { createJobsCodexModel, runJobsCodexBatch } from "../lib/jobs-codex-worker";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("jobs_worker_configuration_required");
  return value;
}

async function main() {
  const api = createJobsWorkClient({ baseUrl: requireEnv("JOBS_WORKER_BASE_URL"), secret: requireEnv("JOBS_WORKER_SECRET") });
  const outbox = createJobsWorkOutbox(requireEnv("JOBS_WORKER_OUTBOX"), api);
  await outbox.drain();
  const login = Bun.spawn([process.execPath, "run", "--bun", "codex", "login", "status"], { stdout: "ignore", stderr: "ignore",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: requireEnv("CODEX_HOME") } });
  if (await login.exited !== 0) throw new Error("jobs_worker_codex_login_required");
  const workingDirectory = await mkdtemp(join(tmpdir(), "qs-jobs-model-"));
  try {
    const totals = await runJobsCodexBatch({
      api, outbox, workerId: process.env.JOBS_WORKER_ID?.trim() || `jobs-codex-${hostname()}`,
      runModel: createJobsCodexModel({ workingDirectory, model: process.env.JOBS_CODEX_MODEL?.trim() || undefined }),
      limit: Number(process.env.JOBS_WORKER_BATCH_SIZE ?? 20),
    });
    console.log(`Jobs Codex worker claimed=${totals.claimed} completed=${totals.completed} failed=${totals.failed} rateLimited=${totals.rateLimited}`);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main().catch(error => {
    const code = error instanceof Error ? error.message : "";
    console.error(/^(?:jobs_worker_configuration_required|jobs_worker_codex_login_required|invalid_jobs_worker_limit|jobs_work_api_(?:unavailable|\d{3}))$/.test(code)
      ? code : "jobs_codex_worker_failed");
    process.exitCode = 1;
  });
}
