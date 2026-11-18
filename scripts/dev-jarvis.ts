import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { developmentOrigin, isDevelopmentOrigin } from "./dev-tunnel";

export function callbackTools(tools: { id: string; tool_config: any }[], origin: string, secretId: string, configuredOrigin?: string) {
  const target = developmentOrigin(origin);
  if (!isDevelopmentOrigin(origin, configuredOrigin)) throw Error("Expected an explicitly configured HTTPS development tunnel.");
  const allowed = new Set(["/api/v1/todos", "/api/v1/todos/{number}", "/api/v1/access-context", "/api/v1/todo-jarvis/{id}/commands"]);
  return tools.filter(tool => tool.tool_config.type === "webhook").map(tool => {
    const config = structuredClone(tool.tool_config);
    const url = new URL(config.api_schema.url);
    // Validate every source before configureDevJarvis creates credentials or patches tools.
    // Provider tools can be shared across agents, so an agent ID alone is not isolation.
    if (url.username || url.password || !isDevelopmentOrigin(url.origin, configuredOrigin)) throw Error("Refusing to overwrite production Jarvis callbacks. Use a dedicated development agent with cloned tools targeting a development tunnel.");
    const path = decodeURI(url.pathname);
    if (!allowed.has(path) || url.search || url.hash || !config.api_schema.request_headers?.["X-API-Key"]?.secret_id) throw Error("Unexpected Jarvis callback configuration; refusing to overwrite it.");
    config.api_schema.url = target.origin + path;
    config.api_schema.request_headers["X-API-Key"] = { secret_id: secretId };
    return { id: tool.id, tool_config: config };
  });
}

export async function verifyTunnel(origin: string, secret: string, request: typeof fetch = fetch, sleep: (ms: number) => Promise<unknown> = Bun.sleep) {
    const deadline = Date.now() + 180000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await request(`${origin}/api/v1/access-context`, { headers: { "X-API-Key": secret }, signal: AbortSignal.timeout(5000) });
        if (response.ok) { ready = true; break; }
        if (response.status === 401 || response.status === 403) throw Error(`Jarvis tunnel authentication failed: HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Jarvis tunnel authentication")) throw error;
      }
      await sleep(1000);
    }
    if (!ready) throw Error("Jarvis tunnel did not become reachable within 180 seconds. Check network access and rerun dev.");
}

export async function configureDevJarvis() {
  const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
  const agentId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
  const origin = process.env.QUANTSELF_JARVIS_TOOL_ORIGIN;
  if (!key || !agentId || !origin) throw Error("Jarvis needs QUANTSELF_ELEVENLABS_API_KEY and QUANTSELF_ELEVENLABS_AGENT_ID in .env.");
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, { method, headers: { "xi-api-key": key!, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`Jarvis configuration failed: ${method} ${path.split("/")[0]} HTTP ${response.status}`);
    return response.json() as Promise<any>;
  }
  const agent = await request(`agents/${encodeURIComponent(agentId)}`);
  const ids: string[] = agent.conversation_config.agent.prompt.tool_ids ?? [];
  const tools: { id: string; tool_config: any }[] = [];
  // Small bounded batches; do not fan out with task/record count.
  for (let i = 0; i < ids.length; i += 4) tools.push(...await Promise.all(ids.slice(i, i + 4).map(async id => ({ id, ...await request(`tools/${encodeURIComponent(id)}`) }))));
  const candidates = callbackTools(tools, origin, "validation-only", process.env.QUANTSELF_DEV_TUNNEL_ORIGIN);
  if (!candidates.length) throw Error("No Jarvis task callbacks configured.");
  const directory = process.env.QUANTSELF_DEV_STORAGE_ROOT!;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, ".jarvis-dev-credential.json");
  type Credential = { secret: string; secretId?: string; expiresAt: number; keyId: string };
  let credential: Credential | undefined;
  try { credential = JSON.parse(await readFile(file, "utf8")); } catch { /* First run. */ }
  const { prisma } = await import("../packages/db/index");
  try {
    let valid = false;
    if (credential && credential.expiresAt > Date.now() + 13 * 3600000) {
      const response = await fetch(`${process.env.QUANTSELF_API_INTERNAL_URL}/api/v1/access-context`, { headers: { "X-API-Key": credential.secret }, signal: AbortSignal.timeout(10000) });
      if (response.status !== 200 && response.status !== 401 && response.status !== 403) throw Error(`Local credential verification unavailable: HTTP ${response.status}`);
      valid = response.ok;
    }
    if (!valid) {
      const { createApiKey } = await import("../packages/auth/src/api-keys");
      const owner = await prisma.authOwner.findFirst();
      if (!owner) throw Error("Start bun run dev with the local Owner database before configuring Jarvis.");
      const expiresAt = Date.now() + 86400000;
      const created = await createApiKey({ name: "Jarvis native development", preset: "custom", permissionIds: ["todos:read", "todos:write"], userId: owner.userId, expiresAt: new Date(expiresAt) });
      credential = { secret: created.secret, keyId: created.credential.id, expiresAt };
      await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
    }
    if (!credential!.secretId) {
      const secret = await request("secrets", "POST", { type: "new", name: `quantself-native-${credential!.keyId}`, value: credential!.secret });
      credential!.secretId = secret.id ?? secret.secret_id;
      if (!credential!.secretId) throw Error("Provider did not return a secret reference.");
      await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
    }
    // DNS propagation can lag tunnel creation. Keep existing callbacks until this
    // origin proves it can reach the API with the same task-only credential.
    await verifyTunnel(origin, credential!.secret);
    const updates = callbackTools(tools, origin, credential!.secretId!, process.env.QUANTSELF_DEV_TUNNEL_ORIGIN);
    await writeFile(join(directory, ".jarvis-dev-callback-backup.json"), JSON.stringify(tools), { mode: 0o600 });
    const changed: string[] = [];
    try {
      for (const tool of updates) {
        await request(`tools/${tool.id}`, "PATCH", { tool_config: tool.tool_config });
        changed.push(tool.id);
      }
      for (const tool of updates) {
        const actual = await request(`tools/${tool.id}`);
        if (actual.tool_config.api_schema.url !== tool.tool_config.api_schema.url || actual.tool_config.api_schema.request_headers["X-API-Key"].secret_id !== credential!.secretId) throw Error("Jarvis callback verification failed.");
      }
    } catch (error) {
      for (const id of changed) await request(`tools/${id}`, "PATCH", { tool_config: tools.find(tool => tool.id === id)!.tool_config }).catch(() => console.error("Callback rollback incomplete; rerun dev to reconcile."));
      throw error;
    }
    console.log("Jarvis callbacks and task-only credential verified.");
  } finally { await prisma.$disconnect(); }
}

if (import.meta.main) {
  try { await configureDevJarvis(); } catch (error) { console.error(error instanceof Error ? error.message : "Jarvis configuration failed."); process.exitCode = 1; }
}
