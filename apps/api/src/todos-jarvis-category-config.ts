import { withoutManagedBlock, type JarvisTaskTool } from "./todos-jarvis-task-config";

export const jarvisCategoryClientToolNames = ["set_category_filter", "change_category"] as const;
export const jarvisCategoryInstructions = `Use the active Quantself client hooks for category filters, category assignment/removal, category creation/rename/color/deletion, and task high priority. These use the same optimistic UI and Undo/Redo as manual controls. For filters use set_category_filter with all, uncategorized, or category plus categoryId from the newest UI context.categories. For writes use change_category, not duplicate server edits: action=assign with taskNumbers and categoryId (omit categoryId to remove categorization); action=create with name and optional color; action=update with categoryId and name and/or color; action=delete with categoryId and optional replacementCategoryId (omitted moves affected tasks to uncategorized); action=priority with taskNumbers and highPriority boolean. Resolve IDs from current context; do not fabricate IDs or treat category selection as write authority. Explicit delegated categorization authorizes choosing existing categories and assigning them without another approval. Read task details when needed to understand them. A task supports one category; assigning replaces its old category. Deleting a category never deletes tasks. Colors are gray, blue, green, yellow, orange, red, pink, purple. High priority is the separate Top priority field; it is not Commitment or category, and the app enforces its limit. Tools project changes immediately and report pending/saved/failed honestly; a pending result is not saved. Inspect the actual result and summarize briefly, including failures. Do not replay a client mutation through a webhook after an uncertain client result. If client controls are unavailable, report that rather than claiming success. Do not add a second approval after a clear instruction.`;

const property = (value: Record<string, any>) => ({ description: "", enum: null, is_system_provided: false, dynamic_variable: "", allowed_values: null, allowed_values_dynamic_variable: "", constant_value: "", is_omitted: false, ...value });
const number = (description: string) => property({ type: "integer", description });

export function prepareJarvisCategoryConfiguration(agent: Record<string, any>, tools: JarvisTaskTool[]) {
  const prompt = agent.conversation_config?.agent?.prompt;
  if (agent.platform_settings?.auth?.enable_auth !== true || typeof prompt?.prompt !== "string" || !Array.isArray(prompt.tool_ids)) throw Error("Private Jarvis with attached tools required.");
  const templates = tools.filter(tool => prompt.tool_ids.includes(tool.id) && tool.tool_config.type === "client" && tool.tool_config.name === "show_task");
  if (templates.length !== 1) throw Error("Expected one attached show_task client tool.");
  const definitions = [
    { name: "set_category_filter", description: "Change the visible Quantself category filter using the client hook. No task mutation. Read category IDs from current UI context. Wait for rendered result.", required: ["filter"], properties: {
      filter: property({ type: "string", enum: ["all", "uncategorized", "category"], description: "Requested category filter." }),
      categoryId: number("Existing category ID, required only for filter=category."),
    } },
    { name: "change_category", description: "Use Quantself optimistic UI controls to assign/remove task categories, create/update/delete categories, or set task high priority. Explicit requests and delegated classification require no second approval. Inspect result; never treat pending as saved or duplicate through webhook.", required: ["action"], properties: {
      action: property({ type: "string", enum: ["create", "update", "delete", "assign", "priority"], description: "Requested operation; priority changes Top priority independently of categories." }),
      categoryId: number("Existing category ID for update/delete/assign. Omit for assign to remove categories."),
      name: property({ type: "string", description: "New category name; required for create, optional for update." }),
      color: property({ type: "string", enum: ["gray", "blue", "green", "yellow", "orange", "red", "pink", "purple"], description: "Category color for create/update; create defaults blue." }),
      taskNumbers: { type: "array", description: "Existing task issue numbers, required for assign/priority.", items: number("Positive task issue number."), dynamic_variable: "", is_omitted: false, constant_value: null },
      replacementCategoryId: number("Existing destination category ID when deleting; omit to uncategorize affected tasks."),
      highPriority: property({ type: "boolean", description: "Required for priority: true sets high priority, false removes it." }),
    } },
  ];
  const desired = definitions.map(definition => {
    const matches = tools.filter(tool => tool.tool_config.name === definition.name);
    if (matches.length > 1 || matches[0] && matches[0].tool_config.type !== "client") throw Error(`Ambiguous ${definition.name} tool.`);
    const config = structuredClone(matches[0]?.tool_config ?? templates[0].tool_config);
    Object.assign(config, { name: definition.name, description: definition.description, expects_response: true, pre_tool_speech: "off", tool_error_handling_mode: "passthrough", response_timeout_secs: 120, assignments: [] });
    config.parameters = { description: "Quantself client controls.", dynamic_variable: "", is_omitted: false, type: "object", required: definition.required, properties: definition.properties };
    return { id: matches[0]?.id, toolConfig: config };
  });
  const nextPrompt = `${withoutManagedBlock(prompt.prompt, "category client contract").trim()}\n\n[Quantself category client contract]\n${jarvisCategoryInstructions}\n[/Quantself category client contract]`;
  const expectedAgent = structuredClone(agent);
  const expected = expectedAgent.conversation_config.agent.prompt;
  expected.prompt = nextPrompt;
  for (const tool of desired) if (tool.id && !expected.tool_ids.includes(tool.id)) expected.tool_ids.push(tool.id);
  if (Array.isArray(expected.tools)) {
    // Provider expands registry tools in tool_ids order, followed by inline system tools.
    const attached = expected.tool_ids.map((id: string) => structuredClone(desired.find(tool => tool.id === id)?.toolConfig ?? tools.find(tool => tool.id === id)!.tool_config));
    const attachedNames = new Set(attached.map((tool: any) => tool.name));
    expected.tools = [...attached, ...expected.tools.filter((tool: any) => !attachedNames.has(tool.name))];
  }
  return { desired, expectedAgent };
}
