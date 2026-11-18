import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jarvisCrudInstructions, jarvisTrashCommandDescription } from "../src/todos-jarvis-crud-contract";
import { jarvisEditCommandDescription } from "../src/todos-jarvis-tool-contract";

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
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const detail = Array.isArray(error?.detail) ? error.detail.map((issue: any) => ({ path: issue.loc, message: issue.msg })) : undefined;
    throw Error(`Jarvis configuration failed: HTTP ${response.status}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  }
  return response.json();
}
const begin = "[Quantself task CRUD]", end = "[/Quantself task CRUD]";
function replaceBlock(text: string, content: string) {
  const start = text.indexOf(begin), stop = text.indexOf(end, start);
  if (start >= 0 && stop < start) throw Error("Incomplete CRUD contract block.");
  const preserved = start < 0 ? text : text.slice(0, start) + text.slice(stop + end.length);
  return `${preserved.trim()}\n\n${begin}\n${content}\n${end}`;
}
const agent = await request(`agents/${agentId}`);
const tools = await Promise.all((agent.conversation_config.agent.prompt.tool_ids ?? []).map(async (id: string) => ({ id, ...await request(`tools/${id}`) })));
function tool(name: string) {
  const found = tools.filter(item => item.tool_config.name === name);
  if (found.length !== 1 || found[0].tool_config.type !== "webhook") throw Error(`Expected one existing ${name} webhook.`);
  return found[0];
}
const read = tool("read_tasks"), edit = tool("edit_task_command");
const readConfig = structuredClone(read.tool_config), editConfig = structuredClone(edit.tool_config);
if (readConfig.api_schema.method !== "GET" || new URL(readConfig.api_schema.url).pathname !== "/api/v1/todos" ||
    editConfig.api_schema.method !== "POST" || editConfig.api_schema.request_body_schema?.properties?.command?.type !== "string") throw Error("Unexpected task tool contract.");
const query = readConfig.api_schema.query_params_schema ?? { properties: {}, required: [] };
readConfig.api_schema.query_params_schema = { ...query, properties: { ...query.properties, trash: {
  type: "string", enum: ["exclude", "include", "only"], description: "exclude (default): normal tasks; only: recoverable trash; include: both normal and trashed tasks. Use only/include to find tasks for restoration.",
} } };
editConfig.api_schema.request_body_schema.properties.command.description = jarvisEditCommandDescription;
editConfig.description = "Update an existing task only on explicit Owner request or accepted suggestion. Supports task facts, lifecycle, recoverable trash and restoration. Read current facts first, preserve unrelated data and inspect every outcome. No permanent deletion or execution approval.";
console.log("Existing tools: expose trash lookup and recoverable trash/restore. No additional tools or credentials.");
if (!process.argv.includes("--apply")) console.log("Dry run. Add --apply to update ElevenLabs.");
else {
  const backup = join(tmpdir(), `quantself-jarvis-crud-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify({ agent, read, edit }), { mode: 0o600 });
  await request(`tools/${read.id}`, { tool_config: readConfig });
  await request(`tools/${edit.id}`, { tool_config: editConfig });
  // Read again before changing the prompt, preserving other configuration work.
  const latest = await request(`agents/${agentId}`);
  const prompt = replaceBlock(latest.conversation_config.agent.prompt.prompt, jarvisCrudInstructions);
  await request(`agents/${agentId}`, { conversation_config: { agent: { prompt: { prompt } } } });
  const verified = await request(`agents/${agentId}`);
  const savedRead = await request(`tools/${read.id}`), savedEdit = await request(`tools/${edit.id}`);
  if (verified.conversation_config.agent.prompt.prompt !== prompt ||
      JSON.stringify(verified.conversation_config.agent.prompt.tool_ids) !== JSON.stringify(latest.conversation_config.agent.prompt.tool_ids) ||
      JSON.stringify(verified.conversation_config.tts) !== JSON.stringify(latest.conversation_config.tts) ||
      JSON.stringify(verified.platform_settings) !== JSON.stringify(latest.platform_settings) ||
      !savedRead.tool_config.api_schema.query_params_schema.properties.trash.enum.includes("only") ||
      !savedEdit.tool_config.api_schema.request_body_schema.properties.command.description.includes(jarvisTrashCommandDescription)) throw Error(`Configuration verification failed. Backup: ${backup}`);
  console.log(`CRUD tools and agent verified. Backup: ${backup}`);
}
