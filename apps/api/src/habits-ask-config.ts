/** Permit per-conversation restriction of tools and suppressing Ask's greeting.
 * Does not change defaults, model, prompt, tools, credentials or permissions. */
export function habitAskAgentPatch(agent: Record<string, any>) {
  const platform = agent.platform_settings;
  if (!platform?.auth?.enable_auth) throw Error("Habit Ask requires the existing private Jarvis agent.");
  const overrides = platform.overrides ?? {}, conversation = overrides.conversation_config_override ?? {}, current = conversation.agent ?? {};
  return { platform_settings: { ...platform, overrides: { ...overrides, conversation_config_override: { ...conversation,
    conversation: { ...conversation.conversation, text_only: true },
    agent: { ...current, first_message: true, prompt: { ...current.prompt, tool_ids: true, tool_ids_strict: true, native_mcp_server_ids: true } },
  } } } };
}
