import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createBunCommandRunner, type CommandRunner } from "./ops";
import { namedDevelopmentTunnel } from "./dev-tunnel";
import { reservePort, startDevOwnerIngress } from "./dev-owner-ingress";

export { reservePort };

type Environment = Record<string, string | undefined>;
const root = resolve(import.meta.dir, "..");
const sharedProject = "quantself-shared-dev";

/** Only the discovered project container can supply the native database URL. */
export function nativeEnvironment(env: Environment, binding: string, containerEnv: string[], database?: string): Environment {
  if (env.QUANTSELF_DEV_TUNNEL_ORIGIN && (!env.QUANTSELF_DEV_ELEVENLABS_AGENT_ID || env.QUANTSELF_DEV_ELEVENLABS_AGENT_ID === env.QUANTSELF_ELEVENLABS_AGENT_ID))
    throw Error("Named development tunnel requires a dedicated agent distinct from the production Jarvis agent.");
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error("Project PostgreSQL must publish a loopback port.");
  const config = Object.fromEntries(containerEnv.map(item => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; }));
  if (!config.POSTGRES_USER || !config.POSTGRES_PASSWORD || !config.POSTGRES_DB) throw Error("Project PostgreSQL connection configuration is incomplete.");
  const storage = resolve(env.QUANTSELF_DEV_STORAGE_ROOT || resolve(root, "storage"));
  return {
    ...env,
    NODE_ENV: "development",
    QUANTSELF_ELEVENLABS_AGENT_ID: env.QUANTSELF_DEV_ELEVENLABS_AGENT_ID || env.QUANTSELF_ELEVENLABS_AGENT_ID,
    DATABASE_URL: `postgresql://${encodeURIComponent(config.POSTGRES_USER)}:${encodeURIComponent(config.POSTGRES_PASSWORD)}@127.0.0.1:${match[1]}/${encodeURIComponent(database ?? config.POSTGRES_DB)}`,
    API_HOSTNAME: "127.0.0.1", API_PORT: undefined, PORT: undefined,
    QUANTSELF_API_INTERNAL_URL: undefined, QUANTSELF_DEV_STORAGE_ROOT: storage,
    BETTER_AUTH_SECRET: env.QUANTSELF_DEV_AUTH_SECRET || "quantself-local-development-secret-only",
    BETTER_AUTH_URL: undefined, QUANTSELF_PUBLIC_ORIGIN: undefined,
    QUANTSELF_INSTANCE_NAME: "Quantself Local 2.0", QUANTSELF_OWNER_EMAIL: "local@quantself.valid",
    INVENTORY_UPLOAD_DIR: resolve(storage, "inventory-images"),
    INVENTORY_AUDIO_UPLOAD_DIR: resolve(storage, "inventory-audio"),
    INVENTORY_ASSET_UPLOAD_DIR: resolve(storage, "inventory-assets"),
    QUANTSELF_TODO_CAPTURE_ROOT: resolve(storage, "todo-captures"),
  };
}

