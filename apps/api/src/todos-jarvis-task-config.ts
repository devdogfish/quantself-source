import { jarvisCaptureInstructions } from "./todos-jarvis-capture-contract";
import { jarvisCrudInstructions } from "./todos-jarvis-crud-contract";
import { jarvisCreateCommandDescription, jarvisEditCommandDescription, jarvisTaskTimingInstructions } from "./todos-jarvis-tool-contract";

// Provider-owned properties are deliberately carried through without narrowing/rebuilding schemas.
type ProviderRecord = Record<string, any>;
export type JarvisTaskTool = { id: string; tool_config: ProviderRecord };

export function withoutManagedBlock(prompt: string, name: string) {
  const begin = `[Quantself ${name}]`, end = `[/Quantself ${name}]`;
  let text = prompt;
  for (;;) {
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start < 0 && stop < 0) return text;
    if (start < 0 || stop < start || text.indexOf(begin, start + begin.length) >= 0 && text.indexOf(begin, start + begin.length) < stop) throw Error(`Malformed ${name} contract block.`);
    text = text.slice(0, start) + text.slice(stop + end.length);
  }
}

/** Pure, repeatable configuration preparation; no requests and no mutation of fetched records. */
export function prepareJarvisTaskTimingConfiguration(agent: ProviderRecord, tools: JarvisTaskTool[]) {
  const promptConfig = agent.conversation_config?.agent?.prompt;
  if (typeof promptConfig?.prompt !== "string" || !Array.isArray(promptConfig.tool_ids)) throw Error("Unexpected Jarvis prompt configuration.");
  if (agent.platform_settings?.auth?.enable_auth !== true) throw Error("Private Jarvis required.");
  const updatedTools = ["apply_task_command", "edit_task_command"].map(name => {
    const matches = tools.filter(tool => tool.tool_config?.name === name);
    if (matches.length !== 1 || !promptConfig.tool_ids.includes(matches[0].id)) throw Error(`Expected one attached ${name} task tool.`);
    const tool = matches[0];
    const toolConfig = structuredClone(tool.tool_config);
    if (toolConfig.type !== "webhook" || toolConfig.api_schema?.method !== "POST" || toolConfig.api_schema.request_body_schema?.properties?.command?.type !== "string") throw Error("Unexpected task tool transport.");
    const create = name === "apply_task_command";
    toolConfig.description = create
      ? "Create one todo from the Owner's rough wording. Infer a useful title; never ask for a title, category or date. Preserve original wording in description. Optional requested timing saves in the same command; a lone bound seeds 30 minutes. Never invent a time. Follow validated intent and overlap rules."
      : "Edit an existing todo after reading current values. Preserve unrelated facts and use the current revision for timing. Relative moves use shiftMinutes; exact moves preserve duration. A single-bound resize retains its other bound. Prep edits preserve the event range. Follow validated intent and overlap rules; never approve execution.";
    toolConfig.api_schema.request_body_schema.properties.command.description = create ? jarvisCreateCommandDescription : jarvisEditCommandDescription;
    return { id: tool.id, toolConfig };
  });
  const reads = tools.filter(tool => tool.tool_config?.name === "read_tasks");
  if (reads.length !== 1 || !promptConfig.tool_ids.includes(reads[0].id) || reads[0].tool_config.api_schema?.method !== "GET") throw Error("Expected one attached read_tasks tool.");
  const readConfig = structuredClone(reads[0].tool_config);
  const query = readConfig.api_schema.query_params_schema ?? { properties: {}, required: [] };
  readConfig.api_schema.query_params_schema = { ...query, properties: { ...query.properties, includeCategories: {
    type: "string", enum: ["true", "false"], description: "Use true when categorizing tasks to include current category names in categories. Category assignments use fields.Category; Commitment is separate status. Omit for ordinary reads.",
    is_system_provided: false, dynamic_variable: "", allowed_values: null, allowed_values_dynamic_variable: "", constant_value: "", is_omitted: false,
  } } };
  updatedTools.push({ id: reads[0].id, toolConfig: readConfig });
  let preserved = promptConfig.prompt as string;
  for (const name of ["task CRUD", "session-edit contract", "task-timing contract", "capture contract"]) preserved = withoutManagedBlock(preserved, name);
  const nextPrompt = `${preserved.trim()}\n\n[Quantself task CRUD]\n${jarvisCrudInstructions}\n[/Quantself task CRUD]\n\n[Quantself capture contract]\n${jarvisCaptureInstructions}\n[/Quantself capture contract]\n\n[Quantself task-timing contract]\n${jarvisTaskTimingInstructions}\n[/Quantself task-timing contract]`;
  const expectedAgent = structuredClone(agent);
  expectedAgent.conversation_config.agent.prompt.prompt = nextPrompt;
  if (Array.isArray(expectedAgent.conversation_config.agent.prompt.tools)) {
    expectedAgent.conversation_config.agent.prompt.tools = expectedAgent.conversation_config.agent.prompt.tools.map((tool: ProviderRecord) => structuredClone(updatedTools.find(update => update.toolConfig.name === tool.name)?.toolConfig ?? tool));
  }
  return { nextPrompt, updatedTools, expectedAgent };
}
