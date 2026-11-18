import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareJarvisTaskTimingConfiguration, type JarvisTaskTool } from "../src/todos-jarvis-task-config";

import { assertUnchangedJarvisPrompt, assertUnchangedJarvisTool, assertVerifiedJarvisPrompt, jarvisPromptPatch } from "./jarvis-task-sync-guards";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
if (!key || !agentId || !/^[\w-]+$/.test(agentId)) throw Error("Jarvis configuration unavailable.");
const base = "https://api.elevenlabs.io/v1/convai/";
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": key!, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`Jarvis configuration request failed: HTTP ${response.status}`);
  return response.json();
}
const agent = await request(`agents/${agentId}`);
const tools: JarvisTaskTool[] = await Promise.all((agent.conversation_config.agent.prompt.tool_ids ?? []).map(async (id: string) => ({ ...await request(`tools/${id}`), id })));
const { nextPrompt, updatedTools, expectedAgent } = prepareJarvisTaskTimingConfiguration(agent, tools);
console.log("Existing task tools: infer capture titles, preserve original wording, and seed missing timing bounds by 30 minutes. No UI or new tools.");
if (!process.argv.includes("--apply")) {
  console.log("Dry run. Add --apply to update the existing task tools and agent.");
} else {
  const backup = join(tmpdir(), `quantself-jarvis-task-timing-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify({ agent, tools }, null, 2), { mode: 0o600 });
  // Refuse to overwrite concurrent provider configuration changes made after preparation.
  const latest = await request(`agents/${agentId}`);
  try { assertUnchangedJarvisPrompt(agent, latest); } catch { throw Error(`Jarvis changed during preparation. Rerun. Backup: ${backup}`); }
  for (const tool of updatedTools) {
    const current = await request(`tools/${tool.id}`);
    try { assertUnchangedJarvisTool(tools.find(original => original.id === tool.id)!.tool_config, current.tool_config); } catch { throw Error(`Task tool changed during preparation. Rerun. Backup: ${backup}`); }
  }
  for (const tool of updatedTools) await request(`tools/${tool.id}`, { tool_config: tool.toolConfig });
  await request(`agents/${agentId}`, jarvisPromptPatch(nextPrompt));
  const verifiedAgent = await request(`agents/${agentId}`);
  for (const tool of updatedTools) {
    const verified = await request(`tools/${tool.id}`);
    if (!isDeepStrictEqual(verified.tool_config, tool.toolConfig)) throw Error(`Tool verification failed. Backup: ${backup}`);
  }
  try { assertVerifiedJarvisPrompt(expectedAgent, verifiedAgent); } catch { throw Error(`Agent verification failed. Backup: ${backup}`); }
  console.log(`Updated and verified capture/timing contract; unrelated provider settings excluded from PATCH. Backup: ${backup}`);
}
