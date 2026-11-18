import { randomUUID } from "node:crypto";

export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type CommandOptions = {
  env?: Record<string, string>;
  stdio?: "capture" | "inherit";
};

export interface CommandRunner {
  interrupt(): void;
  run(command: string[], options?: CommandOptions): Promise<CommandResult>;
}

type OpsEnvironment = Record<string, string | undefined>;

const GH_TOKEN_ENVIRONMENT_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const DEFAULT_COMPOSE_BASE_FILE = "compose.yaml";
const DEFAULT_COMPOSE_PROD_FILE = "compose.prod.yaml";
const DEFAULT_DEPLOY_WORKFLOW = "deploy.yml";
const ATLAS_CONTROL_WORKFLOW = "promote-keep.yml";
const ATLAS_RELAY_REPOSITORY = "devdogfish/quantself-atlas-control";
const ATLAS_RELAY_REPOSITORY_ID = "1459341623";
const QUANTSELF_SOURCE_REPOSITORY = "devdogfish/quantself";
const KEEP_PRODUCTION_ORIGIN = "https://qs.girke.dev";

type ProdDependencies = {
  env?: OpsEnvironment;
  requestId?: () => string;
  runner?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  write?: (line: string) => void;
};

export async function runProd(
  dependencies: ProdDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? createBunCommandRunner();
  const sleep = dependencies.sleep ?? wait;
  const write = dependencies.write ?? console.log;
  const atlasControlRepo = readAtlasControlRepo(env.QUANTSELF_DEPLOY_CONTROL_REPO);
  const autoRelay = readAutomaticRelay(env, atlasControlRepo);
  const deployTarget = env.QUANTSELF_DEPLOY_TARGET ?? "home";
  if (deployTarget !== "home") {
    throw new Error("Current releases deploy to Keep. Use the retained release and rollback procedure for Hostinger.");
  }
  const sshTarget = requireEnvironmentValue(env.QUANTSELF_SSH_TARGET, "QUANTSELF_SSH_TARGET");
  if (autoRelay?.sshTarget === sshTarget) {
    throw new Error("Automatic Atlas relay requires a separate pinned guest SSH alias.");
  }
  const deployPath = requireEnvironmentValue(env.QUANTSELF_DEPLOY_PATH, "QUANTSELF_DEPLOY_PATH");
  if (!deployPath.startsWith("/")) {
    throw new Error("QUANTSELF_DEPLOY_PATH must be absolute for home.");
  }
  const productionOrigin = readOrigin(
    requireEnvironmentValue(
      env.QUANTSELF_PRODUCTION_URL,
      "QUANTSELF_PRODUCTION_URL",
    ),
  );
  if (productionOrigin !== KEEP_PRODUCTION_ORIGIN) {
    throw new Error(`QUANTSELF_PRODUCTION_URL must use the Keep origin ${KEEP_PRODUCTION_ORIGIN}.`);
  }
  const baseFile = env.QUANTSELF_COMPOSE_BASE_FILE ?? DEFAULT_COMPOSE_BASE_FILE;
  const prodFile = env.QUANTSELF_COMPOSE_PROD_FILE ?? DEFAULT_COMPOSE_PROD_FILE;
  const branch = (
    await requireSuccess(runner, ["git", "branch", "--show-current"])
  ).stdout.trim();
  if (branch !== "main") {
    throw new Error(
      `Production deploy requires branch main; current: ${
        branch || "(detached)"
      }.`,
    );
  }

  const status = (
    await requireSuccess(runner, ["git", "status", "--porcelain"])
  ).stdout.trim();
  if (status) {
    throw new Error(
      "Production deploy requires a clean committed main worktree.",
    );
  }

  const sourceSha = (
    await requireSuccess(runner, ["git", "rev-parse", "HEAD"])
  ).stdout.trim();
  if (atlasControlRepo && !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Atlas promotion requires a full Git commit SHA.");
  }
  await requireSuccess(runner, ["gh", "--version"]);
  await requireSuccess(runner, [
    "gh", "auth", "status", ...(atlasControlRepo ? ["--hostname", "github.com"] : []),
  ]);
  const workflowRunId = atlasControlRepo
    ? await promoteAtlas(runner, atlasControlRepo, sourceSha)
    : await deployLegacy({ env, requestId: dependencies.requestId, runner, sleep, sshTarget });
  if (autoRelay) {
    write("Starting the exact Atlas relay for production deploy run " + workflowRunId + ", attempt 1.");
    try {
      await requireSuccess(runner, [
        "python3", "-B", "scripts/infra/home-production/atlas-provision-jit.py",
        "relay", ATLAS_RELAY_REPOSITORY, ATLAS_RELAY_REPOSITORY_ID, "quantself-atlas-control",
        "--run-id", workflowRunId, "--attempt", "1", "--source-sha", sourceSha,
        "--control-sha", autoRelay.controlSha, "--relay-ssh-target", autoRelay.sshTarget,
        "--wait-for-job", "--timing",
      ], { stdio: "inherit" });
    } catch {
      throw new Error("Atlas relay did not confirm assignment for run " + workflowRunId +
        " attempt 1. Inspect that run and runner before retrying.");
    }
  }
  if (autoRelay) {
    write(`Watching production deploy run ${workflowRunId}, attempt 1.`);
    await watchAtlasAttempt(runner, workflowRunId, sourceSha, autoRelay.controlSha, sleep);
  } else {
    write(`Watching production deploy run ${workflowRunId}.`);
    await requireSuccess(
      runner,
      ["gh", "run", "watch", workflowRunId, "--exit-status",
        ...(atlasControlRepo ? ["--repo", `github.com/${atlasControlRepo}`] : [])],
      { stdio: "inherit" },
    );
  }

  if (atlasControlRepo) {
    const jobsPath = "repos/" + atlasControlRepo + "/actions/runs/" + workflowRunId
      + (autoRelay ? "/attempts/1/jobs" : "/jobs");
    const relay = await requireSuccess(runner, [
      "gh", "api", "--hostname", "github.com",
      jobsPath,
      "--jq", autoRelay
        ? 'if .total_count == 1 and (.jobs | length) == 1 and .jobs[0].name == "relay" then .jobs[0].conclusion else "" end'
        : '.jobs[] | select(.name == "relay") | .conclusion',
    ]);
    if (relay.stdout.trim() !== "success") {
      throw new Error("Atlas relay did not acknowledge promotion. Inspect the control run.");
    }
    if (autoRelay) {
      write("Atlas timing attempt: " + JSON.stringify({
        repo_id: ATLAS_RELAY_REPOSITORY_ID, run_id: workflowRunId, attempt: "1", source_sha: sourceSha,
      }));
    }
  }

  await requireSuccess(
    runner,
    productionCurl(new URL("/", productionOrigin).toString()),
  );
  await requireSuccess(
    runner,
    productionCurl(new URL("/api/health", productionOrigin).toString()),
  );
  await requireSuccess(
    runner,
    productionCurl(productionContainerVisualUrl(productionOrigin)),
  );
  write(`Production healthy: ${productionOrigin}`);

  const remoteCompose = [
    "sudo", "docker", "compose", "-f", baseFile, "-f", prodFile, "-f", "compose.home.yaml",
  ].map(shellQuote).join(" ");
  const remotePrefix = `cd ${shellQuote(deployPath)} && ${remoteCompose}`;
  write("Following production app/api/gateway logs; Ctrl-C detaches only.");
  await requireSuccess(
    runner,
    [
      "ssh", "-t",
      sshTarget,
      `${remotePrefix} logs --follow --tail 200 app api gateway`,
    ],
    { stdio: "inherit" },
  );
}

