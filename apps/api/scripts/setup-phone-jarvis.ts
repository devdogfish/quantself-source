import { createHash } from "node:crypto";
import { phoneJarvisCategoryTools } from "../src/phone-jarvis-task-tools";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { phoneJarvisTaskToolNames, phoneJarvisToolConfig, phoneJarvisAgentConfig, phoneJarvisResourceId, phoneJarvisSetupTarget } from "../src/phone-jarvis-config";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const sourceId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
let targetId = process.env.QUANTSELF_ELEVENLABS_PHONE_AGENT_ID?.trim() || undefined;
if (!key || !sourceId || !/^[\w-]+$/.test(sourceId) || (targetId && !/^[\w-]+$/.test(targetId))) throw Error("Jarvis configuration unavailable.");
if (sourceId === targetId) throw Error("Phone agent must be separate from browser Jarvis.");
async function request(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": key!, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`Phone Jarvis configuration failed: HTTP ${response.status}`);
  return response.json();
}
const source = await request(`agents/${sourceId}`);
const privacy = source.platform_settings?.privacy;
if (!source.platform_settings?.auth?.enable_auth || !privacy?.record_voice || privacy.retention_days !== -1 || privacy.delete_audio || privacy.delete_transcript_and_pii || privacy.zero_retention_mode) throw Error("Private retained source Jarvis required.");
const tools = await Promise.all((source.conversation_config.agent.prompt.tool_ids ?? []).map(async (id: string) => ({ id, ...await request(`tools/${id}`) })));
const chosen = phoneJarvisTaskToolNames.map(name => {
  const matches = tools.filter(tool => tool.tool_config?.name === name && tool.tool_config.type === "webhook");
  if (matches.length !== 1) throw Error(`Expected one task webhook: ${name}`);
  return matches[0];
});
const publicOrigin = process.env.QUANTSELF_PHONE_PUBLIC_URL;
const phoneApiKey = process.env.QUANTSELF_PHONE_API_KEY;
if (!publicOrigin || !phoneApiKey) throw Error("Phone production origin and scoped API key required.");
const receiptDirectory = process.env.QUANTSELF_PHONE_SETUP_RECEIPT_ROOT ?? join(homedir(), ".codex", "phone-jarvis-setup");
const receiptPath = join(receiptDirectory, createHash("sha256").update(`${sourceId}:${publicOrigin}`).digest("hex") + ".json");
const receipt = await readFile(receiptPath, "utf8").then(text => JSON.parse(text) as { phase: string; agentId?: string }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
targetId = phoneJarvisSetupTarget(receipt, targetId);
async function saveReceipt(value: { phase: string; agentId?: string }) {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, JSON.stringify(value), { mode: 0o600 });
}
// Validate all source endpoints before any provider mutation.
const preparedTools = [...chosen.map(tool => phoneJarvisToolConfig(tool.tool_config, publicOrigin, "pending-phone-secret")), ...phoneJarvisCategoryTools(publicOrigin, "pending-phone-secret")];
const body = phoneJarvisAgentConfig(source, []);
const conversation = body.conversation_config;
console.log("Phone agent: same voice, private access, indefinite recordings, six cloned production task/category webhooks, no browser tools. Requires phone_context on every call.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to create/update the separate phone agent.");
else {
  const backup = join(tmpdir(), `quantself-phone-jarvis-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify({ source, target: targetId ? await request(`agents/${targetId}`) : null }), { mode: 0o600 });
  const latest = await request(`agents/${sourceId}`);
  if (!isDeepStrictEqual(latest.conversation_config, source.conversation_config)) throw Error("Source Jarvis changed. Rerun setup.");
  const secret = await request("secrets", "POST", { type: "new", name: `Quantself phone tasks ${Date.now()}`, value: phoneApiKey });
  const secretId = phoneJarvisResourceId(secret);
  const createdTools: string[] = [];
  for (const prepared of preparedTools) {
    prepared.api_schema.request_headers = { "X-API-Key": { secret_id: secretId } };
    const created = await request("tools", "POST", { tool_config: prepared });
    const toolId = phoneJarvisResourceId(created);
    const verified = await request(`tools/${toolId}`);
    if (!isDeepStrictEqual(verified.tool_config.api_schema.request_headers, prepared.api_schema.request_headers) || verified.tool_config.api_schema.url !== prepared.api_schema.url || verified.tool_config.type !== "webhook") throw Error("Phone tool readback verification failed.");
    createdTools.push(toolId);
  }
  conversation.agent.prompt.tool_ids = createdTools;
  if (!targetId) await saveReceipt({ phase: "creating-agent" });
  const result = await request(targetId ? `agents/${targetId}` : "agents/create", targetId ? "PATCH" : "POST", body);
  const id = targetId ?? phoneJarvisResourceId(result);
  await saveReceipt({ phase: "created", agentId: id });
  const saved = await request(`agents/${id}`);
  if (!isDeepStrictEqual(saved.conversation_config.tts, conversation.tts) || saved.conversation_config.agent.prompt.prompt !== conversation.agent.prompt.prompt || !isDeepStrictEqual(saved.conversation_config.agent.prompt.tool_ids, conversation.agent.prompt.tool_ids) || saved.conversation_config.asr.user_input_audio_format !== "ulaw_8000" || saved.platform_settings.auth.enable_auth !== true || saved.platform_settings.privacy.retention_days !== -1 || saved.platform_settings.privacy.record_voice !== true) throw Error(`Phone agent verification failed. Backup: ${backup}`);
  await saveReceipt({ phase: "verified", agentId: id });
  console.log(`QUANTSELF_ELEVENLABS_PHONE_AGENT_ID=${id}`);
  console.log(`Verified phone Jarvis. Private backup: ${backup}`);
}
