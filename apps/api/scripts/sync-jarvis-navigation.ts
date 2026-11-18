import { jarvisNavigationInstructions } from "../src/todos-jarvis-navigation-contract";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
if (!key || !agentId || !/^[\w-]+$/.test(agentId)) throw Error("Jarvis configuration unavailable.");
async function request(body?: unknown) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: body ? "PATCH" : "GET",
    headers: { "xi-api-key": key!, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`Jarvis configuration request failed: HTTP ${response.status}`);
  return response.json();
}
const agent = await request();
if (!agent.platform_settings.auth.enable_auth) throw Error("Private Jarvis required.");
const existing = agent.conversation_config.agent.prompt.prompt as string;
if (!existing.includes("{{ui_context}}")) throw Error("Initial UI context binding required.");
const instructions = jarvisNavigationInstructions;
const prompt = `${existing.replace(/\[Quantself navigation contract\][\s\S]*?\[\/Quantself navigation contract\]/g, "").trim()}\n\n[Quantself navigation contract]\n${instructions}\n[/Quantself navigation contract]`;
console.log("Honor explicit navigation units independently of the visible view; correct mistaken navigation.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to update the existing agent.");
else {
  const backup = join(tmpdir(), `quantself-jarvis-navigation-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(agent, null, 2), { mode: 0o600 });
  const current = await request();
  if (!isDeepStrictEqual(current.conversation_config, agent.conversation_config)) throw Error("Agent changed during preparation. Rerun.");
  await request({ conversation_config: { agent: { prompt: { prompt } } } });
  const verified = await request();
  const expected = structuredClone(agent.conversation_config);
  expected.agent.prompt.prompt = prompt;
  if (!isDeepStrictEqual(verified.conversation_config, expected) || !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)) throw Error(`Readback verification failed. Backup: ${backup}`);
  console.log(`Updated and verified Jarvis navigation contract. Private backup: ${backup}`);
}
