import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function fixture(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "phone ssh fixture "));
  const bin = join(root, "bin"), scripts = join(root, "scripts");
  await mkdir(bin); await mkdir(scripts);
  for (const name of ["bootstrap-phone-production.sh", "provision-runtime-env.py"]) await writeFile(join(scripts, name), await readFile(join(import.meta.dir, name)));
  await writeFile(join(root, ".env"), "QUANTSELF_PHONE_ENABLED=\nKEEP=preserved\n");
  await writeFile(join(bin, "ssh"), '#!/usr/bin/env bash\nexec bash -c "${@: -1}"\n', { mode: 0o700 });
  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
if [[ "$1" == ls-remote ]]; then printf '%s\\trefs/heads/main\\n' "$TEST_REMOTE_REVISION"; else printf '%s\\n' "$BOOTSTRAP_REVISION"; fi
`, { mode: 0o700 });
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == compose ]]; then
  shift 5
  case "$1" in
    ps) echo api-container ;;
    config) printf '{"services":{"api":{"environment":{"QUANTSELF_PHONE_ENABLED":"%s"}}}}' "\${TEST_ENABLED:-}" ;;
    exec) cat >/dev/null; touch "$TEST_ROOT/bootstrap-ran" ;;
    *) exit 91 ;;
  esac
elif [[ "$1" == inspect ]]; then
  if [[ "$3" == *State.Running* ]]; then echo true; else echo "$TEST_IMAGE_REVISION"; fi
elif [[ "$1" == exec ]]; then
  if [[ "$5" == *"printf %s"* ]]; then printf %s '/custom/capture path'; else test "\${TEST_ENABLED:-}" != 1; fi
elif [[ "$1" == cp ]]; then
  [[ "$2" == 'api-container:/custom/capture path/.phone-bootstrap/runtime.env' ]]
  printf "QUANTSELF_PHONE_API_KEY='synthetic-private-key'\\nQUANTSELF_ELEVENLABS_PHONE_AGENT_ID='phone-agent'\\n" > "$3"
else exit 92
fi
`, { mode: 0o700 });
  const workflow = await readFile(join(import.meta.dir, "fixtures/production-workflows/bootstrap-phone-jarvis.yml"), "utf8");
  const shell = workflow.split("          [[ \"$BOOTSTRAP_REVISION\"")[1]!;
  const executable = ('[[ "$BOOTSTRAP_REVISION"' + shell).split("\n").map(line => line.replace(/^          /, "")).join("\n");
  const revision = "a".repeat(40);
  const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", executable], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, DEPLOY_PATH: root, BOOTSTRAP_REVISION: revision, TEST_REMOTE_REVISION: revision, TEST_IMAGE_REVISION: revision, SSH_USER: "test", SSH_HOST: "test", ...overrides }, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
  return { root, stdout, stderr, exit: await child.exited, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("Actions SSH command bootstraps verified disabled image and merges private fragment without secrets", async () => {
  const f = await fixture();
  try {
    expect(f.stderr).toBe(""); expect(f.exit).toBe(0);
    expect(f.stdout).not.toContain("synthetic-private-key");
    expect(await readFile(join(f.root, ".env"), "utf8")).toContain("QUANTSELF_PHONE_ENABLED=\nKEEP=preserved");
    expect(await readFile(join(f.root, ".env"), "utf8")).toContain("QUANTSELF_ELEVENLABS_PHONE_AGENT_ID='phone-agent'");
    expect((await stat(join(f.root, ".private-phone/runtime.env"))).mode & 0o077).toBe(0);
  } finally { await f.cleanup(); }
});
test("stale main, mismatched API image and enabled phone fail before bootstrap", async () => {
  for (const overrides of [{ TEST_REMOTE_REVISION: "b".repeat(40) }, { TEST_IMAGE_REVISION: "b".repeat(40) }, { TEST_ENABLED: "1" }]) {
    const f = await fixture(overrides);
    try {
      expect(f.exit).not.toBe(0);
      expect(await stat(join(f.root, "bootstrap-ran")).catch(() => null)).toBeNull();
      expect(await readFile(join(f.root, ".env"), "utf8")).toBe("QUANTSELF_PHONE_ENABLED=\nKEEP=preserved\n");
    } finally { await f.cleanup(); }
  }
});