export async function prepareNativeDev(runner: CommandRunner, env: Environment = process.env) {
  const sharedDatabase = env.QUANTSELF_SHARED_DEV_DATABASE || undefined;
  if (sharedDatabase && !/^qs_dev_[a-z0-9_]{1,56}$/.test(sharedDatabase)) {
    throw Error("QUANTSELF_SHARED_DEV_DATABASE must start with qs_dev_ and use lowercase letters, digits or underscores (63 characters maximum).");
  }
  const legacyProject = env.QUANTSELF_DEV_POSTGRES_PROJECT || "quantself-dev";
  if (legacyProject !== "quantself-dev" && legacyProject !== "quantself-main-dev") {
    throw Error("QUANTSELF_DEV_POSTGRES_PROJECT must be quantself-dev or quantself-main-dev.");
  }
  const compose = ["docker", "compose", "-p", sharedDatabase ? sharedProject : legacyProject, "-f", "compose.yaml", "-f", "compose.dev.yaml"];

  async function run(args: string[], options?: Parameters<CommandRunner["run"]>[1]) {
    const result = await runner.run(args, options);
    if (result.exitCode !== 0) throw Error(`Development setup failed: ${args.slice(0, 3).join(" ")}. ${result.stderr.trim() || "See output above. Ensure Docker Desktop is running."}`);
    return result.stdout.trim();
  }
  await run(["docker", "version"]);
  await run(["docker", "ps", "--format", "{{.Names}} {{.Ports}}"]);
  if (!sharedDatabase) {
    // Inspect before starting: --no-recreate keeps existing data and port bindings.
    const before = await run([...compose, "ps", "--all", "--quiet", "postgres"]);
    if (before.split(/\s+/).filter(Boolean).length > 1) throw Error("Multiple project PostgreSQL containers found.");
    if (!before && legacyProject === "quantself-main-dev") throw Error("The legacy quantself-main-dev PostgreSQL container could not be found.");
    await run([...compose, "up", "-d", "--wait", "--no-recreate", "postgres"], { stdio: "inherit" });
  }
  const id = await run([...compose, "ps", "--quiet", "postgres"]);
  if (sharedDatabase && !id) throw Error(`Start the prepared ${sharedProject} PostgreSQL container before using a shared checkout database.`);
  if (!id || /\s/.test(id)) throw Error("Expected one running project PostgreSQL container.");
  const binding = await run(["docker", "port", id, "5432/tcp"]);
  const containerEnv = await run(["docker", "inspect", "--format", "{{json .Config.Env}}", id]);
  const native = nativeEnvironment(env, binding, JSON.parse(containerEnv), sharedDatabase);
  if (sharedDatabase) {
    const connected = await run(["docker", "exec", id, "sh", "-ec",
      'exec psql -XqAt --no-password --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$1" --command="SELECT current_database()"',
      "sh", sharedDatabase]);
    if (connected !== sharedDatabase) throw Error("PostgreSQL did not confirm the requested checkout database.");
  }
  const options = { env: native as Record<string, string>, stdio: "inherit" as const };
  await run(["bun", "run", "db:generate"], options);
  await run(["bun", "run", "--cwd", "packages/db", "migrate:deploy-only"], options);
  await run(["bun", "run", "scripts/ensure-dev-owner.ts"], options);
  return native;
}

export function tunnelOrigin(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
}

