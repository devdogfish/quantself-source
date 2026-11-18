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

describe("production deploy helper", () => {
  test("rejects direct local execution", async () => {
    const process = Bun.spawn(
      [
        "bash",
        join(import.meta.dir, "deploy-production.sh"),
        "/tmp/quantself",
        "girke-edge",
        "https://github.com/devdogfish/quantself.git",
        "0123456789012345678901234567890123456789",
        "https://dashboard.example.com/",
      ],
      {
        env: {
          PATH: Bun.env.PATH ?? "",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "GitHub Actions is the only production deploy owner",
    );
  });

  test("home deploy rejects an archive without its exact approved image ID", async () => {
    const child = Bun.spawn([
      "bash", join(import.meta.dir, "deploy-production.sh"), "/unused", "", "",
      "a".repeat(40), "https://qs.girke.dev",
    ], {
      env: {
        PATH: Bun.env.PATH ?? "",
        QUANTSELF_DEPLOY_OWNER: "github-actions",
        QUANTSELF_DEPLOY_TARGET: "home",
        QUANTSELF_IMAGE_ARCHIVE: "/unused/image.tar.gz",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(child.stderr).text()).toContain("requires the exact verified image archive and ID");
    expect(await child.exited).toBe(1);
  });

  test("fails an obsolete queued workflow revision before checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quantself-deploy-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    const deployDirectory = join(directory, "checkout");
    const commandLog = join(directory, "commands.log");
    await Promise.all([mkdir(binDirectory), mkdir(deployDirectory)]);
    await writeExecutable(
      join(binDirectory, "gh"),
      `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$COMMAND_LOG"
`,
    );
    await writeExecutable(
      join(binDirectory, "git"),
      `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "rev-parse FETCH_HEAD" ]]; then
  printf '%s\\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fi
`,
    );

    const process = Bun.spawn(
      [
        "bash",
        join(import.meta.dir, "deploy-production.sh"),
        deployDirectory,
        "",
        "",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "https://qs.girke.dev/",
      ],
      {
        env: {
          COMMAND_LOG: commandLog,
          PATH: `${binDirectory}:${Bun.env.PATH ?? ""}`,
          QUANTSELF_DEPLOY_OWNER: "github-actions",
          QUANTSELF_DEPLOY_TARGET: "home",
          QUANTSELF_IMAGE_ARCHIVE: "/unused/candidate.tar.gz",
          QUANTSELF_IMAGE_ID: `sha256:${"a".repeat(64)}`,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Obsolete deploy rejected");
    expect((await Bun.file(commandLog).text()).trim()).toBe("git rev-parse FETCH_HEAD");
  });

  test.each([false, true])("Keep validates the exact image before migration and promotion (matches=%s)", async (matches) => {
    const directory = await mkdtemp(join(tmpdir(), "quantself-deploy-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    const deployDirectory = join(directory, "checkout");
    const scriptsDirectory = join(deployDirectory, "scripts");
    const commandLog = join(directory, "commands.log");
    const postgresStarted = join(directory, "postgres-started");
    const deploySha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const archive = join(directory, "candidate.tar.gz");
    const imageId = `sha256:${"a".repeat(64)}`;
    const compose = "docker compose -f compose.yaml -f compose.prod.yaml -f compose.home.yaml";
    const environment = { QUANTSELF_PUBLIC_ORIGIN: "https://qs.girke.dev", QUANTSELF_OWNER_INGRESS_TOKEN: "e".repeat(64) };
    const config = JSON.stringify({ services: {
      app: { environment },
      api: { environment: {
        ...environment,
        QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN: "a".repeat(32),
        QUANTSELF_TRACKED_LINKS_READ_TOKEN: "b".repeat(32),
        QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN: "c".repeat(32),
        QUANTSELF_TRACKED_LINKS_SHARE_TOKEN: "d".repeat(32),
      } },
    } });
    await Bun.write(archive, "test image");
    await Promise.all([mkdir(binDirectory), mkdir(deployDirectory)]);
    await mkdir(scriptsDirectory);
    await writeExecutable(
      join(binDirectory, "gh"),
      `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$COMMAND_LOG"
`,
    );
    await writeExecutable(
      join(binDirectory, "git"),
      `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == "rev-parse FETCH_HEAD" || "$*" == "rev-parse HEAD" ]]; then
  printf '%s\\n' "$DEPLOY_SHA"
fi
`,
    );
    await writeExecutable(
      join(binDirectory, "docker"),
      `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1 $2" == "image inspect" ]]; then
  printf '%s\\n' "$IMAGE_REVISION"
  exit 0
fi
if [[ "$*" == *" config --format json" ]]; then
  printf '%s\\n' "$COMPOSE_CONFIG"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" run "* && "$*" != *"--interactive=false"* ]]; then
  cat >/dev/null
fi
if [[ "$*" == "compose -f compose.yaml -f compose.prod.yaml -f compose.home.yaml ps --quiet postgres" ]]; then
  if [[ -f "$POSTGRES_STARTED" ]]; then
    printf '%s\\n' "postgres-container"
  fi
  exit 0
fi
if [[ "$*" == "compose -f compose.yaml -f compose.prod.yaml -f compose.home.yaml up --detach --no-build postgres" ]]; then
  : > "$POSTGRES_STARTED"
  exit 0
fi
if [[ "$*" == "compose -f compose.yaml -f compose.prod.yaml -f compose.home.yaml ps --quiet "* ]]; then
  printf '%s\\n' "service-container"
  exit 0
fi
if [[ "$*" == "compose ps --quiet "* ]]; then
  printf '%s\\n' "worker-container"
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *".State.Status"* ]]; then
  if [[ "$*" == *"quantself-inventory-preprocessing-worker" ]]; then
    printf '%s\\n' "created"
  else
    printf '%s\\n' "running"
  fi
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *".State.Health"* ]]; then
  printf '%s\\n' "healthy"
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *".RestartCount"* ]]; then
  printf '%s\\n' "0"
  exit 0
fi
`,
    );
    await writeExecutable(
      join(binDirectory, "curl"),
      `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$COMMAND_LOG"
printf 200
`,
    );
    await writeExecutable(
      join(binDirectory, "sleep"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await Promise.all(
      [
        "check-inventory-worker-config.sh",
        "check-api-foundation-config.sh",
      ].map((name) =>
        writeExecutable(
          join(scriptsDirectory, name),
          "#!/usr/bin/env bash\nexit 0\n",
        ),
      ),
    );
    await writeExecutable(
      join(scriptsDirectory, "check-inventory-workers.sh"),
      `${
        (
          await Bun.file(
            join(import.meta.dir, "check-inventory-workers.sh"),
          ).text()
        ).split("declare -A restart_counts")[0]
      }exit 0\n`,
    );

    await Bun.write(join(scriptsDirectory, "smoke-production.sh"), Bun.file(join(import.meta.dir, "smoke-production.sh")));

    const deployScript = await Bun.file(
      join(import.meta.dir, "deploy-production.sh"),
    ).text();
    const process = Bun.spawn(
      [
        "bash",
        "-s",
        "--",
        deployDirectory,
        "",
        "",
        deploySha,
        "https://qs.girke.dev/",
      ],
      {
        env: {
          COMMAND_LOG: commandLog,
          DEPLOY_SHA: deploySha,
          PATH: `${binDirectory}:${Bun.env.PATH ?? ""}`,
          POSTGRES_STARTED: postgresStarted,
          QUANTSELF_DEPLOY_OWNER: "github-actions",
          QUANTSELF_DEPLOY_TARGET: "home",
          QUANTSELF_IMAGE_ARCHIVE: archive,
          QUANTSELF_IMAGE_ID: imageId,
          QUANTSELF_PRODUCTION_HTTPS_IP: "100.64.0.1",
          IMAGE_REVISION: matches ? deploySha : "b".repeat(40),
          COMPOSE_CONFIG: config,
        },
        stdin: "pipe",
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    process.stdin.write(deployScript);
    process.stdin.end();
    const [exitCode, stderr, stdout] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ]);
    const commands = (await Bun.file(commandLog).text()).trim().split("\n");
    const startIndex = commands.indexOf(`${compose} up --detach --no-build postgres`);
    const healthIndex = commands.findIndex((command) =>
      command.includes(".State.Health"),
    );
    const migrationIndex = commands.findIndex((command) =>
      command.includes("--exit-code-from migrate migrate"),
    );
    const imageLoadIndex = commands.indexOf(`docker load --input ${archive}`);
    const promotionIndex = commands.indexOf(`${compose} up --detach --no-build --remove-orphans`);
    const composeRuns = commands
      .filter((command) => command.includes("docker compose"))
      .filter((command) => command.includes(" run "));

    expect(imageLoadIndex).toBeGreaterThan(-1);
    const inspectIndex = commands.findIndex(command => command.startsWith("docker image inspect ") && command.endsWith(imageId));
    expect(inspectIndex).toBeGreaterThan(imageLoadIndex);
    expect(commands.some(command => / image prune| compose .* build(?: |$)/.test(command))).toBe(false);
    if (!matches) {
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Candidate image revision does not match");
      expect(startIndex).toBe(-1);
      expect(migrationIndex).toBe(-1);
      expect(promotionIndex).toBe(-1);
      return;
    }
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Production deploy complete: ${deploySha}`);
    expect(composeRuns).toHaveLength(5);
    expect(
      composeRuns.every((command) => command.includes("--interactive=false")),
    ).toBe(true);
    expect(startIndex).toBeGreaterThan(-1);
    expect(healthIndex).toBeGreaterThan(startIndex);
    expect(migrationIndex).toBeGreaterThan(healthIndex);
    expect(promotionIndex).toBeGreaterThan(migrationIndex);
    expect(commands.indexOf(`docker image tag ${imageId} quantself-app`)).toBeGreaterThan(inspectIndex);
    const pauseIndex = commands.indexOf(`${compose} stop inventory-preprocessing-worker`);
    expect(pauseIndex).toBeGreaterThan(migrationIndex);
    expect(pauseIndex).toBeLessThan(promotionIndex);
    expect(commands.indexOf(`${compose} up --no-start --no-deps --no-build --force-recreate inventory-preprocessing-worker`))
      .toBeGreaterThan(promotionIndex);
    expect(commands.findIndex(command => command.startsWith("curl ") && command.endsWith("https://qs.girke.dev/api/health")))
      .toBeGreaterThan(promotionIndex);
  });
});

async function writeExecutable(path: string, contents: string) {
  await Bun.write(path, contents);
  await chmod(path, 0o755);
}
