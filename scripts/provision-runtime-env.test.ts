import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("provisioning replaces complete multiline PEM and roundtrips supported dotenv values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-env-test-"));
  try {
    const file = join(directory, ".env");
    const pem = '-----BEGIN PRIVATE KEY-----\nnew\\back"quote\n-----END PRIVATE KEY-----';
    await writeFile(file, 'KEEP=value\nQUANTSELF_GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nobsolete\n-----END PRIVATE KEY-----"\nAFTER=preserved\n');
    const child = Bun.spawn(["python3", join(import.meta.dir, "provision-runtime-env.py"), file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ QUANTSELF_GITHUB_PRIVATE_KEY: pem })); child.stdin.end();
    expect(await child.exited).toBe(0);
    const output = await readFile(file, "utf8");
    expect(output).not.toContain("obsolete");
    expect(output).toContain("AFTER=preserved");
    const parsed = Bun.spawn(["bun", `--env-file=${file}`, "-e", "process.stdout.write(process.env.QUANTSELF_GITHUB_PRIVATE_KEY)"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } });
    // Never print a credential value in a failed assertion.
    expect((await new Response(parsed.stdout).text()) === pem).toBe(true);
    expect(await parsed.exited).toBe(0);
    await writeFile(join(directory, "compose.yaml"), 'services:\n  fixture:\n    image: test\n    environment:\n      VALUE: ${QUANTSELF_GITHUB_PRIVATE_KEY}\n');
    const compose = Bun.spawn(["docker", "compose", "--env-file", file, "-f", join(directory, "compose.yaml"), "config", "--format", "json"], { cwd: directory, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect((JSON.parse(await new Response(compose.stdout).text())).services.fixture.environment.VALUE === pem).toBe(true);
    expect(await compose.exited).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("unsupported interpolation values reject without modifying existing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-env-test-"));
  try {
    const file = join(directory, ".env"); await writeFile(file, "KEEP=unchanged\n");
    for (const value of ["dollar$value", "apostrophe'value"]) {
      const child = Bun.spawn(["python3", join(import.meta.dir, "provision-runtime-env.py"), file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ QUANTSELF_PHONE_API_KEY: value })); child.stdin.end();
      expect(await child.exited).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe("KEEP=unchanged\n");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("provision workflow shell parses", async () => {
  const workflow = await readFile(join(import.meta.dir, "fixtures/production-workflows/provision-production.yml"), "utf8");
  const shell = workflow.split("        run: |\n")[1]!.split("\n").map(line => line.replace(/^          /, "")).join("\n");
  const process = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write(shell); process.stdin.end(); expect(await process.exited).toBe(0);
});
test("provision workflow sends a working remote Python command through SSH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-ssh-test-"));
  try {
    const file = join(directory, ".env");
    const fakeSsh = join(directory, "ssh");
    await writeFile(fakeSsh, '#!/usr/bin/env bash\nset -euo pipefail\nremote="${@: -1}"\n# Match the SSH server invoking a shell with the transmitted command.\nexec bash -c "$remote"\n', { mode: 0o700 });
    const workflow = await readFile(join(import.meta.dir, "fixtures/production-workflows/provision-production.yml"), "utf8");
    const shell = workflow.split("          # Code is public repository content;")[1]!.split("\n").slice(1).map(line => line.replace(/^          /, "")).join("\n");
    await writeFile(join(directory, "source.py"), await readFile(join(import.meta.dir, "provision-runtime-env.py"), "utf8"));
    const adjusted = shell.replace("scripts/provision-runtime-env.py", "source.py");
    const child = Bun.spawn(["bash", "-c", adjusted], { cwd: directory, env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DEPLOY_PATH: directory, SSH_USER: "test", SSH_HOST: "test", RUNTIME_CONFIGURATION: JSON.stringify({ QUANTSELF_PHONE_API_KEY: "synthetic-key" }) }, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(error).toBe("");
    expect(await child.exited).toBe(0);
    expect(await readFile(file, "utf8")).toContain("QUANTSELF_PHONE_API_KEY='synthetic-key'");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("private runtime fragment merges without exposing its credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-phone-fragment-"));
  try {
    const file = join(directory, ".env"), fragment = join(directory, "runtime.env");
    await writeFile(file, "QUANTSELF_PHONE_ENABLED=\nKEEP=preserved\n");
    await writeFile(fragment, "QUANTSELF_PHONE_API_KEY='private-synthetic-key'\nQUANTSELF_ELEVENLABS_PHONE_AGENT_ID='phone-agent'\n", { mode: 0o600 });
    const child = Bun.spawn(["python3", join(import.meta.dir, "provision-runtime-env.py"), file, "--phone-runtime-file", fragment], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).not.toContain("private-synthetic-key");
    expect(await child.exited).toBe(0);
    expect(await readFile(file, "utf8")).toContain("QUANTSELF_PHONE_ENABLED=\nKEEP=preserved");
    expect(await readFile(file, "utf8")).toContain("QUANTSELF_ELEVENLABS_PHONE_AGENT_ID='phone-agent'");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private Jobs provisioning rotates an atomic pair and scopes the runner credential to the API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-jobs-runtime-"));
  try {
    const file = join(directory, ".env");
    const fragment = join(directory, "jobs-runtime.json");
    const original = "KEEP=preserved\nJOBS_RUNNER_SECRET=old-runner\nJOBS_WORKER_SECRET=old-worker\n";
    await writeFile(file, original);
    const runner = "synthetic-runner-".padEnd(32, "a") + "$value'\"";
    const worker = "synthetic-worker-".padEnd(32, "b") + "\\";
    const values = { JOBS_RUNNER_SECRET: runner, JOBS_WORKER_SECRET: worker };
    const command = ["python3", join(import.meta.dir, "provision-runtime-env.py"), file];
    const provision = (args: string[], input?: string) => Bun.spawnSync([...command, ...args], {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });

    for (const [payload, mode] of [
      [{ JOBS_RUNNER_SECRET: runner }, 0o600],
      [{ ...values, JOBS_WORKER_SECRET: runner }, 0o600],
      [{ ...values, JOBS_WORKER_SECRET: "x".repeat(31) }, 0o600],
      [{ ...values, JOBS_WORKER_SECRET: worker + " " }, 0o600],
      [{ ...values, OTHER: "x" }, 0o600],
      [values, 0o644],
    ] as const) {
      await rm(fragment, { force: true });
      await writeFile(fragment, JSON.stringify(payload), { mode });
      expect(provision(["--jobs-runtime-file", fragment]).exitCode).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe(original);
    }

    expect(provision([], JSON.stringify(values)).exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe(original);

    await rm(fragment);
    await writeFile(fragment, JSON.stringify(values), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = provision(["--jobs-runtime-file", fragment]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("Runtime settings provisioned; services unchanged\n");
      expect(result.stderr.toString()).toBe("");
    }
    const updated = await readFile(file, "utf8");
    expect(updated).toStartWith("KEEP=preserved\n");
    expect(updated.match(/^JOBS_(?:RUNNER|WORKER)_SECRET=/gm)).toHaveLength(2);
    expect(updated.includes("old-runner") || updated.includes("old-worker")).toBe(false);

    const composeFiles = ["compose.yaml", "compose.prod.yaml", "compose.home.yaml"].map(
      (name) => join(import.meta.dir, "..", name),
    );
    const required = new Set<string>();
    for (const path of composeFiles) {
      for (const match of (await readFile(path, "utf8")).matchAll(/\$\{([A-Z_]+):\?/g)) {
        required.add(match[1]!);
      }
    }
    const compose = Bun.spawnSync([
      "docker", "compose", "--env-file", file, "--profile", "jobs-worker",
      ...composeFiles.flatMap((path) => ["-f", path]),
      "config", "--format", "json",
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(
        [...required].map((key) => [key, "synthetic"]),
      ) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(compose.exitCode).toBe(0);
    const services = JSON.parse(compose.stdout.toString()).services;
    // Compose config escapes literal dollars so the rendered model can be reused.
    expect(services.api.environment.JOBS_RUNNER_SECRET.replaceAll("$$", "$") === runner).toBe(true);
    expect(services.api.environment.JOBS_WORKER_SECRET === worker).toBe(true);
    expect(services["jobs-codex-worker"].environment.JOBS_WORKER_SECRET === worker).toBe(true);
    expect("JOBS_RUNNER_SECRET" in services["jobs-codex-worker"].environment).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native analytics keys are provisioned atomically and stay API-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-native-analytics-"));
  try {
    const file = join(directory, ".env");
    const fragment = join(directory, "native-runtime.json");
    const names = [
      "QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN",
      "QUANTSELF_TRACKED_LINKS_READ_TOKEN",
      "QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN",
      "QUANTSELF_TRACKED_LINKS_SHARE_TOKEN",
    ];
    const values = Object.fromEntries(names.map((key, index) => [key, `synthetic-native-${index}-`.padEnd(40, "x")]));
    const original = `KEEP=preserved\n${names[0]}=obsolete\n`;
    await writeFile(file, original);
    const provision = (args: string[], input?: string) => Bun.spawnSync(
      ["python3", join(import.meta.dir, "provision-runtime-env.py"), file, ...args],
      { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" },
    );
    const privateArgs = ["--native-analytics-runtime-file", fragment];

    expect(provision([], JSON.stringify(values)).exitCode).not.toBe(0);
    for (const [payload, mode] of [
      [{ [names[0]!]: values[names[0]!] }, 0o600],
      [{ ...values, [names[1]!]: values[names[0]!] }, 0o600],
      [{ ...values, [names[1]!]: "x".repeat(31) }, 0o600],
      [{ ...values, [names[1]!]: values[names[1]!] + " " }, 0o600],
      [{ ...values, EXTRA: "invalid" }, 0o600],
      [values, 0o644],
    ] as const) {
      await rm(fragment, { force: true });
      await writeFile(fragment, JSON.stringify(payload), { mode });
      expect(provision(privateArgs).exitCode).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe(original);
    }

    await rm(fragment);
    await writeFile(fragment, JSON.stringify(values), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = provision(privateArgs);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("Runtime settings provisioned; services unchanged\n");
      expect(result.stderr.toString()).toBe("");
    }
    const output = await readFile(file, "utf8");
    expect(output).toStartWith("KEEP=preserved\n");
    expect(output).not.toContain("obsolete");
    for (const key of names) expect(output.match(new RegExp(`^${key}=`, "gm"))).toHaveLength(1);

    const composeFiles = ["compose.yaml", "compose.prod.yaml", "compose.home.yaml"].map(
      (name) => join(import.meta.dir, "..", name),
    );
    const required = new Set<string>();
    for (const path of composeFiles) {
      for (const match of (await readFile(path, "utf8")).matchAll(/\$\{([A-Z_]+):\?/g)) required.add(match[1]!);
    }
    const render = (files: string[], extraEnv: Record<string, string> = {}) => {
      const compose = Bun.spawnSync([
        "docker", "compose", "--env-file", file, "--profile", "*",
        ...files.flatMap((path) => ["-f", path]),
        "config", "--format", "json",
      ], {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(
          [...required].map((key) => [key, "synthetic"]),
        ), ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(compose.exitCode).toBe(0);
      return JSON.parse(compose.stdout.toString());
    };
    const legacySettings = {
      QUANTSELF_UMAMI_WEBSITE_ID: "synthetic-website",
      QUANTSELF_UMAMI_READ_DATABASE_URL: "postgresql://reader:fixture@umami.test:5432/umami",
      APPLICATION_LINKS_TOKEN: "synthetic-legacy-registry-key",
    };
    const collectorSettings = {
      QUANTSELF_UMAMI_URL: "http://umami.test:3000",
      QUANTSELF_WEBSITE_ANALYTICS_TOKEN: "synthetic-legacy-collector-key",
    };
    const home = render(composeFiles);
    for (const target of [home, render(composeFiles, { ...legacySettings, ...collectorSettings })]) {
      expect(Object.keys(target.services.app.networks)).toEqual(["quantself_internal"]);
      expect(target.networks).not.toHaveProperty("portfolio_analytics");
      for (const key of Object.keys(legacySettings)) {
        expect(target.services.app.environment[key]).toBe("");
      }
      for (const service of Object.values<{ environment?: Record<string, string> }>(target.services)) {
        for (const key of Object.keys(collectorSettings)) {
          expect(service.environment ?? {}).not.toHaveProperty(key);
        }
      }
    }
    const hostinger = render(composeFiles.slice(0, 2), legacySettings);
    expect(hostinger.services.app.networks).toHaveProperty("portfolio_analytics");
    expect(hostinger.networks.portfolio_analytics).toMatchObject({
      external: true, name: "portfolio-analytics_default",
    });
    for (const [key, value] of Object.entries(legacySettings)) {
      expect(hostinger.services.app.environment[key]).toBe(value);
    }

    const { services } = home;
    for (const [service, config] of Object.entries<{ environment?: Record<string, string> }>(services)) {
      for (const key of names) {
        expect(config.environment?.[key] === values[key]).toBe(service === "api");
        if (service !== "api") expect(Object.hasOwn(config.environment ?? {}, key)).toBe(false);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
