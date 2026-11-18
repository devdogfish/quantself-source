import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { habitAskAgentPatch } from "../src/habits-ask-config";
const key = process.env.QUANTSELF_ELEVENLABS_API_KEY, id = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
if (!key || !id || !/^[\w-]+$/.test(id)) throw Error("Jarvis configuration unavailable.");
const request = async (body?: unknown) => {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${id}`, { method: body ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "xi-api-key": key, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw Error(`Jarvis configuration request failed: HTTP ${r.status}`);
  return r.json();
};
const before = await request(), patch = habitAskAgentPatch(before);
if (!process.argv.includes("--apply")) {
  console.log("Dry run: allow text-only, empty first-message and strict tool/MCP subset overrides. Default Jarvis prompt/model/tools unchanged. Add --apply to sync.");
} else {
  const backup = join(tmpdir(), `quantself-habit-ask-agent-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(before, null, 2), { mode: 0o600 });
  const fresh = await request();
  if (!isDeepStrictEqual(fresh.platform_settings, before.platform_settings) || !isDeepStrictEqual(fresh.conversation_config, before.conversation_config)) throw Error("Jarvis changed since preflight. Rerun.");
  await request(patch);
  const after = await request();
  if (!isDeepStrictEqual(after.platform_settings, patch.platform_settings) || !isDeepStrictEqual(after.conversation_config, before.conversation_config)) throw Error(`Configuration verification failed; inspect backup ${backup}`);
  console.log(`Verified Habit Ask conversation restrictions. Default Jarvis unchanged. Backup: ${backup}`);
}
