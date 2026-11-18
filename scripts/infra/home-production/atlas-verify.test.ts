import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = join(import.meta.dir, "../../..");
const gate = "scripts/ci/verify-atlas.sh";

function runGate({ platform = "Linux", version = "1.3.14", failure = "", outsideCheckout = false, extraArgs = [] as string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-verify-"));
  const bin = join(root, "bin");
  const checkout = outsideCheckout ? join(root, "detached source checkout") : root;
  try {
    for (const directory of [bin, join(root, "scripts/ci"), join(checkout, "scripts/ci")]) {
      mkdirSync(directory, { recursive: true });
    }
    if (outsideCheckout) {
      const commands = [
        ["init", "--template="],
        ["-c", "user.name=Atlas fixture", "-c", "user.email=fixture@example.invalid",
          "commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture"],
        ["checkout", "--detach"],
      ];
      for (const args of commands) {
        const git = Bun.spawnSync(["git", ...args], {
          cwd: checkout,
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
        if (git.exitCode !== 0) throw new Error(git.stderr.toString());
      }
    }
    copyFileSync(join(source, gate), join(root, gate));
    writeFileSync(join(bin, "uname"), `#!/bin/bash
case "$1" in
  -s) echo ${platform} ;;
  -m) echo x86_64 ;;
esac
`);
    writeFileSync(join(bin, "bun"), `#!/bin/bash
set -euo pipefail
[[ -z \${GITHUB_TOKEN+x} && -z \${ACTIONS_RUNTIME_TOKEN+x} ]]
printf '%s\n' "$*" >> "$HOME/calls"
if [[ $* == --version ]]; then
  echo ${version}
fi
[[ $* != '${failure}' ]]
`);
    writeFileSync(join(bin, "timeout"), `#!/bin/bash
set -euo pipefail
[[ $1 == --kill-after=15s && $2 == 12m ]]
shift 2
exec "$@"
`, { mode: 0o755 });
    writeFileSync(join(checkout, "scripts/ci/typecheck.sh"), `#!/bin/bash
set -euo pipefail
[[ -z \${GITHUB_TOKEN+x} && -z \${ACTIONS_RUNTIME_TOKEN+x} ]]
printf '%s\n' "typecheck $*" >> "$HOME/calls"
printf '%s\n' "$DATABASE_URL" "$NEXT_TELEMETRY_DISABLED" "$TZ" "$NODE_OPTIONS" > "$HOME/type-env"
[[ "typecheck $*" != '${failure}' ]]
`);
    chmodSync(join(bin, "uname"), 0o755);
    chmodSync(join(bin, "bun"), 0o755);
    writeFileSync(join(root, "calls"), "");
    writeFileSync(join(root, "type-env"), "");
    const checkoutArgs = outsideCheckout ? [checkout] : [];
    const result = Bun.spawnSync(["bash", gate, ...checkoutArgs, ...extraArgs], {
      cwd: root,
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, GITHUB_TOKEN: "fixture", ACTIONS_RUNTIME_TOKEN: "fixture" },
    });
    const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean);
    const typeEnv = readFileSync(join(root, "type-env"), "utf8").trim().split("\n");
    return { exitCode: result.exitCode, calls, typeEnv };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Atlas runs all required verification scopes and the repository test suite", () => {
  const result = runGate();
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual([
    "--version",
    "install --frozen-lockfile",
    "typecheck tsc web",
    "typecheck tsc server",
    "typecheck tsc scripts",
    "run --cwd packages/db generate",
    "run test",
  ]);
  expect(result.typeEnv).toEqual([
    "postgresql://unused:unused@127.0.0.1:59999/unused",
    "1",
    "America/Halifax",
    "--max-old-space-size=5632",
  ]);
});

test("Atlas can invoke the trusted verifier from outside the admitted checkout", () => {
  const result = runGate({ outsideCheckout: true });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("typecheck tsc web");
  expect(result.calls.at(-1)).toBe("run test");
  expect(runGate({ outsideCheckout: true, extraArgs: ["unexpected"] })).toMatchObject({ exitCode: 2, calls: [] });
});

test("Atlas refuses an unsupported platform or Bun release before installing", () => {
  expect(runGate({ platform: "Darwin" })).toMatchObject({ exitCode: 2, calls: [] });
  expect(runGate({ version: "1.3.13" })).toMatchObject({ exitCode: 2, calls: ["--version"] });
});

test("Atlas stops when install or shared test generation fails", () => {
  for (const failure of ["install --frozen-lockfile", "run --cwd packages/db generate"]) {
    const { calls, exitCode } = runGate({ failure });
    expect(exitCode).toBe(1);
    expect(calls.at(-1)).toBe(failure);
  }
});

test("Atlas fails any required scope or the full test suite and completes the remaining checks", () => {
  for (const failure of ["typecheck tsc web", "run test"]) {
    const { calls, exitCode } = runGate({ failure });
    expect(exitCode).toBe(1);
    expect(calls).toContain("typecheck tsc scripts");
    expect(calls.at(-1)).toBe("run test");
  }
});
