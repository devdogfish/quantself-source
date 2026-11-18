import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { phoneJarvisReliabilityPatch, phoneJarvisTaskToolNames } from "../src/phone-jarvis-config";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_PHONE_AGENT_ID?.trim();
if (!key || !agentId || !/^[\w-]+$/.test(agentId) || agentId === process.env.QUANTSELF_ELEVENLABS_AGENT_ID) throw Error("Separate phone agent configuration required.");
async function request(path: string, body?: unknown) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, {
    method: body ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": key!, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`Phone configuration failed: HTTP ${response.status}`);
  return response.json();
}
const path = `agents/${agentId}`;
const agent = await request(path);
const patch = phoneJarvisReliabilityPatch(agent);
const ids: string[] = agent.conversation_config.agent.prompt.tool_ids ?? [];
const tools = await Promise.all(ids.map(async id => ({ id, value: await request(`tools/${id}`) })));
const taskNames = new Set<string>([...phoneJarvisTaskToolNames, "read_task_categories", "change_task_category"]);
if (tools.length !== 6 || tools.some(t => t.value.tool_config.type !== "webhook" || !taskNames.delete(t.value.tool_config.name)) || taskNames.size) throw Error("Expected six existing phone task tools.");
console.log("Existing phone agent: result-led replies, bounded retries, no silence hangup; retain tool IDs, credentials, voice and privacy.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to update existing resources.");
else {
  const backup = join(tmpdir(), `quantself-phone-reliability-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify({ agent, tools }), { mode: 0o600 });
  if (!isDeepStrictEqual(await request(path), agent)) throw Error("Phone agent changed; rerun.");
  const writes = new Set(["apply_task_command", "edit_task_command", "change_task_category"]);
  for (const tool of tools) {
    const toolPath = `tools/${tool.id}`;
    if (!isDeepStrictEqual(await request(toolPath), tool.value)) throw Error("Phone tool changed; rerun.");
    const expected = { ...tool.value.tool_config, tool_error_handling_mode: "passthrough", ...(writes.has(tool.value.tool_config.name) ? { interruption_mode: "disable_during_tool", disable_interruptions: true } : {}) };
    await request(toolPath, { tool_config: expected });
    if (!isDeepStrictEqual((await request(toolPath)).tool_config, expected)) throw Error(`Phone tool readback failed. Backup: ${backup}`);
  }
  await request(path, patch);
  const expected = structuredClone(agent);
  expected.conversation_config.agent.prompt.prompt = patch.conversation_config.agent.prompt.prompt;
  expected.conversation_config.turn.silence_end_call_timeout = -1;
  expected.conversation_config.turn.transcribe_on_disabled_interruptions = true;
  // Provider also materializes referenced webhook definitions in prompt.tools.
  for (const tool of expected.conversation_config.agent.prompt.tools ?? []) {
    if (tools.some(existing => existing.value.tool_config.name === tool.name)) {
      tool.tool_error_handling_mode = "passthrough";
      if (writes.has(tool.name)) { tool.interruption_mode = "disable_during_tool"; tool.disable_interruptions = true; }
    }
  }
  const saved = await request(path);
  if (!isDeepStrictEqual(saved.conversation_config, expected.conversation_config) || !isDeepStrictEqual(saved.platform_settings, agent.platform_settings)) throw Error(`Phone agent readback failed. Backup: ${backup}`);
  console.log(`Updated and verified existing phone agent and six tools. Private backup: ${backup}`);
}
