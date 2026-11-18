import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const keys = ["DATABASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_RP_ID", "QUANTSELF_INSTANCE_NAME", "QUANTSELF_OWNER_EMAIL", "QUANTSELF_TODO_REPOSITORY", "QUANTSELF_TODO_TEST_REPOSITORY", "QUANTSELF_GITHUB_APP_ID", "QUANTSELF_GITHUB_INSTALLATION_ID", "QUANTSELF_GITHUB_PRIVATE_KEY", "QUANTSELF_GITHUB_WEBHOOK_SECRET", "QUANTSELF_ELEVENLABS_API_KEY", "QUANTSELF_ELEVENLABS_AGENT_ID"];
async function run(overrides: Record<string, string> = {}, unhealthy = false) {
  const directory = await mkdtemp(join(tmpdir(), "quantself-preflight-")); directories.push(directory);
  const bin = join(directory, "bin"); await mkdir(bin);
  const config = { ...Object.fromEntries(keys.map(key => [key, `PRIVATE-${key}`])), BETTER_AUTH_URL: "https://private-origin.example", ...overrides };
  const original = Object.entries(config).map(([key, value]) => `${key}='${value}'`).join("\n");
  await writeFile(join(directory, ".env"), original);
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'compose -f compose.yaml -f compose.prod.yaml ps --quiet '*) printf '%s\\n' 'fixture-container' ;;
  'inspect --format '*) printf '%s\\n' '${unhealthy ? "running unhealthy" : "running healthy"}' ;;
  'compose -f compose.yaml -f compose.prod.yaml exec -T api bun -') cat > "$QUERY_LOG"; printf '%s\\n' 'PRIVATE-unexpected-container-diagnostic' 'MIGRATIONS: 10 applied; 0 unfinished' ;;
  *) echo 'Unexpected or mutating command' >&2; exit 99 ;;
esac
`); await chmod(join(bin, "docker"), 0o755);
  const process = Bun.spawn(["bash", join(import.meta.dir, "preflight-production.sh"), directory], { env: { PATH: `${bin}:${Bun.env.PATH}`, COMMAND_LOG: join(directory, "commands"), QUERY_LOG: join(directory, "query") }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect(await readFile(join(directory, ".env"), "utf8")).toBe(original);
  expect(stdout + stderr).not.toContain("PRIVATE-");
  expect(stdout + stderr).not.toContain("private-origin");
  return { exit, stdout, commands: await readFile(join(directory, "commands"), "utf8"), query: await readFile(join(directory, "query"), "utf8") };
}
test("preflight reports only presence and health, queries bookkeeping read-only, preserves runtime env", async () => {
  const result = await run();
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("PRESENT: QUANTSELF_GITHUB_WEBHOOK_SECRET");
  expect(result.stdout).toContain("HEALTHY: api");
  expect(result.stdout).toContain("OPTIONAL ABSENT: QUANTSELF_JARVIS_TOOL_ORIGIN");
  expect(result.query).toContain("SET TRANSACTION READ ONLY");
  expect(result.query).toContain('FROM \\"_prisma_migrations\\"'.replaceAll("\\", ""));
  expect(result.commands).not.toMatch(/\b(up|run|logs|build|restart|down)\b/);
});
test("missing credentials fail clearly without values or stopping diagnostic checks", async () => {
  const result = await run({ QUANTSELF_GITHUB_WEBHOOK_SECRET: "", QUANTSELF_ELEVENLABS_API_KEY: "" });
  expect(result.exit).toBe(1);
  expect(result.stdout).toContain("MISSING: QUANTSELF_GITHUB_WEBHOOK_SECRET");
  expect(result.stdout).toContain("MISSING: QUANTSELF_ELEVENLABS_API_KEY");
  expect(result.stdout).toContain("MIGRATIONS: 10 applied");
});
test("unhealthy services and development callback origins fail preflight", async () => {
  const result = await run({ QUANTSELF_JARVIS_TOOL_ORIGIN: "https://fixture.trycloudflare.com" }, true);
  expect(result.exit).toBe(1);
  expect(result.stdout).toContain("UNHEALTHY: api");
  expect(result.stdout).toContain("stable HTTPS origin");
  expect(result.stdout).not.toContain("fixture.trycloudflare.com");
});
