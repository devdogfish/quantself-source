import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { nativeEnvironment, prepareNativeDev, reservePort, tunnelOrigin, tunnelFailure, serveNativeDev, superviseDev, acquireDevSupervisor } from "./dev";
import { startDevOwnerIngress } from "./dev-owner-ingress";
import type { CommandRunner } from "./ops";

const databaseEnv = ["POSTGRES_USER=dev", "POSTGRES_PASSWORD=test:password", "POSTGRES_DB=quantself"];
function fixture(fail?: string, containerId = "project-postgres") {
  const calls: { command: string[]; options: any }[] = [];
  const runner: CommandRunner = {
    interrupt() {},
    async run(command, options) {
      calls.push({ command, options });
      let stdout = "";
      if (command.includes("--quiet")) stdout = containerId;
      if (command.includes("port")) stdout = "127.0.0.1:55001\n";
      if (command.includes("inspect")) stdout = JSON.stringify(databaseEnv);
      if (command.includes("exec")) stdout = command.at(-1)!;
      return { exitCode: fail && command.includes(fail) ? 1 : 0, stdout, stderr: "" };
    },
  };
  return { calls, runner };
}

test("root dev starts only Docker PostgreSQL, discovers its binding, then generates and migrates natively", async () => {
  const f = fixture();
  const env = await prepareNativeDev(f.runner, { DATABASE_URL: "postgresql://wrong@localhost:5432/wrong", QUANTSELF_ELEVENLABS_API_KEY: "existing" });
  expect(env.DATABASE_URL).toBe("postgresql://dev:test%3Apassword@127.0.0.1:55001/quantself");
  expect(env.QUANTSELF_ELEVENLABS_API_KEY).toBe("existing");
  expect(env.QUANTSELF_API_INTERNAL_URL).toBeUndefined();
  expect(env.BETTER_AUTH_URL).toBeUndefined();
  const up = f.calls.find(call => call.command.includes("up"))!;
  expect(up.command.slice(-4)).toEqual(["-d", "--wait", "--no-recreate", "postgres"]);
  expect(f.calls.some(call => call.command.includes("build") || call.command.includes("--watch"))).toBe(false);
  expect(f.calls.slice(-2).map(call => call.command)).toEqual([
    ["bun", "run", "--cwd", "packages/db", "migrate:deploy-only"],
    ["bun", "run", "scripts/ensure-dev-owner.ts"],
  ]);
  expect(f.calls.at(-1)?.options.env.DATABASE_URL).toBe(env.DATABASE_URL);
});

test("Docker failure prevents migrations and never falls back to host PostgreSQL", async () => {
  const f = fixture("version");
  await expect(prepareNativeDev(f.runner, {})).rejects.toThrow("Docker Desktop");
  expect(f.calls).toHaveLength(1);
});

test("shared development routes the checkout database without starting or creating Docker resources", async () => {
  const f = fixture();
  const env = await prepareNativeDev(f.runner, {
    QUANTSELF_SHARED_DEV_DATABASE: "qs_dev_main",
    QUANTSELF_DEV_POSTGRES_PROJECT: "quantself-main-dev",
    DATABASE_URL: "postgresql://wrong@localhost:5432/wrong",
  });
  expect(env.DATABASE_URL).toBe("postgresql://dev:test%3Apassword@127.0.0.1:55001/qs_dev_main");
  expect(f.calls.filter(call => call.command[1] === "compose").map(call => call.command.slice(2)))
    .toEqual([["-p", "quantself-shared-dev", "-f", "compose.yaml", "-f", "compose.dev.yaml", "ps", "--quiet", "postgres"]]);
  expect(f.calls.find(call => call.command[1] === "exec")?.command.at(-1)).toBe("qs_dev_main");
  expect(f.calls.at(-1)?.options.env.DATABASE_URL).toBe(env.DATABASE_URL);
});

test("shared development stops before Prisma when the selected container or database is unavailable", async () => {
  for (const f of [fixture(undefined, ""), fixture(undefined, "first\nsecond"), fixture("exec")]) {
    await expect(prepareNativeDev(f.runner, { QUANTSELF_SHARED_DEV_DATABASE: "qs_dev_main" })).rejects.toThrow();
    expect(f.calls.some(call => call.command[0] === "bun" || call.command.includes("up"))).toBe(false);
  }
  for (const database of ["postgres", "quantself", "qs_dev_main?host=elsewhere", "qs_dev_" + "a".repeat(57)]) {
    const f = fixture();
    await expect(prepareNativeDev(f.runner, { QUANTSELF_SHARED_DEV_DATABASE: database })).rejects.toThrow("QUANTSELF_SHARED_DEV_DATABASE");
    expect(f.calls).toHaveLength(0);
  }
});

