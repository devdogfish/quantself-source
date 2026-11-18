import { expect, test } from "bun:test";
import { prepareJarvisCategoryConfiguration } from "./todos-jarvis-category-config";
import { syncJarvisCategoryConfiguration } from "./todos-jarvis-category-sync";

function fixture() {
  const tools = new Map<string, any>([["show", { id: "show", tool_config: { type: "client", name: "show_task", description: "Keep navigation", parameters: { type: "object", properties: {} }, expects_response: true, response_timeout_secs: 20, dynamic_variables: { dynamic_variable_placeholders: {} } } }]]);
  const systemTools = [{ type: "system", name: "end_call", params: { system_tool_type: "end_call" } }];
  let agent = { platform_settings: { auth: { enable_auth: true }, privacy: { record_voice: true } }, conversation_config: { tts: { voice_id: "preserve" }, agent: { prompt: { prompt: "Identity {{ui_context}}", tool_ids: ["show"], tools: [tools.get("show").tool_config, ...systemTools] } } } };
  const calls: string[] = []; const backups: unknown[] = [];
  const transport = {
    async request(path: string, method = "GET", body?: any): Promise<any> {
      calls.push(`${method} ${path}`);
      if (path === "agents/agent") {
        if (method === "PATCH") { Object.assign(agent.conversation_config.agent.prompt, body.conversation_config.agent.prompt); }
        agent.conversation_config.agent.prompt.tools = [...agent.conversation_config.agent.prompt.tool_ids.map(id => tools.get(id).tool_config), ...systemTools];
        return structuredClone(agent);
      }
      if (path.startsWith("tools?")) return { tools: [...tools.values()].filter(tool => tool.tool_config.name === new URLSearchParams(path.slice(6)).get("search")), has_more: false };
      if (path === "tools" && method === "POST") {
        const id = `created_${tools.size}`;
        const created = structuredClone(body);
        // ElevenLabs expands array parameters with this explicit nullable default.
        for (const parameter of Object.values(created.tool_config.parameters.properties) as any[]) if (parameter.type === "array" && parameter.constant_value === undefined) parameter.constant_value = null;
        tools.set(id, { id, ...created }); return { id };
      }
      const id = path.slice(6);
      if (method === "PATCH") tools.set(id, { id, ...structuredClone(body) });
      return structuredClone(tools.get(id));
    },
    async backup(value: unknown) { backups.push(structuredClone(value)); },
  };
  return { tools, agent, calls, backups, transport };
}

test("category sync previews without writes then attaches exact client capabilities, preserving configuration and idempotence", async () => {
  const f = fixture();
  const dry = await syncJarvisCategoryConfiguration(f.transport, "agent");
  expect(dry.applied).toBe(false); expect(f.backups).toHaveLength(0);
  expect(f.calls.every(call => call.startsWith("GET"))).toBe(true);
  await syncJarvisCategoryConfiguration(f.transport, "agent", true);
  expect(f.tools.size).toBe(3); expect(f.backups.length).toBe(3);
  expect(f.agent.conversation_config.agent.prompt.tools.map(tool => tool.name)).toEqual(["show_task", "set_category_filter", "change_category", "end_call"]);
  expect(f.agent.conversation_config.tts).toEqual({ voice_id: "preserve" });
  const change = [...f.tools.values()].find(tool => tool.tool_config.name === "change_category").tool_config;
  expect(change.type).toBe("client"); expect(change.parameters.properties.action.enum).toContain("priority");
  expect(change.parameters.properties.highPriority.type).toBe("boolean");
  expect(change.parameters.properties.taskNumbers.constant_value).toBeNull();
  expect(change.api_schema).toBeUndefined();
  const before = f.calls.length;
  await syncJarvisCategoryConfiguration(f.transport, "agent", true);
  expect(f.calls.slice(before).every(call => call.startsWith("GET"))).toBe(true);
});

test("configuration rejects duplicate tools and nonprivate agents", () => {
  const f = fixture(); const tools = [...f.tools.values()];
  expect(() => prepareJarvisCategoryConfiguration({ ...f.agent, platform_settings: { auth: { enable_auth: false } } }, tools)).toThrow("Private");
  expect(() => prepareJarvisCategoryConfiguration(f.agent, [...tools, ...[1, 2].map(id => ({ id: `${id}`, tool_config: { type: "client", name: "change_category" } }))])).toThrow("Ambiguous");
});

test("sync recovers tools created before attachment without creating duplicates", async () => {
  const f = fixture();
  const prepared = prepareJarvisCategoryConfiguration(f.agent, [...f.tools.values()]);
  f.tools.set("orphan", { id: "orphan", tool_config: prepared.desired[0].toolConfig });
  await syncJarvisCategoryConfiguration(f.transport, "agent", true);
  expect(f.tools.size).toBe(3);
  expect(f.agent.conversation_config.agent.prompt.tool_ids).toContain("orphan");
  expect(f.calls.filter(call => call === "POST tools")).toHaveLength(1);
});

test("sync rejects incomplete discovery pagination before writes", async () => {
  const f = fixture(); const original = f.transport.request;
  f.transport.request = async (path, method, body) => path.startsWith("tools?") ? { tools: [], has_more: true } : original(path, method, body);
  await expect(syncJarvisCategoryConfiguration(f.transport, "agent", true)).rejects.toThrow("pagination");
  expect(f.backups).toHaveLength(0);
  expect(f.calls.every(call => call.startsWith("GET"))).toBe(true);
});
