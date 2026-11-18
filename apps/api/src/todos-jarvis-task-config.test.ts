import { expect, test } from "bun:test";
import { prepareJarvisTaskTimingConfiguration, type JarvisTaskTool } from "./todos-jarvis-task-config";
import { jarvisCaptureInstructions } from "./todos-jarvis-capture-contract";
import { jarvisTaskTimingInstructions, jarvisCreateCommandDescription, jarvisEditCommandDescription } from "./todos-jarvis-tool-contract";

function fixture() {
  const agent = {
    name: "Jarvis", agent_id: "agent_fixture",
    conversation_config: { agent: { first_message: "At your service.", language: "en", prompt: { prompt: "Identity guide and selected task {{ui_context}}.\n\n[Quantself planning contract]\nKeep scoped planning.\n[/Quantself planning contract]\n\n[Quantself task-timing contract]\nAsk for title and missing end.\n[/Quantself task-timing contract]", tool_ids: ["read", "create", "edit"], llm: "existing-model", temperature: 0.3 } }, tts: { voice_id: "keep-voice", model_id: "keep-model" }, turn: { turn_timeout: 9 } },
    platform_settings: { auth: { enable_auth: true }, privacy: { record_voice: true } },
  };
  const tool = (id: string, name: string) => ({ id, tool_config: { type: "webhook", name, description: "old description", tool_error_handling_mode: "passthrough", response_timeout_secs: 19, api_schema: { method: "POST", url: "https://quantself.example/api/v1/todo-jarvis/{capture_id}/commands", request_headers: { "X-API-Key": { secret_id: "existing-secret-reference" } }, request_body_schema: { type: "object", required: ["command", "intent"], properties: { intent: { type: "string", enum: ["requested", "reviewed", "planning"] }, modeId: { type: "string" }, command: { type: "string", description: "old command" } } } } } });
  return { agent, tools: [tool("create", "apply_task_command"), tool("edit", "edit_task_command"), { id: "read", tool_config: { type: "webhook", name: "read_tasks", description: "Read unchanged", api_schema: { method: "GET", url: "https://quantself.example/api/v1/todos" } } }] };
}

test("capture/timing configuration changes only managed prompt blocks and task descriptions and opt-in category lookup", () => {
  const f = fixture(), original = structuredClone(f);
  const result = prepareJarvisTaskTimingConfiguration(f.agent, f.tools);
  expect(f).toEqual(original);
  expect(result.nextPrompt).toContain(jarvisCaptureInstructions);
  expect(result.nextPrompt).toContain(jarvisTaskTimingInstructions);
  expect(result.nextPrompt).not.toContain("Ask for title and missing end.");
  expect(result.nextPrompt).toContain("[Quantself planning contract]\nKeep scoped planning.\n[/Quantself planning contract]");
  expect(result.expectedAgent.conversation_config.tts).toEqual(f.agent.conversation_config.tts);
  expect(result.expectedAgent.platform_settings).toEqual(f.agent.platform_settings);
  const expectedAgent = structuredClone(f.agent); expectedAgent.conversation_config.agent.prompt.prompt = result.nextPrompt;
  expect(result.expectedAgent).toEqual(expectedAgent);
  expect(result.updatedTools.map(tool => tool.id)).toEqual(["create", "edit", "read"]);
  for (const update of result.updatedTools) {
    const before = f.tools.find(tool => tool.id === update.id)!.tool_config;
    const expected: JarvisTaskTool["tool_config"] = structuredClone(before);
    expected.description = update.toolConfig.description;
    if (update.id === "read") {
      expected.api_schema.query_params_schema = update.toolConfig.api_schema.query_params_schema;
      expect(expected.api_schema.query_params_schema.properties.includeCategories.enum).toEqual(["true", "false"]);
    } else expected.api_schema.request_body_schema!.properties.command.description = update.id === "create" ? jarvisCreateCommandDescription : jarvisEditCommandDescription;
    expect(update.toolConfig).toEqual(expected);
  }
});

test("configuration preparation is idempotent and retires every old managed capture/session block", () => {
  const f = fixture();
  f.agent.conversation_config.agent.prompt.prompt += "\n\n[Quantself capture contract]\nOld title interview.\n[/Quantself capture contract]\n\n[Quantself session-edit contract]\nOld separate session.\n[/Quantself session-edit contract]";
  const first = prepareJarvisTaskTimingConfiguration(f.agent, f.tools);
  const second = prepareJarvisTaskTimingConfiguration(first.expectedAgent, f.tools.map(tool => ({ ...tool, tool_config: first.updatedTools.find(update => update.id === tool.id)?.toolConfig ?? tool.tool_config })));
  expect(second).toEqual(first);
  expect(first.nextPrompt.split("[Quantself capture contract]")).toHaveLength(2);
  expect(first.nextPrompt).not.toContain("Old title interview.");
  expect(first.nextPrompt).not.toContain("Old separate session.");
});

test("expected agent includes provider-expanded task tool changes", () => {
  const f = fixture();
  const agent: Record<string, any> = structuredClone(f.agent);
  agent.conversation_config.agent.prompt.tools = [...f.tools.map(tool => tool.tool_config), { type: "system", name: "end_call" }];
  const result = prepareJarvisTaskTimingConfiguration(agent, f.tools);
  expect(result.expectedAgent.conversation_config.agent.prompt.tools).toEqual([...f.tools.map(tool => result.updatedTools.find(update => update.id === tool.id)?.toolConfig ?? tool.tool_config), { type: "system", name: "end_call" }]);
});

test("configuration rejects unsafe or ambiguous provider shapes before proposing writes", () => {
  const f = fixture();
  expect(() => prepareJarvisTaskTimingConfiguration({ ...f.agent, platform_settings: { auth: { enable_auth: false } } }, f.tools)).toThrow("Private Jarvis");
  expect(() => prepareJarvisTaskTimingConfiguration(f.agent, [...f.tools, f.tools[0]])).toThrow("Expected one attached");
  const malformed = structuredClone(f.agent); malformed.conversation_config.agent.prompt.prompt += "\n[Quantself capture contract]\nUnclosed";
  expect(() => prepareJarvisTaskTimingConfiguration(malformed, f.tools)).toThrow("Malformed capture");
  const changed = structuredClone(f.tools); changed[0].tool_config.api_schema.method = "GET";
  expect(() => prepareJarvisTaskTimingConfiguration(f.agent, changed)).toThrow("Unexpected task tool transport");
});
