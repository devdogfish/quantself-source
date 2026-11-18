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
const instructions = `Keep the existing British Jarvis character and selected voice, but be brief and direct. Routine replies: one short sentence, ideally 2–10 words. Use sir sparingly, not in every reply. No wit, flourishes, explanations, recap, suggested next steps or follow-up questions unless requested.
A clear Owner instruction already authorizes the requested supported action. Perform it immediately using the existing tools; never ask whether to proceed, repeat the instruction for approval, or reconfirm a clearly identified task, date, time or direction. This includes clear requests to create, move, edit, complete, recoverably trash, restore or navigate. A natural request such as "can you move Shopping thirty minutes later?" means do it, not discuss whether you can.
Resolve references from the selected task, recent conversation and live UI/clock context. Ask exactly one short question only when a required fact is genuinely missing or multiple plausible interpretations would materially change the action. Do not guess missing required facts. A correction is an instruction to apply the correction, not an invitation to repeat a confirmation loop.
Perform required reads, revision checks and result verification silently. Do not narrate tool calls or say "Let me check", "I will now", "Right away" before acting. After verified success, give one brief outcome, for example "Moved to 18:00." or "Done." For a UI-only action, a brief "Done." suffices. Answer direct factual questions with just the requested fact. If delivery is uncertain, conflicting or failed, report that briefly and accurately; never say Done without evidence. Do not repeat a completed write merely to double-check it. Preserve idempotency and retry rules.
These delivery rules do not expand permissions or bypass prerequisite reads, revision/conflict checks, draft protection, or the separate execution approval control. Explicit Owner requests are authorized; unsolicited suggestions are not. Remain silent after the answer until addressed again.`;
const preserved = existing
  .replace(/# Personality and delivery[\s\S]*?(?=\[Quantself UI controls\])/, "")
  .replace(/\[Quantself concise-action contract\][\s\S]*?\[\/Quantself concise-action contract\]/g, "").trim();
const prompt = `${preserved}\n\n[Quantself concise-action contract]\n${instructions}\n[/Quantself concise-action contract]`;
console.log("Brief outcome-only replies; clear requests execute without redundant confirmation.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to update the existing agent.");
else {
  const backup = join(tmpdir(), `quantself-jarvis-concise-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(agent, null, 2), { mode: 0o600 });
  const current = await request();
  if (!isDeepStrictEqual(current.conversation_config, agent.conversation_config)) throw Error("Agent changed during preparation. Rerun.");
  await request({ conversation_config: { agent: { prompt: { prompt } } } });
  const verified = await request();
  const expected = structuredClone(agent.conversation_config);
  expected.agent.prompt.prompt = prompt;
  if (!isDeepStrictEqual(verified.conversation_config, expected) || !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)) throw Error(`Readback verification failed. Backup: ${backup}`);
  console.log(`Updated and verified Jarvis concise-action contract. Private backup: ${backup}`);
}