test("clearing the shared selection routes the main checkout back to its existing legacy project", async () => {
  const f = fixture();
  const env = await prepareNativeDev(f.runner, { QUANTSELF_SHARED_DEV_DATABASE: "", QUANTSELF_DEV_POSTGRES_PROJECT: "quantself-main-dev" });
  expect(env.DATABASE_URL).toBe("postgresql://dev:test%3Apassword@127.0.0.1:55001/quantself");
  const composeCalls = f.calls.filter(call => call.command[1] === "compose");
  expect(composeCalls.every(call => call.command[3] === "quantself-main-dev")).toBe(true);
  expect(composeCalls.some(call => call.command.includes("--no-recreate"))).toBe(true);
  const missing = fixture(undefined, "");
  await expect(prepareNativeDev(missing.runner, { QUANTSELF_DEV_POSTGRES_PROJECT: "quantself-main-dev" })).rejects.toThrow("could not be found");
  expect(missing.calls.some(call => call.command.includes("up"))).toBe(false);
});

test("production data pulls refuse the shared container or an active shared checkout", () => {
  for (const env of [
    { QUANTSELF_SHARED_DEV_DATABASE: "qs_dev_main" },
    { QUANTSELF_DEV_PROJECT_NAME: "quantself-shared-dev" },
  ]) {
    // No Docker or SSH commands can run, including if the guard regresses.
    const pull = Bun.spawnSync(["/bin/bash", `${import.meta.dir}/pull-production-data.sh`, "--yes"], {
      env: { PATH: "/nonexistent", ...env },
    });
    expect(pull.exitCode).toBe(1);
    expect(pull.stderr.toString()).toContain("legacy checkout");
  }
});

test("native development selects its dedicated Jarvis agent without modifying production configuration", () => {
  const source = { QUANTSELF_ELEVENLABS_AGENT_ID: "production", QUANTSELF_DEV_ELEVENLABS_AGENT_ID: "development" };
  expect(nativeEnvironment(source, "127.0.0.1:55001", databaseEnv).QUANTSELF_ELEVENLABS_AGENT_ID).toBe("development");
  expect(source.QUANTSELF_ELEVENLABS_AGENT_ID).toBe("production");
  expect(() => nativeEnvironment({ ...source, QUANTSELF_DEV_TUNNEL_ORIGIN: "https://quantself-local.girke.dev", QUANTSELF_DEV_ELEVENLABS_AGENT_ID: "production" }, "127.0.0.1:55001", databaseEnv)).toThrow("distinct");
  expect(nativeEnvironment({ QUANTSELF_ELEVENLABS_AGENT_ID: "existing" }, "127.0.0.1:55001", databaseEnv).QUANTSELF_ELEVENLABS_AGENT_ID).toBe("existing");
});

