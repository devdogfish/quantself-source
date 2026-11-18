import { isDeepStrictEqual } from "node:util";
import { prepareJarvisPlanningConfiguration } from "./todos-jarvis-planning-config";
import type { JarvisTaskTool } from "./todos-jarvis-task-config";

type RecordValue = Record<string, any>;
export interface JarvisConfigurationTransport {
  request(path: string, method?: "GET" | "POST" | "PATCH", body?: unknown): Promise<RecordValue>;
  backup(snapshot: unknown): Promise<void>;
}

/** Provider orchestration is injectable so dry-run, retries and preservation can be verified offline. */
export async function syncJarvisPlanningConfiguration(transport: JarvisConfigurationTransport, agentId: string, apply = false) {
  if (!/^[\w-]+$/.test(agentId)) throw Error("Invalid Jarvis agent ID.");
  const { request } = transport;
  const agent = await request(`agents/${agentId}`);
  const ids = agent.conversation_config?.agent?.prompt?.tool_ids;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[\w-]+$/.test(id))) throw Error("Unexpected attached tool IDs.");
  const tools: JarvisTaskTool[] = [];
  // At most four provider reads at once, independent of the number of attached tools.
  for (let offset = 0; offset < ids.length; offset += 4) tools.push(...await Promise.all(ids.slice(offset, offset + 4).map(async id => ({ ...await request(`tools/${id}`), id } as JarvisTaskTool))));
  const prepared = prepareJarvisPlanningConfiguration(agent, tools);
  if (!apply) return { applied: false, ...prepared };
  const snapshot = { agent, tools };
  await transport.backup(snapshot);
  const assertAgentUnchanged = async (toolsUpdated = false) => {
    const current = await request(`agents/${agentId}`);
    const expectedConfig = structuredClone(agent.conversation_config);
    if (toolsUpdated && Array.isArray(expectedConfig.agent.prompt.tools)) expectedConfig.agent.prompt.tools = expectedConfig.agent.prompt.tools.map((tool: RecordValue) => prepared.updatedTools.find(update => update.toolConfig.name === tool.name)?.toolConfig ?? tool);
    if (!isDeepStrictEqual(current.conversation_config, expectedConfig) || !isDeepStrictEqual(current.platform_settings, agent.platform_settings)) throw Error("Jarvis changed during preparation; rerun from fresh configuration.");
  };
  await assertAgentUnchanged();
  for (const update of prepared.updatedTools) {
    const current = await request(`tools/${update.id}`);
    if (!isDeepStrictEqual(current.tool_config, tools.find(tool => tool.id === update.id)!.tool_config)) throw Error("Task tool changed during preparation; rerun from fresh configuration.");
  }
  for (const update of prepared.updatedTools) {
    if (!isDeepStrictEqual(update.toolConfig, tools.find(tool => tool.id === update.id)!.tool_config)) await request(`tools/${update.id}`, "PATCH", { tool_config: update.toolConfig });
  }
  await assertAgentUnchanged(true);
  const expectedPrompt = prepared.expectedAgent.conversation_config.agent.prompt;
  if (!isDeepStrictEqual(expectedPrompt, agent.conversation_config.agent.prompt)) await request(`agents/${agentId}`, "PATCH", { conversation_config: { agent: { prompt: { prompt: expectedPrompt.prompt, tool_ids: expectedPrompt.tool_ids } } } });
  const verified = await request(`agents/${agentId}`);
  if (!isDeepStrictEqual(verified.conversation_config, prepared.expectedAgent.conversation_config) || !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)) throw Error("Jarvis configuration verification failed; inspect backup.");
  for (const update of prepared.updatedTools) if (!isDeepStrictEqual((await request(`tools/${update.id}`)).tool_config, update.toolConfig)) throw Error("Task tool verification failed; inspect backup.");
  return { applied: true, ...prepared };
}
