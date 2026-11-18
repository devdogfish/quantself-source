import { expect, test } from "bun:test";
import { prepareJarvisPlanningConfiguration } from "./todos-jarvis-planning-config";
import { syncJarvisPlanningConfiguration } from "./todos-jarvis-planning-sync";
import type { JarvisTaskTool } from "./todos-jarvis-task-config";

function fixture() {
  const agent: Record<string, any> = {
    conversation_config: { agent: { prompt: { prompt: "Keep identity. {{ui_context}}", tool_ids: ["create", "edit", "read"], llm: "keep-model" } }, tts: { voice_id: "keep-voice" } },
    platform_settings: { auth: { enable_auth: true }, privacy: { record_voice: true } },
  };
  const makeTool = (id: string, name: string): JarvisTaskTool => ({ id, tool_config: {
    type: "webhook", name, description: "original", response_timeout_secs: 19,
    api_schema: { url: "https://example.test/api/v1/todo-jarvis/{id}/commands", method: "POST",
      request_headers: { "X-API-Key": { secret_id: "keep-secret-reference" } },
      path_params_schema: { id: { type: "string", dynamic_variable: "system__user_id" } },
      request_body_schema: { type: "object", required: ["conversationId", "command", "intent"], properties: {
        conversationId: { type: "string", dynamic_variable: "system__conversation_id" },
        command: { type: "string", description: "original command" },
        intent: { type: "string", enum: ["requested", "reviewed", "suggested", "ambiguous"], description: "original intent" },
      } },
    },
  } });
  const tools = [makeTool("create", "apply_task_command"), makeTool("edit", "edit_task_command"), { id: "read", tool_config: { type: "webhook", name: "read_tasks", description: "Keep reader", api_schema: { method: "GET", url: "https://example.test/api/v1/todos" } } }];
  agent.conversation_config.agent.prompt.tools = [...tools.map(tool => structuredClone(tool.tool_config)), { type: "system", name: "end_call" }];
  return { agent, tools };
}

test("ordinary contract removes retired mode and preserves transport, identity and controls", () => {
  const f = fixture();
  const retired = { id: "mode", tool_config: { name: "set_planning_mode", type: "webhook" } };
  f.tools.push(retired);
  f.agent.conversation_config.agent.prompt.tool_ids.push("mode");
  f.agent.conversation_config.agent.prompt.tools.push(retired.tool_config);
  const old = f.tools[0].tool_config.api_schema;
  const result = prepareJarvisPlanningConfiguration(f.agent, f.tools);
  expect(result.removedToolIds).toEqual(["mode"]);
  expect(result.expectedAgent.conversation_config.agent.prompt.tool_ids).not.toContain("mode");
  expect(result.expectedAgent.conversation_config.agent.prompt.tools.some((tool: any) => tool.name === "set_planning_mode")).toBe(false);
  expect(result.expectedAgent.platform_settings).toEqual(f.agent.platform_settings);
  expect(result.expectedAgent.conversation_config.tts).toEqual(f.agent.conversation_config.tts);
  for (const update of result.updatedTools.filter(tool => tool.id !== "read")) {
    expect(update.toolConfig.api_schema.request_headers).toEqual(old.request_headers);
    expect(update.toolConfig.api_schema.request_body_schema.properties.intent.enum).toEqual(["requested", "reviewed", "suggested", "ambiguous"]);
    expect(update.toolConfig.api_schema.request_body_schema.properties.modeId).toBeUndefined();
    expect(update.toolConfig.pre_tool_speech).toBe("off");
  }
  expect(result.nextPrompt).toContain("plan next week");
  const nextTools = f.tools.filter(tool => tool.id !== "mode").map(tool => ({ ...tool, tool_config: result.updatedTools.find(update => update.id === tool.id)?.toolConfig ?? tool.tool_config }));
  expect(prepareJarvisPlanningConfiguration(result.expectedAgent, nextTools).expectedAgent).toEqual(result.expectedAgent);
});

function providerFixture() {
  const f = fixture();
  f.tools.push({ id: "retired", tool_config: { type: "webhook", name: "set_planning_mode" } });
  f.agent.conversation_config.agent.prompt.tool_ids.push("retired");
  f.agent.conversation_config.agent.prompt.tools.push(f.tools.at(-1)!.tool_config);
  let agent = structuredClone(f.agent);
  const tools = new Map(f.tools.map(tool => [tool.id, structuredClone(tool)]));
  const mutations: string[] = [], backups: unknown[] = [];
  const transport = {
    async backup(value: unknown) { backups.push(structuredClone(value)); },
    async request(path: string, method = "GET", body?: any) {
      if (method !== "GET") mutations.push(path);
      if (path === "agents/agent") {
        if (method === "PATCH") {
          Object.assign(agent.conversation_config.agent.prompt, body.conversation_config.agent.prompt);
          agent.conversation_config.agent.prompt.tools = agent.conversation_config.agent.prompt.tool_ids.map((id: string) => tools.get(id)!.tool_config).concat([{ type: "system", name: "end_call" }]);
        }
        return structuredClone(agent);
      }
      const id = path.replace("tools/", "");
      if (!tools.has(id)) throw Error("Unexpected tool request");
      if (method === "PATCH") {
        tools.get(id)!.tool_config = structuredClone(body.tool_config);
        agent.conversation_config.agent.prompt.tools = agent.conversation_config.agent.prompt.tools.map((tool: any) => tool.name === body.tool_config.name ? structuredClone(body.tool_config) : tool);
      }
      return structuredClone(tools.get(id)!);
    },
  };
  return { transport, mutations, backups };
}

test("sync dry run writes nothing; apply backs up, verifies and retries idempotently without tool creation", async () => {
  const p = providerFixture();
  await syncJarvisPlanningConfiguration(p.transport, "agent");
  expect(p.mutations).toEqual([]); expect(p.backups).toEqual([]);
  await syncJarvisPlanningConfiguration(p.transport, "agent", true);
  expect(p.backups).toHaveLength(1);
  const count = p.mutations.length;
  await syncJarvisPlanningConfiguration(p.transport, "agent", true);
  expect(p.mutations).toHaveLength(count);
});

test("sync refuses concurrent source changes before writing", async () => {
  const p = providerFixture();
  const request = p.transport.request;
  let reads = 0;
  p.transport.request = async (path, method, body) => {
    const value: Record<string, any> = await request(path, method, body);
    if (path === "agents/agent" && ++reads === 2) value.platform_settings = { changed: true };
    return value;
  };
  await expect(syncJarvisPlanningConfiguration(p.transport, "agent", true)).rejects.toThrow("changed during preparation");
  expect(p.mutations).toEqual([]);
});

test("ordinary command configuration retains bound conversation transport requirement", () => {
  const f = fixture();
  delete f.tools[1].tool_config.api_schema.request_body_schema.properties.conversationId.dynamic_variable;
  expect(() => prepareJarvisPlanningConfiguration(f.agent, f.tools)).toThrow("conversationId bound");
});