// Classify only known diagnostics; raw tunnel output can contain credentials.
export function tunnelFailure(output: string): string {
  return /429 Too Many Requests|status_code[=:]\s*["']?429/.test(output)
    ? "Cloudflare quick tunnel rate-limited (HTTP 429). Stop repeated restarts and wait before retrying."
    : "";
}

export async function serveNativeDev(baseEnv: Environment) {
  // launchd must own the entire group so a killed supervisor cannot orphan the
  // API/web processes while losing the tunnel. Foreground mode retains groups
  // per child for its existing explicit shutdown handling.
  const detached = process.platform !== "win32" && baseEnv.QUANTSELF_DEV_MANAGED !== "1";
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  let stopped = false;
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  void failure.catch(() => {});
  const guard = <T>(promise: Promise<T>) => Promise.race([promise, failure]);
  const interrupt = () => { stopped = true; fail(Error("Development stopped.")); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const stop = (signal: NodeJS.Signals) => {
    for (const child of children) {
      if (!child.pid) continue;
      try { if (!detached) child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    }
  };
  function launch(name: string, command: string, args: string[], env: Environment, persistent = true, output?: (text: string) => void, cwd = root, failureDetail?: () => string) {
    const child = spawn(command, args, { cwd, env, stdio: output ? ["ignore", "pipe", "pipe"] as const : "inherit", detached });
    children.push(child);
    if (output) { child.stdout!.on("data", data => output(String(data))); child.stderr!.on("data", data => output(String(data))); }
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", error => { fail(Error(`${name}: ${error.message}`)); reject(error); });
      // Wait for buffered tunnel diagnostics before reporting process failure.
      child.once("close", code => {
        if (!persistent) { const index = children.indexOf(child); if (index !== -1) children.splice(index, 1); }
        if (persistent && !stopped) fail(Error(`${name} exited (${code ?? "signal"}); stopping development.${failureDetail?.() ? ` ${failureDetail()}` : ""}`));
        if (!persistent && code !== 0) reject(Error(`${name} failed. See output above.`)); else resolve();
      });
    });
    void done.catch(() => {});
    exits.push(done);
    return done;
  }
  let web: Awaited<ReturnType<typeof reservePort>> | undefined;
  let api: Awaited<ReturnType<typeof reservePort>> | undefined;
  let ownerPort: Awaited<ReturnType<typeof reservePort>> | undefined;
  let ownerIngress: ReturnType<typeof startDevOwnerIngress> | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    ownerPort = await reservePort();
    web = await reservePort(0);
    api = await reservePort(0);
    const proof = randomBytes(32).toString("hex");
    const env: Environment & { PORT: string; API_PORT: string; QUANTSELF_API_INTERNAL_URL: string } = {
      ...baseEnv,
      PORT: String(web.port),
      API_PORT: String(api.port),
      QUANTSELF_PUBLIC_ORIGIN: `http://localhost:${ownerPort.port}`,
      QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${api.port}`,
      QUANTSELF_OWNER_INGRESS_TOKEN: proof,
      QUANTSELF_JARVIS_TOOL_ORIGIN: baseEnv.QUANTSELF_JARVIS_TOOL_ORIGIN,
    };
    const jarvisEnabled = baseEnv.QUANTSELF_DEV_JARVIS !== "0";
    const webhookEnabled = baseEnv.QUANTSELF_DEV_GITHUB_WEBHOOK === "1";
    if (jarvisEnabled || webhookEnabled) {
      if (jarvisEnabled && (!env.QUANTSELF_ELEVENLABS_API_KEY || !env.QUANTSELF_ELEVENLABS_AGENT_ID)) throw Error("Set ElevenLabs credentials in .env, or QUANTSELF_DEV_JARVIS=0 to explicitly run without Jarvis.");
      const named = namedDevelopmentTunnel(env, web.port);
      if (named) {
        env.QUANTSELF_JARVIS_TOOL_ORIGIN = named.origin;
        console.log(`Starting named development tunnel for ${named.origin}…`);
        launch("Jarvis tunnel", "cloudflared", named.args, env, true, () => {});
      } else {
        let log = "";
        let found!: (origin: string) => void;
        const url = new Promise<string>(resolve => { found = resolve; });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Jarvis tunnel startup timed out; check cloudflared/network access.")), 45000); });
        console.log(`Starting Jarvis tunnel for http://localhost:${web.port}…`);
        launch("Jarvis tunnel", "cloudflared", ["tunnel", "--url", `http://127.0.0.1:${web.port}`, "--protocol", "http2", "--no-autoupdate"], env, true, text => {
          log = (log + text).slice(-16384);
          const origin = tunnelOrigin(log); if (origin) found(origin);
        }, root, () => tunnelFailure(log));
        try { env.QUANTSELF_JARVIS_TOOL_ORIGIN = await guard(Promise.race([url, timeout])); } finally { clearTimeout(timer); }
      }
    }
    await api.release(); api = undefined;
    launch("API", process.execPath, ["run", "dev:api"], env);
    await web.release(); web = undefined;
    launch("Next.js", process.execPath, ["run", "dev", "--port", env.PORT, "--hostname", "127.0.0.1"], env, true, undefined, resolve(root, "apps/web"));
    const ingressPort = ownerPort.port;
    await ownerPort.release(); ownerPort = undefined;
    ownerIngress = startDevOwnerIngress(ingressPort, Number(env.PORT), proof);
    await guard(once(ownerIngress, "listening"));
    if (jarvisEnabled || webhookEnabled) {
      await guard((async () => {
        const deadline = Date.now() + 60000;
        while (!stopped && Date.now() < deadline) {
          try { if ((await fetch(`http://127.0.0.1:${env.PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* Servers starting. */ }
          await Bun.sleep(250);
        }
        if (!stopped) throw Error("Local API did not become ready.");
      })());
      if (jarvisEnabled) {
        const configure = () => launch("Jarvis configuration", process.execPath, ["run", "scripts/dev-jarvis.ts"], env, false);
        await guard(configure());
        // Keep the same short-lived task-only permission scope; renew before expiry.
        renewal = setInterval(() => { void configure().catch(error => fail(error)); }, 12 * 60 * 60 * 1000);
      }
      if (webhookEnabled) await guard(launch("GitHub webhook configuration", process.execPath, ["run", "scripts/dev-webhook.ts"], env, false));
    }
    console.log(`Ready: ${env.QUANTSELF_PUBLIC_ORIGIN} · API ${env.QUANTSELF_API_INTERNAL_URL}${env.QUANTSELF_JARVIS_TOOL_ORIGIN && baseEnv.QUANTSELF_DEV_JARVIS !== "0" ? ` · Jarvis ${env.QUANTSELF_JARVIS_TOOL_ORIGIN}` : ""}`);
    console.log("Ctrl-C stops Next.js, API and tunnel; PostgreSQL stays running.");
    await failure;
  } catch (error) { if (!stopped) throw error; }
  finally {
    stopped = true;
    clearInterval(renewal);
    await web?.release(); await api?.release(); await ownerPort?.release();
    ownerIngress?.close();
    ownerIngress?.closeAllConnections();
    stop("SIGTERM");
    const force = setTimeout(() => stop("SIGKILL"), 3000);
    await Promise.allSettled(exits);
    clearTimeout(force);
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}

/** OS-owned lock: atomic acquisition and automatic release even after a crash. */
export async function acquireDevSupervisor(port = 47329): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer(socket => socket.destroy());
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", error => reject(Error(`Development supervisor already running or lock port unavailable (127.0.0.1:${port}): ${error.message}`)));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(Error("Development supervisor did not bind a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    port: boundPort,
    release: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function retrySleep(delay: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** One owner retries only after the previous attempt has fully shut down. */
export async function superviseDev(attempt: () => Promise<void>, signal: AbortSignal,
  sleep = retrySleep, report: (message: string) => void = console.error) {
  for (let index = 0; index < 5 && !signal.aborted; index++) {
    try { await attempt(); return; }
    catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : "Development startup failed.";
      report(message);
      if (index === 4) throw Error("Development startup circuit open after five failures. Fix the cause, then run bun run dev:service start. See dev service log.");
      const delay = /HTTP 429/.test(message) ? 300000 : Math.min(30000 * 2 ** index, 300000);
      report(`Development retry ${index + 2}/5 in ${delay / 1000}s; stop the service to cancel.`);
      await sleep(delay, signal);
    }
  }
}

if (import.meta.main) {
  process.chdir(root);
  const runner = createBunCommandRunner();
  const controller = new AbortController();
  const interruptSetup = () => { controller.abort(); runner.interrupt(); };
  process.on("SIGINT", interruptSetup); process.on("SIGTERM", interruptSetup);
  let release: (() => Promise<void>) | undefined;
  try {
    ({ release } = await acquireDevSupervisor());
    const attempt = async () => {
      const env = await prepareNativeDev(runner);
      if (!controller.signal.aborted) {
        for (const key of ["INVENTORY_UPLOAD_DIR", "INVENTORY_AUDIO_UPLOAD_DIR", "INVENTORY_ASSET_UPLOAD_DIR", "QUANTSELF_TODO_CAPTURE_ROOT"]) mkdirSync(env[key]!, { recursive: true });
        await serveNativeDev(env);
      }
    };
    if (process.env.QUANTSELF_DEV_MANAGED === "1") await superviseDev(attempt, controller.signal);
    else await attempt();
  } catch (error) {
    if (!controller.signal.aborted) { console.error(error instanceof Error ? error.message : "Development startup failed."); process.exitCode = 1; }
  } finally {
    await release?.();
    process.off("SIGINT", interruptSetup); process.off("SIGTERM", interruptSetup);
  }
}