function readAtlasControlRepo(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const repo = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ||
      repo.toLowerCase() === QUANTSELF_SOURCE_REPOSITORY) {
    throw new Error("QUANTSELF_DEPLOY_CONTROL_REPO must name the separate Atlas control repository as OWNER/REPO.");
  }
  return repo;
}

function readAutomaticRelay(env: OpsEnvironment, repo: string | undefined) {
  if (env.QUANTSELF_ATLAS_RELAY_AUTO !== "1") {
    return undefined;
  }
  if (repo !== ATLAS_RELAY_REPOSITORY) {
    throw new Error("Automatic Atlas relay requires the approved private control repository.");
  }
  const controlSha = requireEnvironmentValue(env.QUANTSELF_ATLAS_RELAY_CONTROL_SHA, "QUANTSELF_ATLAS_RELAY_CONTROL_SHA");
  const sshTarget = requireEnvironmentValue(env.QUANTSELF_ATLAS_RELAY_SSH_TARGET, "QUANTSELF_ATLAS_RELAY_SSH_TARGET");
  if (!/^[0-9a-f]{40}$/.test(controlSha)
    || !/^(?:[a-z_][a-z0-9_-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(sshTarget)) {
    throw new Error("Automatic Atlas relay requires a pinned control SHA and a pinned guest SSH alias.");
  }
  return { controlSha, sshTarget };
}

async function watchAtlasAttempt(
  runner: CommandRunner, runId: string, sourceSha: string, controlSha: string, sleep: (ms: number) => Promise<void>,
) {
  const path = `repos/${ATLAS_RELAY_REPOSITORY}/actions/runs/${runId}/attempts/1`;
  const fields = '[.id, .run_attempt, .repository.id, .head_sha, .event, .head_branch, .display_title, .status, (.conclusion // "-")] | @tsv';
  const deadline = performance.now() + 50 * 60_000;
  while (performance.now() < deadline) {
    const result = await requireSuccess(runner, ["gh", "api", "--hostname", "github.com", path, "--jq", fields]);
    const columns = result.stdout.trim().split("\t");
    const [id, attempt, repoId, sha, event, branch, title, status, conclusion] = columns;
    if (columns.length !== 9 || id !== runId || attempt !== "1" || repoId !== ATLAS_RELAY_REPOSITORY_ID
      || sha !== controlSha || event !== "workflow_dispatch" || branch !== "main"
      || title !== `Promote Quantself ${sourceSha}`) {
      throw new Error("Atlas workflow attempt identity changed. Inspect the original run.");
    }
    if (status === "completed" && conclusion === "success") {
      return;
    }
    if ((status !== "in_progress" && status !== "queued") || conclusion !== "-") {
      throw new Error("Atlas workflow attempt 1 did not complete successfully. Inspect the original run.");
    }
    await sleep(3_000);
  }
  throw new Error("Timed out watching Atlas workflow attempt 1. Inspect the original run.");
}

async function promoteAtlas(runner: CommandRunner, repo: string, sourceSha: string) {
  const main = await requireSuccess(runner, [
    "gh", "api", "--hostname", "github.com",
    `repos/${QUANTSELF_SOURCE_REPOSITORY}/git/ref/heads/main`,
    "--jq", ".object.sha",
  ]);
  if (main.stdout.trim() !== sourceSha) {
    throw new Error("Atlas promotion requires local main to match GitHub main. Stage signed evidence for that revision before dispatch.");
  }

  const dispatch = await requireSuccess(runner, [
    "gh", "api", "--hostname", "github.com", "--method", "POST",
    `repos/${repo}/actions/workflows/${ATLAS_CONTROL_WORKFLOW}/dispatches`,
    "-H", "X-GitHub-Api-Version: 2026-03-10",
    "-f", "ref=main",
    "-F", "return_run_details=true",
    "-f", `inputs[source_sha]=${sourceSha}`,
    "--jq", ".workflow_run_id",
  ]);
  const runId = dispatch.stdout.trim();
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("Atlas dispatch returned no valid run ID. Inspect the control repository runs before dispatching again.");
  }
  return runId;
}

async function deployLegacy(input: {
  env: OpsEnvironment;
  requestId?: () => string;
  runner: CommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
  sshTarget: string;
}) {
  const { env, runner, sleep, sshTarget } = input;
  const requestId =
    input.requestId?.() ??
    `ops-${new Date()
      .toISOString()
      .replaceAll(/[^0-9]/g, "")
      .slice(0, 14)}-${randomUUID()}`;
  const workflow = env.QUANTSELF_DEPLOY_WORKFLOW ?? DEFAULT_DEPLOY_WORKFLOW;
  const remoteName = env.QUANTSELF_GIT_REMOTE ?? "origin";
  const pollAttempts = readPositiveInteger(
    env.QUANTSELF_WORKFLOW_POLL_ATTEMPTS,
    30,
    "workflow poll attempts",
  );
  const pollDelayMs = readPositiveInteger(
    env.QUANTSELF_WORKFLOW_POLL_DELAY_MS,
    2_000,
    "workflow poll delay",
  );
  const dispatchAttempts = readPositiveInteger(
    env.QUANTSELF_WORKFLOW_DISPATCH_ATTEMPTS,
    31,
    "workflow dispatch attempts",
  );
  const dispatchDelayMs = readPositiveInteger(
    env.QUANTSELF_WORKFLOW_DISPATCH_DELAY_MS,
    2_000,
    "workflow dispatch delay",
  );

  const workflowId = (
    await requireSuccess(runner, [
      "gh",
      "api",
      `repos/{owner}/{repo}/actions/workflows/${workflow}`,
      "--jq",
      ".id",
    ])
  ).stdout.trim();
  if (!/^[1-9]\d*$/.test(workflowId)) {
    throw new Error(
      `Invalid GitHub Actions workflow ID: ${workflowId || "(empty)"}.`,
    );
  }
  await requireSuccess(runner, ["ssh", "-V"]);
  await requireSuccess(runner, [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    sshTarget,
    "true",
  ]);
  await requireSuccess(runner, ["git", "push", remoteName, "main"]);
  await dispatchWorkflow({
    attempts: dispatchAttempts,
    command: [
      "gh",
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/actions/workflows/${workflowId}/dispatches`,
      "-f",
      "ref=main",
      "-f",
      "inputs[deploy_target]=home",
      "-f",
      `inputs[request_id]=${requestId}`,
    ],
    delayMs: dispatchDelayMs,
    runner,
    sleep,
  });

  return findWorkflowRun({
    attempts: pollAttempts,
    delayMs: pollDelayMs,
    requestId,
    runner,
    sleep,
    workflow,
  });
}

export function createBunCommandRunner(): CommandRunner {
  let activeProcess: ReturnType<typeof Bun.spawn> | null = null;

  return {
    interrupt() {
      activeProcess?.kill("SIGINT");
    },
    async run(command, options = {}) {
      const stdio = options.stdio ?? "capture";
      const subprocess = Bun.spawn(command, {
        env: commandEnvironment(command, { ...process.env, ...options.env }),
        stdin: stdio === "inherit" ? "inherit" : "ignore",
        stdout: stdio === "inherit" ? "inherit" : "pipe",
        stderr: stdio === "inherit" ? "inherit" : "pipe",
      });
      activeProcess = subprocess;

      try {
        if (stdio === "inherit") {
          return {
            exitCode: await subprocess.exited,
            stderr: "",
            stdout: "",
          };
        }

        const [exitCode, stdout, stderr] = await Promise.all([
          subprocess.exited,
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
        ]);
        return { exitCode, stderr, stdout };
      } finally {
        if (activeProcess === subprocess) {
          activeProcess = null;
        }
      }
    },
  };
}

export function commandEnvironment(
  command: string[],
  environment: OpsEnvironment,
) {
  if (command[0]?.split(/[/\\]/).at(-1) !== "gh") {
    return environment;
  }

  const sanitized = { ...environment };
  for (const key of GH_TOKEN_ENVIRONMENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

async function requireSuccess(
  runner: CommandRunner,
  command: string[],
  options?: CommandOptions,
) {
  const result = await runner.run(command, options);
  if (result.exitCode !== 0) {
    throw commandError(command, result);
  }
  return result;
}

function commandError(command: string[], result: CommandResult) {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `Command failed (${result.exitCode}): ${formatCommand(command)}${
      detail ? `\n${detail}` : ""
    }`,
  );
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
) {
  if (!value) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

async function findWorkflowRun(input: {
  attempts: number;
  delayMs: number;
  requestId: string;
  runner: CommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
  workflow: string;
}) {
  const displayTitle = `Deploy production · ${input.requestId}`;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const result = await requireSuccess(input.runner, [
      "gh",
      "run",
      "list",
      "--workflow",
      input.workflow,
      "--branch",
      "main",
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,displayTitle",
      "--jq",
      `.[] | select(.displayTitle == ${JSON.stringify(displayTitle)}) | .databaseId`,
    ]);
    const runId = result.stdout.trim().split("\n").find(Boolean);
    if (runId && /^\d+$/.test(runId)) {
      return runId;
    }
    if (attempt < input.attempts) {
      await input.sleep(input.delayMs);
    }
  }

  throw new Error(`Timed out finding GitHub Actions run: ${displayTitle}`);
}

async function dispatchWorkflow(input: {
  attempts: number;
  command: string[];
  delayMs: number;
  runner: CommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
}) {
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const result = await input.runner.run(input.command);
    if (result.exitCode === 0) {
      return;
    }

    const detail = `${result.stdout}\n${result.stderr}`;
    const retryable = /\bHTTP 403\b/.test(detail);
    if (!retryable || attempt === input.attempts) {
      throw commandError(input.command, result);
    }

    await input.sleep(input.delayMs);
  }
}

function productionCurl(url: string) {
  return [
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--retry",
    "12",
    "--retry-all-errors",
    "--retry-delay",
    "5",
    url,
  ];
}

function productionContainerVisualUrl(origin: string) {
  const url = new URL("/_next/image", origin);
  url.searchParams.set(
    "url",
    "/inventory/container-visual-catalog/6l/back.webp",
  );
  url.searchParams.set("w", "1920");
  url.searchParams.set("q", "75");
  return url.toString();
}

function readOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid production URL: ${value}`);
  }
  return url.origin;
}

function requireEnvironmentValue(
  value: string | undefined,
  name: string,
) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function formatCommand(command: string[]) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
