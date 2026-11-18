import { isDeepStrictEqual } from "node:util";

type Agent = Record<string, any>;

/** Protect every overlapping prompt setting and the private-agent invariant. */
export function assertUnchangedJarvisPrompt(original: Agent, latest: Agent) {
  if (latest.platform_settings?.auth?.enable_auth !== true || !isDeepStrictEqual(original.conversation_config?.agent?.prompt, latest.conversation_config?.agent?.prompt)) {
    throw Error("Jarvis changed during preparation.");
  }
}

export function assertUnchangedJarvisTool(original: unknown, latest: unknown) {
  if (!isDeepStrictEqual(original, latest)) throw Error("Task tool changed during preparation.");
}

/** The provider merges this nested PATCH; unrelated settings are never submitted. */
export function jarvisPromptPatch(prompt: string) {
  return { conversation_config: { agent: { prompt: { prompt } } } };
}

export function assertVerifiedJarvisPrompt(expected: Agent, actual: Agent) {
  if (actual.platform_settings?.auth?.enable_auth !== true || !isDeepStrictEqual(expected.conversation_config?.agent?.prompt, actual.conversation_config?.agent?.prompt)) {
    throw Error("Agent verification failed.");
  }
}
