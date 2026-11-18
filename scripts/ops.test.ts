import { describe, expect, test } from "bun:test";
import {
  commandEnvironment,
  createBunCommandRunner,
  runProd,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "./ops";

describe("command environment", () => {
  test("passes per-command environment overrides to the subprocess", async () => {
    const result = await createBunCommandRunner().run(
      [process.execPath, "-e", "console.log(process.env.QUANTSELF_POSTGRES_PORT)"],
      { env: { QUANTSELF_POSTGRES_PORT: "55001" } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("55001");
  });

  test("scrubs token overrides only for GitHub CLI subprocesses", () => {
    const environment = {
      GH_ENTERPRISE_TOKEN: "stale-enterprise",
      GH_HOST: "github.com",
      GH_REPO: "devdogfish/quantself",
      GH_TOKEN: "stale",
      GITHUB_ENTERPRISE_TOKEN: "stale-github-enterprise",
      GITHUB_TOKEN: "stale-github",
      PATH: "/usr/bin",
      UNRELATED: "keep",
    };

    expect(commandEnvironment(["gh", "auth", "status"], environment)).toEqual({
      GH_HOST: "github.com",
      GH_REPO: "devdogfish/quantself",
      PATH: "/usr/bin",
      UNRELATED: "keep",
    });
    expect(
      commandEnvironment(["/opt/homebrew/bin/gh", "api", "user"], environment),
    ).toEqual({
      GH_HOST: "github.com",
      GH_REPO: "devdogfish/quantself",
      PATH: "/usr/bin",
      UNRELATED: "keep",
    });
    expect(commandEnvironment(["git", "push"], environment)).toBe(environment);
    expect(environment.GH_TOKEN).toBe("stale");
  });
});

class FakeCommandRunner implements CommandRunner {
  calls: Array<{ command: string[]; options?: CommandOptions }> = [];
  results: CommandResult[] = [];

  async run(command: string[], options?: CommandOptions) {
    this.calls.push({ command, options });
    return this.results.shift() ?? { exitCode: 0, stderr: "", stdout: "" };
  }

  interrupt() {}
}

const PRODUCTION_ENV = {
  QUANTSELF_PRODUCTION_URL: "https://qs.girke.dev",
  QUANTSELF_SSH_TARGET: "quantself-owner",
  QUANTSELF_DEPLOY_PATH: "/opt/quantself-production",
};

describe("ops prod", () => {
  test("rejects the legacy target before running any command", async () => {
    const runner = new FakeCommandRunner();
    await expect(runProd({ runner, env: { ...PRODUCTION_ENV, QUANTSELF_DEPLOY_TARGET: "hostinger" } }))
      .rejects.toThrow("Use the retained release and rollback procedure for Hostinger");
    expect(runner.calls).toEqual([]);
  });
  test("rejects the retained Hostinger URL before running any command", async () => {
    const runner = new FakeCommandRunner();
    await expect(runProd({ runner, env: { ...PRODUCTION_ENV, QUANTSELF_PRODUCTION_URL: "https://dashboard.girke.dev" } }))
      .rejects.toThrow("QUANTSELF_PRODUCTION_URL must use the Keep origin https://qs.girke.dev");
    expect(runner.calls).toEqual([]);
  });

  test("dispatches and watches its unique deploy before verification and logs", async () => {
    const runner = new FakeCommandRunner();
    const output: string[] = [];
    const sleeps: number[] = [];
    runner.results = [
      { exitCode: 0, stderr: "", stdout: "main\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "abc123\n" },
      { exitCode: 0, stderr: "", stdout: "gh version 2\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "4242\n" },
      { exitCode: 0, stderr: "OpenSSH_9\n", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      {
        exitCode: 1,
        stderr: "gh: Resource not accessible by integration (HTTP 403)\n",
        stdout: "",
      },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "918\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
    ];

    await runProd({
      env: PRODUCTION_ENV,
      requestId: () => "ops-20260728-test",
      runner,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      write: (line) => output.push(line),
    });

    const commands = runner.calls.map(({ command }) => command);
    expect(commands).toContainEqual([
      "gh",
      "api",
      "repos/{owner}/{repo}/actions/workflows/deploy.yml",
      "--jq",
      ".id",
    ]);
    expect(commands).toContainEqual(["git", "push", "origin", "main"]);
    const dispatchCommand = [
      "gh",
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/actions/workflows/4242/dispatches",
      "-f",
      "ref=main",
      "-f",
      "inputs[deploy_target]=home",
      "-f",
      "inputs[request_id]=ops-20260728-test",
    ];
    const dispatchCommands = commands.filter(
      (command) =>
        command[0] === "gh" &&
        command[1] === "api" &&
        command.at(-1) === "inputs[request_id]=ops-20260728-test",
    );
    expect(dispatchCommands).toEqual([dispatchCommand, dispatchCommand]);
    const workflowResolutionIndex = commands.findIndex(
      (command) =>
        command[0] === "gh" && command[1] === "api" && command.at(-1) === ".id",
    );
    const pushIndex = commands.findIndex(
      (command) => command[0] === "git" && command[1] === "push",
    );
    const dispatchIndex = commands.findIndex(
      (command) =>
        command[0] === "gh" &&
        command[1] === "api" &&
        command.includes("--method"),
    );
    expect(workflowResolutionIndex).toBeLessThan(pushIndex);
    expect(pushIndex).toBeLessThan(dispatchIndex);
    expect(commands).toContainEqual([
      "gh",
      "run",
      "watch",
      "918",
      "--exit-status",
    ]);
    expect(
      runner.calls.find(
        ({ command }) => command[0] === "gh" && command[2] === "watch",
      )?.options?.stdio,
    ).toBe("inherit");
    expect(commands).toContainEqual([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "12",
      "--retry-all-errors",
      "--retry-delay",
      "5",
      "https://qs.girke.dev/_next/image?url=%2Finventory%2Fcontainer-visual-catalog%2F6l%2Fback.webp&w=1920&q=75",
    ]);
    expect(commands.at(-1)?.slice(0, 3)).toEqual(["ssh", "-t", "quantself-owner"]);
    expect(commands.at(-1)?.at(-1)).toStartWith(
      "cd /opt/quantself-production && sudo docker compose",
    );
    expect(commands.at(-1)?.at(-1)).toContain(
      "logs --follow --tail 200 app api gateway",
    );
    expect(runner.calls.at(-1)?.options?.stdio).toBe("inherit");
    expect(sleeps).toEqual([2_000]);
  });

  test("stops retrying workflow dispatch after bounded 403 failures", async () => {
    const runner = new FakeCommandRunner();
    const sleeps: number[] = [];
    runner.results = [
      { exitCode: 0, stderr: "", stdout: "main\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "abc123\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "4242\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      {
        exitCode: 1,
        stderr: "gh: dispatch unavailable (HTTP 403)\n",
        stdout: "",
      },
      {
        exitCode: 1,
        stderr: "gh: dispatch unavailable (HTTP 403)\n",
        stdout: "",
      },
    ];

    expect(
      runProd({
        env: {
          ...PRODUCTION_ENV,
          QUANTSELF_WORKFLOW_DISPATCH_ATTEMPTS: "2",
          QUANTSELF_WORKFLOW_DISPATCH_DELAY_MS: "7",
        },
        requestId: () => "ops-exhausted",
        runner,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        write: () => {},
      }),
    ).rejects.toThrow("HTTP 403");
    expect(
      runner.calls.filter(
        ({ command }) =>
          command[0] === "gh" &&
          command[1] === "api" &&
          command.includes("--method"),
      ),
    ).toHaveLength(2);
    expect(sleeps).toEqual([7]);
  });

  test("rejects a nonnumeric workflow ID before pushing main", async () => {
    const runner = new FakeCommandRunner();
    runner.results = [
      { exitCode: 0, stderr: "", stdout: "main\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "abc123\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "not-an-id\n" },
    ];

    expect(
      runProd({
        env: PRODUCTION_ENV,
        requestId: () => "unused",
        runner,
        sleep: async () => {},
        write: () => {},
      }),
    ).rejects.toThrow("Invalid GitHub Actions workflow ID");
    expect(
      runner.calls.some(
        ({ command }) => command[0] === "git" && command[1] === "push",
      ),
    ).toBe(false);
  });

  test("rejects dirty main before contacting GitHub or production", async () => {
    const runner = new FakeCommandRunner();
    runner.results = [
      { exitCode: 0, stderr: "", stdout: "main\n" },
      { exitCode: 0, stderr: "", stdout: " M package.json\n" },
    ];

    expect(
      runProd({
        env: PRODUCTION_ENV,
        requestId: () => "unused",
        runner,
        sleep: async () => {},
        write: () => {},
      }),
    ).rejects.toThrow("clean committed main");
    expect(runner.calls.map(({ command }) => command)).toEqual([
      ["git", "branch", "--show-current"],
      ["git", "status", "--porcelain"],
    ]);
  });

  test("stops when the dispatched deployment fails", async () => {
    const runner = new FakeCommandRunner();
    runner.results = [
      { exitCode: 0, stderr: "", stdout: "main\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "abc123\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "4242\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "919\n" },
      { exitCode: 1, stderr: "deploy failed\n", stdout: "" },
    ];

    expect(
      runProd({
        env: PRODUCTION_ENV,
        requestId: () => "ops-failed",
        runner,
        sleep: async () => {},
        write: () => {},
      }),
    ).rejects.toThrow("deploy failed");
    expect(runner.calls.at(-1)?.command).toEqual([
      "gh",
      "run",
      "watch",
      "919",
      "--exit-status",
    ]);
  });
});

test("ops prod explicitly dispatches home and follows logs there over the Owner SSH connection", async () => {
  const runner = new FakeCommandRunner();
  runner.results = ["main", "", "abc123", "", "", "4242", "", "", "", "", "918", "", "", "", "", ""]
    .map((stdout) => ({ exitCode: 0, stdout, stderr: "" }));
  await runProd({
    env: {
      ...PRODUCTION_ENV,
      QUANTSELF_DEPLOY_TARGET: "home",
      QUANTSELF_SSH_TARGET: "owner@private-host",
      QUANTSELF_DEPLOY_PATH: "/opt/quantself production",
    },
    runner,
    requestId: () => "ops-test",
    write: () => {},
  });
  const commands = runner.calls.map(({ command }) => command);
  expect(commands.find((command) => command.includes("inputs[request_id]=ops-test"))?.slice(-6))
    .toEqual(["-f", "ref=main", "-f", "inputs[deploy_target]=home", "-f", "inputs[request_id]=ops-test"]);
  expect(commands.at(-1)).toEqual([
    "ssh", "-t", "owner@private-host",
    "cd '/opt/quantself production' && sudo docker compose -f compose.yaml -f compose.prod.yaml -f compose.home.yaml logs --follow --tail 200 app api gateway",
  ]);
});

describe("Atlas production promotion", () => {
  const repo = "devdogfish/quantself-atlas";
  const sha = "a".repeat(40);
  const env = { ...PRODUCTION_ENV, QUANTSELF_DEPLOY_CONTROL_REPO: repo };
  const autoRepo = "devdogfish/quantself-atlas-control";
  const controlSha = "b".repeat(40);
  const autoEnv = {
    ...env, QUANTSELF_DEPLOY_CONTROL_REPO: autoRepo, QUANTSELF_ATLAS_RELAY_AUTO: "1",
    QUANTSELF_ATLAS_RELAY_CONTROL_SHA: controlSha, QUANTSELF_ATLAS_RELAY_SSH_TARGET: "atlas-relay-operator",
  };

  function runnerWithResults(...outputs: string[]) {
    const runner = new FakeCommandRunner();
    runner.results = ["main", "", sha, "", "", ...outputs]
      .map((stdout) => ({ exitCode: 0, stdout, stderr: "" }));
    return runner;
  }

  function attemptStatus(attempt = "1", status = "completed", conclusion = "success") {
    return ["918", attempt, "1459341623", controlSha, "workflow_dispatch", "main",
      "Promote Quantself " + sha, status, conclusion].join("\t");
  }

  test("dispatches the canonical SHA and watches the exact returned control run", async () => {
    const runner = runnerWithResults(sha, "918", "", "success");
    await runProd({ runner, env, write: () => {} });

    const commands = runner.calls.map(({ command }) => command);
    expect(commands).toContainEqual([
      "gh", "api", "--hostname", "github.com", "repos/devdogfish/quantself/git/ref/heads/main",
      "--jq", ".object.sha",
    ]);
    expect(commands).toContainEqual([
      "gh", "api", "--hostname", "github.com", "--method", "POST",
      `repos/${repo}/actions/workflows/promote-keep.yml/dispatches`,
      "-H", "X-GitHub-Api-Version: 2026-03-10",
      "-f", "ref=main", "-F", "return_run_details=true", "-f", `inputs[source_sha]=${sha}`,
      "--jq", ".workflow_run_id",
    ]);
    expect(commands).toContainEqual([
      "gh", "run", "watch", "918", "--exit-status", "--repo", `github.com/${repo}`,
    ]);
    expect(commands.filter((command) => command[0] === "gh" && command[1] === "run")).toHaveLength(1);
    expect(commands.some((command) => command[0] === "python3")).toBe(false);
    expect(commands.some((command) => command[0] === "git" && command[1] === "push")).toBe(false);
    expect(commands.filter((command) => command[0] === "curl")).toHaveLength(3);
  });

  test("stops before dispatch when local main is out of sync", async () => {
    const runner = runnerWithResults("b".repeat(40));
    await expect(runProd({ runner, env, write: () => {} })).rejects.toThrow("local main to match GitHub main");
    expect(runner.calls.some(({ command }) => command.includes("POST"))).toBe(false);
  });

  test("reports dispatch without a valid run ID without posting again", async () => {
    const runner = runnerWithResults(sha, "");
    await expect(runProd({ runner, env, write: () => {} })).rejects.toThrow("no valid run ID");
    expect(runner.calls.filter(({ command }) => command.includes("POST"))).toHaveLength(1);
  });

  test("requires relay acknowledgement even when a skipped workflow reports success", async () => {
    const runner = runnerWithResults(sha, "918", "", "skipped");
    await expect(runProd({ runner, env, write: () => {} })).rejects.toThrow("did not acknowledge promotion");
    expect(runner.calls.some(({ command }) => command[0] === "curl")).toBe(false);
  });

  test("hands only the returned first attempt to the existing provisioner before watching", async () => {
    const runner = runnerWithResults(sha, "918", "", attemptStatus(), "success");
    const lines: string[] = [];
    await runProd({ runner, env: autoEnv, write: (line) => lines.push(line) });
    expect(runner.calls.slice(6, 9)).toEqual([
      expect.objectContaining({ command: expect.arrayContaining([
        "POST", "repos/devdogfish/quantself-atlas-control/actions/workflows/promote-keep.yml/dispatches",
      ]) }),
      {
        command: [
          "python3", "-B", "scripts/infra/home-production/atlas-provision-jit.py",
          "relay", autoRepo, "1459341623", "quantself-atlas-control",
          "--run-id", "918", "--attempt", "1", "--source-sha", sha,
          "--control-sha", controlSha, "--relay-ssh-target", "atlas-relay-operator",
          "--wait-for-job", "--timing",
        ],
        options: { stdio: "inherit" },
      },
      expect.objectContaining({ command: expect.arrayContaining([
        "repos/" + autoRepo + "/actions/runs/918/attempts/1",
      ]) }),
    ]);
    expect(runner.calls[9].command).toContain("repos/" + autoRepo + "/actions/runs/918/attempts/1/jobs");
    expect(lines).toContain("Atlas timing attempt: " + JSON.stringify({
      repo_id: "1459341623", run_id: "918", attempt: "1", source_sha: sha,
    }));
  });

  test("does not accept rerun drift or a failed exact attempt", async () => {
    for (const result of [attemptStatus("2"), attemptStatus("1", "completed", "failure"), ""]) {
      const runner = runnerWithResults(sha, "918", "", result);
      const lines: string[] = [];
      await expect(runProd({ runner, env: autoEnv, write: (line) => lines.push(line) }))
        .rejects.toThrow(/attempt (identity changed|1 did not complete)/);
      expect(lines.some((line) => line.startsWith("Atlas timing attempt: "))).toBe(false);
      expect(runner.calls.some(({ command }) => command[1] === "run" || command[0] === "curl")).toBe(false);
    }
  });

  test("automatic handoff rejects wrong repo, invalid pin, or Keep alias before dispatch", async () => {
    for (const override of [
      { QUANTSELF_DEPLOY_CONTROL_REPO: repo },
      { QUANTSELF_ATLAS_RELAY_CONTROL_SHA: "bad" },
      { QUANTSELF_ATLAS_RELAY_SSH_TARGET: PRODUCTION_ENV.QUANTSELF_SSH_TARGET },
    ]) {
      const runner = runnerWithResults();
      await expect(runProd({ runner, env: { ...autoEnv, ...override } })).rejects.toThrow("Automatic Atlas relay requires");
      expect(runner.calls).toEqual([]);
    }
  });

  test("an ambiguous dispatch never starts the provisioner or retries", async () => {
    for (const stdout of ["", "918\n919"]) {
      const runner = runnerWithResults(sha, stdout);
      await expect(runProd({ runner, env: autoEnv, write: () => {} })).rejects.toThrow("no valid run ID");
      expect(runner.calls.filter(({ command }) => command.includes("POST"))).toHaveLength(1);
      expect(runner.calls.some(({ command }) => command[0] === "python3")).toBe(false);
    }
  });

  test("a denied or unreachable relay requires reconciling the exact attempt", async () => {
    const runner = runnerWithResults(sha, "918", "");
    const lines: string[] = [];
    runner.results[7] = { exitCode: 1, stdout: "", stderr: "" };
    await expect(runProd({ runner, env: autoEnv, write: (line) => lines.push(line) }))
      .rejects.toThrow("run 918 attempt 1. Inspect that run and runner before retrying.");
    expect(lines).toEqual(["Starting the exact Atlas relay for production deploy run 918, attempt 1."]);
    const commands = runner.calls.map(({ command }) => command);
    expect(commands.filter((command) => command.includes("POST"))).toHaveLength(1);
    expect(commands.filter((command) => command[0] === "python3")).toHaveLength(1);
    expect(commands.some((command) => command[1] === "run" || command[0] === "curl")).toBe(false);
  });
});