test("native connection requires a discovered loopback binding and complete container configuration", () => {
  for (const binding of ["", "0.0.0.0:5432", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:55001\n127.0.0.1:55002"]) {
    expect(() => nativeEnvironment({}, binding, databaseEnv)).toThrow();
  }
  expect(() => nativeEnvironment({}, "127.0.0.1:55001", [])).toThrow();
  const env = nativeEnvironment({ QUANTSELF_DEV_STORAGE_ROOT: "/tmp/dev-storage" }, "127.0.0.1:55001", databaseEnv);
  expect(env.INVENTORY_UPLOAD_DIR).toBe("/tmp/dev-storage/inventory-images");
  expect(env.QUANTSELF_TODO_CAPTURE_ROOT).toBe("/tmp/dev-storage/todo-captures");
});

test("root dev is native and exposes the checkout cache cleanup", async () => {
  const config = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(config.scripts.dev).toBe("bun run scripts/dev.ts");
  expect(config.scripts["dev:docker"]).toBeUndefined();
  expect(config.scripts["dev:clean"]).toBe("bun run scripts/dev-clean.ts");
});


test("port selection skips occupied ports and reserves a separate API socket", async () => {
  const occupied = await reservePort(0);
  const web = await reservePort(occupied.port);
  const api = await reservePort(0);
  try {
    expect(web.port).toBeGreaterThan(occupied.port);
    expect(api.port).not.toBe(web.port);
    expect(api.port).not.toBe(occupied.port);
  } finally { await occupied.release(); await web.release(); await api.release(); }
});

test("loopback Owner ingress replaces spoofed proof and rejects a foreign host or origin", async () => {
  const upstream = createServer((incoming, response) => {
    response.end(JSON.stringify(incoming.headers));
  }).listen(0, "127.0.0.1");
  const [port] = await Promise.all([reservePort(0), once(upstream, "listening")]);
  await port.release();
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  const host = `localhost:${port.port}`;
  const proof = "a".repeat(64);
  const ingress = startDevOwnerIngress(port.port, address.port, proof);
  try {
    await once(ingress, "listening");
    function get(headers: Record<string, string>) {
      return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const client = request({ hostname: "127.0.0.1", port: port.port, headers }, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        client.on("error", reject);
        client.end();
      });
    }
    const allowed = await get({ host, "x-quantself-owner-proof": "spoofed", "x-forwarded-host": "foreign.test" });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({
      "x-quantself-owner-proof": proof,
      "x-forwarded-host": host,
    });
    expect((await get({ host: "foreign.test" })).status).toBe(403);
    expect((await get({ host, origin: "https://foreign.test" })).status).toBe(403);
  } finally {
    ingress.close();
    upstream.close();
  }
});

test("extracts a quick tunnel URL from streamed output without accepting arbitrary domains", () => {
  expect(tunnelOrigin("INF | https://private-feel-golden-spreading.trycloudflare.com |\n")).toBe("https://private-feel-golden-spreading.trycloudflare.com");
  expect(tunnelOrigin("https://example.com")).toBeUndefined();
});

test("tunnel startup surfaces rate limits without exposing raw provider output", () => {
  expect(tunnelFailure('ERR Error unmarshaling QuickTunnel response status_code="429 Too Many Requests" private-value')).toBe("Cloudflare quick tunnel rate-limited (HTTP 429). Stop repeated restarts and wait before retrying.");
  expect(tunnelFailure("private-value arbitrary error")).toBe("");
});

// Exercise the supervisor boundary with the provider's observed failure.
test("supervisor reports quick-tunnel HTTP 429", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "quantself-tunnel-test-"));
  try {
    await writeFile(join(dir, "cloudflared"), `#!/bin/sh\necho 'status_code="429 Too Many Requests"' >&2\nexit 1\n`, { mode: 0o700 });
    await expect(serveNativeDev({ PATH: dir, QUANTSELF_ELEVENLABS_API_KEY: "fixture", QUANTSELF_ELEVENLABS_AGENT_ID: "fixture" })).rejects.toThrow("Cloudflare quick tunnel rate-limited (HTTP 429)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("managed startup opens circuit after five rate-limited attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await expect(superviseDev(async () => { attempts++; throw Error("HTTP 429"); }, new AbortController().signal,
    async delay => { delays.push(delay); }, () => {})).rejects.toThrow("circuit open");
  expect(attempts).toBe(5);
  expect(delays).toEqual([300000, 300000, 300000, 300000]);
});

test("shutdown cancels retry backoff without another startup", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const done = superviseDev(async () => { attempts++; throw Error("offline"); }, controller.signal, undefined, () => {});
  controller.abort();
  await done;
  expect(attempts).toBe(1);
});

test("exclusive supervisor socket prevents duplicate startup and releases cleanly", async () => {
  const { port, release } = await acquireDevSupervisor(0);
  try { await expect(acquireDevSupervisor(port)).rejects.toThrow("already running"); }
  finally { await release(); }
  await (await acquireDevSupervisor(port)).release();
});


test("transient failures back off exponentially and stop retrying after recovery", async () => {
  const delays: number[] = [];
  let attempts = 0;
  await superviseDev(async () => { if (++attempts < 4) throw Error("offline"); }, new AbortController().signal,
    async delay => { delays.push(delay); }, () => {});
  expect(attempts).toBe(4);
  expect(delays).toEqual([30000, 60000, 120000]);
});
