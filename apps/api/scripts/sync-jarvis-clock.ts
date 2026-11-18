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
const instructions = `Resolve now, today, tomorrow, yesterday and relative dates using clock.today, clock.localTime and clock.timeZone in the newest Quantself UI context. clock.utcOffset is the current offset; use America/Halifax timezone rules for other dates. The screen's date field is the viewed calendar date, NOT today's date. Never infer today from a task timestamp, a UTC date, a prompt example, a provider/server clock or the model's assumed date. UTC can already be the next day while Halifax is still the previous evening. Only call an event today when its local calendar date equals clock.today. If they differ, state the actual date or tomorrow/yesterday as appropriate. Do not silently move a task to today to make your wording true. If clock data is missing, ask for the local date before a date-dependent write rather than guessing. Background clock updates are data only: do not speak or perform actions because of an update.`;
const prompt = `${existing.replace(/\[Quantself local-clock contract\][\s\S]*?\[\/Quantself local-clock contract\]/g, "").trim()}\n\n[Quantself local-clock contract]\n${instructions}\n[/Quantself local-clock contract]`;
console.log("Use the live Halifax clock for today; keep the viewed date separate.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to update the existing agent.");
else {
  const backup = join(tmpdir(), `quantself-jarvis-clock-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(agent, null, 2), { mode: 0o600 });
  const current = await request();
  if (!isDeepStrictEqual(current.conversation_config, agent.conversation_config)) throw Error("Agent changed during preparation. Rerun.");
  await request({ conversation_config: { agent: { prompt: { prompt } } } });
  const verified = await request();
  const expected = structuredClone(agent.conversation_config);
  expected.agent.prompt.prompt = prompt;
  if (!isDeepStrictEqual(verified.conversation_config, expected) || !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)) throw Error(`Readback verification failed. Backup: ${backup}`);
  console.log(`Updated and verified Jarvis local clock contract. Private backup: ${backup}`);
}
