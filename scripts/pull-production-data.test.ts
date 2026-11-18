import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production data pull", () => {
  test("requires explicit local replacement confirmation", async () => {
    const result = await runScript([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to replace local data without --yes");
  });

  test("preserves auth tables and tolerates incompatible table restores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quantself-data-pull-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    const commandLog = join(directory, "commands.log");
    await mkdir(binDirectory);

    await writeExecutable(
      join(binDirectory, "docker"),
      `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"ps --quiet postgres"* ]]; then printf '%s\\n' local-postgres; fi
if [[ "$*" == *"ps --services --filter status=running"* ]]; then
  printf '%s\\n' app api gateway
fi
if [[ "$*" == *"exec -i local-postgres"* ]]; then cat >/dev/null; fi
if [[ "$*" == *"pg_restore --list"* ]]; then exit 0; fi
if [[ "$*" == *"pg_restore"* ]]; then
  printf '%s\\n' 'pg_restore: error: could not execute query: schema mismatch' >&2
  exit 1
fi
if [[ "$*" == *" run "* ]]; then cat >/dev/null; fi
`,
    );
    await writeExecutable(
      join(binDirectory, "ssh"),
      `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"--format '{{.Names}}'"* ]]; then
  if [[ "$*" == *"quantself-postgres"* ]]; then printf '%s\\n' quantself-postgres; else printf '%s\\n' quantself-next; fi
elif [[ "$*" == *"pg_dump"* ]]; then
  printf '%s' dump
elif [[ "$*" == *" tar "* ]]; then
  printf '%s' archive
fi
`,
    );
    await writeExecutable(join(binDirectory, "tar"), "#!/usr/bin/env bash\nexit 0\n");

    const result = await runScript(["--yes"], {
      COMMAND_LOG: commandLog,
      PATH: `${binDirectory}:${Bun.env.PATH ?? ""}`,
    });
    const commands = await Bun.file(commandLog).text();

    expect({ exitCode: result.exitCode, unexpectedError: result.stderr }).toEqual({
      exitCode: 0,
      unexpectedError: expect.stringContaining("incompatible and stayed empty"),
    });
    expect(result.stderr).toContain("incompatible and stayed empty");
    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "passkey",
      "apikey",
      "auth_owner",
      "owner_setup_token",
      "_prisma_migrations",
    ]) {
      expect(commands).toContain(`--exclude-table-data=public.${table}`);
    }
    expect(commands).not.toContain("quantself_auth_secret");
    expect(commands).not.toContain("quantself_codex_home");
    expect(commands).toContain("ssh root@hostinger-vps");
    expect(commands).toContain(
      'pg_restore --data-only --disable-triggers --no-owner --no-privileges --username="$POSTGRES_USER"',
    );
    expect(commands).toContain(" start app api gateway");
    expect(commands).not.toContain(" up --detach --no-build app api gateway");
    expect(commands).not.toContain("--interactive=false --entrypoint sh app");
    expect(result.stdout).toContain("now match compatible production data");
  });
});

async function runScript(
  arguments_: string[],
  environment: Record<string, string> = {},
) {
  const process = Bun.spawn(
    ["bash", join(import.meta.dir, "pull-production-data.sh"), ...arguments_],
    {
      env: { ...Bun.env, ...environment },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function writeExecutable(path: string, contents: string) {
  await Bun.write(path, contents);
  await chmod(path, 0o755);
}
