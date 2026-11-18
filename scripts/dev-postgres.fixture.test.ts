import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareNativeDev } from "./dev";
import type { CommandRunner } from "./ops";

const root = resolve(import.meta.dir, "..");

test.skipIf(process.env.QUANTSELF_DEV_POSTGRES_FIXTURE !== "1")(
  "one disposable Postgres container restores and routes two checkouts independently",
  async () => {
    const context = process.env.DOCKER_CONTEXT;
    const endpoint = (!context && process.env.DOCKER_HOST) || Bun.spawnSync([
      "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}", ...(context ? [context] : []),
    ]).stdout.toString().trim();
    if (!endpoint.startsWith("unix:///") || /[\r\n]/.test(endpoint)) throw Error("The fixture requires a local Docker socket.");

    const directory = await mkdtemp(join(tmpdir(), "qs-dev-db-"));
    const project = `qs-dev-db-fixture-${crypto.randomUUID()}`;
    const override = join(directory, "compose.fixture.yaml");
    const compose = ["compose", "--env-file", "/dev/null", "-p", project,
      "-f", "compose.yaml", "-f", "compose.dev.yaml", "-f", override];
    const docker = (args: string[], stdin?: Uint8Array) => Bun.spawnSync(["docker", "--host", endpoint, ...args], {
      cwd: root, env: { ...process.env, DOCKER_CONTEXT: "", QUANTSELF_POSTGRES_PORT: "0" },
      stdin, timeout: 30_000,
    });
    function requireSuccess(args: string[], stdin?: Uint8Array) {
      const result = docker(args, stdin);
      if (result.exitCode !== 0) throw Error(result.stderr.toString() || `Fixture Docker command failed: ${args[0]}`);
      return result.stdout;
    }

    let started = false;
    try {
      await writeFile(override, `services:
  postgres:
    volumes: !reset []
    tmpfs:
      - /var/lib/postgresql:size=128m
    mem_limit: 256m
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U dev -d quantself"]
      interval: 1s
      timeout: 2s
      retries: 15
`);
      expect(requireSuccess(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).length).toBe(0);
      started = true;
      requireSuccess([...compose, "up", "--pull", "never", "-d", "--wait", "--wait-timeout", "20", "postgres"]);
      const id = requireSuccess([...compose, "ps", "--quiet", "postgres"]).toString().trim();
      expect(id).toMatch(/^[a-f0-9]{12,64}$/);
      expect(requireSuccess(["inspect", "--format", '{{index .HostConfig.Tmpfs "/var/lib/postgresql"}}', id]).toString().trim()).toBe("size=128m");
      const exec = (args: string[], archive?: Uint8Array) => requireSuccess(["exec", "-i", id, ...args], archive);
      const psql = (database: string, sql: string) =>
        exec(["psql", "-XqAt", "-U", "dev", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", sql]).toString().trim();

      const migrations = new Map<string, string>();
      const runner: CommandRunner = {
        interrupt() {},
        async run(command, options) {
          const [, action, ...args] = command;
          if (command[0] === "bun") {
            // Observe the migration target without generating Prisma or applying the app schema.
            if (command.includes("migrate:deploy-only")) {
              const url = new URL(options?.env?.DATABASE_URL ?? "");
              migrations.set(url.pathname.slice(1), url.host);
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          let fixtureArgs = [action, ...args];
          if (action === "compose") {
            expect(args).toEqual(["-p", "quantself-shared-dev", "-f", "compose.yaml", "-f", "compose.dev.yaml", "ps", "--quiet", "postgres"]);
            fixtureArgs = [...compose, "ps", "--quiet", "postgres"];
          } else if (["port", "exec"].includes(action)) {
            expect(args[0]).toBe(id);
          } else if (action === "inspect") {
            expect(args.at(-1)).toBe(id);
          } else if (action === "ps") {
            fixtureArgs = ["ps", "--filter", `label=com.docker.compose.project=${project}`, ...args];
          } else {
            expect(action).toBe("version");
          }
          const result = docker(fixtureArgs);
          return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
        },
      };

      for (const checkout of ["checkout", "main"] as const) {
        const source = `fixture_source_${checkout}`;
        const target = `qs_dev_${checkout}`;
        exec(["createdb", "-U", "dev", source]);
        psql(source, `CREATE TABLE fixture (name text PRIMARY KEY); INSERT INTO fixture VALUES ('${checkout}');`);
        const archive = exec(["pg_dump", "-U", "dev", "--format=custom", source]);
        exec(["createdb", "-U", "dev", target]);
        exec(["pg_restore", "-U", "dev", "--no-owner", "--no-privileges", "--single-transaction", "-d", target], archive);

        const env = await prepareNativeDev(runner, { QUANTSELF_SHARED_DEV_DATABASE: target });
        const client = new Bun.SQL({ url: env.DATABASE_URL!, max: 1 });
        try {
          const rows = await client<{ database: string; name: string }[]>`SELECT current_database() AS database, name FROM fixture`;
          expect(rows).toEqual([{ database: target, name: checkout }]);
          await client`UPDATE fixture SET name = ${`${checkout}_updated`}`;
        } finally {
          await client.close();
        }
      }

      expect(migrations.size).toBe(2);
      expect(migrations.get("qs_dev_checkout")).toBe(migrations.get("qs_dev_main"));
      expect(psql("qs_dev_checkout", "SELECT name FROM fixture")).toBe("checkout_updated");
      expect(psql("qs_dev_main", "SELECT name FROM fixture")).toBe("main_updated");
      expect(psql("fixture_source_checkout", "SELECT name FROM fixture")).toBe("checkout");
      expect(psql("fixture_source_main", "SELECT name FROM fixture")).toBe("main");
      await expect(prepareNativeDev(runner, { QUANTSELF_SHARED_DEV_DATABASE: "qs_dev_absent" })).rejects.toThrow();
      expect(migrations.has("qs_dev_absent")).toBe(false);
    } finally {
      try {
        if (started) requireSuccess([...compose, "down", "--volumes"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  45_000,
);
