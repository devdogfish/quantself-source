import { prepareJarvisTaskTimingConfiguration, withoutManagedBlock, type JarvisTaskTool } from "./todos-jarvis-task-config";
import { jarvisIntentDescription, jarvisPlanningInstructions } from "./todos-jarvis-planning-contract";

const property = (value: Record<string, any>) => ({ description: "", enum: null, is_system_provided: false, dynamic_variable: "", allowed_values: null, allowed_values_dynamic_variable: "", constant_value: "", is_omitted: false, ...value });

/** Retired planning-mode migration plus the ordinary conversational task contract. */
export function prepareJarvisPlanningConfiguration(agent: Record<string, any>, tools: JarvisTaskTool[]) {
  const input = structuredClone(agent);
  const prompt = input.conversation_config?.agent?.prompt;
  if (typeof prompt?.prompt !== "string") throw Error("Unexpected Jarvis prompt configuration.");
  const retiredIds = new Set(tools.filter(tool => tool.tool_config.name === "set_planning_mode").map(tool => tool.id));
  prompt.tool_ids = prompt.tool_ids.filter((id: string) => !retiredIds.has(id));
  if (Array.isArray(prompt.tools)) prompt.tools = prompt.tools.filter((tool: Record<string, any>) => tool.name !== "set_planning_mode");
  prompt.prompt = withoutManagedBlock(withoutManagedBlock(prompt.prompt, "planning contract"), "conversation contract");
  const prepared = prepareJarvisTaskTimingConfiguration(input, tools.filter(tool => !retiredIds.has(tool.id)));
  for (const update of prepared.updatedTools) {
    if (!["apply_task_command", "edit_task_command"].includes(update.toolConfig.name)) continue;
    const body = update.toolConfig.api_schema.request_body_schema;
    const conversation = body.properties.conversationId;
    if (conversation?.type !== "string" || !conversation.dynamic_variable) throw Error("Expected conversationId bound to the provider conversation.");
    body.properties.intent = property({ type: "string", enum: ["requested", "reviewed", "suggested", "ambiguous"], description: jarvisIntentDescription });
    delete body.properties.modeId;
    body.properties.overlapConfirmed = property({ type: "boolean", description: "True only after explicit Owner acceptance of the known overlap for this exact interval. Otherwise omit; never infer acceptance." });
    body.required = (body.required ?? []).filter((name: string) => name !== "modeId" && name !== "overlapConfirmed");
  }
  const quietTools = new Set(["read_tasks", "read_task", "apply_task_command", "edit_task_command", "show_task", "set_calendar_view", "navigate_calendar", "close_panel", "set_category_filter", "change_category"]);
  for (const tool of tools) {
    if (!prompt.tool_ids.includes(tool.id) || !quietTools.has(tool.tool_config.name) || tool.tool_config.type === "system") continue;
    let update = prepared.updatedTools.find(value => value.id === tool.id);
    if (!update) {
      update = { id: tool.id, toolConfig: structuredClone(tool.tool_config) };
      prepared.updatedTools.push(update);
    }
    update.toolConfig.pre_tool_speech = "off";
  }
  const nextPrompt = `${prepared.nextPrompt}\n\n[Quantself conversation contract]\n${jarvisPlanningInstructions}\n[/Quantself conversation contract]`;
  const expectedAgent = prepared.expectedAgent;
  expectedAgent.conversation_config.agent.prompt.prompt = nextPrompt;
  const expanded = expectedAgent.conversation_config.agent.prompt.tools;
  if (Array.isArray(expanded)) {
    const attachedNames = new Set(tools.map(tool => tool.tool_config.name));
    const attachedTools = expectedAgent.conversation_config.agent.prompt.tool_ids.map((id: string) => structuredClone(prepared.updatedTools.find(tool => tool.id === id)?.toolConfig ?? tools.find(tool => tool.id === id)!.tool_config));
    expectedAgent.conversation_config.agent.prompt.tools = [...attachedTools, ...expanded.filter((tool: Record<string, any>) => !attachedNames.has(tool.name))];
  }
  return { nextPrompt, updatedTools: prepared.updatedTools, expectedAgent, removedToolIds: [...retiredIds] };
}
