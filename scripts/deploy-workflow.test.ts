import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("production deploy workflow", () => {
  test("retries SSH discovery for the retained Hostinger preflight", async () => {
    const workflow = await Bun.file(
      join(import.meta.dir, "fixtures/production-workflows/deploy.yml"),
    ).text();

    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(workflow).toContain('ssh-keyscan -T 10 -H "$SSH_HOST"');
    expect(workflow).toContain("-o ConnectTimeout=20");
    expect(workflow).toContain("-o ServerAliveInterval=30");
    expect(workflow).toContain("-o ServerAliveCountMax=3");
  });
});

test("preflight mode skips every deployment and log-reading step, retaining deploy as default", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "fixtures/production-workflows/deploy.yml")).text()) as any;
  expect(workflow.on.workflow_dispatch.inputs.preflight_only).toMatchObject({ type: "boolean", default: false, required: false });
  const steps = workflow.jobs["preflight-hostinger"].steps;
  expect(steps.map((step: { name: string }) => step.name)).toEqual([
    "Validate deployment configuration", "Check out workflow revision", "Configure SSH", "Read-only production preflight",
  ]);
  const preflight = steps.at(-1);
  expect(preflight.run).toContain("< scripts/preflight-production.sh");
  expect(preflight.run).not.toMatch(/docker|git|logs|scp/);
});

test("Keep is the only deployment target for current releases", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "fixtures/production-workflows/deploy.yml")).text()) as any;
  expect(workflow.on.workflow_dispatch.inputs.deploy_target).toMatchObject({ type: "choice", default: "home" });
  expect(workflow.jobs["preflight-hostinger"].if).toBe("${{ inputs.deploy_target == 'hostinger' && inputs.preflight_only }}");
  expect(workflow.jobs["reject-legacy-deploy"].if).toBe("${{ inputs.deploy_target == 'hostinger' && !inputs.preflight_only }}");
  const home = workflow.jobs["deploy-home"];
  expect(home.if).toBe("${{ inputs.deploy_target == 'home' }}");
  expect(home.environment).toBe("production-home");
  expect(home.permissions).toEqual({ actions: "read", contents: "read" });
  const gate = home.steps[0];
  expect(gate.env.PREFLIGHT_ONLY).toBe("${{ inputs.preflight_only }}");
  for (const [ref, preflight, enabled, exitCode] of [
    ["refs/heads/main", "true", "", 0],
    ["refs/heads/main", "false", "", 1],
    ["refs/heads/main", "false", "true", 0],
    ["refs/heads/main", "", "", 1],
    ["refs/heads/feature", "true", "true", 1],
  ] as const) {
    const check = Bun.spawnSync(["bash", "-c", gate.run], {
      env: { GITHUB_REF: ref, PREFLIGHT_ONLY: preflight, HOME_DEPLOY_ENABLED: enabled },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(check.exitCode).toBe(exitCode);
  }
  expect(home.steps.some((step: any) => step.uses?.includes("upload-artifact"))).toBe(false);
  expect(home.steps.some((step: any) => step.run?.includes("docker build"))).toBe(false);
  const tailscale = home.steps.find((step: any) => step.uses?.startsWith("tailscale/github-action@"));
  expect(tailscale.with.tags).toBe("tag:ci");
  const transport = home.steps.at(-1).run;
  expect(home.steps.at(-1).env.PREFLIGHT_ONLY).toBe(gate.env.PREFLIGHT_ONLY);
  expect(home.steps.at(-1).env.DEPLOY_GITHUB_TOKEN).toBe("${{ !inputs.preflight_only && github.token || '' }}");
  expect(transport).toContain("StrictHostKeyChecking=yes");
  expect(transport).toContain('"deploy@$SSH_HOST"');
  expect(transport).toContain("preflight </dev/null");
  expect(transport).toContain('printf \'%s\\n\' "$github_token" |');
  expect(transport).not.toContain("ssh-keyscan");
  const broker = await Bun.file(join(import.meta.dir, "infra/home-production/quantself-deploy")).text();
  expect(broker).toContain("verify_production_release(Path(sys.argv[1]), sys.argv[2], sys.argv[3])");
  expect(broker).toContain('QUANTSELF_IMAGE_ARCHIVE="$release/app-image/image.tar.gz" QUANTSELF_IMAGE_ID="$image"');
  expect(broker).toContain('git show "$revision:scripts/deploy-production.sh"');
  expect(broker).toContain('bash -c "$deploy_script" scripts/deploy-production.sh');
});

test("the deployment script rejects Hostinger and stale Keep origins before checkout", () => {
  const script = join(import.meta.dir, "deploy-production.sh");
  for (const [target, message] of [
    ["hostinger", "Use the retained release and rollback procedure for Hostinger."],
    ["home", "Keep deployment requires the approved production origin."],
  ]) {
    const result = Bun.spawnSync(["/bin/bash", script, "/missing-checkout", "", "", "fixture", "https://dashboard.girke.dev"], {
      env: { PATH: "/nonexistent", QUANTSELF_DEPLOY_OWNER: "github-actions", QUANTSELF_DEPLOY_TARGET: target },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(message);
  }
});

test("both home deploy boundaries reject malformed frames before running any operation", async () => {
  const directory = join(import.meta.dir, "infra/home-production");
  const request = `deploy ${"a".repeat(40)} 10 1`;
  const env = {
    PATH: process.env.PATH,
    DEPLOY_PATH: import.meta.dir,
    PRODUCTION_URL: "https://qs.girke.dev",
    PRODUCTION_HTTPS_IP: "100.64.0.1",
    BACKUP_READY_REVISION: "a".repeat(40),
  };
  async function reject(script: string, input: string, message: string, command?: string) {
    const child = Bun.spawn(["bash", join(directory, script)], {
      env: command ? { ...env, SSH_ORIGINAL_COMMAND: command } : env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stdout + stderr).toBe(message + "\n");
    expect(status).toBe(1);
  }
  for (const payload of ["", "ghs_fixture", "ghs_fixture\nextra\n", "ghs_fi\0xture\n", `ghs_${"x".repeat(4091)}\n`]) {
    await reject("quantself-deploy-ssh", payload, "Invalid deployment credential.", request);
    await reject(
      "quantself-deploy", `${request}\n${payload}`,
      payload.includes("\0") ? "Invalid deployment request." : "Invalid deployment credential.",
    );
  }
  await reject("quantself-deploy", `de\0${request.slice(2)}\nghs_fixture\n`, "Invalid deployment request.");
  await reject("quantself-deploy", "preflight\nghs_fixture\n", "Unexpected preflight input.");
  await reject("quantself-deploy-ssh", "ghs_fixture\n", "Unexpected preflight input.", "preflight");
});

test("home broker refuses an unapproved revision before invoking GitHub or Docker", async () => {
  const broker = join(import.meta.dir, "infra/home-production/quantself-deploy");
  const child = Bun.spawn(["bash", broker], {
    env: {
      PATH: process.env.PATH,
      DEPLOY_PATH: import.meta.dir,
      PRODUCTION_URL: "https://qs.girke.dev",
      PRODUCTION_HTTPS_IP: "100.64.0.1",
      GIRKE_API_BASE_URL: "https://worker.example.com",
      BACKUP_READY_REVISION: "a".repeat(40),
    },
    stdin: new Blob([`deploy ${"b".repeat(40)} 10 1\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("Production backup readiness is not approved for this revision.\n");
  expect(await new Response(child.stderr).text()).toBe("");
  expect(await child.exited).toBe(1);
});
