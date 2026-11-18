import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the private workflow sends one exact SSH command with its token on stdin and requires acknowledgement", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(import.meta.dir, "promote-keep.yml")).text(),
  ) as { jobs: { relay: { "if": string; "runs-on": string[]; steps: [{ run: string }] } } };
  const relay = workflow.jobs.relay;
  expect(relay.if).toContain("github.actor_id == vars.ATLAS_CONTROL_ACTOR_ID");
  expect(relay["runs-on"]).toContain(
    "${{ format('quantself-atlas-control-{0}-{1}', github.run_id, github.run_attempt) }}",
  );
  const script = relay.steps[0].run;
  const scratch = await mkdtemp(join(tmpdir(), "atlas-control-workflow-"));
  try {
    await writeFile(join(scratch, "timeout"), `#!/bin/bash
set -eu
[[ $1 == --kill-after=5s && $2 == 42m ]]
shift 2
exec "$@"
`, { mode: 0o700 });
    await writeFile(join(scratch, "ssh"), `#!/bin/bash
set -eu
[[ "$*" == *"StrictHostKeyChecking=yes"* ]]
[[ "$*" == *"IdentityAgent=none"* ]]
while (( $# > 2 )); do shift; done
[[ $1 == deploy-atlas@keep.example && $2 == "promote-atlas $SOURCE_SHA 23 1" ]]
[[ -z ${"$"}{CONTROL_JOB_TOKEN+x} && -z ${"$"}{CONTROL_SSH_KEY+x} ]]
IFS= read -r token
[[ $token == ghs_fixture ]]
! IFS= read -r ignored
printf '%s\\n' "$REPLY"
`, { mode: 0o700 });
    const env = {
      PATH: `${scratch}:${process.env.PATH}`,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_PROTECTED: "true",
      GITHUB_REPOSITORY: "devdogfish/private-control",
      GITHUB_REPOSITORY_ID: "123",
      CONTROL_REPOSITORY_ID: "123",
      GITHUB_ACTOR_ID: "42",
      CONTROL_ACTOR_ID: "42",
      GITHUB_ACTOR: "devdogfish",
      GITHUB_TRIGGERING_ACTOR: "devdogfish",
      GITHUB_RUN_ID: "23",
      GITHUB_RUN_ATTEMPT: "1",
      SOURCE_SHA: "a".repeat(40),
      CONTROL_SSH_HOST: "keep.example",
      CONTROL_SSH_KNOWN_HOST: `keep.example ssh-ed25519 ${"a".repeat(68)}`,
      CONTROL_SSH_KEY: "private-key-fixture",
      CONTROL_JOB_TOKEN: "ghs_fixture",
      REPLY: "QUANTSELF_DEPLOY_OK",
    };
    const invoke = (overrides: Partial<typeof env> = {}) => Bun.spawnSync(
      ["/bin/bash", "-c", script], { env: { ...env, ...overrides } },
    );
    const accepted = invoke();
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout.toString()).toBe("Keep promotion acknowledged.\n");

    for (const overrides of [
      { REPLY: "QUANTSELF_DEPLOY_OK\nextra" },
      { GITHUB_TRIGGERING_ACTOR: "someone-else" },
      { GITHUB_ACTOR_ID: "43" },
      { CONTROL_SSH_KNOWN_HOST: "unknown-host ssh-ed25519 bad" },
      { GITHUB_REPOSITORY: "DevDogFish/Quantself" },
    ]) {
      const rejected = invoke(overrides);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout.toString()).toBe("");
      expect(rejected.stderr.toString()).toBe(
        "Atlas promotion failed. Check the staged signed evidence and Keep broker journal.\n",
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
