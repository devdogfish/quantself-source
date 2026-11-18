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
const config = agent.conversation_config;
const prompt = config.agent.prompt;
const marker = "Quantself silent-listening contract";
const instructions = `Greet the Owner once with the configured first message when the conversation starts, then remain available silently until addressed. Never prompt because of silence or inactivity. Never ask whether the Owner is still there, needs anything, or wants more help unless their actual spoken request requires clarification. On silence or a request to wait, call skip_turn without any spoken preamble. After answering or finishing requested work, wait silently. UI context updates are background information, not requests to speak or act. The session automatically ends after two minutes without Owner speech to prevent idle charges. Do not keep an idle session alive. Use end_call when the Owner explicitly asks to stop/end Jarvis. Do not repeat the startup greeting or offer unsolicited reminders.`;
const preserved = (prompt.prompt as string).replace(/\[Quantself silent-listening contract\][\s\S]*?\[\/Quantself silent-listening contract\]/g, "").trim();
const nextPrompt = `${preserved}\n\n[${marker}]\n${instructions}\n[/${marker}]`;
const skipTurn = { type: "system", name: "skip_turn", description: "Wait silently whenever the Owner has not asked anything new, including silence timeouts and requests to pause. Never announce this tool.", params: { system_tool_type: "skip_turn" } };
const patch = { conversation_config: {
  agent: { first_message: "{{startup_greeting}}", dynamic_variables: { ...config.agent.dynamic_variables, dynamic_variable_placeholders: { ...config.agent.dynamic_variables?.dynamic_variable_placeholders, startup_greeting: "At your service, sir." } }, prompt: { prompt: nextPrompt, built_in_tools: { ...prompt.built_in_tools, skip_turn: skipTurn } } },
  turn: { turn_timeout: 30, silence_end_call_timeout: 120, soft_timeout_config: { ...config.turn.soft_timeout_config, timeout_seconds: -1 } },
  conversation: { max_duration_seconds: 7200 },
} };
console.log("One startup greeting; silent waiting; two-minute idle hangup; two-hour maximum. Voice, task tools and privacy retained.");
if (!process.argv.includes("--apply")) {
  console.log("Dry run. Add --apply to update the existing agent.");
} else {
  const backup = join(tmpdir(), `quantself-jarvis-silent-listening-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(agent, null, 2), { mode: 0o600 });
  const current = await request();
  if (!isDeepStrictEqual(current.conversation_config, config) || !isDeepStrictEqual(current.platform_settings, agent.platform_settings)) throw Error("Agent changed during preparation. Rerun to preserve concurrent edits.");
  await request(patch);
  const verified = await request();
  const v = verified.conversation_config;
  if (v.agent.first_message !== "{{startup_greeting}}" || v.agent.dynamic_variables?.dynamic_variable_placeholders?.startup_greeting !== "At your service, sir." || v.agent.prompt.prompt !== nextPrompt || v.agent.prompt.built_in_tools.skip_turn?.params?.system_tool_type !== "skip_turn" || v.turn.turn_timeout !== 30 || v.turn.silence_end_call_timeout !== 120 || v.turn.soft_timeout_config.timeout_seconds !== -1 || v.conversation.max_duration_seconds !== 7200 || !isDeepStrictEqual(v.agent.prompt.tool_ids, prompt.tool_ids) || !isDeepStrictEqual((v.agent.prompt.tools ?? []).filter((tool: { name: string }) => tool.name !== "skip_turn"), (prompt.tools ?? []).filter((tool: { name: string }) => tool.name !== "skip_turn")) || !isDeepStrictEqual(v.tts, config.tts) || !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)) throw Error(`Agent verification failed. Backup: ${backup}`);
  console.log(`Updated and verified Jarvis. Private backup: ${backup}`);
}
